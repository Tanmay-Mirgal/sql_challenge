import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Challenge } from "@/modules/challenges/challenge.model";
import { EventModel } from "@/modules/events/event.model";
import { recomputeRoundResult } from "@/modules/leaderboard/round-result.service";
import { RoundResult } from "@/modules/leaderboard/round-result.model";
import { Round } from "@/modules/rounds/round.model";
import { Submission } from "@/modules/submissions/submission.model";
import { User } from "@/modules/users/user.model";
import { advanceTo, CORRECT, goLive, insertScoredSubmission, releaseClock, setupPublishedCompetition, T0, useFakeClock } from "./helpers/competition";
import { type TestClient, newClient, startTestContext, stopTestContext, type TestContext } from "./helpers/test-app";

let ctx: TestContext;
let admin: TestClient;

beforeAll(async () => {
  useFakeClock();
  ctx = await startTestContext();
  admin = await newClient(ctx, { role: "admin" });
});
afterAll(async () => {
  releaseClock();
  await stopTestContext(ctx);
});

const key = () => `key-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`;
async function submitAndWait(client: TestClient, challengeId: string, sql: string) {
  const res = await client.post(`/api/v1/challenges/${challengeId}/submit`, { sql }).set("Idempotency-Key", key());
  expect([200, 202], JSON.stringify(res.body)).toContain(res.status);
  for (let i = 0; i < 200; i += 1) {
    const poll = await client.get(`/api/v1/submissions/${res.body.data.submission.id}`);
    if (["completed", "failed"].includes(poll.body.data.submission.status)) return poll.body.data.submission;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("evaluation timed out");
}
const finalize = (roundId: string, body: object = {}) => admin.post(`/api/v1/admin/rounds/${roundId}/finalize`, body);

describe("three-round competition, end to end", () => {
  it("runs registration → Round 1 → qualification → Round 2 → Round 3 → final results", async () => {
    await EventModel.updateMany({}, { status: "finalized" });
    const comp = await setupPublishedCompetition(admin, { topN: [3, 2] });
    const [r1, r2, r3] = comp.rounds as [string, string, string];
    const [c1, c2, c3] = comp.challengeIds as [string, string, string];
    await goLive(admin, comp.eventId);

    // 1. students authenticate and register
    const [p1, p2, p3, p4, p5, p6] = await Promise.all(["ana", "ben", "cy", "dia", "eli", "fay"].map((n) => newClient(ctx, { email: `${n}@college.edu`, name: n })));
    for (const p of [p1!, p2!, p3!, p4!, p5!, p6!]) expect((await p.post(`/api/v1/events/${comp.eventId}/register`)).status).toBe(201);
    expect((await admin.post(`/api/v1/admin/events/${comp.eventId}/transition`, { to: "live" })).status).toBe(200);

    // 2-3. round 1 opens on schedule; the challenge is visible
    advanceTo(0);
    expect((await p1!.get(`/api/v1/rounds/${r1}/challenges`)).body.data.challenges).toHaveLength(1);

    // 4-9. writing, running, submitting, hidden tests, scores
    advanceTo(1);
    expect((await p1!.post(`/api/v1/challenges/${c1}/run`, { sql: CORRECT[1] })).body.data.results[0].status).toBe("passed");
    const s1 = await submitAndWait(p1!, c1, CORRECT[1]); // 100 + 10 − 2 = 108
    advanceTo(30);
    const s2 = await submitAndWait(p2!, c1, CORRECT[1]); // 100 + 10 − min(30, 60) = 80
    advanceTo(10);
    const s3 = await submitAndWait(p3!, c1, "SELECT name FROM students WHERE name IN ('Bilal','Divya') ORDER BY name"); // partial
    advanceTo(5);
    const s4 = await submitAndWait(p4!, c1, "SELECT name FROM students ORDER BY name"); // wrong everywhere
    const s5 = await p5!.post(`/api/v1/challenges/${c1}/submit`, { sql: "SELEC oops" }).set("Idempotency-Key", key()); // rejected
    expect([s1.score, s2.score]).toEqual([108, 80]);
    expect(s3.verdict).toBe("partial");
    expect(s3.score).toBeGreaterThan(0);
    expect(s4).toMatchObject({ verdict: "wrong_answer", score: 0 });
    expect(s5.body.data.submission.verdict).toBe("rejected");

    // 10. the leaderboard reflects the persisted scores (provisional)
    advanceTo(31);
    const live = (await p6!.get(`/api/v1/rounds/${r1}/leaderboard`)).body.data.leaderboard;
    expect(live.entries.map((e: { name: string; score: number }) => [e.name, e.score])).toEqual([["ana", 108], ["ben", 80], ["cy", s3.score], ["dia", 0]]);
    expect(live.entries.every((e: { qualification: string }) => e.qualification === "pending")).toBe(true);

    // provisional rank never unlocks round 2
    const early = await p1!.get(`/api/v1/challenges/${c2}`);
    expect(early.status).toBe(403);
    expect(["ROUND_LOCKED", "ROUND_NOT_OPEN"]).toContain(early.body.error.code);

    // finalization needs a closed round, and does nothing while it is open
    expect((await finalize(r1)).body.error.code).toBe("ROUND_STILL_OPEN");

    // 11. the window ends (server time) and the administrator finalizes
    advanceTo(125);
    const late = await p1!.post(`/api/v1/challenges/${c1}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", key());
    expect(late.body.error.code).toBe("ROUND_CLOSED");
    const fin1 = await finalize(r1);
    expect(fin1.status, JSON.stringify(fin1.body)).toBe(200);
    expect(fin1.body.data.summary).toMatchObject({ participants: 4, qualified: 3, topN: 3, alreadyFinalized: false });
    const again = await finalize(r1);
    expect(again.body.data.summary).toMatchObject({ alreadyFinalized: true, snapshotHash: fin1.body.data.summary.snapshotHash, qualified: 3 });

    // 12-13. the top 3 advance; everyone else stays locked out
    const results1 = await RoundResult.find({ roundId: r1 }).sort({ "qualification.finalRank": 1 });
    expect(results1.map((r) => [String(r.userId) === p1!.user.id ? "ana" : String(r.userId) === p2!.user.id ? "ben" : String(r.userId) === p3!.user.id ? "cy" : "dia", r.qualification.status, r.qualification.finalRank])).toEqual([
      ["ana", "qualified", 1],
      ["ben", "qualified", 2],
      ["cy", "qualified", 3],
      ["dia", "eliminated", 4],
    ]);
    advanceTo(185); // round 2 window
    for (const loser of [p4!, p5!, p6!]) {
      const denied = await loser.get(`/api/v1/challenges/${c2}`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("NOT_QUALIFIED");
      expect((await loser.post(`/api/v1/challenges/${c2}/submit`, { sql: CORRECT[2] }).set("Idempotency-Key", key())).body.error.code).toBe("NOT_QUALIFIED");
    }
    const dash = (await p4!.get("/api/v1/me/dashboard")).body.data.dashboard;
    expect(dash.rounds.map((r: { access: string }) => r.access)).toEqual(["eliminated", "locked", "locked"]);
    expect(dash.rounds[1].lockedReason).toBe("not_qualified");
    const qualifiedDash = (await p1!.get("/api/v1/me/dashboard")).body.data.dashboard;
    expect(qualifiedDash.rounds[0]).toMatchObject({ access: "qualified" });
    expect(qualifiedDash.rounds[1]).toMatchObject({ phase: "open", access: "available" });

    // Round 2: ana and cy answer, ben does not
    advanceTo(190);
    const r2a = await submitAndWait(p1!, c2, CORRECT[2]);
    advanceTo(200);
    const r2c = await submitAndWait(p3!, c2, CORRECT[2]);
    expect([r2a.verdict, r2c.verdict]).toEqual(["accepted", "accepted"]);
    expect(r2a.score).toBeGreaterThan(r2c.score);
    advanceTo(240);
    // administrator closes early and finalizes concurrently from several tabs: exactly one result
    expect((await admin.post(`/api/v1/admin/rounds/${r2}/actions`, { action: "close" })).status).toBe(200);
    const racers = await Promise.all(Array.from({ length: 6 }, () => finalize(r2)));
    const okResponses = racers.filter((r) => r.status === 200);
    expect(okResponses.length).toBeGreaterThanOrEqual(1);
    for (const r of racers) expect([200, 409]).toContain(r.status);
    expect(new Set(okResponses.map((r) => r.body.data.summary.snapshotHash)).size).toBe(1);
    expect(okResponses.filter((r) => r.body.data.summary.alreadyFinalized === false)).toHaveLength(1);
    const resultsR2 = await RoundResult.find({ roundId: r2, "qualification.status": "qualified" }).sort({ "qualification.finalRank": 1 });
    expect(resultsR2.map((r) => String(r.userId))).toEqual([p1!.user.id, p3!.user.id]);

    // ben placed 3rd in round 1 only as a qualifier but skipped round 2 → never reaches round 3
    advanceTo(370); // round 3 window
    expect((await p2!.get(`/api/v1/challenges/${c3}`)).body.error.code).toBe("NOT_QUALIFIED");
    const r3a = await submitAndWait(p1!, c3, CORRECT[3]);
    advanceTo(380);
    const r3c = await submitAndWait(p3!, c3, CORRECT[3]);
    expect([r3a.verdict, r3c.verdict]).toEqual(["accepted", "accepted"]);
    advanceTo(500);
    const fin3 = await finalize(r3);
    expect(fin3.body.data.summary).toMatchObject({ participants: 2, qualified: 0, topN: null });
    expect((await RoundResult.find({ roundId: r3 })).every((r) => r.qualification.status === "finalist")).toBe(true);

    // 15. final results for participants and administrators
    expect((await admin.post(`/api/v1/admin/events/${comp.eventId}/transition`, { to: "finalized" })).status).toBe(200);
    const results = await p4!.get(`/api/v1/events/${comp.eventId}/results`);
    expect(results.status).toBe(200);
    expect(results.body.data.rounds.map((r: { number: number }) => r.number)).toEqual([1, 2, 3]);
    expect(results.body.data.podium.map((e: { name: string }) => e.name)).toEqual(["ana", "cy", "ben"]);
    const mine = (await p1!.get("/api/v1/me/results")).body.data;
    expect(mine.rounds.map((r: { rank: number; qualification: string }) => [r.rank, r.qualification])).toEqual([[1, "qualified"], [1, "qualified"], [1, "finalist"]]);
    expect(mine.rounds.every((r: { finalized: boolean }) => r.finalized)).toBe(true);

    const overall = (await admin.get(`/api/v1/admin/events/${comp.eventId}/leaderboard`)).body.data;
    expect(overall.entries.map((e: { name: string; reachedRound: number }) => [e.name, e.reachedRound]).slice(0, 3)).toEqual([["ana", 3], ["cy", 3], ["ben", 2]]);

    // exports: CSV with formula-injection protection
    await User.updateOne({ _id: p4!.user._id }, { name: '=HYPERLINK("http://evil.example","x")' });
    const csv = await admin.get(`/api/v1/admin/rounds/${r1}/results.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toBe("rank,name,email,roll_number,department,score,challenges_solved,submissions,reached_at,qualification,tie_break");
    expect(csv.text).toContain("1,ana,ana@college.edu");
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect((await admin.get(`/api/v1/admin/events/${comp.eventId}/results.csv`)).text).toContain("overall_rank,name,email");
    expect((await p1!.get(`/api/v1/admin/rounds/${r1}/results.csv`)).status).toBe(403);
  });
});

describe("qualification at scale and at the cut-off", () => {
  it("advances exactly the top 20, resolves the cut-off tie deterministically and freezes the snapshot", async () => {
    await EventModel.updateMany({}, { status: "finalized" });
    advanceTo(0);
    const comp = await setupPublishedCompetition(admin); // default thresholds: 20 / 10
    await goLive(admin, comp.eventId);
    const challenge = (await Challenge.findById(comp.challengeIds[0]))!;
    const users = await Promise.all(Array.from({ length: 30 }, (_, i) => newClient(ctx, { email: `bulk${i}@college.edu`, name: `bulk${i}` })));
    for (const u of users) await u.post(`/api/v1/events/${comp.eventId}/register`);
    expect((await admin.post(`/api/v1/admin/events/${comp.eventId}/transition`, { to: "live" })).status).toBe(200);

    // users 0..18 have distinct high scores; 19 and 20 tie on 100 (19 reached it first); the rest score lower
    const scoreOf = (i: number) => (i < 19 ? 200 - i : i === 19 || i === 20 ? 100 : 90 - i);
    const minuteOf = (i: number) => (i === 19 ? 10 : i === 20 ? 20 : 5);
    for (const [i, u] of users.entries()) {
      await insertScoredSubmission({
        userId: u.user._id,
        eventId: comp.eventId,
        roundId: comp.rounds[0]!,
        roundNumber: 1,
        challengeId: comp.challengeIds[0]!,
        lineageId: challenge.lineageId,
        score: scoreOf(i),
        at: new Date(T0.getTime() + minuteOf(i) * 60_000),
      });
    }
    // a user with a zero score and one with no submissions at all
    advanceTo(125);
    const fin = await finalize(comp.rounds[0]!);
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.data.summary).toMatchObject({ participants: 30, qualified: 20, topN: 20 });
    expect(fin.body.data.summary.cutoff).toMatchObject({ lastQualifiedRank: 20, lastQualifiedScore: 100, decidedBy: "achieved_at" });

    const rows = await RoundResult.find({ roundId: comp.rounds[0]! }).sort({ "qualification.finalRank": 1 });
    expect(rows.filter((r) => r.qualification.status === "qualified")).toHaveLength(20);
    expect(String(rows[19]!.userId)).toBe(users[19]!.user.id); // earlier to 100 points
    expect(rows[19]!.qualification).toMatchObject({ status: "qualified", finalRank: 20, tieBreakApplied: "achieved_at" });
    expect(String(rows[20]!.userId)).toBe(users[20]!.user.id);
    expect(rows[20]!.qualification).toMatchObject({ status: "eliminated", finalRank: 21 });
    expect(new Set(rows.map((r) => r.qualification.finalRank)).size).toBe(30);

    // the 21st-placed participant stays locked out of round 2
    advanceTo(185);
    expect((await users[20]!.get(`/api/v1/challenges/${comp.challengeIds[1]}`)).body.error.code).toBe("NOT_QUALIFIED");
    expect((await users[19]!.get(`/api/v1/challenges/${comp.challengeIds[1]}`)).status).toBe(200);

    // the snapshot is immutable: recomputation and late data cannot change it
    const before = await RoundResult.findOne({ roundId: comp.rounds[0]!, userId: users[20]!.user._id });
    await insertScoredSubmission({ userId: users[20]!.user._id, eventId: comp.eventId, roundId: comp.rounds[0]!, roundNumber: 1, challengeId: comp.challengeIds[0]!, lineageId: challenge.lineageId, score: 500, at: new Date(T0.getTime() + 60_000) });
    await recomputeRoundResult(comp.rounds[0]!, users[20]!.user._id);
    const after = await RoundResult.findOne({ roundId: comp.rounds[0]!, userId: users[20]!.user._id });
    expect(after?.score).toBe(before?.score);
    expect(after?.qualification.status).toBe("eliminated");
    expect((await Round.findById(comp.rounds[0]!))?.finalization.qualified).toBe(20);
    const board = (await users[3]!.get(`/api/v1/rounds/${comp.rounds[0]}/leaderboard?limit=200`)).body.data.leaderboard;
    expect(board.finalized).toBe(true);
    expect(board.entries).toHaveLength(30);
    expect(board.entries.filter((e: { qualification: string }) => e.qualification === "qualified")).toHaveLength(20);
  });

  it("does not finalize while submissions are still being evaluated, unless forced", async () => {
    await EventModel.updateMany({}, { status: "finalized" });
    advanceTo(0);
    const comp = await setupPublishedCompetition(admin, { topN: [3, 2] });
    await goLive(admin, comp.eventId);
    const user = await newClient(ctx);
    await user.post(`/api/v1/events/${comp.eventId}/register`);
    await admin.post(`/api/v1/admin/events/${comp.eventId}/transition`, { to: "live" });
    const challenge = (await Challenge.findById(comp.challengeIds[0]))!;
    await Submission.create({
      userId: user.user._id,
      eventId: comp.eventId,
      roundId: comp.rounds[0],
      roundNumber: 1,
      challengeId: challenge._id,
      lineageId: challenge.lineageId,
      challengeVersion: 1,
      sql: "SELECT 1",
      sqlHash: "h",
      status: "running",
      idempotencyKey: "stuck-submission-key",
      submittedAt: new Date(T0.getTime() + 60_000),
    });
    advanceTo(125);
    const blocked = await finalize(comp.rounds[0]!);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("SUBMISSIONS_PENDING");
    expect((await Round.findById(comp.rounds[0]!))?.finalization.finalizedAt).toBeFalsy();
    const lease = (await Round.findById(comp.rounds[0]!))?.finalization.lockToken;
    expect(lease ?? null).toBeNull(); // a failed attempt releases its lease
  }, 60_000);
});
