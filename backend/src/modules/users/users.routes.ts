import { Router } from "express";
import { csrfProtection, requireAuth } from "@/middleware/auth";
import { ok } from "@/utils/http";
import { recordAudit } from "@/modules/admin/audit.service";
import { updateProfileSchema } from "./users.schema";
import { toSelfDto, updateProfile } from "./users.service";

export function createUsersRouter(): Router {
  const router = Router();

  router.get("/profile", requireAuth, (req, res) => {
    ok(res, { user: toSelfDto(req.auth!.user) });
  });

  router.patch("/profile", requireAuth, csrfProtection, async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    const user = await updateProfile(req.auth!.user, input);
    await recordAudit({ actorId: user.id, action: "user.profile.update", targetType: "user", targetId: user.id, requestId: String(req.id) });
    ok(res, { user: toSelfDto(user) });
  });

  return router;
}
