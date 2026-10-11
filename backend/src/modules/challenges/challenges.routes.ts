import { Router } from "express";
import { z } from "zod";
import type { Container } from "@/container";
import { requireAuth } from "@/middleware/auth";
import { createLimiter } from "@/middleware/rate-limit";
import { Submission } from "@/modules/submissions/submission.model";
import {
  remainingAttempts,
  runAgainstSamples,
  submissionsForChallenge,
  submitSolution,
  toSubmissionDto,
} from "@/modules/submissions/submissions.service";
import { checkEligibility } from "@/modules/rounds/eligibility";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { Errors } from "@/utils/errors";
import { accepted, ok } from "@/utils/http";
import { authorizeChallenge } from "./challenge-access";
import { toParticipantChallengeDto } from "./challenge.dto";
import { Challenge } from "./challenge.model";

const runSchema = z.strictObject({ sql: z.string() });
const submitSchema = z.strictObject({ sql: z.string() });
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export function createChallengesRouter(container: Container): Router {
  const { config, sql } = container;
  const router = Router();
  router.use(requireAuth);

  const runLimiter = createLimiter({ windowMs: 60_000, limit: config.rateLimits.runPerMinute, perUser: true, message: "You are running queries too quickly. Wait a few seconds." });
  const submitLimiter = createLimiter({ windowMs: 60_000, limit: config.rateLimits.submitPerMinute, perUser: true, message: "You are submitting too quickly. Wait a few seconds." });

  router.get("/:challengeId", async (req, res) => {
    const { challenge, ctx } = await authorizeChallenge(req.auth!.user, String(req.params.challengeId), "view");
    const attemptsLeft = await remainingAttempts(req.auth!.user._id, challenge, ctx.round.submissionLimit.perChallenge);
    ok(res, {
      challenge: toParticipantChallengeDto(challenge, ctx.event, sql.limits),
      round: {
        id: ctx.round.id as string,
        number: ctx.round.number,
        name: ctx.round.name,
        phase: ctx.phase.phase,
        startsAt: ctx.round.startsAt ?? null,
        endsAt: ctx.round.endsAt ?? null,
      },
      canSubmit: ctx.phase.phase === "open",
      attempts: { limit: ctx.round.submissionLimit.perChallenge, remaining: attemptsLeft },
      serverTime: ctx.now,
    });
  });

  router.get("/:challengeId/schema", async (req, res) => {
    const { challenge, ctx } = await authorizeChallenge(req.auth!.user, String(req.params.challengeId), "view");
    ok(res, { schema: toParticipantChallengeDto(challenge, ctx.event, sql.limits).schema });
  });

  router.get("/:challengeId/samples", async (req, res) => {
    const { challenge, ctx } = await authorizeChallenge(req.auth!.user, String(req.params.challengeId), "view");
    ok(res, { samples: toParticipantChallengeDto(challenge, ctx.event, sql.limits).samples });
  });

  router.post("/:challengeId/run", runLimiter, async (req, res) => {
    const { sql: query } = runSchema.parse(req.body);
    const { challenge } = await authorizeChallenge(req.auth!.user, String(req.params.challengeId), "run");
    ok(res, await runAgainstSamples(req.auth!.user, challenge, sql, query));
  });

  router.post("/:challengeId/submit", submitLimiter, async (req, res) => {
    const { sql: query } = submitSchema.parse(req.body);
    const key = req.header("idempotency-key");
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw Errors.badRequest("An Idempotency-Key header (8–100 URL-safe characters) is required for submissions.", undefined, "IDEMPOTENCY_KEY_REQUIRED");
    }
    const { challenge, ctx } = await authorizeChallenge(req.auth!.user, String(req.params.challengeId), "submit");
    const { submission, replay } = await submitSolution({
      user: req.auth!.user,
      challenge,
      ctx,
      sqlText: query,
      idempotencyKey: key,
      sql,
      maxQueryLength: config.sql.maxQueryLength,
    });
    if (replay) res.setHeader("Idempotent-Replay", "true");
    const done = submission.status === "completed" || submission.status === "failed";
    const body = { submission: toSubmissionDto(submission, { includeSql: true }), replay };
    if (done) ok(res, body);
    else accepted(res, body);
  });

  router.get("/:challengeId/submissions", async (req, res) => {
    const { challenge } = await authorizeChallenge(req.auth!.user, String(req.params.challengeId), "view");
    const submissions = await submissionsForChallenge(req.auth!.user._id, challenge.lineageId);
    ok(res, { submissions: submissions.map((submission) => toSubmissionDto(submission, { includeSql: true })) });
  });

  return router;
}

/** `GET /rounds/:roundId/challenges` — what the participant can open in a round, with their progress. */
export function createRoundChallengesHandler() {
  return async (req: import("express").Request, res: import("express").Response) => {
    const user = req.auth!.user;
    const ctx = await loadRoundContext(String(req.params.roundId));
    if (ctx.event.status === "draft") throw Errors.notFound("Round not found.", "ROUND_NOT_FOUND");
    const eligibility = await checkEligibility(user, ctx);
    if (!eligibility.eligible) {
      const code = { not_registered: "NOT_REGISTERED", disqualified: "DISQUALIFIED", previous_round_pending: "ROUND_LOCKED", not_qualified: "NOT_QUALIFIED", account_disabled: "ACCOUNT_DISABLED" }[eligibility.reason ?? "not_registered"];
      throw Errors.forbidden("You cannot access this round.", code);
    }
    const { phase } = ctx.phase;
    if (phase === "draft" || phase === "upcoming") throw Errors.forbidden("This round has not started yet.", "ROUND_NOT_OPEN");

    const challenges = await Challenge.find({ roundId: ctx.round._id, status: "published" }).sort({ order: 1 });
    const mine = await Submission.aggregate<{ _id: unknown; best: number; used: number; accepted: number }>([
      { $match: { userId: user._id, roundId: ctx.round._id, status: "completed" } },
      {
        $group: {
          _id: "$lineageId",
          best: { $max: "$score" },
          used: { $sum: { $cond: ["$counted", 1, 0] } },
          accepted: { $sum: { $cond: [{ $eq: ["$verdict", "accepted"] }, 1, 0] } },
        },
      },
    ]);
    const byLineage = new Map(mine.map((row) => [String(row._id), row]));
    ok(res, {
      round: {
        id: ctx.round.id as string,
        number: ctx.round.number,
        name: ctx.round.name,
        storyChapter: ctx.round.storyChapter,
        phase,
        startsAt: ctx.round.startsAt ?? null,
        endsAt: ctx.round.endsAt ?? null,
        submissionLimit: ctx.round.submissionLimit.perChallenge,
      },
      serverTime: ctx.now,
      challenges: challenges.map((challenge) => {
        const progress = byLineage.get(String(challenge.lineageId));
        return {
          id: challenge.id as string,
          order: challenge.order,
          title: challenge.title,
          difficulty: challenge.difficulty,
          concepts: challenge.concepts,
          maxScore: challenge.maxScore ?? ctx.event.scoring.maxScorePerChallenge,
          bestScore: progress?.best ?? 0,
          attemptsUsed: progress?.used ?? 0,
          solved: (progress?.accepted ?? 0) > 0,
        };
      }),
    });
  };
}
