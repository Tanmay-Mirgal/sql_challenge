import pg, { type FieldDef, type Pool, type PoolClient } from "pg";
import Cursor from "pg-cursor";
import { logger } from "@/utils/logger";
import { quoteIdent } from "./fixtures";
import { mapPgError } from "./pg-errors";
import type { CellValue, DatasetRef, SqlFailure, SqlSuccess } from "./types";

export interface ExecutionSuccess extends SqlSuccess {
  /** PostgreSQL type OID per column; used for type-aware result comparison. */
  typeOids: number[];
}
export type ExecutionOutcome = ExecutionSuccess | SqlFailure;

export interface ExecutorOptions {
  connectionString: string;
  poolSize: number;
  statementTimeoutMs: number;
  maxRows: number;
  maxBytes: number;
}

/** Extra time (beyond the server-side statement_timeout) before the client forcibly drops the connection. */
const WATCHDOG_GRACE_MS = 2000;

function parseFloatCell(text: string): CellValue {
  const value = Number(text);
  return Number.isFinite(value) ? value : text; // keep NaN / ±Infinity as text so they survive JSON
}

/** Type parsers: exact for integers/numerics, raw strings for all date/time types (no timezone drift). */
const typeParsers = {
  getTypeParser(oid: number): (value: string) => CellValue {
    switch (oid) {
      case 16:
        return (v) => v === "t";
      case 20:
        return (v) => {
          const n = Number(v);
          return Number.isSafeInteger(n) ? n : v;
        };
      case 21:
      case 23:
        return (v) => Number.parseInt(v, 10);
      case 700:
      case 701:
        return parseFloatCell;
      default:
        return (v) => v;
    }
  },
};

/**
 * Runs a single participant SELECT inside a locked-down transaction:
 *
 *   BEGIN READ ONLY → SET LOCAL ROLE <dataset role> → search_path = <dataset schema> → statement_timeout
 *
 * and reads results through a server-side cursor so at most `maxRows + 1` rows ever
 * cross the wire. The connection is always rolled back and its session state reset.
 */
export class SqlExecutor {
  readonly pool: Pool;

  constructor(private readonly options: ExecutorOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      application_name: "sql-runner",
    });
    this.pool.on("error", (error) => logger.warn({ err: error }, "idle SQL executor connection error"));
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = performance.now();
    try {
      await this.pool.query("SELECT 1");
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : "unknown" };
    }
  }

  async execute(ref: DatasetRef, sql: string, overrides: { timeoutMs?: number; maxRows?: number } = {}): Promise<ExecutionOutcome> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const timeoutMs = Math.max(100, Math.min(overrides.timeoutMs ?? this.options.statementTimeoutMs, 60_000));
    const maxRows = overrides.maxRows ?? this.options.maxRows;

    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      logger.error({ err: error }, "cannot obtain SQL executor connection");
      return { ok: false, category: "INTERNAL_ERROR", message: "The SQL engine is temporarily unavailable. Please try again.", durationMs: elapsed() };
    }

    let destroyed = false;
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      destroyed = true;
      // Dropping the socket abandons the query client-side; the server-side statement_timeout is the primary stop.
      client.release(new Error("execution watchdog"));
    }, timeoutMs + WATCHDOG_GRACE_MS);

    try {
      await client.query(
        [
          "BEGIN READ ONLY",
          `SET LOCAL ROLE ${quoteIdent(ref.role)}`,
          `SET LOCAL search_path TO ${quoteIdent(ref.schema)}`,
          `SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`,
          "SET LOCAL lock_timeout = 1000",
          "SET LOCAL TimeZone = 'UTC'",
          "SET LOCAL DateStyle = 'ISO, YMD'",
        ].join("; "),
      );

      const cursor = client.query(new Cursor(sql, [], { rowMode: "array", types: typeParsers as never }));
      const { rows, fields } = await new Promise<{ rows: CellValue[][]; fields: FieldDef[] }>((resolve, reject) => {
        cursor.read(maxRows + 1, (error, batch, result) => {
          if (error) reject(error);
          else resolve({ rows: batch as unknown as CellValue[][], fields: result?.fields ?? [] });
        });
      });
      await new Promise<void>((resolve) => cursor.close(() => resolve()));
      await client.query("ROLLBACK");

      let truncated = rows.length > maxRows;
      let visible = truncated ? rows.slice(0, maxRows) : rows;
      let bytes = 0;
      for (let i = 0; i < visible.length; i += 1) {
        bytes += JSON.stringify(visible[i]).length;
        if (bytes > this.options.maxBytes) {
          visible = visible.slice(0, i);
          truncated = true;
          break;
        }
      }
      return {
        ok: true,
        columns: fields.map((field) => field.name),
        typeOids: fields.map((field) => field.dataTypeID),
        rows: visible,
        rowCount: visible.length,
        truncated,
        durationMs: elapsed(),
      };
    } catch (error) {
      if (!destroyed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyed = true;
          client.release(error instanceof Error ? error : new Error("rollback failed"));
        }
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { __watchdog: watchdogFired, __ms: elapsed(), __sql: sql });
    } finally {
      clearTimeout(watchdog);
      if (!destroyed) client.release();
    }
  }

  /** Same as `execute` but converts thrown driver errors into participant-safe failures. */
  async run(ref: DatasetRef, sql: string, overrides: { timeoutMs?: number; maxRows?: number } = {}): Promise<ExecutionOutcome> {
    try {
      return await this.execute(ref, sql, overrides);
    } catch (error) {
      const tagged = error as Error & { __watchdog?: boolean; __ms?: number };
      const failure = mapPgError(error, sql, tagged.__ms ?? 0, tagged.__watchdog === true);
      if (failure.category === "INTERNAL_ERROR") logger.error({ err: error }, "SQL executor internal error");
      else logger.debug({ code: (error as { code?: string }).code, category: failure.category }, "participant query failed");
      return failure;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
