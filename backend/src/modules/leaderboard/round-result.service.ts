import { Types } from "mongoose";
import { Registration } from "@/modules/events/event.model";
import { Round } from "@/modules/rounds/round.model";
import { Submission } from "@/modules/submissions/submission.model";
import { KeyedMutex } from "@/utils/mutex";
import { logger } from "@/utils/logger";
import { invalidateLeaderboard } from "./leaderboard.service";
import { NEVER } from "./ranking";
import { type ChallengeBest, RoundResult, type RoundResultDocument } from "./round-result.model";

const mutex = new KeyedMutex();

/**
 * Recomputes a participant's authoritative round result from their persisted
 * submissions. The computation is idempotent and independent of the order in
 * which submissions finish, so duplicate or racing evaluations converge on the
 * same document. A revision counter protects against concurrent writers across
 * processes; a per-user mutex avoids needless retries inside one process.
 *
 * Results of a finalized round are immutable and are never touched here.
 */
export async function recomputeRoundResult(
  roundId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
): Promise<RoundResultDocument | null> {
  const result = await mutex.run(`${String(roundId)}:${String(userId)}`, () => recompute(new Types.ObjectId(String(roundId)), new Types.ObjectId(String(userId))));
  // Any read of the ranking after this point must see the new result.
  invalidateLeaderboard(roundId);
  return result;
}

async function recompute(roundId: Types.ObjectId, userId: Types.ObjectId): Promise<RoundResultDocument | null> {
  const round = await Round.findById(roundId);
  if (!round) return null;
  if (round.finalization.finalizedAt) return RoundResult.findOne({ roundId, userId });

  const registration = await Registration.findOne({ eventId: round.eventId, userId });
  if (!registration) return null; // only registered participants appear in rankings

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const existing = await RoundResult.findOne({ roundId, userId });
    const challengeIds = round.publishedChallengeIds;

    const bests = await Submission.aggregate<{ _id: Types.ObjectId; best: { _id: Types.ObjectId; challengeId: Types.ObjectId; score: number; verdict: string; submittedAt: Date } }>([
      { $match: { userId, roundId, challengeId: { $in: challengeIds }, status: "completed", score: { $gt: 0 } } },
      { $sort: { score: -1, submittedAt: 1, _id: 1 } },
      { $group: { _id: "$lineageId", best: { $first: "$$ROOT" } } },
    ]);
    const challengeBests: ChallengeBest[] = bests
      .map(({ _id, best }) => ({
        lineageId: _id,
        challengeId: best.challengeId,
        submissionId: best._id,
        score: best.score,
        fullyCorrect: best.verdict === "accepted",
        achievedAt: best.submittedAt,
      }))
      .sort((a, b) => String(a.lineageId).localeCompare(String(b.lineageId)));

    const [submissionCount, last] = await Promise.all([
      Submission.countDocuments({ userId, roundId, counted: true, status: "completed" }),
      Submission.findOne({ userId, roundId, status: "completed" }).sort({ submittedAt: -1 }).select("submittedAt"),
    ]);

    const score = challengeBests.reduce((sum, best) => sum + best.score, 0);
    const solved = challengeBests.filter((best) => best.fullyCorrect).length;
    const achievedAt =
      challengeBests.length > 0 ? new Date(Math.max(...challengeBests.map((best) => best.achievedAt.getTime()))) : NEVER;

    const data = {
      score,
      challengesSolved: solved,
      challengeBests,
      achievedAt,
      submissionCount,
      lastSubmissionAt: last?.submittedAt ?? null,
      completionStatus: challengeIds.length > 0 && solved >= challengeIds.length ? ("completed" as const) : ("in_progress" as const),
    };

    // Rejected-before-execution attempts (invalid SQL) do not make someone a ranked participant.
    if (!existing && submissionCount === 0 && challengeBests.length === 0) return null;

    if (!existing) {
      try {
        return await RoundResult.create({
          eventId: round.eventId,
          roundId,
          roundNumber: round.number,
          userId,
          registeredAt: registration.registeredAt,
          revision: 1,
          qualification: { status: "pending" },
          ...data,
        });
      } catch (error) {
        if ((error as { code?: number }).code === 11000) continue; // someone else created it first: retry as update
        throw error;
      }
    }
    const updated = await RoundResult.findOneAndUpdate(
      { _id: existing._id, revision: existing.revision, "qualification.finalizedAt": null },
      { $set: { ...data, registeredAt: registration.registeredAt }, $inc: { revision: 1 } },
      { returnDocument: "after" },
    );
    if (updated) return updated;
  }
  logger.error({ roundId: String(roundId), userId: String(userId) }, "round result recompute lost too many races");
  return RoundResult.findOne({ roundId, userId });
}

/** Make sure a registered participant has a (possibly empty) result row once they enter a round. */
export async function ensureRoundResult(roundId: Types.ObjectId | string, userId: Types.ObjectId | string): Promise<void> {
  await recomputeRoundResult(roundId, userId);
}
