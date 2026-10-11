import { describe, expect, it } from "vitest";
import { validateSql } from "@/modules/sql-execution/validator";

const options = { allowedTables: ["students", "departments", "registrations", "events"], maxLength: 10_000 };
const ok = async (sql: string) => {
  const result = await validateSql(sql, options);
  expect(result, sql).toMatchObject({ ok: true });
  return result as Extract<Awaited<ReturnType<typeof validateSql>>, { ok: true }>;
};
const rejected = async (sql: string, messagePart?: string, category: "INVALID_QUERY" | "SQL_SYNTAX_ERROR" = "INVALID_QUERY") => {
  const result = await validateSql(sql, options);
  expect(result.ok, sql).toBe(false);
  if (!result.ok) {
    expect(result.category).toBe(category);
    if (messagePart) expect(result.message.toLowerCase()).toContain(messagePart.toLowerCase());
  }
};

describe("SQL validator — accepts the syllabus", () => {
  it.each([
    "SELECT * FROM students",
    "SELECT name, email FROM students WHERE age >= 18 AND dept_id IN (1,2,3) ORDER BY name DESC LIMIT 5 OFFSET 2;",
    "SELECT DISTINCT dept_id FROM students WHERE name LIKE 'A%' AND email IS NOT NULL",
    "SELECT COUNT(*), AVG(age), MIN(age), MAX(age), SUM(age) FROM students",
    "SELECT d.name, COUNT(s.id) AS n FROM departments d LEFT JOIN students s ON s.dept_id = d.id GROUP BY d.name HAVING COUNT(s.id) > 2 ORDER BY n DESC",
    "SELECT s.name FROM students s INNER JOIN registrations r ON r.student_id = s.id JOIN events e USING (id)",
    "SELECT name FROM students WHERE id IN (SELECT student_id FROM registrations WHERE event_id = 3)",
    "SELECT name FROM students s WHERE EXISTS (SELECT 1 FROM registrations r WHERE r.student_id = s.id)",
    "SELECT name, (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) AS regs FROM students s",
    "WITH busy AS (SELECT student_id, COUNT(*) c FROM registrations GROUP BY student_id) SELECT s.name, busy.c FROM busy JOIN students s ON s.id = busy.student_id",
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5) SELECT * FROM n",
    "SELECT CASE WHEN age < 18 THEN 'minor' WHEN age < 25 THEN 'young' ELSE 'adult' END AS bucket, COUNT(*) FROM students GROUP BY 1",
    "SELECT SUM(CASE WHEN status = 'attended' THEN 1 ELSE 0 END) FROM registrations",
    "SELECT COUNT(*) FILTER (WHERE age > 20) FROM students",
    "SELECT name, RANK() OVER (PARTITION BY dept_id ORDER BY age DESC), ROW_NUMBER() OVER (ORDER BY id) FROM students",
    "SELECT COALESCE(email, 'n/a'), NULLIF(age, 0), UPPER(name), LOWER(name), LENGTH(name), ROUND(AVG(age), 2) FROM students GROUP BY name, email, age",
    "SELECT CAST(age AS numeric), age::text, age::integer, '2024-01-01'::date, DATE '2024-02-01', TIMESTAMP '2024-01-01 10:00:00' FROM students",
    "SELECT EXTRACT(year FROM joined_on), DATE_TRUNC('month', joined_on), TO_CHAR(joined_on, 'YYYY-MM'), SUBSTRING(name FROM 1 FOR 3), TRIM(name), POSITION('a' IN name) FROM students",
    "SELECT name FROM students UNION SELECT name FROM departments",
    "SELECT name FROM students EXCEPT SELECT name FROM departments",
    "SELECT * FROM (SELECT dept_id, COUNT(*) c FROM students GROUP BY dept_id) t WHERE c > 1",
    "SELECT GREATEST(1,2), LEAST(1,2), 1 + 2 * 3 % 4, 'a' || 'b', age BETWEEN 1 AND 5, NOT (age > 1 OR age < 0), TRUE, NULL FROM students",
    "SELECT name FROM students WHERE age > ALL (SELECT age FROM students WHERE dept_id = 2) AND age <> ANY (SELECT 1)",
    "SELECT * FROM (VALUES (1,'a'),(2,'b')) AS v(id, label)",
    "select 1 -- trailing comment",
    "/* leading comment */ SELECT 1",
    "SELECT 'it''s fine; really' AS txt",
    'SELECT "name" FROM students',
  ])("%s", async (sql) => {
    await ok(sql);
  });

  it("reports the SQL features a query uses", async () => {
    const r = await ok(
      "WITH c AS (SELECT dept_id, COUNT(*) n FROM students GROUP BY dept_id HAVING COUNT(*) > 1) SELECT d.name, CASE WHEN c.n > 3 THEN 'big' ELSE 'small' END FROM departments d LEFT JOIN c ON c.dept_id = d.id WHERE d.id IN (SELECT 1) ORDER BY 1 LIMIT 3",
    );
    expect(r.features).toMatchObject({ join: true, outerJoin: true, groupBy: true, having: true, subquery: true, cte: true, caseExpr: true, aggregate: true, orderBy: true, limit: true, window: false });
    expect(r.referencedTables).toEqual(["departments", "students"]);
  });
});

