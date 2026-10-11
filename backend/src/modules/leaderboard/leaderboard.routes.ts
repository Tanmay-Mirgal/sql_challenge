import type { Request, Response } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { Registration } from "@/modules/events/event.model";
import { getActiveEvent, getEventOrThrow } from "@/modules/events/events.service";
import { loadRoundContext, resolvePhase } from "@/modules/rounds/round-context";
import { Round } from "@/modules/rounds/round.model";
import { Errors } from "@/utils/errors";
import { now } from "@/utils/clock";
import { ok } from "@/utils/http";
import { getEventStandings, getLeaderboardPage, getRoundRanking } from "./leaderboard.service";
import { RoundResult } from "./round-result.model";

const pageQuery = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Registered participants (and administrators) may watch leaderboards; nobody else. */
async function assertCanWatch(req: Request, eventId: Types.ObjectId): Promise<void> {
  const user = req.auth!.user;
  if (user.role === "admin") return;
  const registration = await Registration.findOne({ eventId, userId: user._id });
  if (!registration || registration.status === "withdrawn") {
    throw Errors.forbidden("Register for the event to view its leaderboard.", "NOT_REGISTERED");
  }
}

export async function roundLeaderboardHandler(req: Request, res: Response): Promise<void> {
  const ctx = await loadRoundContext(String(req.params.roundId));
  if (ctx.event.status === "draft" || ctx.phase.phase === "draft") throw Errors.notFound("Round not found.", "ROUND_NOT_FOUND");
  await assertCanWatch(req, ctx.event._id);
  const query = pageQuery.parse(req.query);
  const page = await getLeaderboardPage(ctx.round, ctx.event, { ...query, forUserId: String(req.auth!.user._id) });
  ok(res, { leaderboard: page, round: { id: ctx.round.id as string, number: ctx.round.number, name: ctx.round.name, phase: ctx.phase.phase }, serverTime: ctx.now });
}

export async function eventLeaderboardHandler(req: Request, res: Response): Promise<void> {
  const event = await getEventOrThrow(String(req.params.eventId));
  if (event.status === "draft") throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
  await assertCanWatch(req, event._id);
  const rounds = await Round.find({ eventId: event._id }).sort({ number: 1 });
  const query = pageQuery.parse(req.query);
  const standings = await getEventStandings(event, rounds, { ...query, forUserId: String(req.auth!.user._id) });
  ok(res, { event: { id: event.id as string, name: event.name, status: event.status }, ...standings });
}

/** The signed-in participant's own results across all rounds. */
export async function myResultsHandler(req: Request, res: Response): Promise<void> {
  const user = req.auth!.user;
  const event = await getActiveEvent();
  if (!event) return ok(res, { event: null, rounds: [] });
  const rounds = await Round.find({ eventId: event._id }).sort({ number: 1 });
  const results = await RoundResult.find({ eventId: event._id, userId: user._id });
  const byRound = new Map(results.map((result) => [String(result.roundId), result]));
  const at = now();
  const items = [];
  for (const round of rounds) {
    const previous = rounds.find((candidate) => candidate.number === round.number - 1) ?? null;
    const phase = resolvePhase(event, round, previous, at);
    const result = byRound.get(String(round._id));
    const ranking = result ? await getRoundRanking(round, event) : null;
    const mine = ranking?.entries.find((entry) => entry.userId === String(user._id));
    items.push({
      roundId: round.id as string,
      number: round.number,
      name: round.name,
      phase: phase.phase,
      participated: Boolean(result),
      score: result?.score ?? 0,
      challengesSolved: result?.challengesSolved ?? 0,
      submissionCount: result?.submissionCount ?? 0,
      achievedAt: result?.achievedAt && result.achievedAt.getTime() < 8e15 ? result.achievedAt : null,
      rank: result?.qualification.finalRank ?? mine?.rank ?? null,
      participants: ranking?.entries.length ?? 0,
      qualification: result?.qualification.status ?? "pending",
      tieBreakApplied: result?.qualification.tieBreakApplied ?? null,
      finalized: Boolean(round.finalization.finalizedAt),
      finalizedAt: round.finalization.finalizedAt ?? null,
      cutoff: round.qualification.topN,
      scoringPolicyVersion: result?.qualification.scoringPolicyVersion ?? null,
      challenges: (result?.challengeBests ?? []).map((best) => ({ challengeId: String(best.challengeId), score: best.score, fullyCorrect: best.fullyCorrect })),
    });
  }
  ok(res, { event: { id: event.id as string, name: event.name, status: event.status }, rounds: items });
}

/** Final results of a finished round / event: the immutable snapshot, visible to registered participants. */
export async function eventResultsHandler(req: Request, res: Response): Promise<void> {
  const event = await getEventOrThrow(String(req.params.eventId));
  if (event.status === "draft") throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
  await assertCanWatch(req, event._id);
  const rounds = await Round.find({ eventId: event._id, "finalization.finalizedAt": { $ne: null } }).sort({ number: 1 });
  const out = [];
  for (const round of rounds) {
    const page = await getLeaderboardPage(round, event, { limit: 200, forUserId: String(req.auth!.user._id) });
    out.push({
      roundId: round.id as string,
      number: round.number,
      name: round.name,
      finalizedAt: round.finalization.finalizedAt,
      participants: round.finalization.participants,
      qualified: round.finalization.qualified,
      entries: page.entries,
      me: page.me,
    });
  }
  const allRounds = await Round.find({ eventId: event._id }).sort({ number: 1 });
  const winners =
    event.status === "finalized"
      ? (await getEventStandings(event, allRounds, { limit: 3, forUserId: String(req.auth!.user._id) })).entries
      : [];
  ok(res, { event: { id: event.id as string, name: event.name, status: event.status }, rounds: out, podium: winners });
}
