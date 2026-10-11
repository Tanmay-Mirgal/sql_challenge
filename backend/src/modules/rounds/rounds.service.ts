import { z } from "zod";
import { Challenge } from "@/modules/challenges/challenge.model";
import { invalidateLeaderboard } from "@/modules/leaderboard/leaderboard.service";
import { realtime } from "@/sockets/realtime";
import { now } from "@/utils/clock";
import { Errors } from "@/utils/errors";
import { type RoundContext, loadRoundContext } from "./round-context";
import { Round, type RoundDocument } from "./round.model";

const nullableDate = z.union([z.coerce.date(), z.null()]);

export const updateRoundSchema = z.strictObject({
  name: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  storyChapter: z.string().trim().max(4000).optional(),
  startsAt: nullableDate.optional(),
  endsAt: nullableDate.optional(),
  qualification: z
    .strictObject({
      topN: z.union([z.number().int().min(1).max(100_000), z.null()]),
      minScore: z.number().min(0).max(1_000_000),
    })
    .partial()
    .optional(),
  submissionLimit: z.strictObject({ perChallenge: z.number().int().min(1).max(1000) }).partial().optional(),
});
export type UpdateRoundInput = z.infer<typeof updateRoundSchema>;

export const ROUND_ACTIONS = ["schedule", "open", "pause", "resume", "close"] as const;
export type RoundAction = (typeof ROUND_ACTIONS)[number];

export const roundActionSchema = z.strictObject({
  action: z.enum(ROUND_ACTIONS),
  /** On resume: push the deadline out by the time the round was paused (default true). */
  extendByPausedTime: z.boolean().optional(),
});

export function toAdminRoundDto(round: RoundDocument, phase?: { phase: string; reason: string }) {
  return {
    id: round.id as string,
    eventId: String(round.eventId),
    number: round.number,
    name: round.name,
    description: round.description,
    storyChapter: round.storyChapter,
    difficulty: round.difficulty,
    status: round.status,
    phase: phase?.phase ?? null,
    phaseReason: phase?.reason ?? null,
    startsAt: round.startsAt ?? null,
    endsAt: round.endsAt ?? null,
    qualification: { topN: round.qualification.topN, minScore: round.qualification.minScore },
    submissionLimit: { perChallenge: round.submissionLimit.perChallenge },
    publishedChallengeIds: round.publishedChallengeIds.map(String),
    pausedAt: round.pausedAt ?? null,
    pausedMs: round.pausedMs,
    finalization: {
      finalizedAt: round.finalization.finalizedAt ?? null,
      participants: round.finalization.participants ?? null,
      qualified: round.finalization.qualified ?? null,
      scoringPolicyVersion: round.finalization.scoringPolicyVersion ?? null,
      snapshotHash: round.finalization.snapshotHash ?? null,
    },
    updatedAt: round.updatedAt,
  };
}

function assertWindow(startsAt?: Date | null, endsAt?: Date | null): void {
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    throw Errors.badRequest("The start time must be before the end time.", undefined, "INVALID_WINDOW");
  }
}

export async function updateRound(roundId: string, patch: UpdateRoundInput): Promise<RoundContext> {
  const ctx = await loadRoundContext(roundId);
  const { round } = ctx;
  if (ctx.phase.phase === "finalized" || round.status === "completed") {
    throw Errors.conflict("This round is closed; its configuration can no longer change.", "ROUND_LOCKED");
  }
  const started = ctx.phase.phase === "open" || ctx.phase.phase === "paused";

  if (patch.qualification) {
    if (started) throw Errors.conflict("Qualification thresholds are locked once the round has started.", "ROUND_LOCKED");
    if (round.number === 3 && patch.qualification.topN !== undefined && patch.qualification.topN !== null) {
      throw Errors.badRequest("The final round has no qualification threshold.", undefined, "INVALID_THRESHOLD");
    }
    if (round.number < 3 && patch.qualification.topN === null) {
      throw Errors.badRequest("A qualification threshold is required for this round.", undefined, "INVALID_THRESHOLD");
    }
    if (patch.qualification.topN !== undefined) round.qualification.topN = patch.qualification.topN;
    if (patch.qualification.minScore !== undefined) round.qualification.minScore = patch.qualification.minScore;
  }
  if (patch.startsAt !== undefined) {
    if (started) throw Errors.conflict("The start time cannot change after the round has started.", "ROUND_LOCKED");
    round.startsAt = patch.startsAt;
  }
  if (patch.endsAt !== undefined) {
    if (started && (patch.endsAt === null || patch.endsAt.getTime() <= now().getTime())) {
      throw Errors.badRequest("A running round's deadline must be in the future.", undefined, "INVALID_WINDOW");
    }
    round.endsAt = patch.endsAt;
  }
  assertWindow(round.startsAt, round.endsAt);
  if (patch.name !== undefined) round.name = patch.name;
  if (patch.description !== undefined) round.description = patch.description;
  if (patch.storyChapter !== undefined) round.storyChapter = patch.storyChapter;
  if (patch.submissionLimit?.perChallenge !== undefined) {
    if (started) throw Errors.conflict("Submission limits are locked once the round has started.", "ROUND_LOCKED");
    round.submissionLimit.perChallenge = patch.submissionLimit.perChallenge;
  }
  await round.save();
  return loadRoundContext(roundId);
}

