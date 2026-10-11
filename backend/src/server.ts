import { createServer } from "node:http";
import { createApp } from "@/app";
import { getConfig } from "@/config";
import { ConfigError } from "@/config/env";
import type { Container } from "@/container";
import { connectMongo, disconnectMongo, syncAllIndexes } from "@/database/mongo";
import "@/database/models";
import { startRoundScheduler } from "@/jobs/round-scheduler";
import { drainGeneration, failInterruptedRuns } from "@/modules/ai-generation/generation.service";
import { createLlmClient } from "@/modules/ai-generation/llm";
import { createGoogleProvider } from "@/modules/auth/google.provider";
import { SqlExecutionService } from "@/modules/sql-execution/service";
import { recoverPendingSubmissions } from "@/modules/submissions/submissions.service";
import { SocketRealtime } from "@/sockets";
import { setRealtime } from "@/sockets/realtime";
import { logger } from "@/utils/logger";

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.google) {
    logger.warn(
      "Google OAuth is NOT configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL). Sign-in is disabled until these are set.",
    );
  }
  if (!config.sql.executorUrl || !config.sql.setupUrl) {
    logger.warn("SQL engine is NOT fully configured (SQL_EXECUTOR_DATABASE_URL / SQL_SETUP_DATABASE_URL). Challenges cannot be validated or evaluated until it is.");
  }
  if (!config.groq) {
    logger.warn("Groq is NOT configured (GROQ_API_KEY). AI challenge generation is disabled; manual authoring still works.");
  } else {
    logger.info({ model: config.groq.model }, "AI generation enabled");
  }
  await connectMongo(config.mongoUri);
  await syncAllIndexes();

  const container: Container = {
    config,
    google: createGoogleProvider(config.google),
    sql: SqlExecutionService.create(config.sql),
    llm: createLlmClient(config.groq),
  };

  const app = createApp(container);
  const server = createServer(app);
  const realtime = new SocketRealtime(server, config);
  setRealtime(realtime);
  const stopScheduler = startRoundScheduler();

  await failInterruptedRuns();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const forced = setTimeout(() => {
      logger.error("forced shutdown after timeout");
      process.exit(1);
    }, 20_000);
    forced.unref();
    try {
      stopScheduler();
      await realtime.close(); // closes the shared HTTP server as well
      server.closeIdleConnections();
      await drainGeneration(5000);
      await container.sql.close();
      await disconnectMongo();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port, env: config.env }, "API listening");

  // Submissions that were queued/running when the previous process stopped are evaluated again.
  if (container.sql.canExecute) {
    const recovered = await recoverPendingSubmissions(container.sql);
    if (recovered > 0) logger.info({ recovered }, "re-queued interrupted submissions");
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n\nCopy backend/.env.example to backend/.env and fill in the missing values.\n`);
  } else {
    console.error("Fatal startup error:", error);
  }
  process.exit(1);
});
