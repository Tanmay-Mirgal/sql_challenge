import { Types } from "mongoose";
import { Challenge, type ChallengeDocument } from "@/modules/challenges/challenge.model";
import { effectiveMaxScore } from "@/modules/challenges/challenge.dto";
import { activeTests } from "@/modules/challenges/challenge.service";
import { getStanding } from "@/modules/leaderboard/leaderboard.service";
import { recomputeRoundResult } from "@/modules/leaderboard/round-result.service";
import { loadRoundContext, type RoundContext } from "@/modules/rounds/round-context";
import { computeScore, isFullyCorrect } from "@/modules/scoring/scoring";
import { QueueRejectedError } from "@/queues/job-queue";
import { SqlEngineUnavailableError, type SqlExecutionService } from "@/modules/sql-execution/service";
import type { SqlErrorCategory } from "@/modules/sql-execution/types";
import type { UserDocument } from "@/modules/users/user.model";
import { realtime } from "@/sockets/realtime";
import { now } from "@/utils/clock";
import { sha256Hex } from "@/utils/crypto";
import { Errors } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { runTests, type TestRun } from "./test-runner";
import { Submission, type SubmissionDocument, type SubmissionTestResult, type Verdict } from "./submission.model";

const GENERIC_MESSAGES: Record<SqlErrorCategory, string> = {
  SQL_SYNTAX_ERROR: "Your query has a syntax error.",
  QUERY_TIMEOUT: "Your query took too long to run and was stopped.",
  INVALID_QUERY: "Your query uses something that isn’t permitted in this challenge.",
  RESOURCE_LIMIT_EXCEEDED: "Your query used too many resources.",
  EXECUTION_ERROR: "Your query failed while running.",
  INTERNAL_ERROR: "The SQL engine had a problem. Your submission was not counted against you.",
};

function assertEngine(sql: SqlExecutionService): void {
  if (!sql.canExecute) {
    throw Errors.unavailable("The SQL execution engine is not available right now. Please try again shortly.", "SQL_ENGINE_UNAVAILABLE");
  }
}

function translateQueueError(error: unknown): never {
  if (error instanceof QueueRejectedError) {
    throw Errors.tooManyRequests(error.message, error.reason === "user_backlog" ? "TOO_MANY_PENDING" : "ENGINE_BUSY");
  }
  if (error instanceof SqlEngineUnavailableError) {
    throw Errors.unavailable("The SQL execution engine is not available right now. Please try again shortly.", "SQL_ENGINE_UNAVAILABLE");
  }
  throw error;
}

// ---------------------------------------------------------------------------------------------
// Run (public samples only; never persisted, never scored)
// ---------------------------------------------------------------------------------------------

