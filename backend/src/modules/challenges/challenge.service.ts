import { Types } from "mongoose";
import { EventModel, type EventDocument } from "@/modules/events/event.model";
import { invalidateLeaderboard } from "@/modules/leaderboard/leaderboard.service";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { Round, type RoundDocument } from "@/modules/rounds/round.model";
import type { SqlExecutionService } from "@/modules/sql-execution/service";
import type { UserDocument } from "@/modules/users/user.model";
import { now } from "@/utils/clock";
import { Errors } from "@/utils/errors";
import { Challenge, type ChallengeDocument, TestCase, type TestCaseDocument } from "./challenge.model";
import { type ChallengeContent, challengeContentSchema, type TextPatch } from "./challenge.schema";
import { authoringHash, type ValidationOutcome, validateAndDerive } from "./challenge-validation";

export async function getChallengeOrThrow(id: string, options: { withPrivate?: boolean } = {}): Promise<ChallengeDocument> {
  if (!Types.ObjectId.isValid(id)) throw Errors.notFound("Challenge not found.", "CHALLENGE_NOT_FOUND");
  const query = Challenge.findById(id);
  if (options.withPrivate) query.select("+private");
  const challenge = await query;
  if (!challenge) throw Errors.notFound("Challenge not found.", "CHALLENGE_NOT_FOUND");
  return challenge;
}

export async function activeTests(challengeId: Types.ObjectId | string): Promise<TestCaseDocument[]> {
  return TestCase.find({ challengeId, active: true }).sort({ order: 1 });
}

/** Rebuilds the authoring input from stored documents so a draft can be re-validated. */
export function reconstructContent(challenge: ChallengeDocument, tests: TestCaseDocument[]): ChallengeContent {
  const samples = tests.filter((test) => test.visibility === "public");
  const hidden = tests.filter((test) => test.visibility === "hidden");
  return challengeContentSchema.parse({
    title: challenge.title,
    narrative: challenge.narrative,
    problemStatement: challenge.problemStatement,
    taskDescription: challenge.taskDescription,
    difficulty: challenge.difficulty,
    concepts: challenge.concepts,
    schema: challenge.schemaSpec,
    publicSamples: samples.map((test) => {
      const sample = challenge.publicSamples.find((s) => s.id === test.sampleId);
      return { name: sample?.name ?? test.label, description: sample?.description ?? "", rows: test.rows };
    }),
    candidateTestCases: hidden.map((test) => ({
      category: test.category,
      description: test.description,
      rows: test.rows,
      weight: test.weight,
      mandatory: test.mandatory,
    })),
    starterSql: challenge.starterSql,
    hints: challenge.hints,
    constraints: challenge.constraints,
    solutionSql: challenge.private?.solutionSql ?? "SELECT 1",
    comparisonPolicy: { ordered: challenge.comparison.ordered, matchColumnNames: challenge.comparison.matchColumnNames },
    explanation: challenge.private?.explanation ?? "",
    storySummary: challenge.generation.storySummary ?? "",
  });
}

export class ChallengeValidationError extends Error {
  constructor(readonly outcome: ValidationOutcome) {
    super("The challenge did not pass validation.");
    this.name = "ChallengeValidationError";
  }
}

async function nextOrder(roundId: Types.ObjectId): Promise<number> {
  const last = await Challenge.findOne({ roundId }).sort({ order: -1 }).select("order");
  return (last?.order ?? 0) + 1;
}

function persistableFields(content: ChallengeContent) {
  return {
    title: content.title,
    narrative: content.narrative,
    problemStatement: content.problemStatement,
    taskDescription: content.taskDescription,
    difficulty: content.difficulty,
    concepts: content.concepts,
    dialect: "postgresql" as const,
    schemaSpec: content.schema,
    starterSql: content.starterSql,
    hints: content.hints,
    constraints: content.constraints,
    comparison: { ordered: content.comparisonPolicy.ordered, matchColumnNames: content.comparisonPolicy.matchColumnNames, numericScale: 6 },
  };
}

/**
 * Validates `content` and, if it passes, stores it as a DRAFT with its derived hidden tests.
 * Invalid content is never stored. Publishing is a separate, explicit administrator action.
 */
