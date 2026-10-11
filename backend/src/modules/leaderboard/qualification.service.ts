import type { Types } from "mongoose";
import { Registration } from "@/modules/events/event.model";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { Round } from "@/modules/rounds/round.model";
import { Submission } from "@/modules/submissions/submission.model";
import type { UserDocument } from "@/modules/users/user.model";
import { realtime } from "@/sockets/realtime";
import { now } from "@/utils/clock";
import { contentHash, randomToken } from "@/utils/crypto";
import { Errors } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { invalidateLeaderboard } from "./leaderboard.service";
import { rankResults, type SeparatedBy } from "./ranking";
import { RoundResult } from "./round-result.model";
import { recomputeRoundResult } from "./round-result.service";

const LEASE_MS = 2 * 60_000;
const PENDING_WAIT_MS = 30_000;

export interface FinalizationSummary {
  roundId: string;
  roundNumber: number;
  finalizedAt: Date;
  participants: number;
  qualified: number;
  topN: number | null;
  snapshotHash: string;
  scoringPolicyVersion: number;
  /** How the qualification cut-off was decided (null when there is no cut-off or no one was ranked). */
  cutoff: { lastQualifiedRank: number | null; lastQualifiedScore: number | null; decidedBy: SeparatedBy | null } | null;
  alreadyFinalized: boolean;
}

function summaryFromRound(round: Awaited<ReturnType<typeof loadRoundContext>>["round"], alreadyFinalized: boolean): FinalizationSummary {
  return {
    roundId: round.id as string,
    roundNumber: round.number,
    finalizedAt: round.finalization.finalizedAt!,
    participants: round.finalization.participants ?? 0,
    qualified: round.finalization.qualified ?? 0,
    topN: round.qualification.topN,
    snapshotHash: round.finalization.snapshotHash ?? "",
    scoringPolicyVersion: round.finalization.scoringPolicyVersion ?? 0,
    cutoff: null,
    alreadyFinalized,
  };
}

