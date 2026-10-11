import { type HydratedDocument, model, Schema, type Types } from "mongoose";

export const EVENT_STATUSES = ["draft", "registration", "live", "paused", "finalized"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Allowed event status transitions. Anything else is rejected by the service layer. */
export const EVENT_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ["registration"],
  registration: ["live", "draft"],
  live: ["paused", "finalized"],
  paused: ["live", "finalized"],
  finalized: [],
};

export const TIE_BREAKERS = ["earliest_achieved", "fewer_submissions"] as const;
export type TieBreaker = (typeof TIE_BREAKERS)[number];

export interface ScoringPolicy {
  /** Incremented every time the policy changes; stored on each submission. */
  version: number;
  /** Points available per challenge for passing all weighted tests. */
  maxScorePerChallenge: number;
  /** Extra points when every mandatory test passes. */
  fullCorrectnessBonus: number;
  /** Seconds of elapsed round time per penalty step. */
  timePenaltyIntervalSeconds: number;
  /** Points deducted per elapsed interval (applied per challenge, from the round's start). */
  timePenaltyPoints: number;
  /** Upper bound on the total time penalty for a single challenge. */
  maxTimePenalty: number;
  /** Ordered tie-break chain applied after score. A final deterministic fallback is always applied. */
  tieBreakers: TieBreaker[];
}

export interface IEvent {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  rules: string;
  status: EventStatus;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxParticipants?: number | null;
  /** Denormalised counter kept in sync atomically with registrations. */
  registeredCount: number;
  allowedEmailDomains: string[];
  profileRequirements: { rollNumber: boolean; department: boolean };
  /** Story seed handed to the AI generator so all rounds share one fictional world. */
  premise: { setting: string; tone: string; characters: string[]; notes: string };
  scoring: ScoringPolicy;
  organizerId: Types.ObjectId;
  pausedAt?: Date | null;
  finalizedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const scoringSchema = new Schema<ScoringPolicy>(
  {
    version: { type: Number, required: true, min: 1, default: 1 },
    maxScorePerChallenge: { type: Number, required: true, min: 1, max: 10_000, default: 100 },
    fullCorrectnessBonus: { type: Number, required: true, min: 0, max: 10_000, default: 10 },
    timePenaltyIntervalSeconds: { type: Number, required: true, min: 1, default: 60 },
    timePenaltyPoints: { type: Number, required: true, min: 0, default: 1 },
    maxTimePenalty: { type: Number, required: true, min: 0, default: 30 },
    tieBreakers: { type: [String], enum: TIE_BREAKERS, default: ["earliest_achieved", "fewer_submissions"] },
  },
  { _id: false },
);

const eventSchema = new Schema<IEvent>(
  {
    name: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: "", maxlength: 4000 },
    rules: { type: String, default: "", maxlength: 8000 },
    status: { type: String, enum: EVENT_STATUSES, default: "draft", required: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    maxParticipants: { type: Number, default: null, min: 1 },
    registeredCount: { type: Number, default: 0, min: 0 },
    allowedEmailDomains: { type: [String], default: [] },
    profileRequirements: {
      rollNumber: { type: Boolean, default: false },
      department: { type: Boolean, default: false },
    },
    premise: {
      setting: { type: String, default: "", maxlength: 1000 },
      tone: { type: String, default: "", maxlength: 300 },
      characters: { type: [String], default: [] },
      notes: { type: String, default: "", maxlength: 2000 },
    },
    scoring: { type: scoringSchema, required: true, default: () => ({}) },
    organizerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    pausedAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

eventSchema.index({ slug: 1 }, { unique: true });
eventSchema.index({ status: 1, createdAt: -1 });

export type EventDocument = HydratedDocument<IEvent>;
export const EventModel = model<IEvent>("Event", eventSchema);

export const ACTIVE_EVENT_STATUSES: readonly EventStatus[] = ["registration", "live", "paused"];

export const REGISTRATION_STATUSES = ["registered", "withdrawn", "disqualified"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export interface IRegistration {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  userId: Types.ObjectId;
  status: RegistrationStatus;
  registeredAt: Date;
  disqualifiedReason?: string | null;
}

const registrationSchema = new Schema<IRegistration>({
  eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: REGISTRATION_STATUSES, default: "registered", required: true },
  registeredAt: { type: Date, required: true },
  disqualifiedReason: { type: String, default: null, maxlength: 500 },
});

registrationSchema.index({ eventId: 1, userId: 1 }, { unique: true });
registrationSchema.index({ eventId: 1, status: 1, registeredAt: 1 });
registrationSchema.index({ userId: 1 });

export const Registration = model<IRegistration>("Registration", registrationSchema);
