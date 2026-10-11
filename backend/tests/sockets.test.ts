import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { Challenge } from "@/modules/challenges/challenge.model";
import { EventModel } from "@/modules/events/event.model";
import { SocketRealtime } from "@/sockets";
import { setRealtime } from "@/sockets/realtime";
import { advanceTo, CORRECT, goLive, insertScoredSubmission, releaseClock, setupPublishedCompetition, useFakeClock } from "./helpers/competition";
import { type TestClient, newClient, startTestContext, stopTestContext, type TestContext } from "./helpers/test-app";

let ctx: TestContext;
let admin: TestClient;
let http: Server;
let realtime: SocketRealtime;
let url: string;
let comp: Awaited<ReturnType<typeof setupPublishedCompetition>>;
let alice: TestClient;
let bob: TestClient;
let outsider: TestClient;
const sockets: Socket[] = [];

beforeAll(async () => {
  useFakeClock();
  ctx = await startTestContext();
  http = createServer(createApp(ctx.container));
  realtime = new SocketRealtime(http, ctx.config);
  setRealtime(realtime);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  admin = await newClient(ctx, { role: "admin" });
  await EventModel.updateMany({}, { status: "finalized" });
  comp = await setupPublishedCompetition(admin, { topN: [5, 3] });
  await goLive(admin, comp.eventId);
  alice = await newClient(ctx, { email: "alice@college.edu", name: "alice" });
  bob = await newClient(ctx, { email: "bob@college.edu", name: "bob" });
  outsider = await newClient(ctx, { email: "outsider@college.edu", name: "outsider" });
  for (const c of [alice, bob]) await c.post(`/api/v1/events/${comp.eventId}/register`);
  await admin.post(`/api/v1/admin/events/${comp.eventId}/transition`, { to: "live" });
  advanceTo(1);
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});
afterAll(async () => {
  setRealtime(undefined);
  await realtime.close();
  releaseClock();
  await stopTestContext(ctx);
});

function open(client: TestClient | null, extra: { cookie?: string; origin?: string } = {}): Socket {
  const socket = connect(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: {
      ...(client || extra.cookie ? { cookie: extra.cookie ?? client!.sessionCookie } : {}),
      ...(extra.origin ? { origin: extra.origin } : { origin: "http://localhost:3000" }),
    },
  });
  sockets.push(socket);
  return socket;
}
const connected = (socket: Socket) => new Promise<void>((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", reject);
});
function next<T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
const ask = (socket: Socket, event: string, payload: unknown) => new Promise<{ ok: boolean; code?: string }>((resolve) => socket.emit(event, payload, resolve));
const key = () => `sock-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`;

