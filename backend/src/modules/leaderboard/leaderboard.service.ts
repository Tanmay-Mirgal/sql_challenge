import type { Types } from "mongoose";
import type { EventDocument } from "@/modules/events/event.model";
import type { RoundDocument } from "@/modules/rounds/round.model";
import { User } from "@/modules/users/user.model";
import { NEVER, type Ranked, type Rankable, rankResults } from "./ranking";
import { type IRoundResult, RoundResult } from "./round-result.model";

type ResultRow = Pick<
  IRoundResult,
  "score" | "challengesSolved" | "submissionCount" | "lastSubmissionAt" | "registeredAt" | "qualification" | "completionStatus"
> & { _id: Types.ObjectId; userId: Types.ObjectId; achievedAt: Date | null };

interface RankableRow extends Rankable {
  row: ResultRow;
}

export interface RoundRanking {
  roundId: string;
  /** Monotonic ordering value so clients can discard stale/duplicate updates. */
  seq: number;
  generatedAt: Date;
  finalized: boolean;
  entries: Ranked<RankableRow>[];
}

export interface LeaderboardEntry {
  rank: number;
  participantId: string;
  name: string;
  picture: string | null;
  department: string | null;
  score: number;
  challengesSolved: number;
  /** When the current score was reached (public tie-break information). */
  achievedAt: Date | null;
  submissionCount: number;
  lastSubmissionAt: Date | null;
  qualification: "pending" | "qualified" | "eliminated" | "finalist";
  /** True while the participant is inside the qualifying positions (provisional until finalized). */
  inQualifyingPosition: boolean;
}

export interface LeaderboardPage {
  roundId: string;
  roundNumber: number;
  seq: number;
  generatedAt: Date;
  finalized: boolean;
  total: number;
  offset: number;
  limit: number;
  cutoff: { topN: number | null; minScore: number };
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
}

const CACHE_TTL_MS = 750;
const cache = new Map<string, { at: number; ranking: RoundRanking }>();
let lastSeq = 0;

function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now());
  return lastSeq;
}

/** Call whenever persisted results for a round change so the next read recomputes. */
export function invalidateLeaderboard(roundId: Types.ObjectId | string): void {
  cache.delete(String(roundId));
}

export function clearLeaderboardCache(): void {
  cache.clear();
}

export async function getRoundRanking(round: RoundDocument, event: EventDocument, options: { fresh?: boolean } = {}): Promise<RoundRanking> {
  const key = String(round._id);
  const cached = cache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ranking;

  const rows = await RoundResult.find({ roundId: round._id })
    .select("userId score challengesSolved achievedAt submissionCount lastSubmissionAt registeredAt qualification completionStatus")
    .lean<ResultRow[]>();

  const finalized = Boolean(round.finalization.finalizedAt);
  const rankable: RankableRow[] = rows.map((row) => ({
    userId: String(row.userId),
    score: row.score,
    achievedAt: row.achievedAt,
    submissionCount: row.submissionCount,
    registeredAt: row.registeredAt,
    row,
  }));

  let entries: Ranked<RankableRow>[];
  if (finalized) {
    // Immutable snapshot: use the ranks stored at finalization, never a recomputation.
    entries = rankable
      .map((item) => ({ ...item, rank: item.row.qualification.finalRank ?? Number.MAX_SAFE_INTEGER, separatedBy: null }))
      .sort((a, b) => a.rank - b.rank);
  } else {
    entries = rankResults(rankable, event.scoring.tieBreakers);
  }
  const ranking: RoundRanking = { roundId: key, seq: nextSeq(), generatedAt: new Date(), finalized, entries };
  cache.set(key, { at: Date.now(), ranking });
  return ranking;
}

function toEntry(
  item: Ranked<RankableRow>,
  user: { publicId: string; name: string; picture?: string | null; department?: string | null } | undefined,
  round: RoundDocument,
): LeaderboardEntry {
  const topN = round.qualification.topN;
  const eligibleToQualify = item.row.score >= Math.max(round.qualification.minScore, 0.0000001);
  return {
    rank: item.rank,
    participantId: user?.publicId ?? "unknown",
    name: user?.name ?? "Participant",
    picture: user?.picture ?? null,
    department: user?.department ?? null,
    score: item.row.score,
    challengesSolved: item.row.challengesSolved,
    achievedAt: item.row.achievedAt && item.row.achievedAt.getTime() < NEVER.getTime() ? item.row.achievedAt : null,
    submissionCount: item.row.submissionCount,
    lastSubmissionAt: item.row.lastSubmissionAt ?? null,
    qualification: item.row.qualification.status,
    inQualifyingPosition: topN !== null && item.rank <= topN && eligibleToQualify,
  };
}

async function hydrate(items: Ranked<RankableRow>[], round: RoundDocument): Promise<LeaderboardEntry[]> {
  if (items.length === 0) return [];
  const users = await User.find({ _id: { $in: items.map((item) => item.row.userId) } })
    .select("publicId name picture department")
    .lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));
  return items.map((item) => toEntry(item, byId.get(item.userId), round));
}

