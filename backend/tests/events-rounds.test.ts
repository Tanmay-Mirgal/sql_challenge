import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventModel, Registration } from "@/modules/events/event.model";
import { Round } from "@/modules/rounds/round.model";
import { computeRoundPhase } from "@/modules/rounds/round-state";
import { deriveAccess } from "@/modules/rounds/participant-view";
import { setClock } from "@/utils/clock";
import { hoursFromNow, makeStubChallenge, roundsOf } from "./helpers/factories";
import { type TestClient, newClient, startTestContext, stopTestContext, type TestContext } from "./helpers/test-app";

let ctx: TestContext;
let admin: TestClient;

beforeAll(async () => {
  ctx = await startTestContext();
  admin = await newClient(ctx, { role: "admin", email: "root@college.edu" });
});
beforeEach(async () => {
  // Only one event may be active at a time: park everything left over from earlier tests.
  await EventModel.updateMany({}, { status: "finalized" });
});
afterAll(async () => {
  setClock(undefined);
  await stopTestContext();
});

async function createEventViaApi(body: object = {}) {
  const res = await admin.post("/api/v1/admin/events", { name: `Campus SQL Cup ${Math.random().toString(36).slice(2, 7)}`, ...body });
  expect(res.status).toBe(201);
  return res.body.data.event as { id: string; slug: string; status: string; scoring: { version: number } };
}

describe("round phase (pure)", () => {
  const base = { eventStatus: "live" as const, previousRoundFinalized: true, now: new Date("2025-01-01T12:00:00Z") };
  const round = (over: object) => ({
    status: "scheduled" as const,
    startsAt: new Date("2025-01-01T11:00:00Z"),
    endsAt: new Date("2025-01-01T13:00:00Z"),
    finalization: {},
    ...over,
  });

  it("opens inside the window when the event is live and the previous round is finalized", () => {
    expect(computeRoundPhase({ ...base, round: round({}) }).phase).toBe("open");
    expect(computeRoundPhase({ ...base, round: round({ status: "active" }) }).phase).toBe("open");
  });
  it("is upcoming before the start and closed after the end — regardless of persisted status", () => {
    expect(computeRoundPhase({ ...base, now: new Date("2025-01-01T10:59:59Z"), round: round({}) }).phase).toBe("upcoming");
    expect(computeRoundPhase({ ...base, now: new Date("2025-01-01T13:00:00Z"), round: round({ status: "active" }) }).phase).toBe("closed");
  });
  it("blocks a round whose predecessor is not finalized, and non-live events", () => {
    expect(computeRoundPhase({ ...base, previousRoundFinalized: false, round: round({}) })).toEqual({ phase: "upcoming", reason: "awaiting_previous_round" });
    expect(computeRoundPhase({ ...base, eventStatus: "registration", round: round({ status: "active" }) }).phase).toBe("upcoming");
    expect(computeRoundPhase({ ...base, eventStatus: "paused", round: round({ status: "active" }) }).phase).toBe("paused");
  });
  it("reports paused, draft and finalized", () => {
    expect(computeRoundPhase({ ...base, round: round({ status: "paused" }) }).phase).toBe("paused");
    expect(computeRoundPhase({ ...base, round: round({ status: "draft" }) }).phase).toBe("draft");
    expect(computeRoundPhase({ ...base, round: round({ status: "completed", finalization: { finalizedAt: new Date() } }) }).phase).toBe("finalized");
  });
  it("derives participant-facing access states", () => {
    const eligible = { eligible: true };
    expect(deriveAccess({ phase: "open", eligibility: eligible, hasSubmissions: false }).access).toBe("available");
    expect(deriveAccess({ phase: "open", eligibility: eligible, hasSubmissions: true }).access).toBe("in_progress");
    expect(deriveAccess({ phase: "closed", eligibility: eligible, hasSubmissions: true }).access).toBe("submitted");
    expect(deriveAccess({ phase: "finalized", eligibility: eligible, hasSubmissions: true, qualification: "qualified" }).access).toBe("qualified");
    expect(deriveAccess({ phase: "finalized", eligibility: eligible, hasSubmissions: true, qualification: "eliminated" }).access).toBe("eliminated");
    expect(deriveAccess({ phase: "upcoming", eligibility: eligible, hasSubmissions: false }).access).toBe("upcoming");
    expect(deriveAccess({ phase: "open", eligibility: { eligible: false, reason: "not_qualified" }, hasSubmissions: false })).toEqual({ access: "locked", lockedReason: "not_qualified" });
  });
});

