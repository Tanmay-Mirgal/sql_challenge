import { type HydratedDocument, model, Schema, type Types } from "mongoose";
import type { SqlErrorCategory } from "@/modules/sql-execution/types";

export const SUBMISSION_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/**
 * accepted      – every mandatory test passed
 * partial       – some (but not all mandatory) tests passed
 * wrong_answer  – executed fine, no test passed
 * error         – the query failed (syntax/runtime/timeout) on every test
 * rejected      – refused before execution (invalid or unsupported SQL); does not count as an attempt
 * system_error  – our infrastructure failed; never held against the participant
 */
export const VERDICTS = ["accepted", "partial", "wrong_answer", "error", "rejected", "system_error"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ScoreBreakdown {
  scoringVersion: number;
  maxScore: number;
  passedWeight: number;
  totalWeight: number;
  baseScore: number;
  fullCorrectnessBonus: number;
  elapsedSeconds: number;
  timePenalty: number;
  finalScore: number;
}

export interface SubmissionTestResult {
  label: string;
  visibility: "public" | "hidden";
  passed: boolean;
  durationMs: number;
  /** Safe error category when the query failed on this test. */
  errorCategory?: SqlErrorCategory | null;
  /** Explanation for PUBLIC tests only (never populated for hidden tests). */
  detail?: string | null;
}

export interface ISubmission {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
  roundId: Types.ObjectId;
  roundNumber: number;
  challengeId: Types.ObjectId;
  lineageId: Types.ObjectId;
  challengeVersion: number;
  sql: string;
  sqlHash: string;
  status: SubmissionStatus;
  verdict?: Verdict | null;
  passedTests: number;
  totalTests: number;
  score: number;
  scoreBreakdown?: ScoreBreakdown | null;
  testResults: SubmissionTestResult[];
  executionMs: number;
  errorCategory?: SqlErrorCategory | null;
  /** Sanitised, participant-safe message. Full diagnostics only exist in server logs. */
  errorMessage?: string | null;
  /** Whether this submission counts towards the per-challenge limit and tie-break counts. */
  counted: boolean;
  idempotencyKey: string;
  /** Authoritative server time at acceptance. Elapsed time and tie-breaks use this value. */
  submittedAt: Date;
  /** Milliseconds between the round start (excluding pauses) and acceptance; fixed at submit time. */
  elapsedMs: number;
  evaluatedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const submissionSchema = new Schema<ISubmission>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    roundId: { type: Schema.Types.ObjectId, ref: "Round", required: true },
    roundNumber: { type: Number, enum: [1, 2, 3], required: true },
    challengeId: { type: Schema.Types.ObjectId, ref: "Challenge", required: true },
    lineageId: { type: Schema.Types.ObjectId, required: true },
    challengeVersion: { type: Number, required: true },
    sql: { type: String, required: true, maxlength: 200_000 },
    sqlHash: { type: String, required: true },
    status: { type: String, enum: SUBMISSION_STATUSES, required: true, default: "queued" },
    verdict: { type: String, enum: VERDICTS, default: null },
    passedTests: { type: Number, default: 0 },
    totalTests: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    scoreBreakdown: { type: Schema.Types.Mixed, default: null },
    testResults: { type: Schema.Types.Mixed, default: () => [] },
    executionMs: { type: Number, default: 0 },
    errorCategory: { type: String, default: null },
    errorMessage: { type: String, default: null, maxlength: 1000 },
    counted: { type: Boolean, default: true },
    idempotencyKey: { type: String, required: true, maxlength: 100 },
    submittedAt: { type: Date, required: true },
    elapsedMs: { type: Number, default: 0 },
    evaluatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

submissionSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
submissionSchema.index({ userId: 1, lineageId: 1, submittedAt: -1 });
submissionSchema.index({ userId: 1, roundId: 1, submittedAt: -1 });
submissionSchema.index({ roundId: 1, status: 1 });
submissionSchema.index({ roundId: 1, userId: 1, lineageId: 1, score: -1, submittedAt: 1 });
submissionSchema.index({ eventId: 1, verdict: 1, createdAt: -1 });
submissionSchema.index({ status: 1, updatedAt: 1 });

export type SubmissionDocument = HydratedDocument<ISubmission>;
export const Submission = model<ISubmission>("Submission", submissionSchema);
