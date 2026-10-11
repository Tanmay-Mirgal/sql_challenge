import type { EventStatus } from "@/modules/events/event.model";
import type { IRound } from "./round.model";

/**
 * Effective phase of a round. This is what every access check uses — it combines
 * the persisted status, the event status, the schedule and the server clock, so
 * enforcement never depends on a background job having run.
 *
 *  draft      – not configured/published yet
 *  upcoming   – scheduled, but not open yet (or blocked: see `reason`)
 *  open       – accepting runs and submissions
 *  paused     – temporarily frozen by an administrator or because the event is paused
 *  closed     – window ended or closed by an administrator; results not finalized yet
 *  finalized  – rankings and qualifications are final and immutable
 */
export type RoundPhase = "draft" | "upcoming" | "open" | "paused" | "closed" | "finalized";

export type PhaseReason =
  | "not_configured"
  | "not_started"
  | "event_not_live"
  | "event_paused"
  | "awaiting_previous_round"
  | "paused_by_admin"
  | "window_ended"
  | "closed_by_admin"
  | "finalized"
  | "in_window";

export interface RoundPhaseInput {
  eventStatus: EventStatus;
  round: Pick<IRound, "status" | "startsAt" | "endsAt" | "finalization">;
  /** True for round 1, or when the previous round has been finalized. */
  previousRoundFinalized: boolean;
  now: Date;
}

export interface RoundPhaseResult {
  phase: RoundPhase;
  reason: PhaseReason;
}

export function computeRoundPhase(input: RoundPhaseInput): RoundPhaseResult {
  const { eventStatus, round, previousRoundFinalized, now } = input;
  const t = now.getTime();
  const starts = round.startsAt?.getTime() ?? null;
  const ends = round.endsAt?.getTime() ?? null;

  if (round.finalization?.finalizedAt) return { phase: "finalized", reason: "finalized" };
  if (round.status === "draft") return { phase: "draft", reason: "not_configured" };
  if (round.status === "completed") return { phase: "closed", reason: "closed_by_admin" };
  if (ends !== null && t >= ends) return { phase: "closed", reason: "window_ended" };
  if (eventStatus === "finalized") return { phase: "closed", reason: "closed_by_admin" };
  if (round.status === "paused") return { phase: "paused", reason: "paused_by_admin" };
  if (eventStatus === "paused") return { phase: "paused", reason: "event_paused" };
  if (eventStatus !== "live") return { phase: "upcoming", reason: "event_not_live" };
  if (!previousRoundFinalized) return { phase: "upcoming", reason: "awaiting_previous_round" };
  if (round.status === "scheduled" && (starts === null || t < starts)) return { phase: "upcoming", reason: "not_started" };
  // status === "active" (or a scheduled round whose start time has passed)
  return { phase: "open", reason: "in_window" };
}

/** Does the persisted status need to change to reflect the effective phase? Used by the scheduler job. */
export function desiredStatus(current: IRound["status"], result: RoundPhaseResult): IRound["status"] {
  if (current === "scheduled" && result.phase === "open") return "active";
  if ((current === "active" || current === "paused" || current === "scheduled") && result.phase === "closed") return "completed";
  return current;
}
