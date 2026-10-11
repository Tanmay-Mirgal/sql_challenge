import { Types } from "mongoose";
import { Challenge, type ChallengeDocument } from "@/modules/challenges/challenge.model";
import { EventModel, type EventDocument, Registration } from "@/modules/events/event.model";
import { createEvent } from "@/modules/events/events.service";
import { Round, type RoundDocument } from "@/modules/rounds/round.model";
import type { UserDocument } from "@/modules/users/user.model";
import type { CreateEventInput } from "@/modules/events/events.schema";
import { contentHash } from "@/utils/crypto";

export async function makeEvent(admin: UserDocument, overrides: Partial<CreateEventInput> = {}): Promise<EventDocument> {
  return createEvent(admin, { name: `Test Event ${new Types.ObjectId().toString().slice(-6)}`, ...overrides });
}

export async function roundsOf(event: EventDocument): Promise<RoundDocument[]> {
  return Round.find({ eventId: event._id }).sort({ number: 1 });
}

/** Minimal published challenge document (not evaluable) for access-control tests. */
export async function makeStubChallenge(
  event: EventDocument,
  round: RoundDocument,
  admin: UserDocument,
  overrides: Partial<{ status: "draft" | "published" | "archived"; order: number; title: string }> = {},
): Promise<ChallengeDocument> {
  const id = new Types.ObjectId();
  const challenge = await Challenge.create({
    _id: id,
    eventId: event._id,
    roundId: round._id,
    roundNumber: round.number,
    lineageId: id,
    version: 1,
    order: overrides.order ?? 1,
    title: overrides.title ?? "Stub challenge",
    narrative: "Story",
    problemStatement: "Problem",
    taskDescription: "Task",
    difficulty: round.difficulty,
    concepts: ["select"],
    schemaSpec: { tables: [] },
    publicSamples: [],
    starterSql: "SELECT 1;",
    contentHash: contentHash({ id: String(id) }),
    status: overrides.status ?? "published",
    publishedAt: overrides.status === "draft" ? null : new Date(),
    generation: { source: "manual" },
    createdBy: admin._id,
  });
  if (challenge.status === "published") {
    await Round.updateOne({ _id: round._id }, { $addToSet: { publishedChallengeIds: challenge._id } });
  }
  return challenge;
}

export async function registerUser(event: EventDocument, user: UserDocument): Promise<void> {
  await Registration.create({ eventId: event._id, userId: user._id, status: "registered", registeredAt: new Date() });
  await EventModel.updateOne({ _id: event._id }, { $inc: { registeredCount: 1 } });
}

export const minutes = (n: number) => n * 60_000;
export const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000);
