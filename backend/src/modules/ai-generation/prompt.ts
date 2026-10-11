import type { EventDocument } from "@/modules/events/event.model";
import type { RoundDocument } from "@/modules/rounds/round.model";
import type { SchemaSpec } from "@/modules/sql-execution/types";

export const PROMPT_VERSION = "2025.10-1";

export interface PriorChapter {
  roundNumber: number;
  title: string;
  storySummary: string;
  narrative: string;
  schema: SchemaSpec;
}

const DIFFICULTY_GUIDE: Record<RoundDocument["difficulty"], string> = {
  basic:
    "BASIC (Round 1): SELECT, WHERE, ORDER BY, DISTINCT, simple filtering (AND/OR/IN/BETWEEN/LIKE/IS NULL), basic aggregates (COUNT/SUM/AVG/MIN/MAX) and LIMIT. A single table is ideal; no joins required.",
  intermediate:
    "INTERMEDIATE (Round 2): INNER JOIN and LEFT JOIN across 2–3 tables, GROUP BY with HAVING, multiple conditions, comparing aggregates, and at most one simple (introductory) subquery.",
  advanced:
    "ADVANCED for undergraduates (Round 3): multi-table joins, nested subqueries, common table expressions (WITH), CASE expressions, conditional aggregation, and — only if natural — a ranking window function such as RANK()/ROW_NUMBER(). Combine at least two of these ideas. Difficulty must come from reasoning, never from obscure syntax or trick questions.",
};

const ALLOWED_FUNCTIONS =
  "COUNT, SUM, AVG, MIN, MAX, ROUND, ABS, CEIL, FLOOR, COALESCE, NULLIF, GREATEST, LEAST, UPPER, LOWER, LENGTH, TRIM, SUBSTRING, CONCAT, REPLACE, POSITION, SPLIT_PART, EXTRACT(year|month|day FROM …), DATE_TRUNC, TO_CHAR, AGE, CAST/::, ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD, STRING_AGG, BOOL_AND, BOOL_OR";

export function buildSystemPrompt(): string {
  return [
    "You are an expert SQL educator who designs fair, story-driven programming-contest problems for undergraduate computer-engineering students.",
    "You output ONE JSON object and nothing else — no markdown, no commentary.",
    "",
    "HARD RULES",
    "1. Dialect: PostgreSQL. The reference solution must be a single SELECT statement (WITH … SELECT is allowed). No INSERT/UPDATE/DELETE/DDL.",
    `2. The solution may only call these functions: ${ALLOWED_FUNCTIONS}. Never use NOW(), CURRENT_DATE, CURRENT_TIMESTAMP, RANDOM(), generate_series, arrays or JSON — results must be deterministic. Use fixed dates stored in the data.`,
    "3. Identifiers (tables, columns) are lower_snake_case, start with a letter, max 40 chars, and must not be SQL reserved words (do NOT use user, order, group, table, desc, end, check, default, limit …).",
    "4. Allowed column types: integer, bigint, smallint, text, boolean, date, timestamp, real, double precision, varchar(n), numeric(p,s). Every table needs a primary key. Foreign keys must reference a single-column primary key of the same type.",
    "5. Fixture rows are arrays aligned with the table's column order. Dates are 'YYYY-MM-DD', timestamps 'YYYY-MM-DD HH:MM:SS'. NULL is null. Foreign keys must point at rows that exist. Primary keys are unique.",
    "6. Do NOT compute expected outputs by hand. The platform runs your reference solution to derive them. (You may include an `expectedOutput` guess for the public sample; it is only cross-checked.)",
    "7. If the output order matters, set comparisonPolicy.ordered=true, use ORDER BY with a fully deterministic tie-breaker (e.g. add the primary key), and say so in taskDescription. Otherwise set ordered=false.",
    "8. taskDescription must state EXACTLY which columns to return, in order, with aliases, plus any rounding (use ROUND(x, 2)) and ordering requirements, so a correct answer is unambiguous.",
    "9. Never reveal the solution in narrative, problemStatement, taskDescription, hints or starterSql. starterSql may contain only a skeleton or comments.",
    "10. Create 1 public sample (5–12 rows per table) and 4–6 hidden test datasets that use the SAME schema with different data. Hidden datasets must differ meaningfully from the sample and cover: an empty-result case, NULLs, duplicates, boundary values, and multiple matching rows / missing optional relations where relevant. Keep each table ≤ 25 rows. A query that merely hard-codes the sample's answer must FAIL the hidden tests.",
    "11. Tone: a fictional college/campus mystery or business scenario. Be suitable for all audiences. No real people, brands or personal data.",
  ].join("\n");
}

