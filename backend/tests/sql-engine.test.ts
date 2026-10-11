import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalize, compareTables } from "@/modules/sql-execution/compare";
import type { ExecutionSuccess } from "@/modules/sql-execution/executor";
import { FixtureError } from "@/modules/sql-execution/provisioner";
import type { DatasetRef, SqlFailure } from "@/modules/sql-execution/types";
import { SqlEngineUnavailableError, type SqlExecutionService } from "@/modules/sql-execution/service";
import { QueueRejectedError } from "@/queues/job-queue";
import { collegeSchema, createSqlService, otherRows, sampleRows } from "./helpers/sample-data";

const TABLES = collegeSchema.tables.map((t) => t.name);
let sql: SqlExecutionService;
let sample: DatasetRef;
let other: DatasetRef;

beforeAll(async () => {
  sql = createSqlService();
  sample = await sql.ensureDataset(collegeSchema, sampleRows);
  other = await sql.ensureDataset(collegeSchema, otherRows);
});
afterAll(async () => {
  await sql.close();
});

const run = (query: string, dataset = sample, user = "u1") => sql.executeOnce(user, dataset, query, TABLES);
async function success(query: string, dataset = sample): Promise<ExecutionSuccess> {
  const result = await run(query, dataset);
  expect(result, query).toMatchObject({ ok: true });
  return result as ExecutionSuccess;
}
async function failure(query: string, dataset = sample): Promise<SqlFailure> {
  const result = await run(query, dataset);
  expect(result.ok, query).toBe(false);
  return result as SqlFailure;
}
const raw = (query: string, dataset = sample, overrides?: { timeoutMs?: number; maxRows?: number }) =>
  sql.executeUnvalidatedForTesting(dataset, query, overrides);

describe("health and configuration", () => {
  it("reports the engine as up and exposes queue statistics", async () => {
    const health = await sql.health();
    expect(health.status).toBe("up");
    expect(health.executor.ok).toBe(true);
    expect(health.provisioning.configured).toBe(true);
    expect(health.queue.concurrency).toBeGreaterThan(0);
  });

  it("is unavailable when no executor is configured", async () => {
    const unconfigured = createSqlService({ executorUrl: null, setupUrl: null });
    expect((await unconfigured.health()).status).toBe("not_configured");
    await expect(unconfigured.executeOnce("u", sample, "SELECT 1", TABLES)).rejects.toBeInstanceOf(SqlEngineUnavailableError);
    await expect(unconfigured.ensureDataset(collegeSchema, sampleRows)).rejects.toBeInstanceOf(SqlEngineUnavailableError);
  });

  it("degrades gracefully when the database cannot be reached", async () => {
    const broken = createSqlService({ executorUrl: "postgresql://sql_runner:x@127.0.0.1:1/none" });
    expect((await broken.health()).status).toBe("down");
    const result = await broken.executeOnce("u", sample, "SELECT 1", TABLES);
    expect(result).toMatchObject({ ok: false, category: "INTERNAL_ERROR" });
    await broken.close();
  });
});

