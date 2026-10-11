import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Challenge, TestCase } from "@/modules/challenges/challenge.model";
import { buildMutants } from "@/modules/challenges/challenge-validation";
import { Round } from "@/modules/rounds/round.model";
import { Submission } from "@/modules/submissions/submission.model";
import { advanceTo, CORRECT, goLive, releaseClock, round1Content, round2Content, setupPublishedCompetition, T0, useFakeClock, variant } from "./helpers/competition";
import { collegeSchema, sampleRows } from "./helpers/sample-data";
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

async function newRound1() {
  const draftEvent = await admin.post("/api/v1/admin/events", { name: `Authoring ${Math.random().toString(36).slice(2, 8)}` });
  const eventId = draftEvent.body.data.event.id as string;
  const rounds = await Round.find({ eventId }).sort({ number: 1 });
  return { eventId, rounds };
}

describe("challenge authoring and validation pipeline", () => {
  it("derives expected outputs by executing the reference solution — never from the author's claim", async () => {
    const { rounds } = await newRound1();
    const content = round1Content();
    content.publicSamples[0]!.expectedOutput = { columns: ["name"], rows: [["Totally", "wrong"]] };
    const res = await admin.post(`/api/v1/admin/rounds/${rounds[0]!.id}/challenges`, content);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const detail = await admin.get(`/api/v1/admin/challenges/${res.body.data.challenge.id}`);
    const challenge = detail.body.data.challenge;
    expect(challenge.samples[0].expectedOutput).toEqual({ columns: ["name"], rows: [["Bilal"], ["Divya"]] });
    expect(challenge.validation).toMatchObject({ status: "passed", upToDate: true });
    expect(challenge.tests.map((t: { label: string; visibility: string }) => [t.label, t.visibility])).toEqual([
      ["Sample test 1", "public"],
      ["Hidden test 1", "hidden"],
      ["Hidden test 2", "hidden"],
      ["Hidden test 3", "hidden"],
    ]);
    const warnings: string[] = res.body.data.report.warnings;
    expect(warnings.join(" ")).toMatch(/author's expected output for sample 1 differs/);
    const strength = res.body.data.report.checks.find((c: { name: string }) => c.name === "test_strength");
    expect(strength.passed).toBe(true);
  });

  it("rejects bad content with a precise report and stores nothing", async () => {
    const { rounds } = await newRound1();
    const before = await Challenge.countDocuments({ roundId: rounds[0]!.id });
    const post = (content: object) => admin.post(`/api/v1/admin/rounds/${rounds[0]!.id}/challenges`, content);
    const failedChecks = (res: { body: { error: { details: { checks: Array<{ name: string; passed: boolean; message: string }> } } } }) =>
      res.body.error.details.checks.filter((c) => !c.passed).map((c) => c.name);

    // reference solution that errors
    let res = await post({ ...round1Content(), solutionSql: "SELECT nope FROM students" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CHALLENGE_INVALID");
    expect(failedChecks(res)).toContain("solution_runs");

    // mutating statement as a "solution"
    res = await post({ ...round1Content(), solutionSql: "DELETE FROM students" });
    expect(failedChecks(res)).toContain("solution_static");

    // fixture integrity: orphan foreign key
    const bad = round1Content();
    bad.candidateTestCases[0]!.rows = variant({ students: [[1, "Orphan", 99, null, 30, null, null]] });
    res = await post(bad);
    expect(failedChecks(res)).toContain("fixture_integrity");
    expect(JSON.stringify(res.body.error.details.checks)).toContain("has no matching departments.id");

    // hard-codable: every hidden dataset equals the sample
    const lazy = round1Content();
    lazy.candidateTestCases = [0, 1, 2].map(() => ({ category: "normal" as const, description: "", rows: sampleRows, weight: 1, mandatory: true }));
    res = await post(lazy);
    expect(failedChecks(res)).toContain("hidden_differs_from_sample");

    // ordered output declared but the solution has no ORDER BY
    res = await post({ ...round1Content(), solutionSql: "SELECT name FROM students WHERE age >= 21" });
    expect(failedChecks(res)).toContain("ordering_declared");

    // solution leaked in the visible text
    res = await post({ ...round1Content(), hints: ["Try: SELECT name FROM students WHERE age >= 21 ORDER BY name;"] });
    expect(failedChecks(res)).toContain("no_solution_leak");

    // too weak: datasets cannot tell the solution from plausible wrong answers
    const weak = { ...round1Content(), solutionSql: "SELECT name FROM students WHERE age >= 21 AND age < 100 ORDER BY name" };
    weak.publicSamples[0]!.rows = variant({ students: [[1, "Solo", 1, null, 30, null, null]], registrations: [] });
    weak.candidateTestCases = [
      { category: "normal", description: "", rows: variant({ students: [[1, "A", 1, null, 40, null, null], [2, "B", 1, null, 50, null, null]], registrations: [] }), weight: 1, mandatory: true },
      { category: "normal", description: "", rows: variant({ students: [[1, "C", 1, null, 60, null, null]], registrations: [] }), weight: 1, mandatory: true },
      { category: "normal", description: "", rows: variant({ students: [[1, "D", 1, null, 70, null, null]], registrations: [] }), weight: 1, mandatory: true },
    ];
    res = await post(weak);
    expect(failedChecks(res)).toContain("test_strength");

    // wrong round difficulty
    res = await post({ ...round2Content() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DIFFICULTY_MISMATCH");

    // malformed (schema) input
    res = await post({ ...round1Content(), schema: { tables: [{ name: "User", columns: [] }] } });
    expect(res.status).toBe(400);
    res = await post({ ...round1Content(), unexpected: true, title: "x" });
    expect(res.status).toBe(400);

    expect(await Challenge.countDocuments({ roundId: rounds[0]!.id })).toBe(before);
  });

  it("requires validation, locks published content and versions changes", async () => {
    const { eventId, rounds } = await newRound1();
    const created = await admin.post(`/api/v1/admin/rounds/${rounds[0]!.id}/challenges`, round1Content());
    const id = created.body.data.challenge.id as string;

    // text edits keep the validation valid
    const edited = await admin.patch(`/api/v1/admin/challenges/${id}`, { title: "A better title" });
    expect(edited.status).toBe(200);
    expect(edited.body.data.challenge.validation.upToDate).toBe(true);
    expect((await admin.patch(`/api/v1/admin/challenges/${id}`, { solutionSql: "x" })).status).toBe(400);

    // content replacement re-runs the pipeline
    const replaced = await admin.put(`/api/v1/admin/challenges/${id}/content`, { ...round1Content(), solutionSql: "SELECT name FROM students WHERE age > 21 ORDER BY name" });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect((await Challenge.findById(id))?.contentHash).not.toBe(created.body.data.challenge.contentHash);

    await admin.patch(`/api/v1/admin/rounds/${rounds[0]!.id}`, { startsAt: new Date(T0.getTime() + 3_600_000), endsAt: new Date(T0.getTime() + 7_200_000) });
    const published = await admin.post(`/api/v1/admin/challenges/${id}/publish`);
    expect(published.status).toBe(200);
    expect((await Round.findById(rounds[0]!.id))?.publishedChallengeIds.map(String)).toEqual([id]);

    // immutable once published
    expect((await admin.patch(`/api/v1/admin/challenges/${id}`, { title: "Sneaky" })).body.error.code).toBe("CHALLENGE_IMMUTABLE");
    expect((await admin.put(`/api/v1/admin/challenges/${id}/content`, round1Content())).body.error.code).toBe("CHALLENGE_IMMUTABLE");

    // new version: same lineage, publish swaps it in while the round has not started
    const v2 = await admin.post(`/api/v1/admin/challenges/${id}/new-version`);
    expect(v2.status).toBe(201);
    expect(v2.body.data.challenge).toMatchObject({ version: 2, status: "draft" });
    expect((await admin.post(`/api/v1/admin/challenges/${id}/new-version`)).body.error.code).toBe("DRAFT_EXISTS");
    await admin.patch(`/api/v1/admin/challenges/${v2.body.data.challenge.id}`, { title: "Second edition" });
    expect((await admin.post(`/api/v1/admin/challenges/${v2.body.data.challenge.id}/publish`)).status).toBe(200);
    expect((await Challenge.findById(id))?.status).toBe("archived");
    expect((await Round.findById(rounds[0]!.id))?.publishedChallengeIds.map(String)).toEqual([v2.body.data.challenge.id]);
    expect(await Challenge.countDocuments({ lineageId: created.body.data.challenge.lineageId, status: "published" })).toBe(1);

    // once the round is running, the set of challenges is frozen
    const draftRound = await Round.findById(rounds[0]!.id);
    expect(draftRound).toBeTruthy();
    void eventId;
  });

  it("freezes publishing after the round has started", async () => {
    const comp = await setupPublishedCompetition(admin, { topN: [5, 3] });
    await goLive(admin, comp.eventId);
    expect((await admin.post(`/api/v1/admin/events/${comp.eventId}/transition`, { to: "live" })).status).toBe(200);
    advanceTo(1);
    const draft = await admin.post(`/api/v1/admin/challenges/${comp.challengeIds[0]}/new-version`);
    const publish = await admin.post(`/api/v1/admin/challenges/${draft.body.data.challenge.id}/publish`);
    expect(publish.status).toBe(409);
    expect(publish.body.error.code).toBe("ROUND_ALREADY_STARTED");
    const extra = await admin.post(`/api/v1/admin/rounds/${comp.rounds[0]}/challenges`, round1Content());
    expect(extra.status).toBe(201);
    expect((await admin.post(`/api/v1/admin/challenges/${extra.body.data.challenge.id}/publish`)).body.error.code).toBe("ROUND_ALREADY_STARTED");
    advanceTo(0);
    await Round.updateMany({ eventId: comp.eventId }, { status: "completed" });
  });

  it("manufactures plausible wrong answers to measure test strength", () => {
    const names = buildMutants(
      "SELECT d.name, COUNT(*) FROM students s INNER JOIN departments d ON d.id = s.dept_id WHERE s.age >= 21 AND s.gpa > 3 GROUP BY d.name HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 3",
      true,
    ).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining([">= → >", "AND → OR", "INNER JOIN → LEFT JOIN", "HAVING threshold +1", "LIMIT +1", "DESC → ASC"]));
    // no JOIN mutation for already-outer joins
    expect(buildMutants("SELECT * FROM a LEFT JOIN b ON a.id = b.id", false).map((m) => m.name)).not.toContain("INNER JOIN → LEFT JOIN");
  });
});

describe("participant access, Run and Submit", () => {
  let comp: Awaited<ReturnType<typeof setupPublishedCompetition>>;
  let alice: TestClient;
  let bob: TestClient;
  let outsider: TestClient;

  beforeAll(async () => {
    await (await import("@/modules/events/event.model")).EventModel.updateMany({}, { status: "finalized" });
    comp = await setupPublishedCompetition(admin, { topN: [5, 3] });
    await goLive(admin, comp.eventId);
    alice = await newClient(ctx, { email: "alice@college.edu" });
    bob = await newClient(ctx, { email: "bob@college.edu" });
    outsider = await newClient(ctx, { email: "outsider@college.edu" });
    for (const c of [alice, bob]) expect((await c.post(`/api/v1/events/${comp.eventId}/register`)).status).toBe(201);
    expect((await admin.post(`/api/v1/admin/events/${comp.eventId}/transition`, { to: "live" })).status).toBe(200);
  });

  const key = () => `key-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`;
  const poll = async (client: TestClient, submissionId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const res = await client.get(`/api/v1/submissions/${submissionId}`);
      if (res.body.data.submission.status === "completed" || res.body.data.submission.status === "failed") return res.body.data.submission;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("submission did not finish");
  };

  it("keeps challenges invisible until the round opens, and only for eligible participants", async () => {
    advanceTo(-10); // before the window
    const before = await alice.get(`/api/v1/challenges/${comp.challengeIds[0]}`);
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe("ROUND_NOT_OPEN");
    expect((await alice.get(`/api/v1/rounds/${comp.rounds[0]}/challenges`)).body.error.code).toBe("ROUND_NOT_OPEN");

    advanceTo(1);
    const res = await alice.get(`/api/v1/challenges/${comp.challengeIds[0]}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.canSubmit).toBe(true);
    expect((await outsider.get(`/api/v1/challenges/${comp.challengeIds[0]}`)).body.error.code).toBe("NOT_REGISTERED");

    // later rounds are locked, even by direct id
    for (const later of [comp.challengeIds[1], comp.challengeIds[2]]) {
      const locked = await alice.get(`/api/v1/challenges/${later}`);
      expect(locked.status).toBe(403);
      expect(["ROUND_LOCKED", "ROUND_NOT_OPEN"]).toContain(locked.body.error.code);
    }
    expect((await alice.post(`/api/v1/challenges/${comp.challengeIds[1]}/submit`, { sql: CORRECT[2] }).set("Idempotency-Key", key())).status).toBe(403);
    expect((await alice.post(`/api/v1/challenges/${comp.challengeIds[1]}/run`, { sql: CORRECT[2] })).status).toBe(403);
    expect((await alice.get(`/api/v1/rounds/${comp.rounds[1]}/challenges`)).status).toBe(403);
  });

  it("never exposes solutions, hidden fixtures or expected hidden outputs", async () => {
    const res = await alice.get(`/api/v1/challenges/${comp.challengeIds[0]}`);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/solutionSql|candidateTestCases|Hidden test|explanation|"expected"|private/i);
    expect(text).not.toContain("ORDER BY name"); // the reference solution
    for (const hidden of ["Mira", "Noor", "Omar", "Quin", "Tara", "Uma"]) expect(text).not.toContain(hidden); // hidden fixture rows
    expect(text).not.toMatch(/Sam/);
    const challenge = res.body.data.challenge;
    expect(challenge.samples[0].rows.students).toHaveLength(5);
    expect(challenge.samples[0].expectedOutput.rows).toEqual([["Bilal"], ["Divya"]]);
    expect(challenge.schema.tables.map((t: { name: string }) => t.name)).toEqual(["departments", "students", "events", "registrations"]);
    for (const path of ["schema", "samples"]) expect((await alice.get(`/api/v1/challenges/${comp.challengeIds[0]}/${path}`)).status).toBe(200);
    const list = await alice.get(`/api/v1/rounds/${comp.rounds[0]}/challenges`);
    expect(JSON.stringify(list.body)).not.toMatch(/solutionSql|Hidden test/);
    expect(list.body.data.challenges).toHaveLength(1);
    // drafts and archived versions do not exist for participants
    const draft = await admin.post(`/api/v1/admin/challenges/${comp.challengeIds[0]}/new-version`);
    expect((await alice.get(`/api/v1/challenges/${draft.body.data.challenge.id}`)).status).toBe(404);
  });

  it("Run executes against the public sample only and compares with the expected output", async () => {
    advanceTo(2);
    const ok = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: CORRECT[1] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("completed");
    expect(ok.body.data.results).toHaveLength(1);
    expect(ok.body.data.results[0]).toMatchObject({ status: "passed", actual: { columns: ["name"], rows: [["Bilal"], ["Divya"]] } });
    expect(await Submission.countDocuments({ userId: alice.user._id })).toBe(0); // runs are never persisted or scored

    const wrong = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: "SELECT name FROM students" });
    expect(wrong.body.data.results[0]).toMatchObject({ status: "failed", message: "Expected 2 rows but your query returned 5." });

    const syntax = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: "SELEC name FROM students" });
    expect(syntax.body.data).toMatchObject({ status: "rejected", error: { category: "SQL_SYNTAX_ERROR", line: 1, column: 1 } });
    const mutation = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: "DELETE FROM students" });
    expect(mutation.body.data).toMatchObject({ status: "rejected", error: { category: "INVALID_QUERY" } });
    const runtime = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: "SELECT salary FROM students" });
    expect(runtime.body.data.results[0]).toMatchObject({ status: "error", error: { category: "EXECUTION_ERROR" } });
    const timeout = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r) SELECT COUNT(*) FROM r" });
    expect(timeout.body.data.results[0]).toMatchObject({ status: "error", error: { category: "QUERY_TIMEOUT" } });
    expect((await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { nope: 1 })).status).toBe(400);
  });

  it("Submit runs the hidden tests and scores on the server clock", async () => {
    advanceTo(5);
    const res = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", key());
    expect(res.status).toBe(202);
    const done = await poll(alice, res.body.data.submission.id);
    // 4 tests all pass: base 100 + bonus 10 − floor(300s/60s)*2 = 100
    expect(done).toMatchObject({ status: "completed", verdict: "accepted", passedTests: 4, totalTests: 4, score: 100 });
    expect(done.scoreBreakdown).toMatchObject({ baseScore: 100, fullCorrectnessBonus: 10, timePenalty: 10, elapsedSeconds: 300, finalScore: 100, scoringVersion: 1 });
    expect(done.testResults.map((t: { label: string; passed: boolean }) => [t.label, t.passed])).toEqual([["Sample test 1", true], ["Hidden test 1", true], ["Hidden test 2", true], ["Hidden test 3", true]]);
    // hidden tests reveal only pass/fail — never data or explanations
    expect(done.testResults.filter((t: { visibility: string }) => t.visibility === "hidden").every((t: { detail: unknown }) => t.detail === null)).toBe(true);

    // the client cannot influence score or time
    const forged = await alice
      .post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1], score: 9999 })
      .set("Idempotency-Key", key());
    expect(forged.status).toBe(400);
  });

  it("gives partial credit when the query only works for the visible sample", async () => {
    advanceTo(10);
    const hardcoded = "SELECT name FROM students WHERE name IN ('Bilal', 'Divya') ORDER BY name";
    const res = await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: hardcoded }).set("Idempotency-Key", key());
    const done = await poll(bob, res.body.data.submission.id);
    expect(done.verdict).toBe("partial");
    expect(done.testResults[0]).toMatchObject({ label: "Sample test 1", passed: true });
    expect(done.passedTests).toBeLessThan(4);
    expect(done.scoreBreakdown.fullCorrectnessBonus).toBe(0);
    expect(done.score).toBeGreaterThan(0);
    expect(done.score).toBeLessThan(60);
  });

  it("reports query errors without charging an attempt for rejected SQL", async () => {
    advanceTo(11);
    const usedBefore = await Submission.countDocuments({ userId: bob.user._id, counted: true });
    const syntax = await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: "SELEC 1" }).set("Idempotency-Key", key());
    expect(syntax.status).toBe(200);
    expect(syntax.body.data.submission).toMatchObject({ status: "completed", verdict: "rejected", errorCategory: "SQL_SYNTAX_ERROR", score: 0, counted: false });
    const mutation = await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: "DROP TABLE students" }).set("Idempotency-Key", key());
    expect(mutation.body.data.submission).toMatchObject({ verdict: "rejected", errorCategory: "INVALID_QUERY" });
    const runtimeError = await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: "SELECT salary FROM students" }).set("Idempotency-Key", key());
    const done = await poll(bob, runtimeError.body.data.submission.id);
    expect(done).toMatchObject({ verdict: "error", score: 0, errorCategory: "EXECUTION_ERROR" });
    expect(done.errorMessage).toContain('column "salary" does not exist');
    expect(await Submission.countDocuments({ userId: bob.user._id, counted: true })).toBe(usedBefore + 1);
  });

  it("is idempotent: repeated requests never score twice", async () => {
    advanceTo(12);
    const k = key();
    const first = await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", k);
    const replays = await Promise.all(Array.from({ length: 4 }, () => bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", k)));
    expect(new Set([first.body.data.submission.id, ...replays.map((r) => r.body.data.submission.id)]).size).toBe(1);
    expect(replays.every((r) => r.headers["idempotent-replay"] === "true" || r.status === 202 || r.status === 200)).toBe(true);
    await poll(bob, first.body.data.submission.id);
    expect(await Submission.countDocuments({ userId: bob.user._id, idempotencyKey: k })).toBe(1);
    const reuse = await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: "SELECT 1 AS x" }).set("Idempotency-Key", k);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] })).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", "short")).status).toBe(400);
  });

  it("keeps the best score per challenge and never lowers it", async () => {
    advanceTo(20);
    const worse = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: "SELECT name FROM students WHERE name = 'Divya'" }).set("Idempotency-Key", key());
    await poll(alice, worse.body.data.submission.id);
    const board = await alice.get(`/api/v1/rounds/${comp.rounds[0]}/leaderboard`);
    expect(board.status).toBe(200);
    const mine = board.body.data.leaderboard.me;
    expect(mine).toMatchObject({ score: 100, challengesSolved: 1 });
    expect(board.body.data.leaderboard.entries[0].participantId).toBe(alice.user.publicId);
    const boardText = JSON.stringify(board.body);
    expect(boardText).not.toMatch(/@college\.edu|googleSub|emailNormalized/);
    expect(boardText).not.toContain(alice.user.id); // internal user ids never appear on the board
    expect(board.body.data.leaderboard.cutoff).toEqual({ topN: 5, minScore: 1 });
  });

  it("enforces the per-challenge submission limit", async () => {
    await Round.updateOne({ _id: comp.rounds[0] }, { "submissionLimit.perChallenge": 3 });
    advanceTo(25);
    const carol = await newClient(ctx, { email: "carol@college.edu" });
    expect((await carol.post(`/api/v1/events/${comp.eventId}/register`)).status).toBe(201);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await carol.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: `SELECT name FROM students WHERE age > ${i}` }).set("Idempotency-Key", key());
      results.push(res);
      if (res.status === 202) await poll(carol, res.body.data.submission.id);
    }
    expect(results.slice(0, 3).map((r) => r.status)).toEqual([202, 202, 202]);
    expect(results[3]!.status).toBe(429);
    expect(results[3]!.body.error.code).toBe("SUBMISSION_LIMIT_REACHED");
    await Round.updateOne({ _id: comp.rounds[0] }, { "submissionLimit.perChallenge": 50 });
  });

  it("restores submission history, including the submitted SQL", async () => {
    const history = await alice.get(`/api/v1/challenges/${comp.challengeIds[0]}/submissions`);
    expect(history.body.data.submissions.length).toBeGreaterThanOrEqual(2);
    expect(history.body.data.submissions[0].sql).toBeTypeOf("string");
    const mine = await alice.get(`/api/v1/me/submissions?challengeId=${comp.challengeIds[0]}`);
    expect(mine.body.meta.total).toBe(history.body.data.submissions.length);
    // other people's submissions are not readable
    const someone = history.body.data.submissions[0].id as string;
    expect((await bob.get(`/api/v1/submissions/${someone}`)).status).toBe(404);
    expect((await admin.get(`/api/v1/submissions/${someone}`)).status).toBe(200);
  });

  it("rejects submissions the instant the round closes (server time), pause included", async () => {
    advanceTo(30);
    expect((await admin.post(`/api/v1/admin/rounds/${comp.rounds[0]}/actions`, { action: "pause" })).status).toBe(200);
    const paused = await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", key());
    expect(paused.status).toBe(409);
    expect(paused.body.error.code).toBe("ROUND_PAUSED");
    expect((await alice.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: CORRECT[1] })).body.error.code).toBe("ROUND_PAUSED");
    expect((await admin.post(`/api/v1/admin/rounds/${comp.rounds[0]}/actions`, { action: "resume" })).status).toBe(200);

    advanceTo(119);
    expect((await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/run`, { sql: CORRECT[1] })).status).toBe(200);
    advanceTo(121); // past endsAt (extended by the 0ms the fake clock paused for)
    const late = await bob.post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`, { sql: CORRECT[1] }).set("Idempotency-Key", key());
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("ROUND_CLOSED");
    expect((await bob.get(`/api/v1/challenges/${comp.challengeIds[0]}`)).body.data.canSubmit).toBe(false); // still viewable, read-only
  });

  it("degrades safely when the SQL engine is unavailable", async () => {
    advanceTo(60);
    await Round.updateOne({ _id: comp.rounds[0] }, { endsAt: new Date(T0.getTime() + 4 * 3_600_000) });
    const down = { ...ctx.container, sql: (await import("@/modules/sql-execution/service")).SqlExecutionService.create({ ...ctx.config.sql, executorUrl: null, setupUrl: null }) };
    const { createApp } = await import("@/app");
    const request = (await import("supertest")).default;
    const app = createApp(down);
    const res = await request(app)
      .post(`/api/v1/challenges/${comp.challengeIds[0]}/submit`)
      .set("Cookie", alice.sessionCookie)
      .set("X-CSRF-Token", alice.csrfToken)
      .set("Idempotency-Key", key())
      .send({ sql: CORRECT[1] });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SQL_ENGINE_UNAVAILABLE");
    const run = await request(app).post(`/api/v1/challenges/${comp.challengeIds[0]}/run`).set("Cookie", alice.sessionCookie).set("X-CSRF-Token", alice.csrfToken).send({ sql: CORRECT[1] });
    expect(run.status).toBe(503);
    expect(await Submission.countDocuments({ idempotencyKey: res.body.data?.submission?.idempotencyKey ?? "none" })).toBe(0);
  });

  it("keeps hidden tests out of every participant response (defence check on stored data)", async () => {
    const hidden = await TestCase.countDocuments({ challengeId: comp.challengeIds[0], visibility: "hidden" });
    expect(hidden).toBe(3);
    expect(collegeSchema.tables.length).toBe(4);
  });
});