export async function getLeaderboardPage(
  round: RoundDocument,
  event: EventDocument,
  options: { offset?: number; limit?: number; forUserId?: string; fresh?: boolean } = {},
): Promise<LeaderboardPage> {
  const ranking = await getRoundRanking(round, event, { fresh: options.fresh });
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const slice = ranking.entries.slice(offset, offset + limit);
  const mine = options.forUserId ? ranking.entries.find((item) => item.userId === options.forUserId) : undefined;
  const hydrated = await hydrate(mine && !slice.includes(mine) ? [...slice, mine] : slice, round);
  const entries = hydrated.slice(0, slice.length);
  const me = mine ? (hydrated[slice.includes(mine) ? slice.indexOf(mine) : hydrated.length - 1] ?? null) : null;
  return {
    roundId: ranking.roundId,
    roundNumber: round.number,
    seq: ranking.seq,
    generatedAt: ranking.generatedAt,
    finalized: ranking.finalized,
    total: ranking.entries.length,
    offset,
    limit,
    cutoff: { topN: round.qualification.topN, minScore: round.qualification.minScore },
    entries,
    me,
  };
}

export async function getStanding(round: RoundDocument, event: EventDocument, userId: string) {
  const ranking = await getRoundRanking(round, event);
  const item = ranking.entries.find((entry) => entry.userId === userId);
  if (!item) return null;
  return { rank: item.rank, total: ranking.entries.length, row: item.row };
}

// ---------------------------------------------------------------------------------------------
// Event-wide standings
// ---------------------------------------------------------------------------------------------

export interface EventStandingEntry {
  rank: number;
  participantId: string;
  name: string;
  picture: string | null;
  department: string | null;
  /** Deepest round the participant has reached (a qualification in round N means they reached N+1). */
  reachedRound: number;
  totalScore: number;
  rounds: Array<{ number: number; score: number; rank: number | null; qualification: "pending" | "qualified" | "eliminated" | "finalist" }>;
}

/**
 * Overall standings. Participants who advanced further rank above those eliminated earlier;
 * within the same depth, the ranking of that round (final if finalized, otherwise provisional) decides.
 */
export async function getEventStandings(
  event: EventDocument,
  rounds: RoundDocument[],
  options: { limit?: number; offset?: number; forUserId?: string } = {},
): Promise<{ total: number; entries: EventStandingEntry[]; me: EventStandingEntry | null }> {
  const rankings = new Map<number, Map<string, number>>();
  const resultsByUser = new Map<string, Map<number, { score: number; qualification: EventStandingEntry["rounds"][number]["qualification"]; userId: string }>>();
  for (const round of rounds) {
    const ranking = await getRoundRanking(round, event);
    rankings.set(round.number, new Map(ranking.entries.map((entry) => [entry.userId, entry.rank])));
    for (const entry of ranking.entries) {
      const perUser = resultsByUser.get(entry.userId) ?? new Map();
      perUser.set(round.number, { score: entry.row.score, qualification: entry.row.qualification.status, userId: entry.userId });
      resultsByUser.set(entry.userId, perUser);
    }
  }
  const lastRound = Math.max(0, ...rounds.map((round) => round.number));
  const candidates = [...resultsByUser.entries()].map(([userId, perRound]) => {
    let reached = 1;
    for (const [number, result] of perRound) {
      reached = Math.max(reached, result.qualification === "qualified" ? Math.min(number + 1, lastRound) : number);
    }
    const rankInReached = rankings.get(reached)?.get(userId) ?? Number.MAX_SAFE_INTEGER;
    return { userId, reached, rankInReached, perRound };
  });
  candidates.sort((a, b) => b.reached - a.reached || a.rankInReached - b.rankInReached || (a.userId < b.userId ? -1 : 1));

  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const wanted = candidates.slice(offset, offset + limit);
  const mineIndex = options.forUserId ? candidates.findIndex((c) => c.userId === options.forUserId) : -1;
  const ids = new Set(wanted.map((c) => c.userId));
  if (mineIndex >= 0) ids.add(candidates[mineIndex]!.userId);
  const users = await User.find({ _id: { $in: [...ids] } })
    .select("publicId name picture department")
    .lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));
  const build = (candidate: (typeof candidates)[number], index: number): EventStandingEntry => {
    const user = byId.get(candidate.userId);
    return {
      rank: index + 1,
      participantId: user?.publicId ?? "unknown",
      name: user?.name ?? "Participant",
      picture: user?.picture ?? null,
      department: user?.department ?? null,
      reachedRound: candidate.reached,
      totalScore: [...candidate.perRound.values()].reduce((sum, r) => sum + r.score, 0),
      rounds: [...candidate.perRound.entries()]
        .sort(([a], [b]) => a - b)
        .map(([number, r]) => ({ number, score: r.score, rank: rankings.get(number)?.get(candidate.userId) ?? null, qualification: r.qualification })),
    };
  };
  return {
    total: candidates.length,
    entries: wanted.map((candidate, i) => build(candidate, offset + i)),
    me: mineIndex >= 0 ? build(candidates[mineIndex]!, mineIndex) : null,
  };
}
