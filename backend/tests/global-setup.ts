import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { initSqlEngine } from "../src/modules/sql-execution/engine-setup";

/**
 * Starts the shared test infrastructure once per `vitest run`:
 *  - MongoDB (single-node replica set) via mongodb-memory-server, unless TEST_MONGODB_URI is set.
 *  - A real PostgreSQL server via embedded-postgres, unless TEST_PG_ADMIN_URL is set. It is
 *    initialised with the SAME script production uses (roles, grants, guard rails).
 */

const RUNNER_PASSWORD = "runner-test-password";
const SETUP_PASSWORD = "setup-test-password";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  let mongo: MongoMemoryReplSet | undefined;
  let postgres: EmbeddedPostgres | undefined;

  if (!process.env.TEST_MONGODB_URI) {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env.TEST_MONGODB_URI = mongo.getUri();
  }

  let adminUrl = process.env.TEST_PG_ADMIN_URL;
  let host = "127.0.0.1";
  let port = 5432;
  if (!adminUrl) {
    port = await freePort();
    postgres = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), "sqlc-pg-")),
      user: "postgres",
      password: "postgres-test-password",
      port,
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("sql_exec");
    adminUrl = `postgresql://postgres:postgres-test-password@${host}:${port}/sql_exec`;
  } else {
    const url = new URL(adminUrl);
    host = url.hostname;
    port = Number(url.port || 5432);
  }

  await initSqlEngine({ adminUrl, runnerPassword: RUNNER_PASSWORD, setupPassword: SETUP_PASSWORD });
  process.env.TEST_PG_ADMIN_URL = adminUrl;
  process.env.TEST_SQL_RUNNER_URL = `postgresql://sql_runner:${RUNNER_PASSWORD}@${host}:${port}/sql_exec`;
  process.env.TEST_SQL_SETUP_URL = `postgresql://sql_setup:${SETUP_PASSWORD}@${host}:${port}/sql_exec`;

  return async () => {
    await postgres?.stop();
    await mongo?.stop();
  };
}
