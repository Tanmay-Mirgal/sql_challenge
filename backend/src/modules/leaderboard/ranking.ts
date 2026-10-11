import type { TieBreaker } from "@/modules/events/event.model";

/** Sentinel "never achieved" instant so zero-score entries sort after scorers on the achieved-at key. */
export const NEVER = new Date(8_640_000_000_000_000);

export interface Rankable {
  userId: string;
  score: number;
  achievedAt: Date | null;
  submissionCount: number;
  registeredAt: Date;
}

export type SeparatedBy = "score" | "achieved_at" | "submission_count" | "registration_order" | "user_id";

/**
 * Total order used for every ranking in the system (live leaderboard, round
 * results, qualification cut-off). It is a strict total order — two different
 * participants never compare equal — so ranking never depends on iteration or
 * insertion order and never uses randomness:
 *
 *  1. higher score
 *  2. earlier time of reaching that score          (if "earliest_achieved" is configured)
 *  3. fewer counted submissions                    (if "fewer_submissions" is configured)
 *  4. earlier registration
 *  5. lexicographically smaller user id            (last-resort deterministic fallback)
 */
export function compareRankable(a: Rankable, b: Rankable, tieBreakers: readonly TieBreaker[]): { order: number; by: SeparatedBy } {
  if (a.score !== b.score) return { order: b.score - a.score, by: "score" };
  if (tieBreakers.includes("earliest_achieved")) {
    const at = (a.achievedAt ?? NEVER).getTime();
    const bt = (b.achievedAt ?? NEVER).getTime();
    if (at !== bt) return { order: at - bt, by: "achieved_at" };
  }
  if (tieBreakers.includes("fewer_submissions") && a.submissionCount !== b.submissionCount) {
    return { order: a.submissionCount - b.submissionCount, by: "submission_count" };
  }
  const ar = a.registeredAt.getTime();
  const br = b.registeredAt.getTime();
  if (ar !== br) return { order: ar - br, by: "registration_order" };
  return { order: a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0, by: "user_id" };
}

export type Ranked<T> = T & { rank: number; separatedBy: SeparatedBy | null };

export function rankResults<T extends Rankable>(items: readonly T[], tieBreakers: readonly TieBreaker[]): Ranked<T>[] {
  const sorted = [...items].sort((a, b) => compareRankable(a, b, tieBreakers).order);
  return sorted.map((item, index) => {
    const next = sorted[index + 1];
    return {
      ...item,
      rank: index + 1,
      separatedBy: next ? compareRankable(item, next, tieBreakers).by : null,
    };
  });
}
