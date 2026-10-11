import type { PublicSample, ValidationCheck, ValidationReport } from "./challenge.model";
import type { ChallengeContent } from "./challenge.schema";
import { contentHash } from "@/utils/crypto";
import { canonicalize, type CanonicalTable, compareTables } from "@/modules/sql-execution/compare";
import type { ExecutionSuccess } from "@/modules/sql-execution/executor";
import { validateDatasetRows, normalizeRows } from "@/modules/sql-execution/fixtures";
import { FixtureError } from "@/modules/sql-execution/provisioner";
import { SqlEngineUnavailableError, type SqlExecutionService } from "@/modules/sql-execution/service";
import type { DatasetRef, ResultTable, TestCategory } from "@/modules/sql-execution/types";
import { type QueryFeatures, validateSql } from "@/modules/sql-execution/validator";
import type { RoundDifficulty } from "@/modules/rounds/round.model";

export interface DerivedTest {
  label: string;
  order: number;
  visibility: "public" | "hidden";
  category: TestCategory;
  description: string;
  rows: ChallengeContent["publicSamples"][number]["rows"];
  expected: CanonicalTable;
  comparison: { ordered: boolean; matchColumnNames: boolean; numericScale: number };
  weight: number;
  mandatory: boolean;
  sampleId: string | null;
}

export interface ValidationOutcome {
  ok: boolean;
  report: ValidationReport;
  /** Present only when the content is valid. */
  derived?: { samples: PublicSample[]; tests: DerivedTest[]; features: QueryFeatures };
}

const MAX_DATASETS = 12;
const PREVIEW_ROWS = 50;
const VALIDATION_USER = "system:validation";

/** Hash of everything that influences evaluation. Text-only edits do not change it. */
export function authoringHash(content: ChallengeContent): string {
  return contentHash({
    schema: content.schema,
    samples: content.publicSamples.map((sample) => sample.rows),
    tests: content.candidateTestCases.map((test) => ({ rows: test.rows, weight: test.weight, mandatory: test.mandatory, category: test.category })),
    solution: content.solutionSql.trim(),
    comparison: content.comparisonPolicy,
  });
}

function normalizeText(sql: string): string {
  return sql.toLowerCase().replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/[\s;]+/g, " ").trim();
}

interface Mutant {
  name: string;
  sql: string;
}

