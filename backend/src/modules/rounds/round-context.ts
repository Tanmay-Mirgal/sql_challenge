import { Types } from "mongoose";
import { EventModel, type EventDocument } from "@/modules/events/event.model";
import { now as serverNow } from "@/utils/clock";
import { Errors } from "@/utils/errors";
import { Round, type RoundDocument } from "./round.model";
import { computeRoundPhase, type RoundPhaseResult } from "./round-state";

export interface RoundContext {
  event: EventDocument;
  round: RoundDocument;
  previousRound: RoundDocument | null;
  phase: RoundPhaseResult;
  now: Date;
}

export function isValidObjectId(value: string): boolean {
  return Types.ObjectId.isValid(value) && String(new Types.ObjectId(value)) === value.toLowerCase();
}

/** Loads a round with its event and previous round, and resolves the effective phase from the server clock. */
export async function loadRoundContext(roundId: string, at: Date = serverNow()): Promise<RoundContext> {
  if (!isValidObjectId(roundId)) throw Errors.notFound("Round not found.", "ROUND_NOT_FOUND");
  const round = await Round.findById(roundId);
  if (!round) throw Errors.notFound("Round not found.", "ROUND_NOT_FOUND");
  const event = await EventModel.findById(round.eventId);
  if (!event) throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
  const previousRound =
    round.number > 1 ? await Round.findOne({ eventId: round.eventId, number: round.number - 1 }) : null;
  return {
    event,
    round,
    previousRound,
    now: at,
    phase: resolvePhase(event, round, previousRound, at),
  };
}

export function resolvePhase(
  event: EventDocument,
  round: RoundDocument,
  previousRound: RoundDocument | null,
  at: Date,
): RoundPhaseResult {
  return computeRoundPhase({
    eventStatus: event.status,
    round,
    previousRoundFinalized: round.number === 1 ? true : Boolean(previousRound?.finalization?.finalizedAt),
    now: at,
  });
}