describe("authentication and authorisation", () => {
  it("rejects anonymous, forged and cross-origin connections", async () => {
    await expect(connected(open(null))).rejects.toThrow(/unauthorized/);
    await expect(connected(open(null, { cookie: "sql_challenge_session=totally-forged" }))).rejects.toThrow(/unauthorized/);
    await expect(connected(open(alice, { origin: "https://evil.example" }))).rejects.toBeTruthy();
    const ok = open(alice);
    await connected(ok);
    expect(ok.connected).toBe(true);
  });

  it("authorises every subscription on the server", async () => {
    const stranger = open(outsider);
    await connected(stranger);
    expect(await ask(stranger, "subscribe", { channel: "round", id: comp.rounds[0] })).toMatchObject({ ok: false, code: "NOT_REGISTERED" });
    expect(await ask(stranger, "subscribe", { channel: "event", id: comp.eventId })).toMatchObject({ ok: false, code: "NOT_REGISTERED" });
    expect(await ask(stranger, "subscribe", { channel: "admin" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await ask(stranger, "subscribe", { channel: "round", id: "not-an-id" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(await ask(stranger, "subscribe", { channel: "round", id: comp.rounds[0], room: "admin" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(await ask(stranger, "subscribe", { channel: "round" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(await ask(stranger, "subscribe", "round:" + comp.rounds[0])).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    const member = open(alice);
    await connected(member);
    expect(await ask(member, "subscribe", { channel: "admin" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const adminSocket = open(admin);
    await connected(adminSocket);
    expect(await ask(adminSocket, "subscribe", { channel: "admin" })).toEqual({ ok: true });
  });

  it("ignores client attempts to pick rooms or inject leaderboard data", async () => {
    const watcher = open(bob);
    await connected(watcher);
    const attacker = open(outsider);
    await connected(attacker);
    const heard: string[] = [];
    for (const event of ["leaderboard:updated", "leaderboard:snapshot", "submission:updated", "participant:updated"]) watcher.on(event, () => heard.push(event));
    // arbitrary events / forged payloads from a participant have no effect on anyone
    attacker.emit("join", `round:${comp.rounds[0]}`);
    attacker.emit("leaderboard:updated", { entries: [{ name: "forged", score: 99999 }] });
    attacker.emit("submission:updated", { score: 100000 });
    attacker.emit("subscribe", { channel: "round", id: comp.rounds[0] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(heard).toEqual([]);
    const board = (await bob.get(`/api/v1/rounds/${comp.rounds[0]}/leaderboard`)).body.data.leaderboard;
    expect(board.entries.some((e: { name: string }) => e.name === "forged")).toBe(false);
  });
});

describe("live leaderboard", () => {
  it("sends a snapshot on subscribe, then incremental updates as submissions are scored", async () => {
    const watcher = open(bob);
    const submitter = open(alice);
    await Promise.all([connected(watcher), connected(submitter)]);
    expect(await ask(watcher, "subscribe", { channel: "event", id: comp.eventId })).toEqual({ ok: true });
    const snapshotPromise = next<{ seq: number; entries: unknown[]; total: number }>(watcher, "leaderboard:snapshot");
    expect(await ask(watcher, "subscribe", { channel: "round", id: comp.rounds[0] })).toMatchObject({ ok: true });
    const snapshot = await snapshotPromise;
    expect(snapshot.entries).toEqual([]);

    const updated = next<{ seq: number; entries: Array<{ name: string; score: number; participantId: string }> }>(watcher, "leaderboard:updated");
    const mine: Array<{ status: string; verdict: string | null }> = [];
    submitter.on("submission:updated", (payload: { status: string; verdict: string | null }) => mine.push(payload));
    const personal = next<{ rank: number; reason: string }>(submitter, "participant:updated");
    // alice (not subscribed to the round) still gets her own events through her user room
    advanceTo(2);
    const response = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", key());
    expect(response.status).toBe(202);
    const board = await updated;
    expect(board.entries.map((e) => [e.name, e.score])).toEqual([["alice", 108]]);
    expect(board.seq).toBeGreaterThan(snapshot.seq);
    expect(JSON.stringify(board)).not.toMatch(/@college\.edu|googleSub/);
    expect(await personal).toMatchObject({ reason: "result", rank: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mine.map((m) => m.status)).toContain("completed");
    expect(mine.at(-1)).toMatchObject({ status: "completed", verdict: "accepted" });
  });

  it("does not leak one participant's submission events to another", async () => {
    const other = open(bob);
    await connected(other);
    const leaked: unknown[] = [];
    other.on("submission:updated", (payload) => leaked.push(payload));
    other.on("participant:updated", (payload) => leaked.push(payload));
    advanceTo(3);
    const response = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: "SELECT name FROM students" }).set("Idempotency-Key", key());
    expect([200, 202]).toContain(response.status);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(leaked).toEqual([]);
  });

  it("resynchronises after a reconnect with a fresh, newer snapshot", async () => {
    const first = open(bob);
    await connected(first);
    const firstSnapshot = next<{ seq: number; total: number }>(first, "leaderboard:snapshot");
    await ask(first, "subscribe", { channel: "round", id: comp.rounds[0] });
    const before = await firstSnapshot;
    first.disconnect();

    // while bob is offline the standings change
    const challenge = (await Challenge.findById(comp.challengeIds[0]))!;
    const extra = await newClient(ctx, { email: "late@college.edu", name: "late" });
    await extra.post(`/api/v1/events/${comp.eventId}/register`);
    await insertScoredSubmission({ userId: extra.user._id, eventId: comp.eventId, roundId: comp.rounds[0]!, roundNumber: 1, challengeId: comp.challengeIds[0]!, lineageId: challenge.lineageId, score: 40, at: new Date() });
    const { recomputeRoundResult } = await import("@/modules/leaderboard/round-result.service");
    await recomputeRoundResult(comp.rounds[0]!, extra.user._id);

    const second = open(bob);
    await connected(second);
    const secondSnapshot = next<{ seq: number; total: number; me: { name: string } | null }>(second, "leaderboard:snapshot");
    await ask(second, "subscribe", { channel: "round", id: comp.rounds[0] });
    const after = await secondSnapshot;
    expect(after.total).toBe(before.total + 1);
    expect(after.seq).toBeGreaterThan(before.seq);
  });

  it("broadcasts round phase changes to the event room", async () => {
    const member = open(bob);
    await connected(member);
    await ask(member, "subscribe", { channel: "event", id: comp.eventId });
    const event = next<{ roundNumber: number; phase: string }>(member, "round:updated");
    expect((await admin.post(`/api/v1/admin/rounds/${comp.rounds[0]}/actions`, { action: "pause" })).status).toBe(200);
    expect(await event).toMatchObject({ roundNumber: 1, phase: "paused" });
    const resumed = next<{ phase: string }>(member, "round:updated");
    await admin.post(`/api/v1/admin/rounds/${comp.rounds[0]}/actions`, { action: "resume" });
    expect(await resumed).toMatchObject({ phase: "open" });
  });

  it("shows administrators live activity and nobody else", async () => {
    const adminSocket = open(admin);
    const member = open(alice);
    await Promise.all([connected(adminSocket), connected(member)]);
    await ask(adminSocket, "subscribe", { channel: "admin" });
    const seen: unknown[] = [];
    member.on("admin:activity", (p) => seen.push(p));
    const activity = next<{ kind: string }>(adminSocket, "admin:activity");
    advanceTo(4);
    await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", key());
    expect(await activity).toMatchObject({ kind: "submission" });
    expect(seen).toEqual([]);
  });

  it("closes live connections when the user logs out", async () => {
    const temp = await newClient(ctx);
    const socket = open(temp);
    await connected(socket);
    const closed = new Promise<string>((resolve) => socket.once("disconnect", resolve));
    expect((await temp.post("/api/v1/auth/logout")).status).toBe(204);
    expect(await closed).toBe("io server disconnect");
  });

  it("throttles subscription floods", async () => {
    const noisy = open(bob);
    await connected(noisy);
    const replies = await Promise.all(Array.from({ length: 60 }, () => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1500);
      noisy.emit("subscribe", { channel: "event", id: comp.eventId }, () => {
        clearTimeout(timer);
        resolve(true);
      });
    })));
    expect(replies.filter(Boolean).length).toBeLessThanOrEqual(30);
  });
});