describe("event management", () => {
  it("creates an event with three draft rounds and the default qualification thresholds", async () => {
    const event = await createEventViaApi();
    const rounds = await Round.find({ eventId: event.id }).sort({ number: 1 });
    expect(rounds.map((r) => [r.number, r.difficulty, r.status, r.qualification.topN])).toEqual([
      [1, "basic", "draft", 20],
      [2, "intermediate", "draft", 10],
      [3, "advanced", "draft", null],
    ]);
    expect(event.status).toBe("draft");
    expect(event.scoring.version).toBe(1);
  });

  it("is reachable only by administrators", async () => {
    const student = await newClient(ctx);
    expect((await student.post("/api/v1/admin/events", { name: "Nope nope" })).status).toBe(403);
    expect((await student.get("/api/v1/admin/events")).status).toBe(403);
    expect((await student.patch("/api/v1/admin/rounds/000000000000000000000000", {})).status).toBe(403);
  });

  it("validates input strictly", async () => {
    expect((await admin.post("/api/v1/admin/events", { name: "ab" })).status).toBe(400);
    expect((await admin.post("/api/v1/admin/events", { name: "Valid name", rogue: true })).status).toBe(400);
    expect((await admin.post("/api/v1/admin/events", { name: "Valid name", allowedEmailDomains: ["not a domain"] })).status).toBe(400);
    expect((await admin.post("/api/v1/admin/events", { name: "Valid name", startsAt: "2025-02-01", endsAt: "2025-01-01" })).status).toBe(400);
  });

  it("enforces explicit status transitions", async () => {
    const event = await createEventViaApi();
    const go = (to: string) => admin.post(`/api/v1/admin/events/${event.id}/transition`, { to });
    expect((await go("live")).body.error.code).toBe("INVALID_TRANSITION");
    expect((await go("finalized")).body.error.code).toBe("INVALID_TRANSITION");
    expect((await go("registration")).status).toBe(200);
    expect((await go("registration")).body.error.code).toBe("NO_CHANGE");
    // going live needs a scheduled Round 1 with a published challenge
    const notReady = await go("live");
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe("EVENT_NOT_READY");
    expect(notReady.body.error.details.length).toBeGreaterThan(0);
  });

  it("allows only one active event at a time", async () => {
    const first = await createEventViaApi();
    const second = await createEventViaApi();
    expect((await admin.post(`/api/v1/admin/events/${first.id}/transition`, { to: "registration" })).status).toBe(200);
    const clash = await admin.post(`/api/v1/admin/events/${second.id}/transition`, { to: "registration" });
    expect(clash.body.error.code).toBe("ANOTHER_EVENT_ACTIVE");
    await EventModel.updateOne({ _id: first.id }, { status: "draft" });
  });

  it("versions the scoring policy and locks it once the event is live", async () => {
    const event = await createEventViaApi();
    const changed = await admin.patch(`/api/v1/admin/events/${event.id}`, { scoring: { timePenaltyPoints: 3 } });
    expect(changed.body.data.event.scoring.version).toBe(2);
    const same = await admin.patch(`/api/v1/admin/events/${event.id}`, { scoring: { timePenaltyPoints: 3 } });
    expect(same.body.data.event.scoring.version).toBe(2);
    await EventModel.updateOne({ _id: event.id }, { status: "live" });
    const locked = await admin.patch(`/api/v1/admin/events/${event.id}`, { scoring: { timePenaltyPoints: 9 } });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("SCORING_LOCKED");
    expect((await admin.patch(`/api/v1/admin/events/${event.id}`, { rules: "new rules" })).body.error.code).toBe("RULES_LOCKED");
    await EventModel.updateOne({ _id: event.id }, { status: "draft" });
  });

  it("writes audit records for administrative actions", async () => {
    const event = await createEventViaApi();
    await admin.patch(`/api/v1/admin/events/${event.id}`, { description: "x" });
    const logs = await admin.get(`/api/v1/admin/audit-logs?eventId=${event.id}`);
    expect(logs.status).toBe(200);
    expect(logs.body.data.logs.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(["event.create", "event.update"]));
    expect(logs.body.data.logs[0].actor.name).toBeTruthy();
  });
});