export async function createDraftChallenge(params: {
  event: EventDocument;
  round: RoundDocument;
  actor: UserDocument;
  content: ChallengeContent;
  sql: SqlExecutionService;
  generation: { source: "ai" | "manual"; runId?: Types.ObjectId | null; model?: string | null; promptVersion?: string | null; attempts?: number | null };
  warnings?: string[];
}): Promise<{ challenge: ChallengeDocument; outcome: ValidationOutcome }> {
  const { event, round, actor, content, sql, generation } = params;
  if (content.difficulty !== round.difficulty) {
    throw Errors.unprocessable(`This challenge is ${content.difficulty} but the round is ${round.difficulty}.`, "DIFFICULTY_MISMATCH");
  }
  const outcome = await validateAndDerive(content, sql, params.warnings);
  if (!outcome.ok || !outcome.derived) throw new ChallengeValidationError(outcome);

  const id = new Types.ObjectId();
  const hash = authoringHash(content);
  const challenge = await Challenge.create({
    _id: id,
    lineageId: id,
    version: 1,
    order: await nextOrder(round._id),
    eventId: event._id,
    roundId: round._id,
    roundNumber: round.number,
    ...persistableFields(content),
    publicSamples: outcome.derived.samples,
    status: "draft",
    contentHash: hash,
    validation: { status: "passed", checkedAt: now(), validatedHash: hash, report: outcome.report },
    generation: { ...generation, storySummary: content.storySummary || null },
    private: { solutionSql: content.solutionSql, explanation: content.explanation },
    createdBy: actor._id,
  });
  await storeTests(challenge, outcome);
  return { challenge, outcome };
}

async function storeTests(challenge: ChallengeDocument, outcome: ValidationOutcome): Promise<void> {
  await TestCase.deleteMany({ challengeId: challenge._id });
  await TestCase.insertMany(
    (outcome.derived?.tests ?? []).map((test) => ({
      challengeId: challenge._id,
      challengeVersion: challenge.version,
      ...test,
      active: true,
    })),
  );
}

async function assertDraft(challenge: ChallengeDocument): Promise<void> {
  if (challenge.status !== "draft") {
    throw Errors.conflict(
      "Published and archived challenges are immutable so existing submissions keep their meaning. Create a new version instead.",
      "CHALLENGE_IMMUTABLE",
    );
  }
}