async function waitForPending(roundId: Types.ObjectId, force: boolean): Promise<void> {
  const deadline = Date.now() + PENDING_WAIT_MS;
  for (;;) {
    const pending = await Submission.countDocuments({ roundId, status: { $in: ["queued", "running"] } });
    if (pending === 0) return;
    if (Date.now() >= deadline) {
      if (!force) {
        throw Errors.conflict(
          `${pending} submission(s) are still being evaluated. Wait for them to finish, or retry with force to mark them as failed.`,
          "SUBMISSIONS_PENDING",
          { pending },
        );
      }
      await Submission.updateMany(
        { roundId, status: { $in: ["queued", "running"] } },
        { $set: { status: "failed", verdict: "system_error", counted: false, errorCategory: "INTERNAL_ERROR", errorMessage: "Evaluation was abandoned when the round was finalized.", evaluatedAt: now() } },
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Authoritative, idempotent round finalization:
 *   1. only a CLOSED round can be finalized (submissions are frozen by server time);
 *   2. a lease on the round makes concurrent attempts safe — losers get the winner's result;
 *   3. every participant's result is recomputed from persisted submissions;
 *   4. ranking uses the documented total order (score → time reached → submissions → registration → id);
 *   5. the top N with a qualifying score advance; the snapshot is written once and never changed.
 *
 * Provisional (live) ranks never influence this — only the frozen data does.
 */
export async function finalizeRound(roundId: string, actor: UserDocument, options: { force?: boolean } = {}): Promise<FinalizationSummary> {
  const ctx = await loadRoundContext(roundId);
  if (ctx.round.finalization.finalizedAt) return summaryFromRound(ctx.round, true);

  switch (ctx.phase.phase) {
    case "closed":
      break;
    case "open":
    case "paused":
      throw Errors.conflict("Close the round before finalizing it.", "ROUND_STILL_OPEN");
    default:
      throw Errors.conflict("This round has not been played yet.", "ROUND_NOT_CLOSED");
  }

  const token = randomToken(12);
  const at = now();
  const leased = await Round.findOneAndUpdate(
    {
      _id: ctx.round._id,
      "finalization.finalizedAt": null,
      $or: [{ "finalization.lockedUntil": null }, { "finalization.lockedUntil": { $lt: at } }],
    },
    { $set: { "finalization.lockedUntil": new Date(at.getTime() + LEASE_MS), "finalization.lockToken": token } },
    { returnDocument: "after" },
  );
  if (!leased) {
    const current = await Round.findById(ctx.round._id);
    if (current?.finalization.finalizedAt) return summaryFromRound(current, true);
    throw Errors.conflict("Finalization is already in progress.", "FINALIZATION_IN_PROGRESS");
  }

  const release = () =>
    Round.updateOne({ _id: leased._id, "finalization.lockToken": token }, { $set: { "finalization.lockedUntil": null, "finalization.lockToken": null } });

  try {
    await waitForPending(leased._id, options.force === true);

    // Recompute every participant who has any submission or result in this round.
    const submitters = await Submission.distinct("userId", { roundId: leased._id });
    const existing = await RoundResult.find({ roundId: leased._id }).select("userId");
    const everyone = new Map<string, Types.ObjectId>();
    for (const id of [...submitters, ...existing.map((row) => row.userId)]) everyone.set(String(id), id);
    for (const userId of everyone.values()) await recomputeRoundResult(leased._id, userId);

    const registrations = await Registration.find({ eventId: ctx.event._id }).select("userId status");
    const registered = new Set(registrations.filter((r) => r.status === "registered").map((r) => String(r.userId)));
    const results = await RoundResult.find({ roundId: leased._id });
    const eligible = results.filter((result) => registered.has(String(result.userId)));
    const ineligible = results.filter((result) => !registered.has(String(result.userId)));

    const policyVersion = ctx.event.scoring.version;
    const ranked = rankResults(
      eligible.map((result) => ({
        userId: String(result.userId),
        score: result.score,
        achievedAt: result.achievedAt,
        submissionCount: result.submissionCount,
        registeredAt: result.registeredAt,
        doc: result,
      })),
      ctx.event.scoring.tieBreakers,
    );

    const { topN, minScore } = leased.qualification;
    const finalizedAt = now();
    const decisions = ranked.map((item) => {
      const qualifies = topN !== null && item.rank <= topN && item.score >= minScore;
      const status = topN === null ? ("finalist" as const) : qualifies ? ("qualified" as const) : ("eliminated" as const);
      return { item, status };
    });
    const snapshotHash = contentHash({
      policyVersion,
      topN,
      ranking: decisions.map(({ item, status }) => [item.userId, item.rank, item.score, item.achievedAt?.toISOString() ?? null, item.submissionCount, status]),
    });

    await RoundResult.bulkWrite([
      ...decisions.map(({ item, status }) => ({
        updateOne: {
          filter: { _id: item.doc._id, "qualification.finalizedAt": null },
          update: {
            $set: {
              "qualification.status": status,
              "qualification.finalRank": item.rank,
              "qualification.finalScore": item.score,
              "qualification.finalAchievedAt": item.achievedAt,
              "qualification.finalSubmissionCount": item.submissionCount,
              "qualification.tieBreakApplied": item.separatedBy,
              "qualification.finalizedAt": finalizedAt,
              "qualification.scoringPolicyVersion": policyVersion,
            },
          },
        },
      })),
      ...ineligible.map((result) => ({
        updateOne: {
          filter: { _id: result._id, "qualification.finalizedAt": null },
          update: { $set: { "qualification.status": "eliminated", "qualification.finalRank": null, "qualification.finalizedAt": finalizedAt, "qualification.scoringPolicyVersion": policyVersion } },
        },
      })),
    ]);

    const qualifiedCount = decisions.filter((d) => d.status === "qualified").length;
    const done = await Round.findOneAndUpdate(
      { _id: leased._id, "finalization.lockToken": token, "finalization.finalizedAt": null },
      {
        $set: {
          status: "completed",
          pausedAt: null,
          "finalization.finalizedAt": finalizedAt,
          "finalization.finalizedBy": actor._id,
          "finalization.scoringPolicyVersion": policyVersion,
          "finalization.participants": ranked.length,
          "finalization.qualified": qualifiedCount,
          "finalization.snapshotHash": snapshotHash,
          "finalization.lockedUntil": null,
          "finalization.lockToken": null,
        },
      },
      { returnDocument: "after" },
    );
    if (!done) {
      const current = await Round.findById(leased._id);
      if (current?.finalization.finalizedAt) return summaryFromRound(current, true);
      throw Errors.conflict("Finalization lost its lease; please retry.", "FINALIZATION_IN_PROGRESS");
    }

    invalidateLeaderboard(done._id);
    realtime.roundUpdated({
      eventId: String(done.eventId),
      roundId: done.id as string,
      roundNumber: done.number,
      phase: "finalized",
      status: done.status,
      finalized: true,
      at: finalizedAt.toISOString(),
    });
    realtime.leaderboardChanged(done.id as string);
    for (const { item, status } of decisions) {
      realtime.participantUpdated(item.userId, { roundId: done.id as string, roundNumber: done.number, reason: "qualification", qualification: status, rank: item.rank, score: item.score });
    }

    const lastQualified = topN !== null ? decisions.filter((d) => d.status === "qualified").at(-1) : undefined;
    return {
      ...summaryFromRound(done, false),
      cutoff:
        topN === null
          ? null
          : { lastQualifiedRank: lastQualified?.item.rank ?? null, lastQualifiedScore: lastQualified?.item.score ?? null, decidedBy: lastQualified?.item.separatedBy ?? null },
    };
  } catch (error) {
    await release().catch((releaseError: unknown) => logger.warn({ err: releaseError }, "could not release finalization lease"));
    throw error;
  }
}
