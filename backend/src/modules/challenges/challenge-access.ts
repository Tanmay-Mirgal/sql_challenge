import { checkEligibility } from "@/modules/rounds/eligibility";
import { loadRoundContext, type RoundContext } from "@/modules/rounds/round-context";
import type { UserDocument } from "@/modules/users/user.model";
import { Errors } from "@/utils/errors";
import { type ChallengeDocument } from "./challenge.model";
import { getChallengeOrThrow } from "./challenge.service";

export type ChallengeAction = "view" | "run" | "submit";

export interface AuthorizedChallenge {
  challenge: ChallengeDocument;
  ctx: RoundContext;
}

/**
 * The single gate for every participant-facing challenge operation. A fabricated URL or API
 * request cannot bypass it: each call re-derives access from the database and the server clock.
 *
 *   authenticated (caller) → account active → challenge published & in this round →
 *   event registration → round eligibility (qualification) → round phase allows the action
 */
export async function authorizeChallenge(user: UserDocument, challengeId: string, action: ChallengeAction): Promise<AuthorizedChallenge> {
  if (user.status !== "active") throw Errors.forbidden("Your account cannot take part in the competition.", "ACCOUNT_DISABLED");

  const challenge = await getChallengeOrThrow(challengeId);
  // Unpublished (draft/archived) challenges do not exist as far as participants are concerned.
  if (challenge.status !== "published") throw Errors.notFound("Challenge not found.", "CHALLENGE_NOT_FOUND");

  const ctx = await loadRoundContext(String(challenge.roundId));
  if (!ctx.round.publishedChallengeIds.some((id) => id.equals(challenge._id))) {
    throw Errors.notFound("Challenge not found.", "CHALLENGE_NOT_FOUND");
  }
  if (ctx.event.status === "draft") throw Errors.notFound("Challenge not found.", "CHALLENGE_NOT_FOUND");

  const eligibility = await checkEligibility(user, ctx);
  if (!eligibility.eligible) {
    switch (eligibility.reason) {
      case "not_registered":
        throw Errors.forbidden("Register for the event to access this round.", "NOT_REGISTERED");
      case "disqualified":
        throw Errors.forbidden("You have been disqualified from this event.", "DISQUALIFIED");
      case "previous_round_pending":
        throw Errors.forbidden("This round unlocks once the previous round is finalized.", "ROUND_LOCKED");
      case "not_qualified":
        throw Errors.forbidden("You did not qualify for this round.", "NOT_QUALIFIED");
      default:
        throw Errors.forbidden("You cannot access this round.", "ACCOUNT_DISABLED");
    }
  }

  const { phase } = ctx.phase;
  if (action === "view") {
    if (phase === "draft" || phase === "upcoming") throw Errors.forbidden("This round has not started yet.", "ROUND_NOT_OPEN");
    return { challenge, ctx };
  }
  switch (phase) {
    case "open":
      return { challenge, ctx };
    case "paused":
      throw Errors.conflict("The round is paused. Submissions resume when an organiser reopens it.", "ROUND_PAUSED");
    case "closed":
    case "finalized":
      throw Errors.conflict("This round has ended; no more runs or submissions are accepted.", "ROUND_CLOSED");
    default:
      throw Errors.forbidden("This round has not started yet.", "ROUND_NOT_OPEN");
  }
}
