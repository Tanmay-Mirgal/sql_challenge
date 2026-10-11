/**
 * Imports every Mongoose model so they are registered (and their indexes can be
 * synchronised) regardless of which modules the current entry point touches.
 *
 * Consistency strategy (see README "Data model"):
 *  - Submissions and RoundResults reference users/rounds/challenges by id; display
 *    fields (names, avatars) are looked up at read time so profile edits propagate.
 *  - Round.publishedChallengeIds and Event.registeredCount are deliberate
 *    denormalisations, updated by the same service call that changes the source of
 *    truth, and verifiable by `RoundResult`/`Challenge` queries.
 *  - RoundResult is a derived aggregate: it is always recomputed from Submissions
 *    (idempotent, order independent) and protected by an optimistic revision.
 *  - After finalization, RoundResult.qualification is an immutable snapshot.
 */
export * from "@/modules/users/user.model";
export * from "@/modules/auth/session.model";
export * from "@/modules/admin/audit-log.model";
export * from "@/modules/events/event.model";
export * from "@/modules/rounds/round.model";
export * from "@/modules/challenges/challenge.model";
export * from "@/modules/submissions/submission.model";
export * from "@/modules/leaderboard/round-result.model";
export * from "@/modules/ai-generation/generation-run.model";
