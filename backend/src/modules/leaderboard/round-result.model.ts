import { type HydratedDocument, model, Schema, type Types } from "mongoose";

export const QUALIFICATION_STATUSES = ["pending", "qualified", "eliminated", "finalist"] as const;
/**
 * pending    – round not finalized yet (provisional ranking only; grants no access)
 * qualified  – finalized and advancing to the next round
 * eliminated – finalized and not advancing
 * finalist   – finalized result of the final round (no further round)
 */
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];

export interface ChallengeBest {
  lineageId: Types.ObjectId;
  challengeId: Types.ObjectId;
  submissionId: Types.ObjectId;
  score: number;
  fullyCorrect: boolean;
  achievedAt: Date;
}

export interface IRoundResult {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  roundId: Types.ObjectId;
  roundNumber: number;
  userId: Types.ObjectId;
  /** Sum of the best score of each challenge in the round. */
  score: number;
  challengesSolved: number;
  challengeBests: ChallengeBest[];
  /** Time at which the current total score was reached (latest contributing best submission). */
  achievedAt: Date | null;
  /** Counted submissions made in the round (used by the optional fewer-submissions tie-break). */
  submissionCount: number;
  lastSubmissionAt: Date | null;
  /** Registration order used as the final deterministic tie-break. */
  registeredAt: Date;
  completionStatus: "in_progress" | "completed";
  qualification: {
    status: QualificationStatus;
    finalRank?: number | null;
    finalScore?: number | null;
    finalAchievedAt?: Date | null;
    finalSubmissionCount?: number | null;
    /** Which rule separated this participant from the next one. */
    tieBreakApplied?: string | null;
    finalizedAt?: Date | null;
    scoringPolicyVersion?: number | null;
  };
  /** Optimistic-concurrency counter for recomputation. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const challengeBestSchema = new Schema<ChallengeBest>(
  {
    lineageId: { type: Schema.Types.ObjectId, required: true },
    challengeId: { type: Schema.Types.ObjectId, required: true },
    submissionId: { type: Schema.Types.ObjectId, required: true },
    score: { type: Number, required: true },
    fullyCorrect: { type: Boolean, required: true },
    achievedAt: { type: Date, required: true },
  },
  { _id: false },
);

const roundResultSchema = new Schema<IRoundResult>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    roundId: { type: Schema.Types.ObjectId, ref: "Round", required: true },
    roundNumber: { type: Number, enum: [1, 2, 3], required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    score: { type: Number, default: 0 },
    challengesSolved: { type: Number, default: 0 },
    challengeBests: { type: [challengeBestSchema], default: [] },
    achievedAt: { type: Date, default: null },
    submissionCount: { type: Number, default: 0 },
    lastSubmissionAt: { type: Date, default: null },
    registeredAt: { type: Date, required: true },
    completionStatus: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },
    qualification: {
      status: { type: String, enum: QUALIFICATION_STATUSES, default: "pending" },
      finalRank: { type: Number, default: null },
      finalScore: { type: Number, default: null },
      finalAchievedAt: { type: Date, default: null },
      finalSubmissionCount: { type: Number, default: null },
      tieBreakApplied: { type: String, default: null },
      finalizedAt: { type: Date, default: null },
      scoringPolicyVersion: { type: Number, default: null },
    },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true },
);

roundResultSchema.index({ roundId: 1, userId: 1 }, { unique: true });
// Ranking order: score desc, earliest achievement, fewer submissions, earliest registration.
roundResultSchema.index({ roundId: 1, score: -1, achievedAt: 1, submissionCount: 1, registeredAt: 1, userId: 1 });
roundResultSchema.index({ eventId: 1, userId: 1, roundNumber: 1 });
roundResultSchema.index({ roundId: 1, "qualification.status": 1, "qualification.finalRank": 1 });

export type RoundResultDocument = HydratedDocument<IRoundResult>;
export const RoundResult = model<IRoundResult>("RoundResult", roundResultSchema);
