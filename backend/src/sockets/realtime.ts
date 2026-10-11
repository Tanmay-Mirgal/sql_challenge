/**
 * Narrow publishing interface used by services. The Socket.IO implementation is
 * installed at start-up (see sockets/index.ts); until then — and in unit tests —
 * a no-op implementation is used so domain code never depends on Socket.IO.
 */
export interface RoundUpdatedPayload {
  eventId: string;
  roundId: string;
  roundNumber: number;
  phase: string;
  status: string;
  finalized: boolean;
  at: string;
}

export interface EventUpdatedPayload {
  eventId: string;
  status: string;
  at: string;
}

export interface SubmissionUpdatedPayload {
  submissionId: string;
  challengeId: string;
  roundId: string;
  status: string;
  verdict: string | null;
  score: number;
  passedTests: number;
  totalTests: number;
}

export interface ParticipantUpdatedPayload {
  roundId: string;
  roundNumber: number;
  reason: "qualification" | "result";
  qualification?: string;
  rank?: number | null;
  score?: number;
}

export interface AdminActivityPayload {
  kind: "submission" | "generation" | "finalization";
  at: string;
  detail: Record<string, unknown>;
}

export interface Realtime {
  /** Round results changed: recompute and broadcast the leaderboard (debounced by the implementation). */
  leaderboardChanged(roundId: string): void;
  roundUpdated(payload: RoundUpdatedPayload): void;
  eventUpdated(payload: EventUpdatedPayload): void;
  submissionUpdated(userId: string, payload: SubmissionUpdatedPayload): void;
  participantUpdated(userId: string, payload: ParticipantUpdatedPayload): void;
  adminActivity(payload: AdminActivityPayload): void;
  /** The user logged out / was suspended: close their live connections. */
  userSignedOut(userId: string): void;
}

class NoopRealtime implements Realtime {
  leaderboardChanged(): void {}
  roundUpdated(): void {}
  eventUpdated(): void {}
  submissionUpdated(): void {}
  participantUpdated(): void {}
  adminActivity(): void {}
  userSignedOut(): void {}
}

let current: Realtime = new NoopRealtime();

export const realtime: Realtime = {
  leaderboardChanged: (roundId) => current.leaderboardChanged(roundId),
  roundUpdated: (payload) => current.roundUpdated(payload),
  eventUpdated: (payload) => current.eventUpdated(payload),
  submissionUpdated: (userId, payload) => current.submissionUpdated(userId, payload),
  participantUpdated: (userId, payload) => current.participantUpdated(userId, payload),
  adminActivity: (payload) => current.adminActivity(payload),
  userSignedOut: (userId) => current.userSignedOut(userId),
};

export function setRealtime(impl: Realtime | undefined): void {
  current = impl ?? new NoopRealtime();
}