/** Cheap syntactic mutants of the reference solution used to measure how well the tests discriminate. */
export function buildMutants(solution: string, ordered: boolean): Mutant[] {
  const mutants: Mutant[] = [];
  const add = (name: string, pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)) => {
    if (!pattern.test(solution)) return;
    const mutated = solution.replace(pattern, replacement as never);
    if (mutated !== solution) mutants.push({ name, sql: mutated });
  };
  add(">= → >", />=/, ">");
  add("<= → <", /<=/, "<");
  add("> → >=", /(?<![<>=-])>(?![=>])/, ">=");
  add("< → <=", /(?<![<>=])<(?![=>])/, "<=");
  add("= → <>", /(?<![<>!=:])=(?![=>])/, "<>");
  add("AND → OR", /\bAND\b/i, "OR");
  add("OR → AND", /\bOR\b/i, "AND");
  add("INNER JOIN → LEFT JOIN", /(?<!\b(?:LEFT|RIGHT|FULL|OUTER|CROSS)\s+)\b(?:INNER\s+)?JOIN\b/i, "LEFT JOIN");
  add("LEFT JOIN → INNER JOIN", /\bLEFT\s+(?:OUTER\s+)?JOIN\b/i, "INNER JOIN");
  add("drop DISTINCT", /\bSELECT\s+DISTINCT\b/i, "SELECT");
  add("COUNT(DISTINCT) → COUNT", /COUNT\s*\(\s*DISTINCT\s+/i, "COUNT(");
  add("HAVING threshold +1", /(HAVING[^;]*?[<>]=?\s*)(\d+)/i, (_m, head, num) => `${head}${Number(num) + 1}`);
  add("LIMIT +1", /\bLIMIT\s+(\d+)/i, (_m, n) => `LIMIT ${Number(n) + 1}`);
  if (ordered) add("DESC → ASC", /\bDESC\b/i, "ASC");
  add("AVG → SUM", /\bAVG\s*\(/i, "SUM(");
  add("MAX → MIN", /\bMAX\s*\(/i, "MIN(");
  return mutants.slice(0, 10);
}

function requiredFeaturesProblem(difficulty: RoundDifficulty, features: QueryFeatures): { message: string; severity: "error" | "warning" } | null {
  switch (difficulty) {
    case "basic":
      if (features.cte || features.window || features.outerJoin)
        return { message: "A Basic-round solution should not need CTEs, window functions or outer joins.", severity: "warning" };
      return null;
    case "intermediate":
      if (!features.join && !features.groupBy && !features.subquery)
        return { message: "An Intermediate challenge should require a JOIN, GROUP BY/HAVING or a subquery.", severity: "error" };
      return null;
    case "advanced": {
      const used = [features.join, features.subquery, features.cte, features.caseExpr, features.window, features.groupBy && features.having].filter(Boolean).length;
      return used >= 2
        ? null
        : { message: "An Advanced challenge should combine at least two of: multi-table joins, subqueries, CTEs, CASE, window functions, GROUP BY/HAVING.", severity: "error" };
    }
  }
}

/**
 * The shared validation pipeline for every challenge, whether written by a model or a human:
 * static checks → fixture integrity → provisioning → reference solution executed on every
 * dataset → expected outputs derived from execution → quality and strength checks.
 * Nothing becomes publishable unless this returns ok.
 */
export async function validateAndDerive(content: ChallengeContent, sql: SqlExecutionService, extraWarnings: string[] = []): Promise<ValidationOutcome> {
  const started = Date.now();
  const checks: ValidationCheck[] = [];
  const warnings: string[] = [...extraWarnings];
  const add = (name: string, passed: boolean, message: string, severity: "error" | "warning" = "error") => {
    checks.push({ name, passed, message, severity });
    if (!passed && severity === "warning") warnings.push(message);
  };
  const finish = (derived?: ValidationOutcome["derived"]): ValidationOutcome => ({
    ok: checks.every((check) => check.passed || check.severity === "warning"),
    report: { checks, warnings, durationMs: Date.now() - started },
    ...(derived ? { derived } : {}),
  });

  if (!sql.canExecute || !sql.canProvision) {
    add("sql_engine", false, "The SQL engine is not configured (SQL_EXECUTOR_DATABASE_URL and SQL_SETUP_DATABASE_URL), so the challenge cannot be validated.");
    return finish();
  }
  const tables = content.schema.tables.map((table) => table.name);
  const comparison = {
    ordered: content.comparisonPolicy.ordered,
    matchColumnNames: content.comparisonPolicy.matchColumnNames,
    numericScale: 6,
  };

  // --- datasets -------------------------------------------------------------------------------
  const datasets = [
    ...content.publicSamples.map((sample, index) => ({
      id: `sample-${index + 1}`,
      kind: "public" as const,
      label: `Sample test ${index + 1}`,
      category: "sample" as TestCategory,
      description: sample.description,
      rows: sample.rows,
      weight: 1,
      mandatory: true,
    })),
    ...content.candidateTestCases.map((test, index) => ({
      id: `hidden-${index + 1}`,
      kind: "hidden" as const,
      label: `Hidden test ${index + 1}`,
      category: test.category as TestCategory,
      description: test.description,
      rows: test.rows,
      weight: test.weight,
      mandatory: test.mandatory,
    })),
  ];
  if (datasets.length > MAX_DATASETS) {
    add("dataset_count", false, `Too many datasets (${datasets.length}); the maximum is ${MAX_DATASETS}.`);
    return finish();
  }

  const problems = datasets.flatMap((dataset) => validateDatasetRows(content.schema, dataset.rows, dataset.label));
  add("fixture_integrity", problems.length === 0, problems.length === 0 ? "All fixtures satisfy the schema, primary keys and foreign keys." : problems.slice(0, 8).join(" | "));
  if (problems.length > 0) return finish();

  const hasNullableColumn = content.schema.tables.some((table) => table.columns.some((column) => column.nullable && !column.primaryKey));

  // --- solution (static) ----------------------------------------------------------------------
  const staticCheck = await validateSql(content.solutionSql, { allowedTables: tables, maxLength: 5000 });
  add("solution_static", staticCheck.ok, staticCheck.ok ? "The reference solution is a single permitted SELECT." : `Reference solution rejected: ${staticCheck.message}`);
  if (!staticCheck.ok) return finish();
  const features = staticCheck.features;

  const orderCheck = !comparison.ordered || features.orderBy;
  add("ordering_declared", orderCheck, orderCheck ? "Ordering policy is consistent with the solution." : "The comparison requires ordered output but the reference solution has no ORDER BY.");
  const featureProblem = requiredFeaturesProblem(content.difficulty, features);
  add("difficulty_fit", featureProblem === null, featureProblem?.message ?? `The solution uses SQL features appropriate for the ${content.difficulty} round.`, featureProblem?.severity ?? "error");

  const solutionNorm = normalizeText(content.solutionSql);
  const leakIn = [content.narrative, content.problemStatement, content.taskDescription, ...content.hints, ...content.constraints, content.starterSql].find((field) =>
    normalizeText(field).includes(solutionNorm),
  );
  add("no_solution_leak", !leakIn, leakIn ? "The reference solution appears verbatim in participant-visible text." : "The reference solution is not leaked in participant-visible text.");
  add(
    "starter_not_solution",
    normalizeText(content.starterSql) !== solutionNorm,
    normalizeText(content.starterSql) !== solutionNorm ? "The starter query is not the solution." : "The starter query equals the solution.",
  );

  // --- provisioning + execution ---------------------------------------------------------------
  let refs: DatasetRef[] = [];
  try {
    refs = await Promise.all(datasets.map((dataset) => sql.ensureDataset(content.schema, dataset.rows)));
    add("provisioning", true, `${datasets.length} datasets loaded into the sandbox.`);
  } catch (error) {
    const message =
      error instanceof FixtureError ? error.problems.slice(0, 5).join(" | ") : error instanceof SqlEngineUnavailableError ? error.message : "Datasets could not be loaded.";
    add("provisioning", false, message);
    return finish();
  }

  const expectedRaw: ExecutionSuccess[] = [];
  const executionErrors: string[] = [];
  const mutantResults: Array<{ mutant: Mutant; killed: boolean }> = [];
  let mutants: Mutant[] = [];

  try {
    await sql.schedule(VALIDATION_USER, async (ctx) => {
      for (const [index, ref] of refs.entries()) {
        const outcome = await ctx.execute(ref, content.solutionSql, tables, { timeoutMs: 3000 });
        if (!outcome.ok) {
          executionErrors.push(`${datasets[index]!.label}: ${outcome.category} — ${outcome.message}`);
        } else if (outcome.truncated) {
          executionErrors.push(`${datasets[index]!.label}: result exceeds the row limit`);
        } else {
          expectedRaw.push(outcome);
        }
      }
      if (executionErrors.length > 0) return;

      // Mutation testing: do the datasets tell the solution apart from plausible wrong answers?
      const expectedCanonical = expectedRaw.map((raw) => canonicalize(raw, comparison));
      mutants = buildMutants(content.solutionSql, comparison.ordered);
      for (const mutant of mutants) {
        let killed = false;
        let applicable = true;
        for (const [index, ref] of refs.entries()) {
          const outcome = await ctx.execute(ref, mutant.sql, tables, { timeoutMs: 2000 });
          if (!outcome.ok) {
            if (outcome.category === "SQL_SYNTAX_ERROR" || outcome.category === "INVALID_QUERY") {
              applicable = false; // the mutation produced something that is not a valid query: ignore it
              break;
            }
            killed = true; // a runtime error is a visible deviation from the reference behaviour
            continue;
          }
          if (outcome.truncated || !compareTables(canonicalize(outcome, comparison), expectedCanonical[index]!, comparison).equal) killed = true;
        }
        if (applicable) mutantResults.push({ mutant, killed });
      }
    });
  } catch (error) {
    add("execution", false, error instanceof SqlEngineUnavailableError ? error.message : "The SQL engine could not run the reference solution.");
    return finish();
  }

  add(
    "solution_runs",
    executionErrors.length === 0,
    executionErrors.length === 0 ? `The reference solution runs on all ${datasets.length} datasets.` : `The reference solution failed — ${executionErrors.slice(0, 4).join(" | ")}`,
  );
  if (executionErrors.length > 0) return finish();

  const expected = expectedRaw.map((raw) => canonicalize(raw, comparison));

  // --- quality checks -------------------------------------------------------------------------
  const sampleCount = content.publicSamples.length;
  const publicEmpty = expected.slice(0, sampleCount).some((table) => table.rows.length === 0);
  add("sample_not_empty", !publicEmpty, publicEmpty ? "A public sample produces an empty result; participants need a visible example." : "Public samples show non-empty output.");
  const allEmpty = expected.every((table) => table.rows.length === 0);
  add("not_all_empty", !allEmpty, allEmpty ? "Every dataset produces an empty result." : "Datasets produce meaningful results.");
  const hiddenExpected = expected.slice(sampleCount);
  const differing = hiddenExpected.filter((table) => !compareTables(table, expected[0]!, comparison).equal).length;
  add(
    "hidden_differs_from_sample",
    differing > 0,
    differing > 0
      ? `${differing} of ${hiddenExpected.length} hidden datasets give results different from the public sample (hard-coding the sample fails).`
      : "Every hidden dataset gives the same result as the public sample, so hard-coding the sample would pass.",
  );
  add(
    "hidden_diversity",
    differing >= Math.ceil(hiddenExpected.length / 2),
    "At least half of the hidden datasets should give results that differ from the sample.",
    "warning",
  );
  add("edge_empty", hiddenExpected.some((table) => table.rows.length === 0), "No hidden dataset exercises the empty-result edge case.", "warning");
  add(
    "edge_nulls",
    !hasNullableColumn || content.candidateTestCases.some((test) => Object.values(test.rows).some((rows) => rows.some((row) => row.some((cell) => cell === null)))),
    "Hidden datasets contain no NULL values although the schema has nullable columns.",
    "warning",
  );
  add("hidden_count", content.candidateTestCases.length >= 3, "At least three hidden datasets are required.");

  // --- claimed output vs executed output ------------------------------------------------------
  content.publicSamples.forEach((sample, index) => {
    if (!sample.expectedOutput) return;
    const claimed = canonicalize({ columns: sample.expectedOutput.columns, typeOids: expectedRaw[index]!.typeOids, rows: sample.expectedOutput.rows }, comparison);
    const same = compareTables(claimed, expected[index]!, comparison).equal;
    add(`claimed_output_${index + 1}`, same, `The author's expected output for sample ${index + 1} differs from what the reference solution returns; the executed output is used.`, "warning");
  });

  // --- test strength (mutation testing) -------------------------------------------------------
  if (mutantResults.length > 0) {
    const killed = mutantResults.filter((r) => r.killed).length;
    const survivors = mutantResults.filter((r) => !r.killed).map((r) => r.mutant.name);
    const strong = mutantResults.length < 2 || killed > 0;
    add(
      "test_strength",
      strong,
      strong
        ? `Datasets distinguish the solution from ${killed}/${mutantResults.length} plausible wrong answers${survivors.length ? ` (undetected: ${survivors.join(", ")})` : ""}.`
        : `The datasets cannot tell the solution apart from plausible wrong answers (${survivors.join(", ")}). Add datasets that cover these edge cases.`,
    );
    if (strong && survivors.length > 0) add("test_strength_gaps", false, `Undetected variants: ${survivors.join(", ")}.`, "warning");
  }

  const toPreview = (raw: ExecutionSuccess): ResultTable => ({ columns: raw.columns, rows: raw.rows.slice(0, PREVIEW_ROWS) });
  const samples: PublicSample[] = content.publicSamples.map((sample, index) => ({
    id: `sample-${index + 1}`,
    name: sample.name,
    description: sample.description,
    rows: normalizeRows(content.schema, sample.rows),
    expectedOutput: toPreview(expectedRaw[index]!),
  }));
  const tests: DerivedTest[] = datasets.map((dataset, index) => ({
    label: dataset.label,
    order: index + 1,
    visibility: dataset.kind,
    category: dataset.category,
    description: dataset.description,
    rows: normalizeRows(content.schema, dataset.rows),
    expected: expected[index]!,
    comparison,
    weight: dataset.weight,
    mandatory: dataset.mandatory,
    sampleId: dataset.kind === "public" ? dataset.id : null,
  }));
  return finish({ samples, tests, features });
}
