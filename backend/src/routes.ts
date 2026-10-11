import { Router } from "express";
import type { Container } from "@/container";
import { csrfProtection } from "@/middleware/auth";
import { createAdminRouter } from "@/modules/admin/admin.routes";
import { createAuthRouter } from "@/modules/auth/auth.routes";
import { createDashboardRouter, createEventsRouter, createRoundStatusRouter } from "@/modules/events/events.routes";
import { createChallengesRouter } from "@/modules/challenges/challenges.routes";
import { createMySubmissionsRouter, createSubmissionsRouter } from "@/modules/submissions/submissions.routes";
import { createUsersRouter } from "@/modules/users/users.routes";
import { mongoIsHealthy } from "@/database/mongo";

/** Mounts every versioned REST router under /api/v1. */
export function createApiRouter(container: Container): Router {
  const { config, sql } = container;
  const router = Router();

  /** Readiness: the API is useful only when MongoDB and the SQL execution engine are both reachable. */
  router.get("/health", async (_req, res) => {
    const mongo = mongoIsHealthy();
    const engine = await sql.health();
    const ready = mongo && engine.status === "up";
    res.status(mongo ? 200 : 503).json({
      data: {
        status: ready ? "ok" : "degraded",
        checks: { mongo: mongo ? "up" : "down", sqlEngine: engine.status },
      },
    });
  });

  /** SQL execution subsystem health (queue pressure is useful when watching a live round). */
  router.get("/health/sql", async (_req, res) => {
    const engine = await sql.health();
    res.status(engine.status === "up" ? 200 : 503).json({
      data: { status: engine.status, latencyMs: engine.executor.latencyMs ?? null, queue: engine.queue },
    });
  });

  router.use("/auth", createAuthRouter(config, container.google));

  // Everything below is state-changing for authenticated users: enforce CSRF tokens.
  router.use(csrfProtection);
  router.use("/me", createUsersRouter());
  router.use("/me", createDashboardRouter());
  router.use("/me", createMySubmissionsRouter());
  router.use("/events", createEventsRouter());
  router.use("/challenges", createChallengesRouter(container));
  router.use("/submissions", createSubmissionsRouter());
  router.use("/rounds", createRoundStatusRouter());
  router.use("/admin", createAdminRouter(container));

  return router;
}
