import { Client } from "pg";

export const RUNNER_ROLE = "sql_runner";
export const SETUP_ROLE = "sql_setup";
export const META_SCHEMA = "sql_meta";

export interface EngineSetupOptions {
  /** Superuser connection to the dedicated execution database. Used ONLY by this script. */
  adminUrl: string;
  runnerPassword: string;
  setupPassword: string;
  /** Per-statement ceiling baked into the runner role (the application sets a tighter value per query). */
  statementTimeout?: string;
  tempFileLimit?: string;
  workMem?: string;
  runnerConnectionLimit?: number;
}

/** Functions a participant must never be able to call, revoked from PUBLIC as a second line of defence. */
const REVOKED_FUNCTION_NAMES = ["set_config", "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_terminate_backend", "pg_cancel_backend"];

/**
 * Idempotently prepares the dedicated PostgreSQL execution database:
 *
 *  - `sql_runner` — LOGIN, no privileges of its own; may only SET ROLE into per-dataset roles.
 *     Role-level defaults enforce read-only transactions, timeouts and temp-file limits.
 *  - `sql_setup`  — LOGIN + CREATEROLE; used only by trusted provisioning code to load fixtures.
 *  - `sql_meta`   — registry of provisioned datasets, readable only by `sql_setup`.
 *  - PUBLIC loses CONNECT/TEMP/CREATE on the database and CREATE on schema public.
 */
export async function initSqlEngine(options: EngineSetupOptions): Promise<void> {
  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string; superuser: boolean }>(
      "SELECT current_database() AS db, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser",
    );
    const { db, superuser } = rows[0]!;
    if (!superuser) throw new Error("initSqlEngine must run as a PostgreSQL superuser (SQL_ADMIN_DATABASE_URL).");
    const dbId = client.escapeIdentifier(db);
    const runner = client.escapeIdentifier(RUNNER_ROLE);
    const setup = client.escapeIdentifier(SETUP_ROLE);
    const meta = client.escapeIdentifier(META_SCHEMA);

    const ensureRole = async (name: string, attrs: string, password: string) => {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
      const id = client.escapeIdentifier(name);
      const stmt = exists.rowCount ? "ALTER ROLE" : "CREATE ROLE";
      await client.query(`${stmt} ${id} WITH LOGIN ${attrs} PASSWORD ${client.escapeLiteral(password)}`);
    };

    await ensureRole(
      RUNNER_ROLE,
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${options.runnerConnectionLimit ?? 50}`,
      options.runnerPassword,
    );
    await ensureRole(SETUP_ROLE, "NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10", options.setupPassword);

    await client.query(`REVOKE ALL ON DATABASE ${dbId} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${dbId} TO ${runner}, ${setup}`);
    await client.query(`GRANT CREATE ON DATABASE ${dbId} TO ${setup}`);
    await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");

    await client.query(`CREATE SCHEMA IF NOT EXISTS ${meta} AUTHORIZATION ${setup}`);
    await client.query(`REVOKE ALL ON SCHEMA ${meta} FROM PUBLIC`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${meta}.datasets (key text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.query(`ALTER TABLE ${meta}.datasets OWNER TO ${setup}`);

    // Role-level guard rails. The application sets tighter per-query values; these are the floor.
    const settings: Array<[string, string]> = [
      ["statement_timeout", options.statementTimeout ?? "5s"],
      ["lock_timeout", "1s"],
      ["idle_in_transaction_session_timeout", "15s"],
      ["idle_session_timeout", "0"],
      ["default_transaction_read_only", "on"],
      ["temp_file_limit", options.tempFileLimit ?? "64MB"],
      ["work_mem", options.workMem ?? "4MB"],
      ["max_parallel_workers_per_gather", "0"],
      ["application_name", "sql-runner"],
    ];
    for (const [name, value] of settings) {
      await client.query(`ALTER ROLE ${runner} SET ${name} = ${client.escapeLiteral(value)}`);
    }
    await client.query(`ALTER ROLE ${setup} SET application_name = 'sql-setup'`);

    // Look the signatures up instead of hard-coding them: they differ between PostgreSQL versions.
    const functions = await client.query<{ signature: string }>(
      "SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pg_catalog' AND p.proname = ANY($1)",
      [REVOKED_FUNCTION_NAMES],
    );
    for (const { signature } of functions.rows) {
      await client.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
    }
  } finally {
    await client.end();
  }
}
