import { type EventDocument, Registration } from "@/modules/events/event.model";
import { toEventDto } from "@/modules/events/events.service";
import { getLeaderboardPage, getRoundRanking } from "@/modules/leaderboard/leaderboard.service";
import { RoundResult } from "@/modules/leaderboard/round-result.model";
import type { UserDocument } from "@/modules/users/user.model";
import { now } from "@/utils/clock";
import { Round, type RoundDocument } from "./round.model";
import { resolvePhase } from "./round-context";
import { type Eligibility, checkEligibility, type IneligibleReason } from "./eligibility";
import type { PhaseReason, RoundPhase } from "./round-state";

export type RoundAccess =
  | "locked"
  | "upcoming"
  | "available"
  | "in_progress"
  | "submitted"
  | "qualified"
  | "eliminated"
  | "completed";

export type LockedReason = IneligibleReason | "not_published";

export function deriveAccess(input: {
  phase: RoundPhase;
  eligibility: Eligibility;
  hasSubmissions: boolean;
  qualification?: "pending" | "qualified" | "eliminated" | "finalist";
}): { access: RoundAccess; lockedReason: LockedReason | null } {
  const { phase, eligibility, hasSubmissions, qualification } = input;
  if (phase === "draft") return { access: "locked", lockedReason: "not_published" };
  if (!eligibility.eligible) return { access: "locked", lockedReason: eligibility.reason ?? "not_registered" };
  switch (phase) {
    case "finalized":
      if (qualification === "qualified") return { access: "qualified", lockedReason: null };
      if (qualification === "eliminated") return { access: "eliminated", lockedReason: null };
      return { access: "completed", lockedReason: null };
    case "closed":
      return { access: hasSubmissions ? "submitted" : "completed", lockedReason: null };
    case "open":
    case "paused":
      return { access: hasSubmissions ? "in_progress" : "available", lockedReason: null };
    default:
      return { access: "upcoming", lockedReason: null };
  }
}

export interface ParticipantRoundView {
  id: string;
  number: number;
  name: string;
  description: string;
  storyChapter: string;
  difficulty: string;
  startsAt: Date | null;
  endsAt: Date | null;
  phase: RoundPhase;
  phaseReason: PhaseReason;
  access: RoundAccess;
  lockedReason: LockedReason | null;
  challengeCount: number;
  qualification: { topN: number | null; minScore: number };
  countdown: { kind: "starts" | "ends"; at: Date } | null;
  me: {
    score: number;
    challengesSolved: number;
    submissionCount: number;
    rank: number | null;
    participants: number;
    qualification: "pending" | "qualified" | "eliminated" | "finalist";
    finalRank: number | null;
  } | null;
}

function countdownFor(round: RoundDocument, phase: RoundPhase, at: Date): ParticipantRoundView["countdown"] {
  if (phase === "upcoming" && round.startsAt && round.startsAt > at) return { kind: "starts", at: round.startsAt };
  if (phase === "open" && round.endsAt) return { kind: "ends", at: round.endsAt };
  return null;
}

export async function buildParticipantRounds(
  user: UserDocument,
  event: EventDocument,
  at: Date = now(),
): Promise<{ views: ParticipantRoundView[]; rounds: RoundDocument[] }> {
  const rounds = await Round.find({ eventId: event._id }).sort({ number: 1 });
  const results = await RoundResult.find({ eventId: event._id, userId: user._id });
  const resultByRound = new Map(results.map((result) => [String(result.roundId), result]));

  const views: ParticipantRoundView[] = [];
  for (const round of rounds) {
    const previousRound = rounds.find((candidate) => candidate.number === round.number - 1) ?? null;
    const phase = resolvePhase(event, round, previousRound, at);
    const eligibility = await checkEligibility(user, { event, round, previousRound });
    const result = resultByRound.get(String(round._id));
    const { access, lockedReason } = deriveAccess({
      phase: phase.phase,
      eligibility,
      hasSubmissions: (result?.submissionCount ?? 0) > 0,
      qualification: result?.qualification.status,
    });
    let me: ParticipantRoundView["me"] = null;
    if (eligibility.eligible && phase.phase !== "draft") {
      const ranking = await getRoundRanking(round, event);
      const mine = ranking.entries.find((entry) => entry.userId === String(user._id));
      me = {
        score: result?.score ?? 0,
        challengesSolved: result?.challengesSolved ?? 0,
        submissionCount: result?.submissionCount ?? 0,
        rank: mine?.rank ?? null,
        participants: ranking.entries.length,
        qualification: result?.qualification.status ?? "pending",
        finalRank: result?.qualification.finalRank ?? null,
      };
    }
    views.push({
      id: round.id as string,
      number: round.number,
      name: round.name,
      description: round.description,
      storyChapter: round.storyChapter,
      difficulty: round.difficulty,
      startsAt: round.startsAt ?? null,
      endsAt: round.endsAt ?? null,
      phase: phase.phase,
      phaseReason: phase.reason,
      access,
      lockedReason,
      challengeCount: round.publishedChallengeIds.length,
      qualification: { topN: round.qualification.topN, minScore: round.qualification.minScore },
      countdown: countdownFor(round, phase.phase, at),
      me,
    });
  }
  return { views, rounds };
}

export async function buildDashboard(user: UserDocument, event: EventDocument) {
  const at = now();
  const registration = await Registration.findOne({ eventId: event._id, userId: user._id });
  const { views, rounds } = await buildParticipantRounds(user, event, at);

  const missing: string[] = [];
  if (event.profileRequirements.rollNumber && !user.rollNumber) missing.push("rollNumber");
  if (event.profileRequirements.department && !user.department) missing.push("department");

  const current =
    views.find((view) => view.phase === "open") ??
    views.find((view) => view.phase === "paused") ??
    views.find((view) => view.phase === "upcoming" && view.access !== "locked") ??
    [...views].reverse().find((view) => view.phase === "finalized" || view.phase === "closed") ??
    null;

  const previewView =
    views.find((view) => view.phase === "open") ??
    [...views].reverse().find((view) => view.phase === "finalized" || view.phase === "closed" || view.phase === "paused") ??
    null;
  let leaderboardPreview = null;
  if (previewView) {
    const round = rounds.find((candidate) => candidate.id === previewView.id);
    if (round) {
      const page = await getLeaderboardPage(round, event, { limit: 5, forUserId: String(user._id) });
      leaderboardPreview = { ...page, roundName: round.name };
    }
  }

  return {
    serverTime: at,
    event: toEventDto(event),
    registration: registration ? { status: registration.status, registeredAt: registration.registeredAt } : null,
    profile: { complete: missing.length === 0, missing },
    currentRoundNumber: current?.number ?? null,
    rounds: views,
    leaderboardPreview,
  };
}
