import { z } from "zod";
import { cellSchema, schemaSpecSchema } from "@/modules/sql-execution/fixtures";
import { TEST_CATEGORIES } from "@/modules/sql-execution/types";
import { ROUND_DIFFICULTIES } from "@/modules/rounds/round.model";

/** Rows per table. Each row is an array aligned with the table's columns. */
export const rowsSchema = z.record(z.string(), z.array(z.array(cellSchema)));

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const claimedOutputSchema = z.strictObject({
  columns: z.array(z.string().max(80)).min(1).max(30),
  rows: z.array(z.array(cellSchema)).max(200),
});

export const publicSampleInputSchema = z.strictObject({
  name: text(2, 60).default("Sample"),
  description: z.string().trim().max(400).default(""),
  rows: rowsSchema,
  /** The author's claim of the expected output. It is verified against the reference solution, never trusted. */
  expectedOutput: claimedOutputSchema.optional(),
});

export const candidateTestInputSchema = z.strictObject({
  category: z.enum(TEST_CATEGORIES as unknown as [string, ...string[]]).default("normal"),
  description: z.string().trim().max(400).default(""),
  rows: rowsSchema,
  weight: z.number().int().min(1).max(100).default(1),
  mandatory: z.boolean().default(true),
});

/**
 * Everything an author (human or model) supplies for a challenge. The reference
 * solution is executed in the sandbox to *derive* expected outputs; the model is
 * never asked to compute results by hand.
 */
export const challengeContentSchema = z.object({
  title: text(3, 120),
  narrative: text(40, 3000),
  problemStatement: text(20, 3000),
  taskDescription: text(10, 2000),
  difficulty: z.enum(ROUND_DIFFICULTIES),
  concepts: z.array(text(2, 40)).min(1).max(8),
  dialect: z.literal("postgresql").default("postgresql"),
  schema: schemaSpecSchema,
  publicSamples: z.array(publicSampleInputSchema).min(1).max(2),
  candidateTestCases: z.array(candidateTestInputSchema).min(3).max(10),
  starterSql: z.string().max(2000).default(""),
  hints: z.array(text(3, 300)).max(5).default([]),
  constraints: z.array(text(3, 300)).max(8).default([]),
  solutionSql: text(10, 5000),
  comparisonPolicy: z
    .strictObject({ ordered: z.boolean(), matchColumnNames: z.boolean().default(false) })
    .default({ ordered: false, matchColumnNames: false }),
  explanation: z.string().trim().max(3000).default(""),
  /** 2–4 sentences: what the player has uncovered so far and the open thread for the next chapter. */
  storySummary: z.string().trim().max(800).default(""),
});

export type ChallengeContent = z.infer<typeof challengeContentSchema>;
export type ChallengeContentInput = z.input<typeof challengeContentSchema>;
export type CandidateTest = z.infer<typeof candidateTestInputSchema>;

/** Top-level keys the schema knows; anything else the model adds is dropped and reported as a warning. */
export const KNOWN_CONTENT_KEYS = new Set(Object.keys(challengeContentSchema.shape));

/** Fields that may be edited on a draft without invalidating its tests. */
export const textPatchSchema = z.strictObject({
  title: text(3, 120).optional(),
  narrative: text(40, 3000).optional(),
  problemStatement: text(20, 3000).optional(),
  taskDescription: text(10, 2000).optional(),
  concepts: z.array(text(2, 40)).min(1).max(8).optional(),
  starterSql: z.string().max(2000).optional(),
  hints: z.array(text(3, 300)).max(5).optional(),
  constraints: z.array(text(3, 300)).max(8).optional(),
  explanation: z.string().trim().max(3000).optional(),
  storySummary: z.string().trim().max(800).optional(),
  maxScore: z.union([z.number().int().min(1).max(10_000), z.null()]).optional(),
});
export type TextPatch = z.infer<typeof textPatchSchema>;