export async function patchChallengeText(id: string, patch: TextPatch): Promise<ChallengeDocument> {
  const challenge = await getChallengeOrThrow(id, { withPrivate: true });
  await assertDraft(challenge);
  const { explanation, storySummary, ...fields } = patch;
  Object.assign(challenge, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
  if (explanation !== undefined) challenge.private = { solutionSql: challenge.private?.solutionSql ?? "", explanation };
  if (storySummary !== undefined) challenge.generation.storySummary = storySummary;
  await challenge.save();
  return challenge;
}

/** Replaces a draft's evaluation content (schema, datasets, solution…) and re-runs the full pipeline. */
export async function replaceDraftContent(id: string, content: ChallengeContent, sql: SqlExecutionService): Promise<{ challenge: ChallengeDocument; outcome: ValidationOutcome }> {
  const challenge = await getChallengeOrThrow(id, { withPrivate: true });
  await assertDraft(challenge);
  const round = await Round.findById(challenge.roundId);
  if (!round) throw Errors.notFound("Round not found.", "ROUND_NOT_FOUND");
  if (content.difficulty !== round.difficulty) {
    throw Errors.unprocessable(`This challenge is ${content.difficulty} but the round is ${round.difficulty}.`, "DIFFICULTY_MISMATCH");
  }
  const outcome = await validateAndDerive(content, sql);
  if (!outcome.ok || !outcome.derived) throw new ChallengeValidationError(outcome);
  const hash = authoringHash(content);
  Object.assign(challenge, persistableFields(content));
  challenge.publicSamples = outcome.derived.samples;
  challenge.contentHash = hash;
  challenge.validation = { status: "passed", checkedAt: now(), validatedHash: hash, report: outcome.report };
  challenge.private = { solutionSql: content.solutionSql, explanation: content.explanation };
  challenge.generation.storySummary = content.storySummary || challenge.generation.storySummary || null;
  await challenge.save();
  await storeTests(challenge, outcome);
  return { challenge, outcome };
}

/** Re-runs validation for an existing draft (e.g. after the SQL engine was rebuilt). */
export async function revalidateChallenge(id: string, sql: SqlExecutionService): Promise<{ challenge: ChallengeDocument; outcome: ValidationOutcome }> {
  const challenge = await getChallengeOrThrow(id, { withPrivate: true });
  const tests = await TestCase.find({ challengeId: challenge._id }).sort({ order: 1 });
  const content = reconstructContent(challenge, tests);
  const outcome = await validateAndDerive(content, sql);
  const hash = authoringHash(content);
  challenge.validation = {
    status: outcome.ok ? "passed" : "failed",
    checkedAt: now(),
    validatedHash: outcome.ok ? hash : (challenge.validation.validatedHash ?? null),
    report: outcome.report,
  };
  if (outcome.ok && outcome.derived && challenge.status === "draft") {
    challenge.publicSamples = outcome.derived.samples;
    challenge.contentHash = hash;
    await storeTests(challenge, outcome);
  }
  await challenge.save();
  return { challenge, outcome };
}

export async function publishChallenge(id: string, actor: UserDocument): Promise<ChallengeDocument> {
  const challenge = await getChallengeOrThrow(id, { withPrivate: true });
  if (challenge.status !== "draft") throw Errors.conflict("Only a draft can be published.", "INVALID_TRANSITION");
  if (challenge.validation.status !== "passed" || challenge.validation.validatedHash !== challenge.contentHash) {
    throw Errors.conflict("The challenge must pass validation (with its current content) before it can be published.", "VALIDATION_REQUIRED");
  }
  const tests = await TestCase.countDocuments({ challengeId: challenge._id, active: true });
  if (tests === 0) throw Errors.conflict("The challenge has no active test cases.", "NO_TEST_CASES");

  const ctx = await loadRoundContext(String(challenge.roundId));
  const previous = await Challenge.findOne({ lineageId: challenge.lineageId, status: "published" });
  const started = ctx.phase.phase === "open" || ctx.phase.phase === "paused" || ctx.phase.phase === "closed" || ctx.phase.phase === "finalized";
  if (started) {
    throw Errors.conflict(
      "This round has already started, so its set of challenges is frozen to keep scores comparable. Pause and reset the round (see the operations guide) before changing published challenges.",
      "ROUND_ALREADY_STARTED",
    );
  }

  if (previous) {
    previous.status = "archived";
    await previous.save();
  }
  try {
    challenge.status = "published";
    challenge.publishedAt = now();
    challenge.publishedBy = actor._id;
    await challenge.save();
  } catch (error) {
    if (previous) {
      previous.status = "published";
      await previous.save();
    }
    throw error;
  }
  const update: Record<string, unknown> = { $addToSet: { publishedChallengeIds: challenge._id } };
  await Round.updateOne({ _id: challenge.roundId }, update);
  if (previous) await Round.updateOne({ _id: challenge.roundId }, { $pull: { publishedChallengeIds: previous._id } });
  const round = await Round.findById(challenge.roundId);
  if (round && !round.storyChapter && challenge.generation.storySummary) {
    round.storyChapter = challenge.generation.storySummary;
    await round.save();
  }
  invalidateLeaderboard(challenge.roundId);
  return challenge;
}

export async function archiveChallenge(id: string): Promise<ChallengeDocument> {
  const challenge = await getChallengeOrThrow(id);
  if (challenge.status === "archived") throw Errors.conflict("The challenge is already archived.", "NO_CHANGE");
  if (challenge.status === "published") {
    const ctx = await loadRoundContext(String(challenge.roundId));
    if (ctx.phase.phase !== "draft" && ctx.phase.phase !== "upcoming") {
      throw Errors.conflict("A challenge in a round that has started cannot be withdrawn.", "ROUND_ALREADY_STARTED");
    }
    await Round.updateOne({ _id: challenge.roundId }, { $pull: { publishedChallengeIds: challenge._id } });
  }
  challenge.status = "archived";
  await challenge.save();
  return challenge;
}

/** Clones a challenge into a new draft version (same lineage). Tests are copied; edit and re-validate as needed. */
export async function createNewVersion(id: string, actor: UserDocument): Promise<ChallengeDocument> {
  const source = await getChallengeOrThrow(id, { withPrivate: true });
  const latest = await Challenge.findOne({ lineageId: source.lineageId }).sort({ version: -1 });
  const draftExists = await Challenge.exists({ lineageId: source.lineageId, status: "draft" });
  if (draftExists) throw Errors.conflict("This challenge already has a draft version.", "DRAFT_EXISTS");
  const version = (latest?.version ?? source.version) + 1;
  const copy = source.toObject();
  const newId = new Types.ObjectId();
  const challenge = await Challenge.create({
    ...copy,
    _id: newId,
    version,
    status: "draft",
    publishedAt: null,
    publishedBy: null,
    createdBy: actor._id,
    createdAt: undefined,
    updatedAt: undefined,
    private: copy.private,
  });
  const tests = await TestCase.find({ challengeId: source._id }).lean();
  await TestCase.insertMany(tests.map(({ _id: _discard, createdAt: _c, updatedAt: _u, ...rest }) => ({ ...rest, challengeId: newId, challengeVersion: version })));
  return challenge;
}

export async function listRoundChallenges(roundId: string) {
  return Challenge.find({ roundId }).sort({ order: 1, version: -1 });
}

export async function loadEventForChallenge(challenge: ChallengeDocument): Promise<EventDocument> {
  const event = await EventModel.findById(challenge.eventId);
  if (!event) throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
  return event;
}
