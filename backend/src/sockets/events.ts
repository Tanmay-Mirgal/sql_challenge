import { z } from "zod";

/**
 * Socket.IO wire contract (see README → "Socket.IO events").
 *
 * Client → server (acknowledged):
 *   subscribe   { channel: "event" | "round" | "admin", id?: string }  → { ok, code?, message? }
 *   unsubscribe { channel, id? }
 *
 * Server → client:
 *   leaderboard:snapshot  LeaderboardPayload    sent to the subscriber right after `subscribe` (round channel)
 *   leaderboard:updated   LeaderboardPayload    broadcast to the round room after results change (coalesced)
 *   submission:updated    SubmissionUpdatedPayload   to the submitting user only
 *   participant:updated   ParticipantUpdatedPayload  to the affected user only (rank / qualification)
 *   round:updated         RoundUpdatedPayload   to the event room (phase/status changes, finalization)
 *   event:updated         EventUpdatedPayload   to the event room
 *   admin:activity        AdminActivityPayload  to the admin room only
 *
 * Clients never send scores, ranks, identities or room names that the server trusts:
 * every subscription is authorised against the database, and nothing a client emits
 * can mutate competition state.
 */
export const subscribeSchema = z.strictObject({
  channel: z.enum(["event", "round", "admin"]),
  id: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
});
export type SubscribeRequest = z.infer<typeof subscribeSchema>;

export type SocketAck = { ok: true; snapshot?: unknown } | { ok: false; code: string; message: string };

export const SOCKET_EVENTS = {
  leaderboardSnapshot: "leaderboard:snapshot",
  leaderboardUpdated: "leaderboard:updated",
  submissionUpdated: "submission:updated",
  participantUpdated: "participant:updated",
  roundUpdated: "round:updated",
  eventUpdated: "event:updated",
  adminActivity: "admin:activity",
} as const;
