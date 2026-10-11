import { Types } from "mongoose";
import { Challenge } from "@/modules/challenges/challenge.model";
import { DEFAULT_ROUNDS, Round } from "@/modules/rounds/round.model";
import type { UserDocument } from "@/modules/users/user.model";
import { now } from "@/utils/clock";
import { Errors } from "@/utils/errors";
import { emailDomain } from "@/utils/sanitize";
import {
  ACTIVE_EVENT_STATUSES,
  EVENT_TRANSITIONS,
  EventModel,
  type EventDocument,
  type EventStatus,
  Registration,
  type ScoringPolicy,
} from "./event.model";
import type { CreateEventInput, UpdateEventInput } from "./events.schema";

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug.length >= 3 ? slug : `event-${slug || "x"}`.slice(0, 70);
}

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; await EventModel.exists({ slug: candidate }); i += 1) candidate = `${base}-${i}`;
  return candidate;
}

function scoringChanged(current: ScoringPolicy, patch: Partial<ScoringPolicy>): boolean {
  return (Object.keys(patch) as (keyof ScoringPolicy)[]).some(
    (key) => key !== "version" && JSON.stringify(patch[key]) !== JSON.stringify(current[key]),
  );
}

function assertWindow(startsAt?: Date | null, endsAt?: Date | null): void {
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    throw Errors.badRequest("The start time must be before the end time.", undefined, "INVALID_WINDOW");
  }
}

export async function createEvent(actor: UserDocument, input: CreateEventInput): Promise<EventDocument> {
  assertWindow(input.startsAt, input.endsAt);
  const slug = input.slug
    ? input.slug
    : await uniqueSlug(slugify(input.name));
  if (input.slug && (await EventModel.exists({ slug }))) {
    throw Errors.conflict("An event with this slug already exists.", "SLUG_TAKEN");
  }
  const event = await EventModel.create({
    name: input.name,
    slug,
    description: input.description ?? "",
    rules: input.rules ?? "",
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    maxParticipants: input.maxParticipants ?? null,
    allowedEmailDomains: input.allowedEmailDomains ?? [],
    profileRequirements: { rollNumber: false, department: false, ...input.profileRequirements },
    premise: { setting: "", tone: "", characters: [], notes: "", ...input.premise },
    scoring: { ...input.scoring, version: 1 },
    organizerId: actor._id,
  });
  await Round.insertMany(
    DEFAULT_ROUNDS.map((round) => ({
      eventId: event._id,
      number: round.number,
      name: round.name,
      description: round.description,
      difficulty: round.difficulty,
      status: "draft",
      qualification: { topN: round.topN, minScore: 1 },
    })),
  );
  return event;
}

export async function updateEvent(eventId: string, patch: UpdateEventInput): Promise<EventDocument> {
  const event = await getEventOrThrow(eventId);
  if (event.status === "finalized") throw Errors.conflict("A finalized event can no longer be edited.", "EVENT_FINALIZED");

  assertWindow(patch.startsAt === undefined ? event.startsAt : patch.startsAt, patch.endsAt === undefined ? event.endsAt : patch.endsAt);

  if (patch.slug && patch.slug !== event.slug) {
    if (await EventModel.exists({ slug: patch.slug, _id: { $ne: event._id } })) {
      throw Errors.conflict("An event with this slug already exists.", "SLUG_TAKEN");
    }
    event.slug = patch.slug;
  }
  if (patch.name !== undefined) event.name = patch.name;
  if (patch.description !== undefined) event.description = patch.description;
  if (patch.startsAt !== undefined) event.startsAt = patch.startsAt;
  if (patch.endsAt !== undefined) event.endsAt = patch.endsAt;
  if (patch.allowedEmailDomains !== undefined) event.allowedEmailDomains = patch.allowedEmailDomains;
  if (patch.profileRequirements) {
    event.profileRequirements = { ...event.toObject().profileRequirements, ...patch.profileRequirements };
  }
  if (patch.premise) event.premise = { ...event.toObject().premise, ...patch.premise };
  if (patch.maxParticipants !== undefined) {
    if (patch.maxParticipants !== null && patch.maxParticipants < event.registeredCount) {
      throw Errors.conflict("The limit cannot be lower than the number of registered participants.", "LIMIT_BELOW_REGISTERED");
    }
    event.maxParticipants = patch.maxParticipants;
  }
  if (patch.rules !== undefined) {
    // Rules are part of the published contract: they are locked once the competition is live.
    if (event.status !== "draft" && event.status !== "registration" && patch.rules !== event.rules) {
      throw Errors.conflict("Event rules cannot be changed once the event is live.", "RULES_LOCKED");
    }
    event.rules = patch.rules;
  }
  const currentScoring = event.toObject().scoring;
  if (patch.scoring && scoringChanged(currentScoring, patch.scoring)) {
    if (event.status !== "draft" && event.status !== "registration") {
      throw Errors.conflict(
        "The scoring policy is locked once the event is live. Changing it requires an audited event reset.",
        "SCORING_LOCKED",
      );
    }
    event.scoring = { ...currentScoring, ...patch.scoring, version: currentScoring.version + 1 } as ScoringPolicy;
  }
  await event.save();
  return event;
}

