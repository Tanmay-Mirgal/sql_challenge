import pg from "pg";
import type { AppConfig } from "@/config";
import { JobQueue, QueueRejectedError } from "@/queues/job-queue";
import { logger } from "@/utils/logger";
import { type ExecutionOutcome, SqlExecutor } from "./executor";
import { FixtureError, DatasetProvisioner } from "./provisioner";
import { isMissingDatasetError, mapPgError } from "./pg-errors";
import type { DatasetRef, DatasetRows, SchemaSpec, SqlFailure } from "./types";
import { type ValidationResult, validateSql } from "./validator";

export type SqlEngineStatus = "up" | "down" | "not_configured";

export interface SqlEngineHealth {
  status: SqlEngineStatus;
  executor: { configured: boolean; ok: boolean; latencyMs?: number; error?: string };
  provisioning: { configured: boolean };
  queue: { running: number; queued: number; concurrency: number };
}

export interface JobContext {
  /** Validates and runs SQL on a dataset inside the already-reserved queue slot. */
  execute(dataset: DatasetRef, sql: string, tables: readonly string[], overrides?: { timeoutMs?: number; maxRows?: number }): Promise<ExecutionOutcome | SqlFailure>;
  ensureDataset(schema: SchemaSpec, rows: DatasetRows): Promise<DatasetRef>;
}

export class SqlEngineUnavailableError extends Error {
  constructor(message = "The SQL execution engine is not available.") {
    super(message);
    this.name = "SqlEngineUnavailableError";
  }
}

/**
 * Façade over the isolated PostgreSQL execution environment: validation, dataset
 * provisioning (trusted role), execution (restricted role), bounded concurrency.
 * It deliberately depends on nothing but `pg` and configuration — no MongoDB, no
 * application models — so it can be lifted into a separate worker service.
 */
export class SqlExecutionService {
  private readonly queue: JobQueue;

  constructor(
    private readonly config: AppConfig["sql"],
    private readonly executor: SqlExecutor | null,
    private readonly provisioner: DatasetProvisioner | null,
  ) {
    this.queue = new JobQueue({
      concurrency: config.maxConcurrentJobs,
      perKeyConcurrency: config.maxConcurrentJobsPerUser,
      maxQueued: config.maxQueuedJobs,
      maxQueuedPerKey: 3,
    });
  }

  static create(config: AppConfig["sql"]): SqlExecutionService {
    const executor = config.executorUrl
      ? new SqlExecutor({
          connectionString: config.executorUrl,
          poolSize: config.poolSize,
          statementTimeoutMs: config.statementTimeoutMs,
          maxRows: config.maxResultRows,
          maxBytes: config.maxResultBytes,
        })
      : null;
    const provisioner = config.setupUrl
      ? new DatasetProvisioner(new pg.Pool({ connectionString: config.setupUrl, max: 2, connectionTimeoutMillis: 5000, application_name: "sql-setup" }))
      : null;
    return new SqlExecutionService(config, executor, provisioner);
  }

  get canExecute(): boolean {
    return this.executor !== null;
  }
  get canProvision(): boolean {
    return this.provisioner !== null;
  }
  get limits() {
    return {
      maxQueryLength: this.config.maxQueryLength,
      statementTimeoutMs: this.config.statementTimeoutMs,
      maxResultRows: this.config.maxResultRows,
    };
  }

  async health(): Promise<SqlEngineHealth> {
    const queue = this.queue.stats();
    if (!this.executor) {
      return { status: "not_configured", executor: { configured: false, ok: false }, provisioning: { configured: this.canProvision }, queue };
    }
    const probe = await this.executor.health();
    return {
      status: probe.ok ? "up" : "down",
      executor: { configured: true, ok: probe.ok, latencyMs: probe.latencyMs, error: probe.error },
      provisioning: { configured: this.canProvision },
      queue,
    };
  }

  canAdmit(userKey: string): boolean {
    return this.queue.canAdmit(userKey);
  }

  validate(sql: unknown, tables: readonly string[]): Promise<ValidationResult> {
    return validateSql(sql, { allowedTables: tables, maxLength: this.config.maxQueryLength });
  }