export async function applyRoundAction(
  roundId: string,
  action: RoundAction,
  options: { extendByPausedTime?: boolean } = {},
): Promise<RoundContext> {
  const ctx = await loadRoundContext(roundId);
  const { round, phase } = ctx;
  const at = now();

  if (phase.phase === "finalized") throw Errors.conflict("This round has been finalized.", "ROUND_FINALIZED");

  switch (action) {
    case "schedule": {
      if (round.status !== "draft") throw Errors.conflict("Only a draft round can be scheduled.", "INVALID_TRANSITION");
      if (!round.startsAt || !round.endsAt) {
        throw Errors.conflict("Set a start and end time before scheduling the round.", "ROUND_NOT_READY");
      }
      assertWindow(round.startsAt, round.endsAt);
      round.status = "scheduled";
      break;
    }
    case "open": {
      if (round.status !== "scheduled" && round.status !== "draft") {
        throw Errors.conflict("Only a scheduled round can be opened.", "INVALID_TRANSITION");
      }
      if (ctx.event.status !== "live") throw Errors.conflict("The event must be live to open a round.", "EVENT_NOT_LIVE");
      if (round.number > 1 && !ctx.previousRound?.finalization.finalizedAt) {
        throw Errors.conflict("The previous round must be finalized first.", "PREVIOUS_ROUND_NOT_FINALIZED");
      }
      const published = await Challenge.countDocuments({ roundId: round._id, status: "published" });
      if (published === 0) throw Errors.conflict("Publish at least one challenge before opening the round.", "NO_PUBLISHED_CHALLENGES");
      if (!round.endsAt || round.endsAt.getTime() <= at.getTime()) {
        throw Errors.conflict("Set an end time in the future before opening the round.", "ROUND_NOT_READY");
      }
      if (!round.startsAt || round.startsAt.getTime() > at.getTime()) round.startsAt = at;
      round.status = "active";
      break;
    }
    case "pause": {
      if (phase.phase !== "open") throw Errors.conflict("Only a running round can be paused.", "INVALID_TRANSITION");
      round.status = "paused";
      round.pausedAt = at;
      break;
    }
    case "resume": {
      if (round.status !== "paused") throw Errors.conflict("The round is not paused.", "INVALID_TRANSITION");
      const pausedFor = round.pausedAt ? Math.max(0, at.getTime() - round.pausedAt.getTime()) : 0;
      round.pausedMs += pausedFor;
      if (options.extendByPausedTime !== false && round.endsAt && pausedFor > 0) {
        round.endsAt = new Date(round.endsAt.getTime() + pausedFor);
      }
      round.pausedAt = null;
      round.status = "active";
      break;
    }
    case "close": {
      if (phase.phase !== "open" && phase.phase !== "paused") {
        throw Errors.conflict("Only a running or paused round can be closed.", "INVALID_TRANSITION");
      }
      round.status = "completed";
      if (!round.endsAt || round.endsAt.getTime() > at.getTime()) round.endsAt = at;
      round.pausedAt = null;
      break;
    }
  }
  await round.save();
  const next = await loadRoundContext(roundId);
  publishRoundUpdate(next);
  return next;
}

export function publishRoundUpdate(ctx: RoundContext): void {
  invalidateLeaderboard(ctx.round._id);
  realtime.roundUpdated({
    eventId: String(ctx.event._id),
    roundId: ctx.round.id as string,
    roundNumber: ctx.round.number,
    phase: ctx.phase.phase,
    status: ctx.round.status,
    finalized: Boolean(ctx.round.finalization.finalizedAt),
    at: now().toISOString(),
  });
}

export async function listRounds(eventId: string): Promise<RoundDocument[]> {
  return Round.find({ eventId }).sort({ number: 1 });
}