export async function getEventOrThrow(eventId: string): Promise<EventDocument> {
  if (!Types.ObjectId.isValid(eventId)) throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
  const event = await EventModel.findById(eventId);
  if (!event) throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
  return event;
}

/** The event participants should currently see: live/paused first, then registration, then the latest finalized. */
export async function getActiveEvent(): Promise<EventDocument | null> {
  const live = await EventModel.findOne({ status: { $in: ["live", "paused"] } }).sort({ updatedAt: -1 });
  if (live) return live;
  const registration = await EventModel.findOne({ status: "registration" }).sort({ updatedAt: -1 });
  if (registration) return registration;
  return EventModel.findOne({ status: "finalized" }).sort({ finalizedAt: -1 });
}

export async function transitionEvent(eventId: string, to: EventStatus): Promise<EventDocument> {
  const event = await getEventOrThrow(eventId);
  const from = event.status;
  if (from === to) throw Errors.conflict(`The event is already ${to}.`, "NO_CHANGE");
  if (!EVENT_TRANSITIONS[from].includes(to)) {
    throw Errors.conflict(`An event cannot move from ${from} to ${to}.`, "INVALID_TRANSITION");
  }

  if (ACTIVE_EVENT_STATUSES.includes(to) && from === "draft") {
    // Only one event may be in registration/live/paused at a time.
    const clash = await EventModel.exists({ _id: { $ne: event._id }, status: { $in: ACTIVE_EVENT_STATUSES } });
    if (clash) throw Errors.conflict("Another event is already active. Finalize or pause it first.", "ANOTHER_EVENT_ACTIVE");
  }
  if (to === "live" && from === "registration") {
    const clash = await EventModel.exists({ _id: { $ne: event._id }, status: { $in: ["live", "paused"] } });
    if (clash) throw Errors.conflict("Another event is already live.", "ANOTHER_EVENT_ACTIVE");
    const problems = await readinessProblems(event);
    if (problems.length > 0) throw Errors.conflict("The event is not ready to go live.", "EVENT_NOT_READY", problems);
  }
  if (to === "finalized") {
    const final = await Round.findOne({ eventId: event._id, number: 3 });
    if (!final?.finalization.finalizedAt) {
      throw Errors.conflict("Round 3 must be finalized before the event can be finalized.", "ROUNDS_NOT_FINALIZED");
    }
    event.finalizedAt = now();
  }
  if (to === "paused") event.pausedAt = now();
  if (from === "paused" && to === "live") {
    const pausedAt = event.pausedAt;
    event.pausedAt = null;
    if (pausedAt) await compensatePause(event._id, pausedAt, now());
  }
  event.status = to;
  await event.save();
  return event;
}

/**
 * Rounds that were running when the event was paused get the paused time back:
 * their deadline moves out and the pause is excluded from elapsed-time scoring.
 */
async function compensatePause(eventId: Types.ObjectId, pausedAt: Date, resumedAt: Date): Promise<void> {
  const pausedFor = Math.max(0, resumedAt.getTime() - pausedAt.getTime());
  if (pausedFor === 0) return;
  await Round.updateMany({ eventId, status: "active", endsAt: { $gt: pausedAt } }, [
    { $set: { pausedMs: { $add: ["$pausedMs", pausedFor] }, endsAt: { $add: ["$endsAt", pausedFor] } } },
  ], { updatePipeline: true });
  await Round.updateMany({ eventId, status: "active", $or: [{ endsAt: null }, { endsAt: { $lte: pausedAt } }] }, [
    { $set: { pausedMs: { $add: ["$pausedMs", pausedFor] } } },
  ], { updatePipeline: true });
}