export interface UserPromptInput {
  event: EventDocument;
  round: RoundDocument;
  prior: PriorChapter[];
  siblingTitles: string[];
  guidance: string;
  feedback?: string[];
}

export function buildUserPrompt(input: UserPromptInput): string {
  const { event, round, prior, siblingTitles, guidance, feedback } = input;
  const premise = event.premise;
  const lines: string[] = [];

  lines.push("EVENT PREMISE");
  lines.push(`Name: ${event.name}`);
  if (event.description) lines.push(`About: ${event.description}`);
  if (premise.setting) lines.push(`Setting: ${premise.setting}`);
  if (premise.tone) lines.push(`Tone: ${premise.tone}`);
  if (premise.characters.length > 0) lines.push(`Recurring characters: ${premise.characters.join(", ")}`);
  if (premise.notes) lines.push(`Notes: ${premise.notes}`);

  lines.push("", `TARGET: Round ${round.number} — ${DIFFICULTY_GUIDE[round.difficulty]}`);
  lines.push(`Set "difficulty" to "${round.difficulty}".`);

  if (prior.length > 0) {
    lines.push("", "STORY SO FAR (continue this exact fictional world; do not change the setting, characters or timeline):");
    for (const chapter of prior) {
      lines.push(`- Chapter ${chapter.roundNumber}: "${chapter.title}" — ${chapter.storySummary || chapter.narrative.slice(0, 400)}`);
    }
    const last = prior[prior.length - 1]!;
    lines.push(
      "",
      "DATABASE FROM THE PREVIOUS CHAPTER (reuse these tables/columns where it makes sense and extend with new tables if the plot needs them; keep names consistent):",
      ...last.schema.tables.map((t) => `  ${t.name}(${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")})`),
    );
    lines.push("", `This chapter must open by following directly from the previous one, then raise the SQL difficulty to the target level.`);
  } else {
    lines.push("", "This is the OPENING chapter of the story. Establish the world, the stakes and a hook that later rounds can continue.");
  }
  if (siblingTitles.length > 0) lines.push("", `Other challenges already in this round (do not duplicate): ${siblingTitles.join("; ")}`);
  if (guidance) lines.push("", `ORGANISER GUIDANCE: ${guidance}`);

  lines.push(
    "",
    "OUTPUT — a single JSON object with exactly these fields:",
    JSON.stringify(
      {
        title: "short title (3–12 words)",
        narrative: "2–4 paragraphs of story that frame this chapter (no SQL)",
        problemStatement: "what the student must find out, in plain language",
        taskDescription: "exact output spec: columns in order with aliases, ordering, rounding",
        difficulty: round.difficulty,
        concepts: ["SELECT", "WHERE"],
        dialect: "postgresql",
        schema: {
          tables: [
            {
              name: "students",
              description: "…",
              columns: [
                { name: "id", type: "integer", nullable: false, primaryKey: true, description: "…" },
                { name: "dept_id", type: "integer", nullable: true, primaryKey: false, references: { table: "departments", column: "id" } },
              ],
            },
          ],
        },
        publicSamples: [{ name: "Sample", description: "…", rows: { students: [[1, 10]] }, expectedOutput: { columns: ["name"], rows: [["Asha"]] } }],
        candidateTestCases: [
          { category: "empty_result", description: "no row matches", rows: { students: [[1, 10]] }, weight: 1, mandatory: true },
        ],
        starterSql: "-- Write your query here\nSELECT ",
        hints: ["gentle hint 1", "gentle hint 2"],
        constraints: ["e.g. Return exactly two columns"],
        solutionSql: "SELECT … ;",
        comparisonPolicy: { ordered: false, matchColumnNames: false },
        explanation: "why the solution works (shown to admins only)",
        storySummary: "2–3 sentences: what the investigator has learned and the open thread leading to the next chapter",
      },
      null,
      1,
    ),
    "",
    'Allowed values for candidateTestCases[].category: "normal","empty_result","duplicates","nulls","boundary","multiple_matches","missing_relation","aggregation","join".',
    "Every table of the schema should appear in `rows` for each dataset (use [] for an empty table).",
  );

  if (feedback && feedback.length > 0) {
    lines.push(
      "",
      "YOUR PREVIOUS ANSWER WAS REJECTED. Fix every problem below and return the COMPLETE corrected JSON object:",
      ...feedback.map((item) => `- ${item}`),
    );
  }
  return lines.join("\n");
}
