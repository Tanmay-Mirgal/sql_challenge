import { type HydratedDocument, model, Schema, type Types } from "mongoose";

export const ROUND_NUMBERS = [1, 2, 3] as const;
export type RoundNumber = (typeof ROUND_NUMBERS)[number];

export const ROUND_DIFFICULTIES = ["basic", "intermediate", "advanced"] as const;
export type RoundDifficulty = (typeof ROUND_DIFFICULTIES)[number];

/** Persisted lifecycle state. The *effective* phase also depends on time and the event (see round-state.ts). */
export const ROUND_STATUSES = ["draft", "scheduled", "active", "paused", "completed"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export interface IRound {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  number: number;
  name: string;
  description: string;
  /** Narrative chapter summary shown on the dashboard (set from the published challenges / by an admin). */
  storyChapter: string;
  difficulty: RoundDifficulty;
  status: RoundStatus;
  startsAt?: Date | null;
  endsAt?: Date | null;
  qualification: {
    /** Number of participants that advance from this round (null for the final round). */
    topN: number | null;
    /** Minimum round score required to qualify, even when inside topN. */
    minScore: number;
  };
  submissionLimit: {
    /** Maximum counted submissions per participant per challenge. */
    perChallenge: number;
  };
  /**
   * Denormalised references to the currently published challenge version of each
   * lineage. Maintained by the publish workflow; challenges remain the source of truth.
   */
  publishedChallengeIds: Types.ObjectId[];
  pausedAt?: Date | null;
  /** Total time the round has spent paused; excluded from elapsed-time scoring. */
  pausedMs: number;
  finalization: {
    /** Lease used to make concurrent finalization attempts safe. */
    lockedUntil?: Date | null;
    lockToken?: string | null;
    finalizedAt?: Date | null;
    finalizedBy?: Types.ObjectId | null;
    scoringPolicyVersion?: number | null;
    participants?: number | null;
    qualified?: number | null;
    /** Hash of the final ordered ranking, stored as proof of the immutable snapshot. */
    snapshotHash?: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const roundSchema = new Schema<IRound>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    number: { type: Number, enum: ROUND_NUMBERS, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 4000 },
    storyChapter: { type: String, default: "", maxlength: 4000 },
    difficulty: { type: String, enum: ROUND_DIFFICULTIES, required: true },
    status: { type: String, enum: ROUND_STATUSES, default: "draft", required: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    qualification: {
      topN: { type: Number, default: null, min: 1 },
      minScore: { type: Number, default: 1, min: 0 },
    },
    submissionLimit: {
      perChallenge: { type: Number, default: 50, min: 1, max: 1000 },
    },
    publishedChallengeIds: { type: [Schema.Types.ObjectId], ref: "Challenge", default: [] },
    pausedAt: { type: Date, default: null },
    pausedMs: { type: Number, default: 0, min: 0 },
    finalization: {
      lockedUntil: { type: Date, default: null },
      lockToken: { type: String, default: null },
      finalizedAt: { type: Date, default: null },
      finalizedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      scoringPolicyVersion: { type: Number, default: null },
      participants: { type: Number, default: null },
      qualified: { type: Number, default: null },
      snapshotHash: { type: String, default: null },
    },
  },
  { timestamps: true },
);

roundSchema.index({ eventId: 1, number: 1 }, { unique: true });
roundSchema.index({ status: 1, startsAt: 1 });
roundSchema.index({ status: 1, endsAt: 1 });

export type RoundDocument = HydratedDocument<IRound>;
export const Round = model<IRound>("Round", roundSchema);

export const DEFAULT_ROUNDS: ReadonlyArray<{
  number: RoundNumber;
  name: string;
  difficulty: RoundDifficulty;
  description: string;
  topN: number | null;
}> = [
  {
    number: 1,
    name: "Round 1 — Basic",
    difficulty: "basic",
    description: "SELECT, WHERE, ORDER BY, DISTINCT, LIMIT and basic aggregates. Open to every registered participant.",
    topN: 20,
  },
  {
    number: 2,
    name: "Round 2 — Intermediate",
    difficulty: "intermediate",
    description: "Joins, GROUP BY / HAVING and introductory subqueries. Top 20 from Round 1.",
    topN: 10,
  },
  {
    number: 3,
    name: "Round 3 — Advanced",
    difficulty: "advanced",
    description: "Multi-table joins, nested subqueries, CTEs, CASE and conditional aggregation. Top 10 from Round 2.",
    topN: null,
  },
];
