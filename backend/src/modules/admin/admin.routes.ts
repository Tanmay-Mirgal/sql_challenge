import { Router } from "express";
import type { Container } from "@/container";
import { requireAdmin } from "@/middleware/auth";
import { ok } from "@/utils/http";
import { createAdminChallengesRouter } from "./admin-challenges.routes";
import { createAdminEventsRouter } from "./admin-events.routes";
import { createAdminResultsRouter } from "./admin-results.routes";

/**
 * Every route in this router sits behind a server-side role check that reads the
 * role from the database record attached to the session.
 */
export function createAdminRouter(container: Container): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/ping", (req, res) => {
    ok(res, { ok: true, role: req.auth!.user.role });
  });

  router.use(createAdminEventsRouter());
  router.use(createAdminChallengesRouter(container));
  router.use(createAdminResultsRouter());

  return router;
}