describe("SQL validator — rejects everything else", () => {
  it("rejects empty and oversized input", async () => {
    await rejected("", "before running");
    await rejected("   \n ", "before running");
    await rejected(";", "before running");
    await rejected(`SELECT '${"x".repeat(10_001)}'`, "too long");
    await rejected("SELECT 1\u0000", "invalid character");
    expect((await validateSql(undefined, options)).ok).toBe(false);
    expect((await validateSql({ sql: "SELECT 1" }, options)).ok).toBe(false);
  });

  it.each([
    ["INSERT INTO students VALUES (1)", "INSERT"],
    ["UPDATE students SET name = 'x'", "UPDATE"],
    ["DELETE FROM students", "DELETE"],
    ["DROP TABLE students", "DROP"],
    ["TRUNCATE students", "TRUNCATE"],
    ["CREATE TABLE x (a int)", "CREATE TABLE"],
    ["ALTER TABLE students ADD COLUMN x int", "ALTER TABLE"],
    ["GRANT ALL ON students TO PUBLIC", "GRANT"],
    ["SET ROLE postgres", "SET"],
    ["SHOW statement_timeout", "SHOW"],
    ["COPY students TO '/tmp/x'", "COPY"],
    ["EXPLAIN SELECT 1", "EXPLAIN"],
    ["BEGIN", "transaction"],
    ["COMMIT", "transaction"],
    ["DO $$ BEGIN PERFORM 1; END $$", "DO"],
    ["CALL foo()", "CALL"],
    ["VACUUM", "VACUUM"],
  ])("rejects non-SELECT statement: %s", async (sql, label) => {
    await rejected(sql, label);
  });

  it("rejects multiple statements, including trailing and comment-hidden ones", async () => {
    await rejected("SELECT 1; SELECT 2", "one SQL statement");
    await rejected("SELECT 1; DROP TABLE students", "one SQL statement");
    await rejected("SELECT 1;; SELECT 2", "one SQL statement");
    await rejected("SELECT 1; -- harmless\n DELETE FROM students", "one SQL statement");
    await rejected("SELECT 1 /* ; */; SELECT 2", "one SQL statement");
    await ok("SELECT 1 /* ; DROP TABLE x */");
    await ok("SELECT ';'");
  });

  it("rejects data-changing CTEs and SELECT INTO / locking", async () => {
    await rejected("WITH d AS (DELETE FROM students RETURNING *) SELECT * FROM d", "data-changing");
    await rejected("WITH i AS (INSERT INTO students VALUES (1) RETURNING *) SELECT * FROM i", "data-changing");
    await rejected("SELECT * INTO newtable FROM students", "INTO");
    await rejected("SELECT * FROM students FOR UPDATE", "locking");
    await rejected("SELECT * FROM students FOR SHARE", "locking");
  });

  it("rejects schema-qualified names, catalogs and unknown tables", async () => {
    await rejected("SELECT * FROM public.students", "schema-qualified");
    await rejected("SELECT * FROM ds_0123456789abcdef01234567.students", "schema-qualified");
    await rejected("SELECT * FROM pg_catalog.pg_roles", "schema-qualified");
    await rejected("SELECT * FROM pg_roles", 'Unknown table "pg_roles"');
    await rejected("SELECT * FROM pg_shadow", "Unknown table");
    await rejected("SELECT * FROM information_schema.tables", "schema-qualified");
    await rejected("SELECT * FROM sql_meta.datasets", "schema-qualified");
    await rejected("SELECT * FROM students s JOIN nope n ON n.id = s.id", 'Unknown table "nope"');
    await rejected('SELECT * FROM "Students"', "Unknown table");
    await rejected("SELECT * FROM (SELECT * FROM secrets) x", 'Unknown table "secrets"');
    await rejected("SELECT 1 WHERE EXISTS (SELECT 1 FROM hidden_table)", "Unknown table");
  });

  it("rejects functions outside the allow-list (privileged, side-effecting, introspective)", async () => {
    for (const sql of [
      "SELECT pg_sleep(10)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT set_config('role', 'postgres', false)",
      "SELECT pg_terminate_backend(1)",
      "SELECT pg_cancel_backend(1)",
      "SELECT lo_import('/etc/passwd')",
      "SELECT version()",
      "SELECT current_setting('server_version')",
      "SELECT now()",
      "SELECT nextval('x')",
      "SELECT query_to_xml('select 1', true, true, '')",
      "SELECT dblink('x', 'select 1')",
      "SELECT pg_catalog.pg_sleep(1)",
      "SELECT public.evil()",
      "SELECT generate_series(1, 1000000000)",
      "SELECT array_agg(id) FROM students",
      "SELECT to_regclass('x')",
      "SELECT inet_server_addr()",
      "SELECT pg_ls_dir('.')",
      'SELECT "pg_sleep"(1)',
      "SELECT PG_SLEEP(1)",
    ]) {
      await rejected(sql, "not available");
    }
  });

  it("rejects value functions, parameters, collations, set-returning FROM items and risky casts", async () => {
    await rejected("SELECT current_user", "CURRENT_USER");
    await rejected("SELECT session_user", "CURRENT_USER");
    await rejected("SELECT current_date", "CURRENT_DATE");
    await rejected("SELECT current_timestamp", "CURRENT_DATE");
    await rejected("SELECT $1", "parameters");
    await rejected("SELECT name COLLATE \"C\" FROM students", "COLLATE");
    await rejected("SELECT * FROM generate_series(1,10)", "FROM clause");
    await rejected("SELECT * FROM unnest(ARRAY[1,2])", "FROM clause");
    await rejected("SELECT * FROM students TABLESAMPLE SYSTEM (50)", "FROM clause");
    await rejected("SELECT 'students'::regclass", "not supported");
    await rejected("SELECT 'x'::regproc", "not supported");
    await rejected("SELECT id::oid FROM students", "not supported");
    await rejected("SELECT '{1,2}'::int[]", "not supported");
    await rejected("SELECT ARRAY[1,2]", "not supported");
  });

  it("reports syntax errors with a position, like PostgreSQL would", async () => {
    const result = await validateSql("SELEC name FROM students", options);
    expect(result).toMatchObject({ ok: false, category: "SQL_SYNTAX_ERROR" });
    if (!result.ok) {
      expect(result.message).toContain('syntax error at or near "SELEC"');
      expect(result.line).toBe(1);
      expect(result.column).toBe(1);
    }
    const second = await validateSql("SELECT name\nFROM students\nWHERE age = = 3", options);
    expect(second).toMatchObject({ ok: false, category: "SQL_SYNTAX_ERROR", line: 3 });
    await rejected("SELECT name FROM", undefined, "SQL_SYNTAX_ERROR");
    await rejected("SELECT 'unterminated", undefined, "SQL_SYNTAX_ERROR");
  });

  it("handles unusual formatting and obfuscation attempts without being fooled", async () => {
    await rejected("SeLeCt 1; DeLeTe FROM students", "one SQL statement");
    await rejected("SELECT 1;\u2028DROP TABLE students", undefined, "SQL_SYNTAX_ERROR");
    await rejected("/**/ DROP /**/ TABLE /**/ students", "DROP");
    await ok("SELECT * FROM students WHERE id = 1; --"); // one statement + a comment
    await rejected("SELECT/**/pg_sleep/**/(5)", "not available");
    await rejected("SELECT chr(112)||chr(103)", "not available");
    await rejected("SELECT $$x$$; DROP TABLE students", "one SQL statement");
    await ok("SELECT $$a;b$$ AS dollar_quoted");
    // an escaped quote inside an E-string keeps the rest of the text inside the literal: still one SELECT
    await ok("SELECT * FROM students WHERE name = E'\\'; DROP TABLE students; --'");
  });

  it("limits query complexity", async () => {
    // ~2,600 additions ≈ 7,800 AST nodes, but still under the 10,000-character input limit.
    await rejected(`SELECT 1${"+1".repeat(2600)}`, "too complex");
    // pathological nesting must never crash the validator (either verdict is acceptable)
    for (const nested of ["(".repeat(4000) + "1" + ")".repeat(4000), "-".repeat(4500) + "1", "NOT ".repeat(2400) + "TRUE"]) {
      await expect(validateSql(`SELECT ${nested}`, options)).resolves.toBeDefined();
    }
  });
});
