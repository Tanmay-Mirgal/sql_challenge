import type { Types } from "mongoose";
import { Registration } from "@/modules/events/event.model";
import { RoundResult } from "@/modules/leaderboard/round-result.model";
import type { UserDocument } from "@/modules/users/user.model";
import type { RoundContext } from "./round-context";

export type IneligibleReason =
  | "account_disabled"
  | "not_registered"
  | "disqualified"
  | "previous_round_pending"
  | "not_qualified";

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
}

/**
 * Server-side round eligibility. Round 1 is open to every registered, active
 * participant; later rounds require a *finalized* qualification from the
 * previous round. Provisional (live) ranks never grant access.
 */
export async function checkEligibility(
  user: Pick<UserDocument, "_id" | "status">,
  ctx: Pick<RoundContext, "event" | "round" | "previousRound">,
): Promise<Eligibility> {
  if (user.status !== "active") return { eligible: false, reason: "account_disabled" };
  const registration = await Registration.findOne({ eventId: ctx.event._id, userId: user._id });
  if (!registration || registration.status === "withdrawn") return { eligible: false, reason: "not_registered" };
  if (registration.status === "disqualified") return { eligible: false, reason: "disqualified" };
  if (ctx.round.number === 1) return { eligible: true };

  if (!ctx.previousRound?.finalization.finalizedAt) return { eligible: false, reason: "previous_round_pending" };
  const previous = await RoundResult.findOne({ roundId: ctx.previousRound._id, userId: user._id }).select("qualification.status");
  return previous?.qualification.status === "qualified" ? { eligible: true } : { eligible: false, reason: "not_qualified" };
}

/** Participants (as ids) allowed into a round once the previous one is finalized. */
export async function qualifiedUserIds(previousRoundId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const rows = await RoundResult.find({ roundId: previousRoundId, "qualification.status": "qualified" }).select("userId").lean();
  return rows.map((row) => row.userId);
}
