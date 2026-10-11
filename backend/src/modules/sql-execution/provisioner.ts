import { Pool, type PoolClient } from "pg";
import { logger } from "@/utils/logger";
import {
  createTableSql,
  datasetKey,
  insertStatements,
  normalizeRows,
  orderTables,
  quoteIdent,
  roleNameFor,
  schemaNameFor,
  validateDatasetRows,
} from "./fixtures";
import { META_SCHEMA, RUNNER_ROLE } from "./engine-setup";
import type { DatasetRef, DatasetRows, SchemaSpec } from "./types";

/**
 * Trusted fixture loader. Runs under the `sql_setup` role and never executes
 * participant-supplied SQL: DDL/DML is generated from validated, structured
 * specifications with quoted identifiers and bound parameters.
 *
 * Every dataset gets its own PostgreSQL schema and its own NOLOGIN role that can
 * read exactly that schema, so a participant's session (which can only `SET ROLE`
 * into the dataset it was routed to) cannot see any other dataset.
 */
export class DatasetProvisioner {
  private readonly known = new Map<string, DatasetRef>();
  private readonly inflight = new Map<string, Promise<DatasetRef>>();

  constructor(private readonly pool: Pool) {}

  forget(key: string): void {
    this.known.delete(key);
  }

  ensure(schema: SchemaSpec, rows: DatasetRows): Promise<DatasetRef> {
    // Validate what was actually supplied (so stray tables are reported rather than silently dropped).
    const problems = validateDatasetRows(schema, rows, "dataset");
    if (problems.length > 0) return Promise.reject(new FixtureError(problems));
    const normalized = normalizeRows(schema, rows);
    const key = datasetKey(schema, normalized);
    const cached = this.known.get(key);
    if (cached) return Promise.resolve(cached);
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.provision(key, schema, normalized)
        .then((ref) => {
          this.known.set(key, ref);
          return ref;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async provision(key: string, schema: SchemaSpec, rows: DatasetRows): Promise<DatasetRef> {
    const ref: DatasetRef = { key, schema: schemaNameFor(key), role: roleNameFor(key) };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`dataset:${key}`]);
      const exists = await client.query(`SELECT 1 FROM ${META_SCHEMA}.datasets WHERE key = $1`, [key]);
      if (exists.rowCount && (await this.isIntact(client, ref))) {
        await client.query("COMMIT");
        return ref;
      }
      if (exists.rowCount) {
        // Registry says provisioned but objects are gone/partial: rebuild from scratch.
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(ref.schema)} CASCADE`);
        await client.query(`DROP ROLE IF EXISTS ${quoteIdent(ref.role)}`);
        await client.query(`DELETE FROM ${META_SCHEMA}.datasets WHERE key = $1`, [key]);
      }

      await client.query(`CREATE SCHEMA ${quoteIdent(ref.schema)}`);
      for (const table of orderTables(schema)) {
        await client.query(createTableSql(ref.schema, table));
        for (const statement of insertStatements(ref.schema, table, rows[table.name] ?? [])) {
          await client.query(statement.text, statement.values);
        }
      }
      await client.query(
        `CREATE ROLE ${quoteIdent(ref.role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await client.query(`GRANT USAGE ON SCHEMA ${quoteIdent(ref.schema)} TO ${quoteIdent(ref.role)}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(ref.schema)} TO ${quoteIdent(ref.role)}`);
      await client.query(`GRANT ${quoteIdent(ref.role)} TO ${quoteIdent(RUNNER_ROLE)}`);
      await client.query(`INSERT INTO ${META_SCHEMA}.datasets (key) VALUES ($1)`, [key]);
      await client.query("COMMIT");
      logger.debug({ dataset: key }, "dataset provisioned");
      return ref;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async isIntact(client: PoolClient, ref: DatasetRef): Promise<boolean> {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS has_schema,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS has_role`,
      [ref.schema, ref.role],
    );
    return Boolean(result.rows[0]?.has_schema && result.rows[0]?.has_role);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class FixtureError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid fixture data:\n${problems.slice(0, 10).join("\n")}`);
    this.name = "FixtureError";
  }
}