async function readinessProblems(event: EventDocument): Promise<string[]> {
  const problems: string[] = [];
  const rounds = await Round.find({ eventId: event._id }).sort({ number: 1 });
  const first = rounds.find((round) => round.number === 1);
  if (!first) return ["Round 1 does not exist."];
  if (!first.startsAt || !first.endsAt) problems.push("Round 1 needs a start and end time.");
  const published = await Challenge.countDocuments({ roundId: first._id, status: "published" });
  if (published === 0) problems.push("Round 1 needs at least one published challenge.");
  if (first.status === "draft") problems.push("Round 1 must be scheduled.");
  return problems;
}

// --- registration -----------------------------------------------------------------------------

export async function registerForEvent(user: UserDocument, eventId: string) {
  const event = await getEventOrThrow(eventId);
  if (event.status !== "registration" && event.status !== "live") {
    throw Errors.conflict("Registration is not open for this event.", "REGISTRATION_CLOSED");
  }
  if (event.status === "live") {
    const first = await Round.findOne({ eventId: event._id, number: 1 });
    if (!first || first.status === "completed" || first.finalization.finalizedAt || (first.endsAt && first.endsAt <= now())) {
      throw Errors.conflict("Registration closed when Round 1 ended.", "REGISTRATION_CLOSED");
    }
  }
  if (user.status !== "active") throw Errors.forbidden("Your account cannot participate.", "ACCOUNT_DISABLED");

  const domains = event.allowedEmailDomains;
  if (domains.length > 0 && !domains.includes(emailDomain(user.email)) && user.role !== "admin") {
    throw Errors.forbidden("Only participants with an approved college e-mail can join this event.", "DOMAIN_NOT_ALLOWED");
  }
  const missing: string[] = [];
  if (event.profileRequirements.rollNumber && !user.rollNumber) missing.push("rollNumber");
  if (event.profileRequirements.department && !user.department) missing.push("department");
  if (missing.length > 0) {
    throw Errors.unprocessable("Complete your profile before joining.", "PROFILE_INCOMPLETE", { missing });
  }

  const existing = await Registration.findOne({ eventId: event._id, userId: user._id });
  if (existing) {
    if (existing.status === "disqualified") throw Errors.forbidden("You have been disqualified from this event.", "DISQUALIFIED");
    if (existing.status === "registered") return existing;
  }

  // Reserve a seat atomically so concurrent sign-ups cannot exceed the limit.
  const reserved = await EventModel.findOneAndUpdate(
    event.maxParticipants ? { _id: event._id, registeredCount: { $lt: event.maxParticipants } } : { _id: event._id },
    { $inc: { registeredCount: 1 } },
  );
  if (!reserved) throw Errors.conflict("This event is full.", "EVENT_FULL");
  try {
    if (existing) {
      existing.status = "registered";
      existing.registeredAt = now();
      await existing.save();
      return existing;
    }
    return await Registration.create({ eventId: event._id, userId: user._id, status: "registered", registeredAt: now() });
  } catch (error) {
    await EventModel.updateOne({ _id: event._id }, { $inc: { registeredCount: -1 } });
    if (typeof error === "object" && error && (error as { code?: number }).code === 11000) {
      const concurrent = await Registration.findOne({ eventId: event._id, userId: user._id });
      if (concurrent) return concurrent;
    }
    throw error;
  }
}

export async function getRegistration(eventId: Types.ObjectId | string, userId: Types.ObjectId | string) {
  return Registration.findOne({ eventId, userId });
}

export function toEventDto(event: EventDocument, extras: { includeAdminFields?: boolean } = {}) {
  return {
    id: event.id as string,
    name: event.name,
    slug: event.slug,
    description: event.description,
    rules: event.rules,
    status: event.status,
    startsAt: event.startsAt ?? null,
    endsAt: event.endsAt ?? null,
    maxParticipants: event.maxParticipants ?? null,
    registeredCount: event.registeredCount,
    profileRequirements: event.profileRequirements,
    // The scoring policy is published to participants before the event starts.
    scoring: {
      version: event.scoring.version,
      maxScorePerChallenge: event.scoring.maxScorePerChallenge,
      fullCorrectnessBonus: event.scoring.fullCorrectnessBonus,
      timePenaltyIntervalSeconds: event.scoring.timePenaltyIntervalSeconds,
      timePenaltyPoints: event.scoring.timePenaltyPoints,
      maxTimePenalty: event.scoring.maxTimePenalty,
      tieBreakers: event.scoring.tieBreakers,
    },
    ...(extras.includeAdminFields
      ? { allowedEmailDomains: event.allowedEmailDomains, premise: event.premise, organizerId: String(event.organizerId) }
      : {}),
    finalizedAt: event.finalizedAt ?? null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}
