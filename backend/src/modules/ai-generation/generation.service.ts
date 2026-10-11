import type { Types } from "mongoose";
import type { AppConfig } from "@/config";
import { Challenge } from "@/modules/challenges/challenge.model";
import { ChallengeValidationError, createDraftChallenge } from "@/modules/challenges/challenge.service";
import { challengeContentSchema, KNOWN_CONTENT_KEYS } from "@/modules/challenges/challenge.schema";
import { EventModel, type EventDocument } from "@/modules/events/event.model";
import { Round, type RoundDocument } from "@/modules/rounds/round.model";
import type { SqlExecutionService } from "@/modules/sql-execution/service";
import type { UserDocument } from "@/modules/users/user.model";
import { realtime } from "@/sockets/realtime";
import { now } from "@/utils/clock";
import { Errors } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { type GenerationAttempt, GenerationRun, type GenerationRunDocument } from "./generation-run.model";
import { type LlmClient, LlmError } from "./llm";
import { buildSystemPrompt, buildUserPrompt, type PriorChapter, PROMPT_VERSION } from "./prompt";

export interface GenerationDeps {
  llm: LlmClient;
  sql: SqlExecutionService;
  groq: AppConfig["groq"];
  /** Base delay for exponential backoff between transient failures (tests use 0). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const running = new Set<string>();

export function generationInFlight(): number {
  return running.size;
}

/** Wait for background generation jobs (graceful shutdown / tests). */
export async function drainGeneration(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (running.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

export async function requestGeneration(params: {
  event: EventDocument;
  round: RoundDocument;
  actor: UserDocument;
  guidance: string;
  deps: GenerationDeps;
}): Promise<GenerationRunDocument> {
  const { event, round, actor, deps } = params;
  if (!deps.llm.configured) {
    throw Errors.notConfigured(
      "AI generation is not configured. Set GROQ_API_KEY (and optionally GROQ_MODEL) in backend/.env and restart the API. You can still author a challenge manually.",
      "AI_NOT_CONFIGURED",
    );
  }
  if (!deps.sql.canExecute || !deps.sql.canProvision) {
    throw Errors.notConfigured("The SQL engine is not configured, so generated challenges cannot be validated.", "SQL_ENGINE_UNAVAILABLE");
  }
  const active = await GenerationRun.findOne({ roundId: round._id, status: { $in: ["queued", "running"] } });
  if (active) throw Errors.conflict("A generation is already running for this round.", "GENERATION_IN_PROGRESS");

  const run = await GenerationRun.create({
    eventId: event._id,
    roundId: round._id,
    requestedBy: actor._id,
    status: "queued",
    model: deps.llm.model,
    promptVersion: PROMPT_VERSION,
    guidance: params.guidance,
    attempts: [],
  });
  running.add(String(run._id));
  void executeGeneration(run._id, actor, deps)
    .catch((error: unknown) => logger.error({ err: error, runId: String(run._id) }, "generation crashed"))
    .finally(() => running.delete(String(run._id)));
  return run;
}

async function loadPriorChapters(event: EventDocument, round: RoundDocument): Promise<PriorChapter[]> {
  const chapters: PriorChapter[] = [];
  const previousRounds = await Round.find({ eventId: event._id, number: { $lt: round.number } }).sort({ number: 1 });
  for (const previous of previousRounds) {
    // Prefer what players actually saw; fall back to the latest validated draft.
    const challenge =
      (await Challenge.findOne({ roundId: previous._id, status: "published" }).sort({ order: -1 })) ??
      (await Challenge.findOne({ roundId: previous._id, status: "draft", "validation.status": "passed" }).sort({ createdAt: -1 }));
    if (challenge) {
      chapters.push({
        roundNumber: previous.number,
        title: challenge.title,
        storySummary: challenge.generation.storySummary ?? "",
        narrative: challenge.narrative,
        schema: challenge.schemaSpec,
      });
    }
  }
  return chapters;
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

function summarizeIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.slice(0, 12).map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
}

async function recordAttempt(runId: Types.ObjectId, attempt: GenerationAttempt): Promise<void> {
  await GenerationRun.updateOne({ _id: runId }, { $push: { attempts: attempt } });
}

export async function executeGeneration(runId: Types.ObjectId, actor: UserDocument, deps: GenerationDeps): Promise<void> {
  const run = await GenerationRun.findById(runId);
  if (!run) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const backoffBase = deps.backoffMs ?? 1000;
  const maxAttempts = deps.groq?.maxAttempts ?? 3;

  run.status = "running";
  run.startedAt = now();
  await run.save();

  const finish = async (status: "succeeded" | "failed", extra: { challengeId?: Types.ObjectId; failureReason?: string }) => {
    await GenerationRun.updateOne({ _id: runId }, { $set: { status, finishedAt: now(), ...extra } });
    realtime.adminActivity({ kind: "generation", at: now().toISOString(), detail: { runId: String(runId), status, ...extra } });
  };

  try {
    const [event, round] = await Promise.all([EventModel.findById(run.eventId), Round.findById(run.roundId)]);
    if (!event || !round) return await finish("failed", { failureReason: "The event or round no longer exists." });
    const prior = await loadPriorChapters(event, round);
    const siblings = (await Challenge.find({ roundId: round._id, status: { $ne: "archived" } }).select("title")).map((c) => c.title);

    let feedback: string[] = [];
    let lastDetail = "No attempt was made.";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = now();
      const t0 = Date.now();
      const record = (outcome: GenerationAttempt["outcome"], detail: string) =>
        recordAttempt(runId, { attempt, startedAt, durationMs: Date.now() - t0, outcome, detail: detail.slice(0, 1500) });

      let text: string;
      try {
        const response = await deps.llm.generateJson({
          system: buildSystemPrompt(),
          user: buildUserPrompt({ event, round, prior, siblingTitles: siblings, guidance: run.guidance, feedback }),
          temperature: attempt === 1 ? 0.6 : 0.4,
        });
        text = response.text;
      } catch (error) {
        const llmError = error instanceof LlmError ? error : new LlmError("Unexpected AI provider failure.", "transient");
        lastDetail = llmError.message;
        await record(llmError.kind === "timeout" ? "timeout" : "llm_error", llmError.message);
        if (!llmError.retryable || attempt === maxAttempts) break;
        const delay = llmError.retryAfterMs ?? backoffBase * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
        await sleep(Math.min(delay, 30_000));
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(stripFence(text));
      } catch {
        lastDetail = "The model did not return valid JSON.";
        feedback = ["Your answer was not valid JSON. Return exactly one JSON object and nothing else."];
        await record("invalid_json", lastDetail);
        continue;
      }
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        lastDetail = "The model returned JSON that is not an object.";
        feedback = ["Return a single JSON object."];
        await record("invalid_json", lastDetail);
        continue;
      }

      const warnings: string[] = [];
      const extraKeys = Object.keys(json).filter((key) => !KNOWN_CONTENT_KEYS.has(key));
      if (extraKeys.length > 0) warnings.push(`Ignored unknown fields from the model: ${extraKeys.join(", ")}.`);

      const parsed = challengeContentSchema.safeParse({ ...(json as object), difficulty: round.difficulty });
      if (!parsed.success) {
        feedback = summarizeIssues(parsed.error.issues);
        lastDetail = `Schema validation failed: ${feedback.slice(0, 3).join("; ")}`;
        await record("schema_invalid", feedback.join(" | "));
        continue;
      }

      try {
        const { challenge } = await createDraftChallenge({
          event,
          round,
          actor,
          content: parsed.data,
          sql: deps.sql,
          generation: { source: "ai", runId, model: run.model, promptVersion: PROMPT_VERSION, attempts: attempt },
          warnings,
        });
        await record("ok", "Validated and saved as a draft.");
        return await finish("succeeded", { challengeId: challenge._id });
      } catch (error) {
        if (error instanceof ChallengeValidationError) {
          const failed = error.outcome.report.checks.filter((check) => !check.passed && check.severity === "error").map((check) => check.message);
          feedback = failed.length > 0 ? failed : ["The challenge failed validation."];
          lastDetail = `Validation failed: ${feedback.slice(0, 3).join("; ")}`;
          await record("validation_failed", feedback.join(" | "));
          continue;
        }
        throw error;
      }
    }
    await finish("failed", { failureReason: lastDetail });
  } catch (error) {
    logger.error({ err: error, runId: String(runId) }, "generation failed unexpectedly");
    await finish("failed", { failureReason: "An unexpected error occurred while generating the challenge. Check the server logs." });
  }
}

/** On start-up, runs that were interrupted by a restart are marked failed so admins see the truth. */
export async function failInterruptedRuns(): Promise<number> {
  const result = await GenerationRun.updateMany(
    { status: { $in: ["queued", "running"] } },
    { $set: { status: "failed", finishedAt: now(), failureReason: "Interrupted by a server restart. Please generate again." } },
  );
  return result.modifiedCount;
}

export function toRunDto(run: GenerationRunDocument) {
  return {
    id: run.id as string,
    roundId: String(run.roundId),
    status: run.status,
    model: run.model,
    promptVersion: run.promptVersion,
    guidance: run.guidance,
    attempts: run.attempts,
    challengeId: run.challengeId ? String(run.challengeId) : null,
    failureReason: run.failureReason ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    createdAt: run.createdAt,
  };
}