  async ensureDataset(schema: SchemaSpec, rows: DatasetRows): Promise<DatasetRef> {
    if (!this.provisioner) throw new SqlEngineUnavailableError("SQL_SETUP_DATABASE_URL is not configured; cannot load challenge datasets.");
    try {
      return await this.provisioner.ensure(schema, rows);
    } catch (error) {
      if (error instanceof FixtureError) throw error;
      logger.error({ err: error }, "dataset provisioning failed");
      throw new SqlEngineUnavailableError("Challenge datasets could not be loaded into the SQL engine.");
    }
  }

  /**
   * Runs `work` inside a queue slot reserved for `userKey`. Use this when several
   * statements must be executed back-to-back (e.g. every hidden test of a submission).
   */
  async schedule<T>(userKey: string, work: (ctx: JobContext) => Promise<T>): Promise<T> {
    if (!this.executor) throw new SqlEngineUnavailableError();
    try {
      return await this.queue.enqueue(userKey, () => work(this.context()));
    } catch (error) {
      if (error instanceof QueueRejectedError) throw error;
      throw error;
    }
  }

  /** Convenience for a single validated statement on one dataset. */
  async executeOnce(
    userKey: string,
    dataset: DatasetRef,
    sql: string,
    tables: readonly string[],
    overrides?: { timeoutMs?: number; maxRows?: number },
  ): Promise<ExecutionOutcome | SqlFailure> {
    return this.schedule(userKey, (ctx) => ctx.execute(dataset, sql, tables, overrides));
  }

  /**
   * Execute without validation or queueing. ONLY for trusted/test code that needs to prove the
   * database-level boundary independently of the validator.
   */
  async executeUnvalidatedForTesting(dataset: DatasetRef, sql: string, overrides?: { timeoutMs?: number; maxRows?: number }): Promise<ExecutionOutcome> {
    if (!this.executor) throw new SqlEngineUnavailableError();
    return this.executor.run(dataset, sql, overrides);
  }

  /** Test helper: surfaces the raw PostgreSQL SQLSTATE so tests can prove WHICH layer refused a statement. */
  async sqlStateForTesting(dataset: DatasetRef, sql: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (!this.executor) throw new SqlEngineUnavailableError();
    try {
      await this.executor.execute(dataset, sql);
      return { ok: true };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { ok: false, code: e.code ?? "", message: e.message ?? "" };
    }
  }

  private context(): JobContext {
    return {
      ensureDataset: (schema, rows) => this.ensureDataset(schema, rows),
      execute: async (dataset, sql, tables, overrides) => {
        const checked = await this.validate(sql, tables);
        if (!checked.ok) {
          return { ok: false, category: checked.category, message: checked.message, line: checked.line, column: checked.column, durationMs: 0 };
        }
        return this.executeWithRecovery(dataset, sql, overrides);
      },
    };
  }

  private async executeWithRecovery(dataset: DatasetRef, sql: string, overrides?: { timeoutMs?: number; maxRows?: number }): Promise<ExecutionOutcome | SqlFailure> {
    if (!this.executor) throw new SqlEngineUnavailableError();
    try {
      return await this.executor.execute(dataset, sql, overrides);
    } catch (error) {
      const tagged = error as Error & { __watchdog?: boolean; __ms?: number };
      if (isMissingDatasetError(error)) {
        logger.warn({ dataset: dataset.key }, "dataset missing in SQL engine");
        return { ok: false, category: "INTERNAL_ERROR", message: "The challenge data is being prepared. Please try again in a few seconds.", durationMs: tagged.__ms ?? 0, datasetMissing: true };
      }
      const failure = mapPgError(error, sql, tagged.__ms ?? 0, tagged.__watchdog === true);
      if (failure.category === "INTERNAL_ERROR") logger.error({ err: error }, "SQL executor internal error");
      return failure;
    }
  }

  /** Re-provision a dataset after the engine reported it missing (e.g. the database was reset). */
  async repairDataset(schema: SchemaSpec, rows: DatasetRows, key: string): Promise<DatasetRef> {
    this.provisioner?.forget(key);
    return this.ensureDataset(schema, rows);
  }

  async close(): Promise<void> {
    await this.queue.drain();
    await Promise.allSettled([this.executor?.close(), this.provisioner?.close()]);
  }
}
