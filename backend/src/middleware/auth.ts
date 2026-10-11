import type { RequestHandler } from "express";
import type { AppConfig } from "@/config";
import { resolveSession, setSessionCookie } from "@/modules/auth/session.service";
import { safeEqual } from "@/utils/crypto";
import { Errors } from "@/utils/errors";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Reads the session cookie and, if valid, attaches `req.auth`. Never rejects. */
export function attachAuth(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[config.session.cookieName];
    if (token && typeof token === "string" && token.length <= 200) {
      const resolved = await resolveSession(config, token);
      if (resolved) {
        req.auth = { user: resolved.user, session: resolved.session, sessionToken: token };
        if (resolved.extended) setSessionCookie(res, config, token);
      }
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(Errors.unauthorized());
  return next();
};

/** Role is always read from the database record, never from the request. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(Errors.unauthorized());
  if (req.auth.user.role !== "admin") return next(Errors.forbidden("Administrator access is required.", "ADMIN_REQUIRED"));
  return next();
};

/**
 * Synchroniser-token CSRF protection for authenticated, state-changing requests.
 * The token is bound to the server-side session and delivered via GET /auth/me.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (!UNSAFE_METHODS.has(req.method)) return next();
  if (!req.auth) return next(); // unauthenticated requests are rejected by requireAuth where relevant
  const header = req.header("x-csrf-token");
  if (!header || !safeEqual(header, req.auth.session.csrfToken)) {
    return next(Errors.forbidden("Missing or invalid CSRF token.", "CSRF_INVALID"));
  }
  return next();
};
