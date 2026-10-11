import { z } from "zod";
import { EVENT_STATUSES, TIE_BREAKERS } from "./event.model";

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "Enter a valid domain such as college.edu");

const nullableDate = z.union([z.coerce.date(), z.null()]);

export const scoringPatchSchema = z
  .strictObject({
    maxScorePerChallenge: z.number().int().min(1).max(10_000),
    fullCorrectnessBonus: z.number().int().min(0).max(10_000),
    timePenaltyIntervalSeconds: z.number().int().min(1).max(86_400),
    timePenaltyPoints: z.number().int().min(0).max(1000),
    maxTimePenalty: z.number().int().min(0).max(10_000),
    tieBreakers: z
      .array(z.enum(TIE_BREAKERS))
      .max(TIE_BREAKERS.length)
      .refine((list) => new Set(list).size === list.length, "Tie-breakers must be unique."),
  })
  .partial();

const premiseSchema = z
  .strictObject({
    setting: z.string().trim().max(1000),
    tone: z.string().trim().max(300),
    characters: z.array(z.string().trim().min(1).max(100)).max(12),
    notes: z.string().trim().max(2000),
  })
  .partial();

const eventFields = {
  name: z.string().trim().min(3).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens.")
    .min(3)
    .max(80),
  description: z.string().trim().max(4000),
  rules: z.string().trim().max(8000),
  startsAt: nullableDate,
  endsAt: nullableDate,
  maxParticipants: z.union([z.number().int().min(1).max(100_000), z.null()]),
  allowedEmailDomains: z.array(domain).max(20),
  profileRequirements: z.strictObject({ rollNumber: z.boolean(), department: z.boolean() }).partial(),
  premise: premiseSchema,
  scoring: scoringPatchSchema,
};

export const createEventSchema = z.strictObject({
  name: eventFields.name,
  slug: eventFields.slug.optional(),
  description: eventFields.description.optional(),
  rules: eventFields.rules.optional(),
  startsAt: eventFields.startsAt.optional(),
  endsAt: eventFields.endsAt.optional(),
  maxParticipants: eventFields.maxParticipants.optional(),
  allowedEmailDomains: eventFields.allowedEmailDomains.optional(),
  profileRequirements: eventFields.profileRequirements.optional(),
  premise: eventFields.premise.optional(),
  scoring: eventFields.scoring.optional(),
});

export const updateEventSchema = createEventSchema.partial();

export const transitionEventSchema = z.strictObject({
  to: z.enum(EVENT_STATUSES),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