export async function runAgainstSamples(user: UserDocument, challenge: ChallengeDocument, sql: SqlExecutionService, query: unknown) {
  assertEngine(sql);
  const tables = challenge.schemaSpec.tables.map((table) => table.name);
  const checked = await sql.validate(query, tables);
  if (!checked.ok) {
    return { status: "rejected" as const, error: { category: checked.category, message: checked.message, line: checked.line ?? null, column: checked.column ?? null }, results: [], durationMs: 0 };
  }
  const tests = (await activeTests(challenge._id)).filter((test) => test.visibility === "public");
  const started = Date.now();
  try {
    const { runs } = await sql.schedule(String(user._id), (ctx) => runTests(sql, ctx, challenge, tests, query as string));
    const results = runs.map((run) => {
      const sample = challenge.publicSamples.find((s) => s.id === run.test.sampleId);
      return {
        sampleId: run.test.sampleId,
        name: sample?.name ?? run.test.label,
        status: run.passed ? ("passed" as const) : run.failure ? ("error" as const) : ("failed" as const),
        durationMs: run.durationMs,
        message: run.detail ?? null,
        error: run.failure ? { category: run.failure.category, message: run.failure.message, line: run.failure.line ?? null, column: run.failure.column ?? null } : null,
        actual: run.preview ?? null,
        expected: sample?.expectedOutput ?? null,
      };
    });
    return { status: "completed" as const, results, error: null, durationMs: Date.now() - started };
  } catch (error) {
    return translateQueueError(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------------------------

export interface SubmitParams {
  user: UserDocument;
  challenge: ChallengeDocument;
  ctx: RoundContext;
  sqlText: unknown;
  idempotencyKey: string;
  sql: SqlExecutionService;
  maxQueryLength: number;
}

export async function submitSolution(params: SubmitParams): Promise<{ submission: SubmissionDocument; replay: boolean }> {
  const { user, challenge, ctx, idempotencyKey, sql } = params;
  if (typeof params.sqlText !== "string") throw Errors.badRequest("`sql` must be a string.", undefined, "INVALID_QUERY");
  const sqlText = params.sqlText;
  const sqlHash = sha256Hex(sqlText);

  // 1. Idempotency: a repeated request returns the original submission and never scores twice.
  const existing = await Submission.findOne({ userId: user._id, idempotencyKey });
  if (existing) return { submission: assertSameRequest(existing, challenge, sqlHash), replay: true };

  // 2. Per-challenge attempt limit (counted submissions only).
  const limit = ctx.round.submissionLimit.perChallenge;
  const used = await Submission.countDocuments({ userId: user._id, lineageId: challenge.lineageId, counted: true });
  if (used >= limit) throw Errors.tooManyRequests(`You have used all ${limit} submissions for this challenge.`, "SUBMISSION_LIMIT_REACHED");

  assertEngine(sql);
  const tables = challenge.schemaSpec.tables.map((table) => table.name);
  const checked = await sql.validate(sqlText, tables);
  const submittedAt = now();
  const startsAt = ctx.round.startsAt?.getTime() ?? submittedAt.getTime();
  const elapsedMs = Math.max(0, submittedAt.getTime() - startsAt - ctx.round.pausedMs);
  const base = {
    userId: user._id,
    eventId: challenge.eventId,
    roundId: challenge.roundId,
    roundNumber: challenge.roundNumber,
    challengeId: challenge._id,
    lineageId: challenge.lineageId,
    challengeVersion: challenge.version,
    sql: sqlText.slice(0, params.maxQueryLength * 2),
    sqlHash,
    idempotencyKey,
    submittedAt,
    elapsedMs,
  };

  // 3a. Invalid / unsupported SQL is rejected immediately, stored for history, and does not use an attempt.
  if (!checked.ok) {
    const submission = await createOrReplay(() =>
      Submission.create({
        ...base,
        status: "completed",
        verdict: "rejected" satisfies Verdict,
        counted: false,
        score: 0,
        errorCategory: checked.category,
        errorMessage: checked.message,
        evaluatedAt: submittedAt,
      }),
      user,
      idempotencyKey,
      challenge,
      sqlHash,
    );
    return submission;
  }

  if (!sql.canAdmit(String(user._id))) {
    throw Errors.tooManyRequests("You already have submissions waiting to be evaluated. Let them finish first.", "TOO_MANY_PENDING");
  }

  // 3b. Queue for authoritative evaluation.
  const result = await createOrReplay(
    () => Submission.create({ ...base, status: "queued", counted: true, score: 0 }),
    user,
    idempotencyKey,
    challenge,
    sqlHash,
  );
  if (result.replay) return result;

  // Re-check the limit after insert so concurrent requests cannot overshoot it.
  const total = await Submission.countDocuments({ userId: user._id, lineageId: challenge.lineageId, counted: true });
  if (total > limit) {
    await Submission.deleteOne({ _id: result.submission._id });
    throw Errors.tooManyRequests(`You have used all ${limit} submissions for this challenge.`, "SUBMISSION_LIMIT_REACHED");
  }

  const submissionId = result.submission._id;
  void evaluateSubmission(submissionId, sql).catch((error: unknown) => {
    logger.error({ err: error, submissionId: String(submissionId) }, "submission evaluation crashed");
  });
  realtime.submissionUpdated(String(user._id), toSocketPayload(result.submission));
  return result;
}

function assertSameRequest(existing: SubmissionDocument, challenge: ChallengeDocument, sqlHash: string): SubmissionDocument {
  if (!existing.challengeId.equals(challenge._id) || existing.sqlHash !== sqlHash) {
    throw Errors.conflict("This Idempotency-Key was already used for a different submission.", "IDEMPOTENCY_KEY_REUSED");
  }
  return existing;
}

async function createOrReplay(
  create: () => Promise<SubmissionDocument>,
  user: UserDocument,
  idempotencyKey: string,
  challenge: ChallengeDocument,
  sqlHash: string,
): Promise<{ submission: SubmissionDocument; replay: boolean }> {
  try {
    return { submission: await create(), replay: false };
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existing = await Submission.findOne({ userId: user._id, idempotencyKey });
      if (existing) return { submission: assertSameRequest(existing, challenge, sqlHash), replay: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluate (authoritative: hidden tests → score → ranking)
// ---------------------------------------------------------------------------------------------

export async function evaluateSubmission(submissionId: Types.ObjectId | string, sql: SqlExecutionService): Promise<void> {
  // Claim the job atomically; a duplicate worker finds nothing to claim.
  const submission = await Submission.findOneAndUpdate({ _id: submissionId, status: "queued" }, { $set: { status: "running" } }, { returnDocument: "after" });
  if (!submission) return;
  realtime.submissionUpdated(String(submission.userId), toSocketPayload(submission));

  const challenge = await Challenge.findById(submission.challengeId);
  if (!challenge) return failSystem(submission, "The challenge no longer exists.");
  const ctx = await loadRoundContext(String(submission.roundId));
  const tests = await activeTests(challenge._id);
  if (tests.length === 0) return failSystem(submission, "The challenge has no test cases.");

  let runs: TestRun[];
  try {
    ({ runs } = await sql.schedule(String(submission.userId), (job) => runTests(sql, job, challenge, tests, submission.sql)));
  } catch (error) {
    const reason = error instanceof QueueRejectedError || error instanceof SqlEngineUnavailableError ? error.message : "Evaluation failed unexpectedly.";
    logger.error({ err: error, submissionId: String(submission._id) }, "evaluation could not run");
    return failSystem(submission, reason);
  }

  // Infrastructure faults are never held against the participant.
  const infraFault = runs.some((run) => run.failure?.category === "INTERNAL_ERROR");
  if (infraFault) return failSystem(submission, GENERIC_MESSAGES.INTERNAL_ERROR);

  const scored = runs.map((run) => ({ weight: run.test.weight, mandatory: run.test.mandatory, passed: run.passed }));
  const breakdown = computeScore({
    policy: ctx.event.toObject().scoring,
    maxScore: effectiveMaxScore(challenge, ctx.event),
    tests: scored,
    elapsedSeconds: submission.elapsedMs / 1000,
  });

  const testResults: SubmissionTestResult[] = runs.map((run) => ({
    label: run.test.label,
    visibility: run.test.visibility,
    passed: run.passed,
    durationMs: run.durationMs,
    errorCategory: run.failure?.category ?? null,
    detail: run.test.visibility === "public" ? (run.detail ?? null) : null,
  }));

  const passedTests = runs.filter((run) => run.passed).length;
  let verdict: Verdict;
  if (isFullyCorrect(scored)) verdict = "accepted";
  else if (breakdown.passedWeight > 0) verdict = "partial";
  else if (runs.every((run) => run.failure)) verdict = "error";
  else verdict = "wrong_answer";

  const firstFailure = runs.find((run) => run.failure && run.test.visibility === "public") ?? runs.find((run) => run.failure);
  const errorCategory = verdict === "error" ? (firstFailure?.failure?.category ?? "EXECUTION_ERROR") : null;
  const errorMessage =
    verdict === "error" ? (firstFailure?.test.visibility === "public" ? firstFailure.failure?.message : GENERIC_MESSAGES[errorCategory!]) : null;

  // Only write if nobody else completed it meanwhile (e.g. crash recovery re-ran the job).
  const done = await Submission.findOneAndUpdate(
    { _id: submission._id, status: "running" },
    {
      $set: {
        status: "completed",
        verdict,
        passedTests,
        totalTests: runs.length,
        score: breakdown.finalScore,
        scoreBreakdown: breakdown,
        testResults,
        executionMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
        errorCategory,
        errorMessage,
        evaluatedAt: now(),
      },
    },
    { returnDocument: "after" },
  );
  if (!done) return;

  await afterScored(done, ctx);
}

async function afterScored(submission: SubmissionDocument, ctx: RoundContext): Promise<void> {
  try {
    await recomputeRoundResult(submission.roundId, submission.userId);
  } catch (error) {
    logger.error({ err: error, submissionId: String(submission._id) }, "failed to update round result");
  }
  const userId = String(submission.userId);
  realtime.submissionUpdated(userId, toSocketPayload(submission));
  realtime.leaderboardChanged(String(submission.roundId));
  try {
    const standing = await getStanding(ctx.round, ctx.event, userId);
    realtime.participantUpdated(userId, {
      roundId: String(submission.roundId),
      roundNumber: submission.roundNumber,
      reason: "result",
      rank: standing?.rank ?? null,
      score: standing?.row.score ?? 0,
    });
  } catch {
    /* best effort */
  }
  realtime.adminActivity({
    kind: "submission",
    at: now().toISOString(),
    detail: { submissionId: String(submission._id), roundNumber: submission.roundNumber, verdict: submission.verdict, score: submission.score },
  });
}

async function failSystem(submission: SubmissionDocument, message: string): Promise<void> {
  const failed = await Submission.findOneAndUpdate(
    { _id: submission._id, status: { $in: ["queued", "running"] } },
    { $set: { status: "failed", verdict: "system_error", counted: false, errorCategory: "INTERNAL_ERROR", errorMessage: message, evaluatedAt: now(), score: 0 } },
    { returnDocument: "after" },
  );
  if (failed) {
    realtime.submissionUpdated(String(failed.userId), toSocketPayload(failed));
    realtime.leaderboardChanged(String(failed.roundId));
  }
}

/** Startup recovery: jobs that were queued/running when the process stopped are re-evaluated. */
export async function recoverPendingSubmissions(sql: SqlExecutionService): Promise<number> {
  const stuck = await Submission.find({ status: { $in: ["queued", "running"] } }).select("_id status");
  for (const submission of stuck) {
    if (submission.status === "running") await Submission.updateOne({ _id: submission._id, status: "running" }, { $set: { status: "queued" } });
    void evaluateSubmission(submission._id, sql).catch((error: unknown) => logger.error({ err: error }, "recovery evaluation failed"));
  }
  return stuck.length;
}

export function toSocketPayload(submission: SubmissionDocument) {
  return {
    submissionId: submission.id as string,
    challengeId: String(submission.challengeId),
    roundId: String(submission.roundId),
    status: submission.status,
    verdict: submission.verdict ?? null,
    score: submission.score,
    passedTests: submission.passedTests,
    totalTests: submission.totalTests,
  };
}

// ---------------------------------------------------------------------------------------------
// DTOs and history
// ---------------------------------------------------------------------------------------------

export function toSubmissionDto(submission: SubmissionDocument, options: { includeSql?: boolean } = {}) {
  return {
    id: submission.id as string,
    challengeId: String(submission.challengeId),
    roundId: String(submission.roundId),
    roundNumber: submission.roundNumber,
    challengeVersion: submission.challengeVersion,
    status: submission.status,
    verdict: submission.verdict ?? null,
    passedTests: submission.passedTests,
    totalTests: submission.totalTests,
    score: submission.score,
    scoreBreakdown: submission.scoreBreakdown ?? null,
    testResults: submission.testResults.map((result) => ({
      label: result.label,
      visibility: result.visibility,
      passed: result.passed,
      durationMs: result.durationMs,
      errorCategory: result.errorCategory ?? null,
      detail: result.visibility === "public" ? (result.detail ?? null) : null,
    })),
    executionMs: submission.executionMs,
    errorCategory: submission.errorCategory ?? null,
    errorMessage: submission.errorMessage ?? null,
    counted: submission.counted,
    submittedAt: submission.submittedAt,
    evaluatedAt: submission.evaluatedAt ?? null,
    ...(options.includeSql ? { sql: submission.sql } : {}),
  };
}

export async function submissionsForChallenge(userId: Types.ObjectId | string, lineageId: Types.ObjectId | string, limit = 50) {
  return Submission.find({ userId, lineageId }).sort({ submittedAt: -1 }).limit(limit);
}

export async function remainingAttempts(userId: Types.ObjectId | string, challenge: ChallengeDocument, perChallenge: number): Promise<number> {
  const used = await Submission.countDocuments({ userId, lineageId: challenge.lineageId, counted: true });
  return Math.max(0, perChallenge - used);
}

