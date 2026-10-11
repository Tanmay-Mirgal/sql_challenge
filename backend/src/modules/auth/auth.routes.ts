import { Router } from "express";
import type { CookieOptions } from "express";
import type { AppConfig } from "@/config";
import { createLimiter } from "@/middleware/rate-limit";
import { csrfProtection, requireAuth } from "@/middleware/auth";
import { ok, noContent } from "@/utils/http";
import { logger } from "@/utils/logger";
import { safeLogText } from "@/utils/sanitize";
import { recordAudit } from "@/modules/admin/audit.service";
import { realtime } from "@/sockets/realtime";
import { toSelfDto } from "@/modules/users/users.service";
import { AuthFlowError, beginLogin, completeLogin, DEFAULT_RETURN_TO, OAUTH_TX_TTL_MS } from "./auth.service";
import type { GoogleOAuthProvider } from "./google.provider";
import { clearSessionCookie, createSession, destroySession, setSessionCookie } from "./session.service";

export function createAuthRouter(config: AppConfig, google: GoogleOAuthProvider): Router {
  const router = Router();
  const limiter = createLimiter({
    windowMs: 15 * 60_000,
    limit: config.rateLimits.authPer15Min,
    message: "Too many authentication attempts. Please try again later.",
  });

  const txCookieName = `${config.session.cookieName}_oauth`;
  const txCookieOptions: CookieOptions = {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: "lax", // must survive the top-level redirect back from Google
    path: "/api/v1/auth",
    maxAge: OAUTH_TX_TTL_MS,
    domain: config.session.cookieDomain,
  };
  const failureRedirect = (code: string) =>
    `${config.frontendUrl}/auth/callback?error=${encodeURIComponent(code)}`;

  /** Public, non-secret configuration so the login page can show setup instructions. */
  router.get("/config", (_req, res) => {
    ok(res, {
      googleConfigured: google.isConfigured,
      missingConfig: google.missingConfig,
      collegeEmailDomains: config.identity.allowedEmailDomains,
    });
  });

  router.get("/google", limiter, (req, res) => {
    try {
      const { redirectUrl, transactionCookie } = beginLogin(config, google, req.query.returnTo);
      res.cookie(txCookieName, transactionCookie, txCookieOptions);
      res.redirect(302, redirectUrl);
    } catch (error) {
      if (error instanceof AuthFlowError) return res.redirect(302, failureRedirect(error.code));
      throw error;
    }
  });

  router.get("/google/callback", limiter, async (req, res) => {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const { txCookieValue, previousSession } = {
      txCookieValue: cookies?.[txCookieName],
      previousSession: cookies?.[config.session.cookieName],
    };
    // The transaction is single-use regardless of outcome.
    const { maxAge: _maxAge, ...clearOptions } = txCookieOptions;
    res.clearCookie(txCookieName, clearOptions);
    try {
      const { user, isNew, returnTo } = await completeLogin(config, google, {
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
        transactionCookie: txCookieValue,
      });
      // Session fixation defence: never reuse a pre-existing session identifier.
      if (previousSession && typeof previousSession === "string") await destroySession(previousSession);
      const { token } = await createSession(config, user, req.header("user-agent"));
      setSessionCookie(res, config, token);
      logger.info({ userId: user.id, isNew, requestId: String(req.id) }, "user signed in");
      if (isNew) await recordAudit({ actorId: user.id, action: "user.register", targetType: "user", targetId: user.id, requestId: String(req.id) });
      const next = returnTo || DEFAULT_RETURN_TO;
      return res.redirect(302, `${config.frontendUrl}/auth/callback?next=${encodeURIComponent(next)}`);
    } catch (error) {
      if (error instanceof AuthFlowError) {
        logger.warn({ reason: safeLogText(error.code), requestId: String(req.id) }, "oauth login rejected");
        return res.redirect(302, failureRedirect(error.code));
      }
      throw error;
    }
  });

  router.get("/me", requireAuth, (req, res) => {
    const auth = req.auth!;
    ok(res, {
      user: toSelfDto(auth.user),
      csrfToken: auth.session.csrfToken,
      sessionExpiresAt: auth.session.expiresAt,
    });
  });

  router.post("/logout", requireAuth, csrfProtection, async (req, res) => {
    const auth = req.auth!;
    await destroySession(auth.sessionToken);
    realtime.userSignedOut(auth.user.id as string);
    clearSessionCookie(res, config);
    logger.info({ userId: auth.user.id, requestId: String(req.id) }, "user signed out");
    noContent(res);
  });

  return router;
}
