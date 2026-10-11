import { Router } from "express";
import { z } from "zod";
import type { Container } from "@/container";
import { createLimiter } from "@/middleware/rate-limit";
import { GenerationRun } from "@/modules/ai-generation/generation-run.model";
import { requestGeneration, toRunDto } from "@/modules/ai-generation/generation.service";
import { toAdminChallengeDto } from "@/modules/challenges/challenge.dto";
import { TestCase } from "@/modules/challenges/challenge.model";
import { challengeContentSchema, textPatchSchema } from "@/modules/challenges/challenge.schema";
import {
  archiveChallenge,
  ChallengeValidationError,
  createDraftChallenge,
  createNewVersion,
  getChallengeOrThrow,
  listRoundChallenges,
  patchChallengeText,
  publishChallenge,
  replaceDraftContent,
  revalidateChallenge,
} from "@/modules/challenges/challenge.service";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { Submission, VERDICTS } from "@/modules/submissions/submission.model";
import { runTests } from "@/modules/submissions/test-runner";
import { User } from "@/modules/users/user.model";
import { Errors } from "@/utils/errors";
import { accepted, created, objectIdParam, ok, paginate, paginationMeta, paginationQuery } from "@/utils/http";
import { recordAudit } from "./audit.service";

export function createAdminChallengesRouter(container: Container): Router {
  const { sql, llm, config } = container;
  const router = Router();
  const generationLimiter = createLimiter({
    windowMs: 3_600_000,
    limit: config.rateLimits.generationPerHour,
    perUser: true,
    message: "Too many generation requests this hour.",
  });

  const audit = (req: import("express").Request, action: string, targetId: string, eventId: unknown, metadata?: Record<string, unknown>) =>
    recordAudit({
      actorId: req.auth!.user.id,
      action,
      targetType: "challenge",
      targetId,
      eventId: eventId as never,
      metadata,
      requestId: String(req.id),
    });

  const failValidation = (error: ChallengeValidationError): never => {
    throw Errors.unprocessable("The challenge did not pass validation.", "CHALLENGE_INVALID", error.outcome.report);
  };

  // ---- system status (admin dashboard header) --------------------------------------------------
  router.get("/system/status", async (_req, res) => {
    ok(res, {
      sql: await sql.health(),
      ai: { configured: llm.configured, model: llm.configured ? llm.model : null },
      google: { configured: container.google.isConfigured, missing: container.google.missingConfig },
      generationInFlight: await GenerationRun.countDocuments({ status: { $in: ["queued", "running"] } }),
    });
  });

  // ---- listing -------------------------------------------------------------------------------
  router.get("/rounds/:roundId/challenges", async (req, res) => {
    const ctx = await loadRoundContext(String(req.params.roundId));
    const challenges = await listRoundChallenges(ctx.round.id as string);
    ok(res, { challenges: challenges.map((challenge) => toAdminChallengeDto(challenge)) });
  });

  router.get("/challenges/:challengeId", async (req, res) => {
    const challenge = await getChallengeOrThrow(String(req.params.challengeId), { withPrivate: true });
    const tests = await TestCase.find({ challengeId: challenge._id }).sort({ order: 1 });
    ok(res, { challenge: toAdminChallengeDto(challenge, tests, { includePrivate: true }) });
  });

  // ---- authoring -----------------------------------------------------------------------------
  /** Manual authoring goes through exactly the same validation pipeline as AI drafts. */
  router.post("/rounds/:roundId/challenges", async (req, res) => {
    const content = challengeContentSchema.parse(req.body);
    const ctx = await loadRoundContext(String(req.params.roundId));
    try {
      const { challenge, outcome } = await createDraftChallenge({
        event: ctx.event,
        round: ctx.round,
        actor: req.auth!.user,
        content,
        sql,
        generation: { source: "manual" },
      });
      await audit(req, "challenge.create", challenge.id as string, ctx.event._id, { source: "manual" });
      created(res, { challenge: toAdminChallengeDto(challenge), report: outcome.report });
    } catch (error) {
      if (error instanceof ChallengeValidationError) failValidation(error);
      throw error;
    }
  });

  router.patch("/challenges/:challengeId", async (req, res) => {
    const patch = textPatchSchema.parse(req.body);
    const challenge = await patchChallengeText(String(req.params.challengeId), patch);
    await audit(req, "challenge.update", challenge.id as string, challenge.eventId, { fields: Object.keys(patch) });
    ok(res, { challenge: toAdminChallengeDto(challenge) });
  });

  router.put("/challenges/:challengeId/content", async (req, res) => {
    const content = challengeContentSchema.parse(req.body);
    try {
      const { challenge, outcome } = await replaceDraftContent(String(req.params.challengeId), content, sql);
      await audit(req, "challenge.replace_content", challenge.id as string, challenge.eventId);
      ok(res, { challenge: toAdminChallengeDto(challenge), report: outcome.report });
    } catch (error) {
      if (error instanceof ChallengeValidationError) failValidation(error);
      throw error;
    }
  });

  router.post("/challenges/:challengeId/validate", async (req, res) => {
    const { challenge, outcome } = await revalidateChallenge(String(req.params.challengeId), sql);
    await audit(req, "challenge.validate", challenge.id as string, challenge.eventId, { ok: outcome.ok });
    ok(res, { challenge: toAdminChallengeDto(challenge), report: outcome.report, ok: outcome.ok });
  });

  router.post("/challenges/:challengeId/publish", async (req, res) => {
    const challenge = await publishChallenge(String(req.params.challengeId), req.auth!.user);
    await audit(req, "challenge.publish", challenge.id as string, challenge.eventId, { version: challenge.version });
    ok(res, { challenge: toAdminChallengeDto(challenge) });
  });

  router.post("/challenges/:challengeId/archive", async (req, res) => {
    const challenge = await archiveChallenge(String(req.params.challengeId));
    await audit(req, "challenge.archive", challenge.id as string, challenge.eventId);
    ok(res, { challenge: toAdminChallengeDto(challenge) });
  });

  router.post("/challenges/:challengeId/new-version", async (req, res) => {
    const challenge = await createNewVersion(String(req.params.challengeId), req.auth!.user);
    await audit(req, "challenge.new_version", challenge.id as string, challenge.eventId, { version: challenge.version });
    created(res, { challenge: toAdminChallengeDto(challenge) });
  });

  /** Runs an arbitrary SELECT against every test of the challenge and shows expected vs actual (admin only). */
  router.post("/challenges/:challengeId/test-run", async (req, res) => {
    const { sql: query } = z.strictObject({ sql: z.string().min(1).max(config.sql.maxQueryLength) }).parse(req.body);
    const challenge = await getChallengeOrThrow(String(req.params.challengeId));
    if (!sql.canExecute) throw Errors.unavailable("The SQL engine is not available.", "SQL_ENGINE_UNAVAILABLE");
    const tests = await TestCase.find({ challengeId: challenge._id }).sort({ order: 1 });
    const checked = await sql.validate(query, challenge.schemaSpec.tables.map((table) => table.name));
    if (!checked.ok) return ok(res, { valid: false, error: { category: checked.category, message: checked.message }, results: [] });
    const { runs } = await sql.schedule(`admin:${req.auth!.user.id}`, (ctx) => runTests(sql, ctx, challenge, tests, query));
    ok(res, {
      valid: true,
      results: runs.map((run) => ({
        label: run.test.label,
        visibility: run.test.visibility,
        passed: run.passed,
        executed: run.executed,
        durationMs: run.durationMs,
        error: run.failure ? { category: run.failure.category, message: run.failure.message } : null,
        detail: run.comparison && !run.passed ? run.comparison.reason : null,
        expected: run.test.expected,
      })),
    });
  });

  // ---- generation ----------------------------------------------------------------------------
  router.post("/rounds/:roundId/generate", generationLimiter, async (req, res) => {
    const { guidance } = z.strictObject({ guidance: z.string().trim().max(1500).optional() }).parse(req.body);
    const ctx = await loadRoundContext(String(req.params.roundId));
    if (ctx.phase.phase !== "draft" && ctx.phase.phase !== "upcoming") {
      throw Errors.conflict("Challenges can only be added before the round starts.", "ROUND_ALREADY_STARTED");
    }
    const run = await requestGeneration({
      event: ctx.event,
      round: ctx.round,
      actor: req.auth!.user,
      guidance: guidance ?? "",
      deps: { llm, sql, groq: config.groq },
    });
    await recordAudit({ actorId: req.auth!.user.id, action: "challenge.generate", targetType: "round", targetId: ctx.round.id, eventId: ctx.event._id, metadata: { runId: run.id }, requestId: String(req.id) });
    accepted(res, { run: toRunDto(run) });
  });

  router.get("/rounds/:roundId/generation-runs", async (req, res) => {
    const ctx = await loadRoundContext(String(req.params.roundId));
    const runs = await GenerationRun.find({ roundId: ctx.round._id }).sort({ createdAt: -1 }).limit(20);
    ok(res, { runs: runs.map(toRunDto) });
  });

  router.get("/generation-runs/:runId", async (req, res) => {
    const run = await GenerationRun.findById(objectIdParam.parse(req.params.runId));
    if (!run) throw Errors.notFound("Generation run not found.", "RUN_NOT_FOUND");
    ok(res, { run: toRunDto(run) });
  });

  // ---- submission monitoring -----------------------------------------------------------------
  router.get("/rounds/:roundId/submissions-summary", async (req, res) => {
    const ctx = await loadRoundContext(String(req.params.roundId));
    const [byVerdict, byStatus, pending] = await Promise.all([
      Submission.aggregate<{ _id: string | null; count: number }>([{ $match: { roundId: ctx.round._id } }, { $group: { _id: "$verdict", count: { $sum: 1 } } }]),
      Submission.aggregate<{ _id: string; count: number }>([{ $match: { roundId: ctx.round._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      Submission.countDocuments({ roundId: ctx.round._id, status: { $in: ["queued", "running"] } }),
    ]);
    const participants = await Submission.distinct("userId", { roundId: ctx.round._id });
    ok(res, {
      total: byStatus.reduce((sum, row) => sum + row.count, 0),
      pending,
      participants: participants.length,
      byVerdict: Object.fromEntries(byVerdict.map((row) => [row._id ?? "pending", row.count])),
      byStatus: Object.fromEntries(byStatus.map((row) => [row._id, row.count])),
    });
  });

  const failuresQuery = paginationQuery.extend({ verdict: z.enum(VERDICTS).optional() });
  router.get("/rounds/:roundId/submissions", async (req, res) => {
    const ctx = await loadRoundContext(String(req.params.roundId));
    const query = failuresQuery.parse(req.query);
    const filter: Record<string, unknown> = { roundId: ctx.round._id };
    filter.verdict = query.verdict ?? { $in: ["system_error", "error", "rejected"] };
    const { skip, limit } = paginate(query);
    const [rows, total] = await Promise.all([
      Submission.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(limit),
      Submission.countDocuments(filter),
    ]);
    const users = await User.find({ _id: { $in: rows.map((row) => row.userId) } }).select("name email").lean<Array<{ _id: unknown; name: string; email: string }>>();
    const byId = new Map(users.map((user) => [String(user._id), user]));
    ok(
      res,
      {
        submissions: rows.map((row) => ({
          id: row.id as string,
          participant: byId.get(String(row.userId))?.name ?? "—",
          email: byId.get(String(row.userId))?.email ?? "—",
          challengeId: String(row.challengeId),
          status: row.status,
          verdict: row.verdict ?? null,
          errorCategory: row.errorCategory ?? null,
          errorMessage: row.errorMessage ?? null,
          score: row.score,
          submittedAt: row.submittedAt,
        })),
      },
      paginationMeta(query, total),
    );
  });

  return router;
}