describe("registration", () => {
  async function openEvent(body: object = {}) {
    const event = await createEventViaApi(body);
    await EventModel.updateOne({ _id: event.id }, { status: "registration" });
    return event;
  }

  it("lets a participant join once and is idempotent", async () => {
    const event = await openEvent();
    const student = await newClient(ctx);
    const a = await student.post(`/api/v1/events/${event.id}/register`);
    const b = await student.post(`/api/v1/events/${event.id}/register`);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await Registration.countDocuments({ eventId: event.id })).toBe(1);
    expect((await EventModel.findById(event.id))?.registeredCount).toBe(1);
    await EventModel.updateOne({ _id: event.id }, { status: "draft" });
  });

  it("refuses registration for draft events, unqualified domains and incomplete profiles", async () => {
    const draft = await createEventViaApi();
    const student = await newClient(ctx);
    expect((await student.post(`/api/v1/events/${draft.id}/register`)).body.error.code).toBe("REGISTRATION_CLOSED");

    const restricted = await openEvent({ allowedEmailDomains: ["college.edu"], profileRequirements: { rollNumber: true } });
    const outsider = await newClient(ctx, { email: "x@gmail.com" });
    expect((await outsider.post(`/api/v1/events/${restricted.id}/register`)).body.error.code).toBe("DOMAIN_NOT_ALLOWED");
    const noRoll = await newClient(ctx, { email: "n@college.edu" });
    await noRoll.user.updateOne({ rollNumber: null });
    const incomplete = await noRoll.post(`/api/v1/events/${restricted.id}/register`);
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.details.missing).toEqual(["rollNumber"]);
    await EventModel.updateMany({ _id: { $in: [restricted.id] } }, { status: "draft" });
  });

  it("never exceeds the participant limit, even under concurrent sign-ups", async () => {
    const event = await openEvent({ maxParticipants: 3 });
    const clients = await Promise.all(Array.from({ length: 8 }, () => newClient(ctx)));
    const results = await Promise.all(clients.map((c) => c.post(`/api/v1/events/${event.id}/register`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.body.error?.code === "EVENT_FULL")).toHaveLength(5);
    expect(await Registration.countDocuments({ eventId: event.id })).toBe(3);
    expect((await EventModel.findById(event.id))?.registeredCount).toBe(3);
    await EventModel.updateOne({ _id: event.id }, { status: "draft" });
  });
});

