import { type HydratedDocument, model, Schema, type Types } from "mongoose";

export const GENERATION_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export interface GenerationAttempt {
  attempt: number;
  startedAt: Date;
  durationMs: number;
  outcome: "ok" | "llm_error" | "invalid_json" | "schema_invalid" | "validation_failed" | "timeout";
  /** Admin-visible reason (never contains secrets). */
  detail: string;
}

export interface IGenerationRun {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  roundId: Types.ObjectId;
  requestedBy: Types.ObjectId;
  status: GenerationStatus;
  model: string;
  promptVersion: string;
  /** Free-text direction from the administrator (topic, desired concepts…). */
  guidance: string;
  attempts: GenerationAttempt[];
  challengeId?: Types.ObjectId | null;
  failureReason?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const generationRunSchema = new Schema<IGenerationRun>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    roundId: { type: Schema.Types.ObjectId, ref: "Round", required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: GENERATION_STATUSES, default: "queued", required: true },
    model: { type: String, required: true },
    promptVersion: { type: String, required: true },
    guidance: { type: String, default: "", maxlength: 2000 },
    attempts: { type: Schema.Types.Mixed, default: () => [] },
    challengeId: { type: Schema.Types.ObjectId, ref: "Challenge", default: null },
    failureReason: { type: String, default: null, maxlength: 2000 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

generationRunSchema.index({ roundId: 1, createdAt: -1 });
generationRunSchema.index({ status: 1, updatedAt: 1 });

export type GenerationRunDocument = HydratedDocument<IGenerationRun>;
export const GenerationRun = model<IGenerationRun>("GenerationRun", generationRunSchema);
