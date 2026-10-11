import type { ChallengeDocument, TestCaseDocument } from "@/modules/challenges/challenge.model";
import { canonicalize, type Comparison, compareTables, describeMismatch } from "@/modules/sql-execution/compare";
import type { ExecutionOutcome } from "@/modules/sql-execution/executor";
import type { JobContext, SqlExecutionService } from "@/modules/sql-execution/service";
import type { CellValue, SqlErrorCategory, SqlFailure } from "@/modules/sql-execution/types";

export interface TestRun {
  test: TestCaseDocument;
  /** The participant's query produced a result set (even if it was wrong). */
  executed: boolean;
  passed: boolean;
  durationMs: number;
  /** Raw result for PUBLIC tests only (so hidden outputs can never leak by construction). */
  preview?: { columns: string[]; rows: CellValue[][]; rowCount: number; truncated: boolean };
  comparison?: Comparison;
  failure?: SqlFailure;
  detail?: string;
}

const FATAL: SqlErrorCategory[] = ["QUERY_TIMEOUT", "RESOURCE_LIMIT_EXCEEDED", "INTERNAL_ERROR"];

/** Executes one test dataset with automatic repair if the dataset vanished from the engine. */
export async function runOneTest(
  sql: SqlExecutionService,
  ctx: JobContext,
  challenge: ChallengeDocument,
  test: TestCaseDocument,
  query: string,
  previewRows = 100,
): Promise<TestRun> {
  const tables = challenge.schemaSpec.tables.map((table) => table.name);
  let ref = await ctx.ensureDataset(challenge.schemaSpec, test.rows);
  let outcome: ExecutionOutcome | SqlFailure = await ctx.execute(ref, query, tables);
  if (!outcome.ok && outcome.datasetMissing) {
    ref = await sql.repairDataset(challenge.schemaSpec, test.rows, ref.key);
    outcome = await ctx.execute(ref, query, tables);
  }
  const isPublic = test.visibility === "public";

  if (!outcome.ok) {
    return { test, executed: false, passed: false, durationMs: outcome.durationMs, failure: outcome, detail: isPublic ? outcome.message : undefined };
  }
  if (outcome.truncated) {
    const failure: SqlFailure = {
      ok: false,
      category: "RESOURCE_LIMIT_EXCEEDED",
      message: "The query returned far more rows than this challenge expects.",
      durationMs: outcome.durationMs,
    };
    return {
      test,
      executed: true,
      passed: false,
      durationMs: outcome.durationMs,
      failure,
      detail: isPublic ? failure.message : undefined,
      preview: isPublic ? { columns: outcome.columns, rows: outcome.rows.slice(0, previewRows), rowCount: outcome.rowCount, truncated: true } : undefined,
    };
  }
  const comparison = compareTables(canonicalize(outcome, test.comparison), test.expected, test.comparison);
  return {
    test,
    executed: true,
    passed: comparison.equal,
    durationMs: outcome.durationMs,
    comparison,
    detail: isPublic && !comparison.equal ? describeMismatch(comparison) : undefined,
    preview: isPublic
      ? { columns: outcome.columns, rows: outcome.rows.slice(0, previewRows), rowCount: outcome.rowCount, truncated: outcome.rowCount > previewRows }
      : undefined,
  };
}

/** Runs tests in order, stopping early after a failure that would only repeat (timeout, resource, engine). */
export async function runTests(
  sql: SqlExecutionService,
  ctx: JobContext,
  challenge: ChallengeDocument,
  tests: TestCaseDocument[],
  query: string,
): Promise<{ runs: TestRun[]; aborted: boolean }> {
  const runs: TestRun[] = [];
  for (const test of tests) {
    const run = await runOneTest(sql, ctx, challenge, test, query);
    runs.push(run);
    if (run.failure && FATAL.includes(run.failure.category)) {
      for (const skipped of tests.slice(runs.length)) {
        runs.push({ test: skipped, executed: false, passed: false, durationMs: 0, failure: { ...run.failure, durationMs: 0 } });
      }
      return { runs, aborted: true };
    }
  }
  return { runs, aborted: false };
}
