import { type HydratedDocument, model, Schema, type Types } from "mongoose";
import type { CanonicalTable } from "@/modules/sql-execution/compare";
import type { ComparisonPolicy, DatasetRows, ResultTable, SchemaSpec, TestCategory } from "@/modules/sql-execution/types";
import type { RoundDifficulty } from "@/modules/rounds/round.model";

export const CHALLENGE_STATUSES = ["draft", "published", "archived"] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const VALIDATION_STATUSES = ["pending", "passed", "failed"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export interface PublicSample {
  id: string;
  name: string;
  description: string;
  /** Sample input data shown to participants. */
  rows: DatasetRows;
  /** Verified expected output (computed by executing the reference solution). */
  expectedOutput: ResultTable;
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationReport {
  checks: ValidationCheck[];
  warnings: string[];
  durationMs: number;
}

export interface IChallenge {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  roundId: Types.ObjectId;
  roundNumber: number;
  /** Shared by every version of "the same" challenge; equals the first version's _id. */
  lineageId: Types.ObjectId;
  version: number;
  /** Position inside the round (1-based). */
  order: number;
  title: string;
  narrative: string;
  problemStatement: string;
  taskDescription: string;
  difficulty: RoundDifficulty;
  concepts: string[];
  dialect: "postgresql";
  schemaSpec: SchemaSpec;
  publicSamples: PublicSample[];
  starterSql: string;
  hints: string[];
  constraints: string[];
  comparison: ComparisonPolicy;
  /** Optional override of the event's maxScorePerChallenge. */
  maxScore?: number | null;
  status: ChallengeStatus;
  publishedAt?: Date | null;
  publishedBy?: Types.ObjectId | null;
  /** Hash of everything that affects evaluation (schema, datasets, solution, comparison). */
  contentHash: string;
  validation: {
    status: ValidationStatus;
    checkedAt?: Date | null;
    /** contentHash at the time validation ran; publishing requires it to match the current hash. */
    validatedHash?: string | null;
    report?: ValidationReport | null;
  };
  generation: {
    source: "ai" | "manual";
    runId?: Types.ObjectId | null;
    model?: string | null;
    promptVersion?: string | null;
    attempts?: number | null;
    /** Short summary of the plot so far, carried forward into the next round's prompt. */
    storySummary?: string | null;
  };
  /** Never selected by default and never serialised to participants. */
  private?: { solutionSql: string; explanation: string };
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const challengeSchema = new Schema<IChallenge>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    roundId: { type: Schema.Types.ObjectId, ref: "Round", required: true },
    roundNumber: { type: Number, enum: [1, 2, 3], required: true },
    lineageId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
    order: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    narrative: { type: String, required: true, maxlength: 6000 },
    problemStatement: { type: String, required: true, maxlength: 6000 },
    taskDescription: { type: String, required: true, maxlength: 4000 },
    difficulty: { type: String, enum: ["basic", "intermediate", "advanced"], required: true },
    concepts: { type: [String], default: [] },
    dialect: { type: String, enum: ["postgresql"], default: "postgresql" },
    schemaSpec: { type: Schema.Types.Mixed, required: true },
    publicSamples: { type: Schema.Types.Mixed, default: () => [] },
    starterSql: { type: String, default: "", maxlength: 5000 },
    hints: { type: [String], default: [] },
    constraints: { type: [String], default: [] },
    comparison: {
      ordered: { type: Boolean, default: false },
      matchColumnNames: { type: Boolean, default: false },
      numericScale: { type: Number, default: 6 },
    },
    maxScore: { type: Number, default: null, min: 1 },
    status: { type: String, enum: CHALLENGE_STATUSES, default: "draft", required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    contentHash: { type: String, required: true },
    validation: {
      status: { type: String, enum: VALIDATION_STATUSES, default: "pending" },
      checkedAt: { type: Date, default: null },
      validatedHash: { type: String, default: null },
      report: { type: Schema.Types.Mixed, default: null },
    },
    generation: {
      source: { type: String, enum: ["ai", "manual"], required: true },
      runId: { type: Schema.Types.ObjectId, ref: "GenerationRun", default: null },
      model: { type: String, default: null },
      promptVersion: { type: String, default: null },
      attempts: { type: Number, default: null },
      storySummary: { type: String, default: null, maxlength: 2000 },
    },
    private: {
      type: new Schema({ solutionSql: String, explanation: String }, { _id: false }),
      select: false,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

challengeSchema.index({ lineageId: 1, version: 1 }, { unique: true });
challengeSchema.index({ roundId: 1, status: 1, order: 1 });
challengeSchema.index({ eventId: 1, roundNumber: 1, status: 1 });
// A lineage can have at most one published version at any time.
challengeSchema.index(
  { lineageId: 1 },
  { unique: true, partialFilterExpression: { status: "published" }, name: "one_published_version_per_lineage" },
);

export type ChallengeDocument = HydratedDocument<IChallenge>;
export const Challenge = model<IChallenge>("Challenge", challengeSchema);

/**
 * Hidden evaluation data. Stored in a separate collection and never returned by
 * participant-facing endpoints.
 */
export interface ITestCase {
  _id: Types.ObjectId;
  challengeId: Types.ObjectId;
  challengeVersion: number;
  /** Stable label used in participant-visible results, e.g. "Hidden test 3". */
  label: string;
  order: number;
  visibility: "public" | "hidden";
  category: TestCategory;
  description: string;
  /** Fixture rows for every table (controlled input configuration). */
  rows: DatasetRows;
  /** Expected result computed by running the reference solution in the sandbox. */
  expected: CanonicalTable;
  comparison: ComparisonPolicy;
  weight: number;
  mandatory: boolean;
  active: boolean;
  /** Public sample this test mirrors, if visibility is public. */
  sampleId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const testCaseSchema = new Schema<ITestCase>(
  {
    challengeId: { type: Schema.Types.ObjectId, ref: "Challenge", required: true },
    challengeVersion: { type: Number, required: true },
    label: { type: String, required: true, maxlength: 80 },
    order: { type: Number, required: true },
    visibility: { type: String, enum: ["public", "hidden"], required: true },
    category: { type: String, required: true },
    description: { type: String, default: "", maxlength: 1000 },
    rows: { type: Schema.Types.Mixed, required: true },
    expected: { type: Schema.Types.Mixed, required: true },
    comparison: {
      ordered: { type: Boolean, default: false },
      matchColumnNames: { type: Boolean, default: false },
      numericScale: { type: Number, default: 6 },
    },
    weight: { type: Number, required: true, min: 1, max: 1000, default: 1 },
    mandatory: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    sampleId: { type: String, default: null },
  },
  { timestamps: true },
);

testCaseSchema.index({ challengeId: 1, active: 1, order: 1 });

export type TestCaseDocument = HydratedDocument<ITestCase>;
export const TestCase = model<ITestCase>("TestCase", testCaseSchema);