describe("dashboard and round access derived from the backend", () => {
  it("walks a participant through locked → upcoming/available states", async () => {
    const event = await createEventViaApi();
    const [r1, r2, r3] = await roundsOf((await EventModel.findById(event.id))!);
    const eventDoc = (await EventModel.findById(event.id))!;
    await makeStubChallenge(eventDoc, r1!, admin.user);
    await Round.updateOne({ _id: r1!._id }, { status: "scheduled", startsAt: hoursFromNow(1), endsAt: hoursFromNow(2) });
    const draftBlocked = await admin.post(`/api/v1/admin/events/${event.id}/transition`, { to: "registration" });
    expect(draftBlocked.status).toBe(200);

    const student = await newClient(ctx);
    expect((await student.post(`/api/v1/events/${event.id}/register`)).status).toBe(201);

    let dash = (await student.get("/api/v1/me/dashboard")).body.data.dashboard;
    expect(dash.event.status).toBe("registration");
    expect(dash.registration.status).toBe("registered");
    expect(dash.rounds.map((r: { access: string }) => r.access)).toEqual(["upcoming", "locked", "locked"]);
    expect(dash.rounds[0].countdown.kind).toBe("starts");
    expect(dash.rounds[1].lockedReason).toBe("not_published");
    expect(dash.rounds[2].qualification.topN).toBeNull();

    // go live and open Round 1
    expect((await admin.post(`/api/v1/admin/events/${event.id}/transition`, { to: "live" })).status).toBe(200);
    const early = await admin.post(`/api/v1/admin/rounds/${r1!.id}/actions`, { action: "open" });
    expect(early.status).toBe(200);
    expect(early.body.data.round.phase).toBe("open");

    dash = (await student.get("/api/v1/me/dashboard")).body.data.dashboard;
    expect(dash.rounds[0]).toMatchObject({ access: "available", phase: "open", challengeCount: 1 });
    expect(dash.rounds[0].countdown.kind).toBe("ends");
    expect(dash.currentRoundNumber).toBe(1);

    // a non-registered user is locked out of every round
    const stranger = await newClient(ctx);
    const strangerDash = (await stranger.get("/api/v1/me/dashboard")).body.data.dashboard;
    expect(strangerDash.rounds.map((r: { lockedReason: string }) => r.lockedReason)).toEqual(["not_registered", "not_published", "not_published"]);
    expect(strangerDash.registration).toBeNull();

    const status = await student.get(`/api/v1/rounds/${r2!.id}/status`);
    expect(status.body.data.round.access).toBe("locked");
    void r3;
    await EventModel.updateOne({ _id: event.id }, { status: "finalized" });
  });

  it("controls round lifecycle with validated actions", async () => {
    const event = await createEventViaApi();
    await EventModel.updateOne({ _id: event.id }, { status: "live" });
    const eventDoc = (await EventModel.findById(event.id))!;
    const [r1, r2] = await roundsOf(eventDoc);
    const act = (id: string, action: string, extra: object = {}) => admin.post(`/api/v1/admin/rounds/${id}/actions`, { action, ...extra });

    expect((await act(r1!.id, "schedule")).body.error.code).toBe("ROUND_NOT_READY");
    expect((await admin.patch(`/api/v1/admin/rounds/${r1!.id}`, { startsAt: hoursFromNow(2), endsAt: hoursFromNow(1) })).body.error.code).toBe("INVALID_WINDOW");
    expect((await admin.patch(`/api/v1/admin/rounds/${r1!.id}`, { startsAt: hoursFromNow(-1), endsAt: hoursFromNow(1) })).status).toBe(200);
    expect((await act(r1!.id, "schedule")).status).toBe(200);
    expect((await act(r1!.id, "open")).body.error.code).toBe("NO_PUBLISHED_CHALLENGES");
    await makeStubChallenge(eventDoc, r1!, admin.user);
    const opened = await act(r1!.id, "open");
    expect(opened.body.data.round).toMatchObject({ status: "active", phase: "open" });

    expect((await act(r1!.id, "resume")).body.error.code).toBe("INVALID_TRANSITION");
    expect((await act(r1!.id, "pause")).body.data.round.phase).toBe("paused");
    expect((await act(r1!.id, "pause")).body.error.code).toBe("INVALID_TRANSITION");
    const before = (await Round.findById(r1!.id))!.endsAt!.getTime();
    setClock(() => new Date(Date.now() + 10 * 60_000));
    const resumed = await act(r1!.id, "resume");
    setClock(undefined);
    expect(resumed.body.data.round.phase).toBe("open");
    const after = (await Round.findById(r1!.id))!;
    expect(after.endsAt!.getTime() - before).toBeGreaterThan(9 * 60_000);
    expect(after.pausedMs).toBeGreaterThan(9 * 60_000);

    // thresholds are locked once running; deadline can only move into the future
    expect((await admin.patch(`/api/v1/admin/rounds/${r1!.id}`, { qualification: { topN: 5 } })).body.error.code).toBe("ROUND_LOCKED");
    expect((await admin.patch(`/api/v1/admin/rounds/${r1!.id}`, { endsAt: hoursFromNow(-1) })).body.error.code).toBe("INVALID_WINDOW");

    // Round 2 cannot open while Round 1 is not finalized
    await makeStubChallenge(eventDoc, r2!, admin.user);
    await admin.patch(`/api/v1/admin/rounds/${r2!.id}`, { startsAt: hoursFromNow(3), endsAt: hoursFromNow(4) });
    await act(r2!.id, "schedule");
    expect((await act(r2!.id, "open")).body.error.code).toBe("PREVIOUS_ROUND_NOT_FINALIZED");

    expect((await act(r1!.id, "close")).body.data.round.phase).toBe("closed");
    expect((await act(r1!.id, "close")).body.error.code).toBe("INVALID_TRANSITION");
    expect((await admin.patch(`/api/v1/admin/rounds/${r1!.id}`, { name: "Renamed" })).body.error.code).toBe("ROUND_LOCKED");
    await EventModel.updateOne({ _id: event.id }, { status: "finalized" });
  });

  it("compensates a running round when the whole event is paused and resumed", async () => {
    const event = await createEventViaApi();
    await EventModel.updateOne({ _id: event.id }, { status: "live" });
    const eventDoc = (await EventModel.findById(event.id))!;
    const [r1] = await roundsOf(eventDoc);
    await makeStubChallenge(eventDoc, r1!, admin.user);
    await Round.updateOne({ _id: r1!._id }, { status: "active", startsAt: hoursFromNow(-1), endsAt: hoursFromNow(1) });
    const originalEnd = hoursFromNow(1).getTime();

    expect((await admin.post(`/api/v1/admin/events/${event.id}/transition`, { to: "paused" })).status).toBe(200);
    const paused = await admin.get(`/api/v1/admin/events/${event.id}/rounds`);
    expect(paused.body.data.rounds[0].phase).toBe("paused");

    setClock(() => new Date(Date.now() + 20 * 60_000));
    expect((await admin.post(`/api/v1/admin/events/${event.id}/transition`, { to: "live" })).status).toBe(200);
    setClock(undefined);
    const round = (await Round.findById(r1!._id))!;
    expect(round.pausedMs).toBeGreaterThan(19 * 60_000);
    expect(round.endsAt!.getTime() - originalEnd).toBeGreaterThan(19 * 60_000);
    await EventModel.updateOne({ _id: event.id }, { status: "finalized" });
  });
});
