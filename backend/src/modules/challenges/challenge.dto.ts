import type { EventDocument } from "@/modules/events/event.model";
import type { SqlExecutionService } from "@/modules/sql-execution/service";
import type { ChallengeDocument, TestCaseDocument } from "./challenge.model";

export function effectiveMaxScore(challenge: Pick<ChallengeDocument, "maxScore">, event: Pick<EventDocument, "scoring">): number {
  return challenge.maxScore ?? event.scoring.maxScorePerChallenge;
}

/** What a participant may see. No solution, no hidden fixtures, no expected hidden results. */
export function toParticipantChallengeDto(challenge: ChallengeDocument, event: EventDocument, limits: SqlExecutionService["limits"]) {
  return {
    id: challenge.id as string,
    lineageId: String(challenge.lineageId),
    roundId: String(challenge.roundId),
    roundNumber: challenge.roundNumber,
    version: challenge.version,
    order: challenge.order,
    title: challenge.title,
    narrative: challenge.narrative,
    problemStatement: challenge.problemStatement,
    taskDescription: challenge.taskDescription,
    difficulty: challenge.difficulty,
    concepts: challenge.concepts,
    dialect: challenge.dialect,
    schema: {
      tables: challenge.schemaSpec.tables.map((table) => ({
        name: table.name,
        description: table.description,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: column.type,
          nullable: column.nullable && !column.primaryKey,
          primaryKey: column.primaryKey,
          references: column.references ?? null,
          description: column.description ?? null,
        })),
      })),
    },
    samples: challenge.publicSamples.map((sample) => ({
      id: sample.id,
      name: sample.name,
      description: sample.description,
      rows: sample.rows,
      expectedOutput: sample.expectedOutput,
    })),
    starterSql: challenge.starterSql,
    hints: challenge.hints,
    constraints: challenge.constraints,
    comparison: { ordered: challenge.comparison.ordered, matchColumnNames: challenge.comparison.matchColumnNames },
    maxScore: effectiveMaxScore(challenge, event),
    limits,
  };
}

export function toAdminChallengeDto(challenge: ChallengeDocument, tests: TestCaseDocument[] = [], options: { includePrivate?: boolean } = {}) {
  return {
    id: challenge.id as string,
    lineageId: String(challenge.lineageId),
    eventId: String(challenge.eventId),
    roundId: String(challenge.roundId),
    roundNumber: challenge.roundNumber,
    version: challenge.version,
    order: challenge.order,
    title: challenge.title,
    narrative: challenge.narrative,
    problemStatement: challenge.problemStatement,
    taskDescription: challenge.taskDescription,
    difficulty: challenge.difficulty,
    concepts: challenge.concepts,
    schema: challenge.schemaSpec,
    samples: challenge.publicSamples,
    starterSql: challenge.starterSql,
    hints: challenge.hints,
    constraints: challenge.constraints,
    comparison: challenge.comparison,
    maxScore: challenge.maxScore ?? null,
    status: challenge.status,
    publishedAt: challenge.publishedAt ?? null,
    validation: {
      status: challenge.validation.status,
      checkedAt: challenge.validation.checkedAt ?? null,
      upToDate: challenge.validation.validatedHash === challenge.contentHash,
      report: challenge.validation.report ?? null,
    },
    generation: challenge.generation,
    createdAt: challenge.createdAt,
    updatedAt: challenge.updatedAt,
    ...(options.includePrivate
      ? {
          solutionSql: challenge.private?.solutionSql ?? null,
          explanation: challenge.private?.explanation ?? null,
          tests: tests.map((test) => ({
            id: test.id as string,
            label: test.label,
            order: test.order,
            visibility: test.visibility,
            category: test.category,
            description: test.description,
            weight: test.weight,
            mandatory: test.mandatory,
            active: test.active,
            rows: test.rows,
            expected: test.expected,
          })),
        }
      : {}),
  };
}
