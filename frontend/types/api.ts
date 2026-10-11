/**
 * API contract types. These mirror the JSON returned by the Express backend
 * (`/api/v1`). Dates arrive as ISO strings.
 */

export interface ApiEnvelope<T> {
  data: T;
  meta?: PaginationMeta & Record<string, unknown>;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export type UserRole = "participant" | "admin";

export interface SelfUser {
  id: string;
  publicId: string;
  name: string;
  email: string;
  picture: string | null;
  collegeStatus: "verified" | "unverified" | "not_required";
  rollNumber: string | null;
  department: string | null;
  profileCompletedAt: string | null;
  role: UserRole;
  status: "active" | "suspended" | "banned";
  createdAt: string;
  lastLoginAt: string | null;
}

export interface MeResponse {
  user: SelfUser;
  csrfToken: string;
  sessionExpiresAt: string;
}

export interface AuthConfig {
  googleConfigured: boolean;
  missingConfig: string[];
  collegeEmailDomains: string[];
}

export type EventStatus = "draft" | "registration" | "live" | "paused" | "finalized";

export interface ScoringPolicyDto {
  version: number;
  maxScorePerChallenge: number;
  fullCorrectnessBonus: number;
  timePenaltyIntervalSeconds: number;
  timePenaltyPoints: number;
  maxTimePenalty: number;
  tieBreakers: Array<"earliest_achieved" | "fewer_submissions">;
}

export interface EventDto {
  id: string;
  name: string;
  slug: string;
  description: string;
  rules: string;
  status: EventStatus;
  startsAt: string | null;
  endsAt: string | null;
  maxParticipants: number | null;
  registeredCount: number;
  profileRequirements: { rollNumber: boolean; department: boolean };
  scoring: ScoringPolicyDto;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // administrator-only
  allowedEmailDomains?: string[];
  premise?: { setting: string; tone: string; characters: string[]; notes: string };
}

export type RoundPhase = "draft" | "upcoming" | "open" | "paused" | "closed" | "finalized";
export type RoundAccess =
  | "locked"
  | "upcoming"
  | "available"
  | "in_progress"
  | "submitted"
  | "qualified"
  | "eliminated"
  | "completed";
export type QualificationStatus = "pending" | "qualified" | "eliminated" | "finalist";

export interface ParticipantRound {
  id: string;
  number: number;
  name: string;
  description: string;
  storyChapter: string;
  difficulty: "basic" | "intermediate" | "advanced";
  startsAt: string | null;
  endsAt: string | null;
  phase: RoundPhase;
  phaseReason: string;
  access: RoundAccess;
  lockedReason: string | null;
  challengeCount: number;
  qualification: { topN: number | null; minScore: number };
  countdown: { kind: "starts" | "ends"; at: string } | null;
  me: {
    score: number;
    challengesSolved: number;
    submissionCount: number;
    rank: number | null;
    participants: number;
    qualification: QualificationStatus;
    finalRank: number | null;
  } | null;
}

export interface LeaderboardEntry {
  rank: number;
  participantId: string;
  name: string;
  picture: string | null;
  department: string | null;
  score: number;
  challengesSolved: number;
  achievedAt: string | null;
  submissionCount: number;
  lastSubmissionAt: string | null;
  qualification: QualificationStatus;
  inQualifyingPosition: boolean;
}

export interface LeaderboardPage {
  roundId: string;
  roundNumber: number;
  seq: number;
  generatedAt: string;
  finalized: boolean;
  total: number;
  offset: number;
  limit: number;
  cutoff: { topN: number | null; minScore: number };
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  roundName?: string;
}

export interface Dashboard {
  serverTime: string;
  event: EventDto;
  registration: { status: "registered" | "withdrawn" | "disqualified"; registeredAt: string } | null;
  profile: { complete: boolean; missing: string[] };
  currentRoundNumber: number | null;
  rounds: ParticipantRound[];
  leaderboardPreview: LeaderboardPage | null;
}