describe("dataset provisioning (trusted path)", () => {
  it("is idempotent and content-addressed", async () => {
    const again = await sql.ensureDataset(collegeSchema, sampleRows);
    expect(again).toEqual(sample);
    expect(sample.schema).toBe(`ds_${sample.key}`);
    expect(other.key).not.toBe(sample.key);
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => sql.ensureDataset(collegeSchema, { ...sampleRows, events: [[1, "Concurrent", 1], [2, "A", 1], [3, "B", 1]] })));
    expect(new Set(concurrent.map((d) => d.key)).size).toBe(1);
    const second = createSqlService(); // a different process would race with us on the same dataset
    const [a, b] = await Promise.all([
      second.ensureDataset(collegeSchema, { ...sampleRows, events: [[1, "Race", 1], [2, "A", 1], [3, "B", 1]] }),
      sql.ensureDataset(collegeSchema, { ...sampleRows, events: [[1, "Race", 1], [2, "A", 1], [3, "B", 1]] }),
    ]);
    expect(a).toEqual(b);
    await second.close();
  });

  it("rejects invalid fixtures before touching the database", async () => {
    const expectProblem = async (rows: typeof sampleRows, fragment: string) => {
      const error = await sql.ensureDataset(collegeSchema, rows).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FixtureError);
      expect((error as FixtureError).problems.join("\n")).toContain(fragment);
    };
    await expectProblem({ ...sampleRows, students: [...sampleRows.students!, [1, "Dup", 1, null, 20, null, null]] }, "duplicate primary key");
    await expectProblem({ ...sampleRows, students: [[9, "Orphan", 99, null, 20, null, null]] }, "has no matching departments.id");
    await expectProblem({ ...sampleRows, students: [[9, "Bad", 1, null, "twenty", null, null]] }, "age expects an integer");
    await expectProblem({ ...sampleRows, students: [[9, null, 1, null, 20, null, null]] }, "must not be NULL");
    await expectProblem({ ...sampleRows, students: [[9, "x", 1, null, 20, null, "2024-02-31"]] }, "joined_on expects a date");
    await expectProblem({ ...sampleRows, students: [[9, "short"]] }, "expected 7");
    await expectProblem({ ...sampleRows, ghosts: [[1]] }, 'unknown table "ghosts"');
    await expectProblem({ ...sampleRows, departments: [[1, "x".repeat(80)]] }, "longer than 50");
  });

  it("repairs a dataset that disappeared from the engine", async () => {
    const rows = { ...sampleRows, events: [[1, "Repair me", 1], [2, "A", 1], [3, "B", 1]] };
    const ref = await sql.ensureDataset(collegeSchema, rows);
    // simulate an operator wiping the dataset behind our back
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: process.env.TEST_PG_ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA "${ref.schema}" CASCADE`);
    await admin.query(`DROP ROLE "${ref.role}"`);
    await admin.end();
    const broken = await run("SELECT * FROM events", ref);
    expect(broken).toMatchObject({ ok: false, category: "INTERNAL_ERROR", datasetMissing: true });
    const fixed = await sql.repairDataset(collegeSchema, rows, ref.key);
    expect(fixed.key).toBe(ref.key);
    const again = await success("SELECT title FROM events", fixed);
    expect(again.rows).toEqual([["Repair me"], ["A"], ["B"]]);
  });
});

describe("executing participant queries", () => {
  it("returns columns, typed values and OIDs", async () => {
    const r = await success("SELECT id, name, gpa, joined_on, COUNT(*) OVER () AS total FROM students WHERE id <= 2 ORDER BY id");
    expect(r.columns).toEqual(["id", "name", "gpa", "joined_on", "total"]);
    expect(r.rows).toEqual([
      [1, "Asha", "3.80", "2023-07-01", 2],
      [2, "Bilal", "3.10", "2023-07-02", 2],
    ]);
    expect(r.typeOids).toEqual([23, 1043, 1700, 1082, 20]);
    expect(r.truncated).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles empty results, NULLs and duplicate rows", async () => {
    const empty = await success("SELECT name FROM students WHERE age > 100");
    expect(empty).toMatchObject({ columns: ["name"], rows: [], rowCount: 0 });
    const nulls = await success("SELECT email FROM students WHERE email IS NULL");
    expect(nulls.rows).toEqual([[null]]);
    const dups = await success("SELECT dept_id FROM students WHERE dept_id IS NOT NULL ORDER BY dept_id");
    expect(dups.rows).toEqual([[1], [1], [2], [2]]);
    const distinct = await success("SELECT DISTINCT dept_id FROM students ORDER BY dept_id NULLS LAST");
    expect(distinct.rows).toEqual([[1], [2], [null]]);
  });

  it("supports joins, grouping, subqueries, CTEs, CASE and window functions", async () => {
    const joined = await success(
      "SELECT d.name, COUNT(s.id) AS n FROM departments d LEFT JOIN students s ON s.dept_id = d.id GROUP BY d.name HAVING COUNT(s.id) >= 0 ORDER BY n DESC, d.name",
    );
    expect(joined.rows).toEqual([["Computer Engineering", 2], ["Information Technology", 2], ["Mechanical", 0]]);
    const nested = await success("SELECT name FROM students WHERE id IN (SELECT student_id FROM registrations WHERE status = 'no_show')");
    expect(nested.rows).toEqual([["Bilal"]]);
    const cte = await success(
      "WITH c AS (SELECT student_id, COUNT(*) n FROM registrations GROUP BY student_id) SELECT s.name, CASE WHEN c.n > 1 THEN 'busy' ELSE 'light' END AS load FROM c JOIN students s ON s.id = c.student_id ORDER BY s.name",
    );
    expect(cte.rows).toEqual([["Asha", "busy"], ["Bilal", "light"], ["Chen", "busy"], ["Divya", "light"]]);
    const win = await success("SELECT name, RANK() OVER (ORDER BY age DESC) AS r FROM students ORDER BY r, name LIMIT 2");
    expect(win.rows).toEqual([["Divya", 1], ["Bilal", 2]]);
  });

  it("returns timestamps verbatim in UTC and numerics without float drift", async () => {
    const r = await success("SELECT registered_at, AVG(gpa) AS avg_gpa, SUM(age) FROM registrations r JOIN students s ON s.id = r.student_id WHERE r.id = 5 GROUP BY registered_at");
    expect(r.rows[0]?.[0]).toBe("2024-03-02 09:15:30");
    expect(typeof r.rows[0]?.[1]).toBe("object"); // NULL gpa -> null
  });

  it("caps result size and flags truncation", async () => {
    const r = await success("WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 1000) SELECT i FROM r");
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBe(200);
    expect(r.rows).toHaveLength(200);
  });

  it("stops runaway queries with a timeout instead of hanging", async () => {
    const started = Date.now();
    const f = await failure("WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT COUNT(*) FROM r");
    expect(f.category).toBe("QUERY_TIMEOUT");
    expect(f.message).toMatch(/too long/);
    expect(Date.now() - started).toBeLessThan(6000);
    // the connection is healthy again afterwards
    expect((await success("SELECT 1")).rows).toEqual([[1]]);
  });

  it("reports helpful, sanitised errors", async () => {
    const col = await failure("SELECT salary FROM students");
    expect(col.category).toBe("EXECUTION_ERROR");
    expect(col.message).toContain('column "salary" does not exist');
    expect(col.message).not.toMatch(/ds_[0-9a-f]{24}/);
    expect(col.line).toBe(1);
    expect(col.column).toBe(8);
    const div = await failure("SELECT 1 / (age - age) FROM students");
    expect(div).toMatchObject({ category: "EXECUTION_ERROR", message: "division by zero" });
    const type = await failure("SELECT name FROM students WHERE age = 'abc'");
    expect(type.category).toBe("EXECUTION_ERROR");
    const syntax = await failure("SELEC name FROM students");
    expect(syntax).toMatchObject({ category: "SQL_SYNTAX_ERROR", line: 1, column: 1 });
    const invalid = await failure("DROP TABLE students");
    expect(invalid.category).toBe("INVALID_QUERY");
    for (const f of [col, div, type, syntax, invalid]) {
      expect(JSON.stringify(f)).not.toMatch(/sql_runner|sql_setup|sql_meta|password|127\.0\.0\.1/i);
    }
  });

  it("rejects disallowed statements before they reach the database", async () => {
    for (const query of [
      "INSERT INTO students VALUES (99, 'x', 1, null, 1, null, null)",
      "UPDATE students SET name = 'x'",
      "DELETE FROM students",
      "CREATE TABLE t (a int)",
      "SELECT 1; SELECT 2",
      "SELECT * FROM pg_roles",
      "SELECT pg_sleep(5)",
    ]) {
      const f = await failure(query);
      expect(f.category).toBe("INVALID_QUERY");
      expect(f.durationMs).toBe(0);
    }
    expect((await success("SELECT COUNT(*) FROM students")).rows).toEqual([[5]]);
  });
});

describe("database-level isolation (validator bypassed on purpose)", () => {
  // These statements never pass the validator. Here we prove the DATABASE refuses them anyway,
  // by checking the raw SQLSTATE that PostgreSQL returned.
  const refusedWith = async (query: string, codes: string[]) => {
    const r = await sql.sqlStateForTesting(sample, query);
    expect(r.ok, query).toBe(false);
    if (!r.ok) expect(codes, `${query} -> ${r.code} ${r.message}`).toContain(r.code);
  };
  const PERMISSION = "42501";
  const READ_ONLY = "25006";

  it("is read-only: writes and DDL are refused by PostgreSQL itself", async () => {
    for (const query of [
      "INSERT INTO students VALUES (50, 'x', 1, null, 1, null, null)",
      "UPDATE students SET name = 'x'",
      "DELETE FROM students",
      "CREATE TABLE t (a int)",
      "CREATE TEMP TABLE t (a int)",
      "DROP TABLE students",
      "TRUNCATE students",
      "SELECT * INTO newt FROM students",
      "GRANT ALL ON students TO PUBLIC",
      "ALTER TABLE students ADD COLUMN x int",
    ]) {
      await refusedWith(query, [PERMISSION, READ_ONLY, "42501", "42P01", "0A000"]);
    }
    expect((await success("SELECT COUNT(*) FROM students")).rows).toEqual([[5]]);
  });

  it("allows only one statement per execution (extended protocol)", async () => {
    await refusedWith("SELECT 1; DROP TABLE students", ["42601"]);
    await refusedWith("SELECT 1; SELECT 2", ["42601"]);
    expect((await success("SELECT COUNT(*) FROM students")).rows).toEqual([[5]]);
  });

  it("cannot read other datasets, the registry, or switch roles", async () => {
    await refusedWith(`SELECT * FROM "${other.schema}".students`, [PERMISSION]);
    await refusedWith("SELECT * FROM sql_meta.datasets", [PERMISSION]);
    await refusedWith("SELECT * FROM public.students", [PERMISSION]);
    await refusedWith(`SELECT set_config('role', '${other.role}', false)`, [PERMISSION]);
    await refusedWith("SELECT set_config('role', 'sql_setup', false)", [PERMISSION]);
    await refusedWith("SELECT set_config('statement_timeout', '0', false)", [PERMISSION]);
    await refusedWith("SELECT set_config('transaction_read_only', 'off', false)", [PERMISSION]);
    await refusedWith("SELECT pg_sleep(0.01)", [PERMISSION]);
    await refusedWith("SELECT pg_terminate_backend(pg_backend_pid())", [PERMISSION]);
    await refusedWith("SELECT pg_cancel_backend(pg_backend_pid())", [PERMISSION]);
    await refusedWith("SELECT pg_read_file('/etc/passwd')", [PERMISSION]);
    await refusedWith("SELECT lo_import('/etc/passwd')", [PERMISSION]);
    await refusedWith("SELECT pg_ls_dir('.')", [PERMISSION]);
    // and the dataset the session is legitimately routed to still works through its own role
    const own = await sql.sqlStateForTesting(sample, `SELECT * FROM "${sample.schema}".students`);
    expect(own.ok).toBe(true);
  });

  it("does not leak session state between executions on pooled connections", async () => {
    for (let i = 0; i < 12; i += 1) {
      const settings = await raw("SELECT current_setting('transaction_read_only') AS ro, current_user::text AS who, current_setting('search_path') AS sp");
      expect(settings).toMatchObject({ ok: true });
      const row = (settings as ExecutionSuccess).rows[0]!;
      expect(row[0]).toBe("on");
      expect(row[1]).toBe(sample.role);
      expect(String(row[2])).toContain(sample.schema);
      const lingering = await raw("SELECT current_setting('statement_timeout') AS t");
      expect((lingering as ExecutionSuccess).rows[0]![0]).toBe("1500ms");
    }
  });

  it("keeps concurrent participants on their own datasets", async () => {
    const jobs = Array.from({ length: 16 }, (_, i) => {
      const dataset = i % 2 === 0 ? sample : other;
      return sql.executeOnce(`user-${i}`, dataset, "SELECT COUNT(*) AS n, MIN(name) AS first_name FROM students", TABLES);
    });
    const results = (await Promise.all(jobs)) as ExecutionSuccess[];
    results.forEach((r, i) => {
      expect(r.ok).toBe(true);
      expect(r.rows[0]).toEqual(i % 2 === 0 ? [5, "Asha"] : [1, "Zed"]);
    });
  });
});

describe("queueing and fairness", () => {
  it("serialises a participant's jobs and sheds load beyond the backlog", async () => {
    const limited = createSqlService({ maxConcurrentJobs: 2, maxConcurrentJobsPerUser: 1, maxQueuedJobs: 50 });
    try {
      const slow = () => limited.schedule("greedy", async (ctx) => ctx.execute(sample, "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 200000) SELECT COUNT(*) FROM r", TABLES));
      const results = await Promise.allSettled([slow(), slow(), slow(), slow(), slow(), slow()]);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected.length).toBeGreaterThan(0);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(QueueRejectedError);
      // another participant is unaffected by the greedy one
      const polite = await limited.executeOnce("polite", sample, "SELECT 1", TABLES);
      expect(polite.ok).toBe(true);
    } finally {
      await limited.close();
    }
  });
});

describe("result comparison against the sandbox output", () => {
  const exec = async (query: string, dataset = sample) => canonicalize(await success(query, dataset));
  const policy = { ordered: false, matchColumnNames: false };

  it("treats integers, bigints and numerics of equal value as equal", async () => {
    const a = await exec("SELECT 5 AS v");
    const b = await exec("SELECT 5::bigint AS v");
    const c = await exec("SELECT 5.00::numeric(5,2) AS v");
    const d = await exec("SELECT 5.0::float8 AS v");
    for (const other of [b, c, d]) expect(compareTables(a, other, policy).equal).toBe(true);
    expect(compareTables(a, await exec("SELECT 6 AS v"), policy)).toMatchObject({ equal: false, reason: "values" });
  });

  it("does not equate different types or NULL with values", async () => {
    expect(compareTables(await exec("SELECT 1 AS v"), await exec("SELECT '1' AS v"), policy).equal).toBe(false);
    expect(compareTables(await exec("SELECT TRUE AS v"), await exec("SELECT 1 AS v"), policy).equal).toBe(false);
    expect(compareTables(await exec("SELECT NULL::int AS v"), await exec("SELECT 0 AS v"), policy).equal).toBe(false);
    expect(compareTables(await exec("SELECT NULL::text AS v"), await exec("SELECT '' AS v"), policy).equal).toBe(false);
    expect(compareTables(await exec("SELECT NULL::int AS v"), await exec("SELECT NULL::int AS v"), policy).equal).toBe(true);
  });

  it("compares floats at a fixed precision rather than bit-for-bit", async () => {
    const a = await exec("SELECT 0.1::float8 + 0.2::float8 AS v");
    const b = await exec("SELECT 0.3::numeric AS v");
    expect(compareTables(a, b, policy).equal).toBe(true);
    const tooFar = await exec("SELECT 0.30001::numeric AS v");
    expect(compareTables(a, tooFar, policy).equal).toBe(false);
  });

  it("honours row order only when the challenge requires it, and multiset semantics for duplicates", async () => {
    const asc = await exec("SELECT name FROM students ORDER BY name");
    const desc = await exec("SELECT name FROM students ORDER BY name DESC");
    expect(compareTables(asc, desc, { ordered: false, matchColumnNames: false }).equal).toBe(true);
    expect(compareTables(asc, desc, { ordered: true, matchColumnNames: false })).toMatchObject({ equal: false, reason: "order" });
    const dups = await exec("SELECT dept_id FROM students WHERE dept_id IS NOT NULL");
    const distinct = await exec("SELECT DISTINCT dept_id FROM students WHERE dept_id IS NOT NULL");
    expect(compareTables(dups, distinct, policy)).toMatchObject({ equal: false, reason: "row_count" });
    const unevenA = canonicalize({ columns: ["x"], typeOids: [23], rows: [[1], [1], [2]] });
    const unevenB = canonicalize({ columns: ["x"], typeOids: [23], rows: [[1], [2], [2]] });
    expect(compareTables(unevenA, unevenB, policy)).toMatchObject({ equal: false, reason: "values" });
  });

  it("checks column count always and names only when asked", async () => {
    const one = await exec("SELECT name FROM students");
    const two = await exec("SELECT name, age FROM students");
    expect(compareTables(one, two, policy)).toMatchObject({ equal: false, reason: "column_count" });
    const renamed = await exec("SELECT name AS who FROM students");
    expect(compareTables(one, renamed, policy).equal).toBe(true);
    expect(compareTables(one, renamed, { ordered: false, matchColumnNames: true })).toMatchObject({ equal: false, reason: "column_names" });
  });

  it("is not fooled by outputs that only coincide on the public sample", async () => {
    const hidden = { ...sampleRows, students: [...sampleRows.students!, [6, "Farah", 1, "f@college.edu", 25, 3.9, "2024-05-01"]] };
    const hiddenRef = await sql.ensureDataset(collegeSchema, hidden);
    const correct = "SELECT name FROM students WHERE age >= 21";
    const hardcoded = "SELECT name FROM students WHERE name IN ('Bilal', 'Divya')"; // happens to match the sample output
    const expectedSample = await exec(correct, sample);
    expect(compareTables(await exec(hardcoded, sample), expectedSample, policy).equal).toBe(true);
    const expectedHidden = await exec(correct, hiddenRef);
    expect(compareTables(await exec(hardcoded, hiddenRef), expectedHidden, policy).equal).toBe(false);
  });
});
