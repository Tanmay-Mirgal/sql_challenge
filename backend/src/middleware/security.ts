import cors from "cors";
import helmet from "helmet";
import type { RequestHandler } from "express";
import type { AppConfig } from "@/config";
import { Errors } from "@/utils/errors";

export function securityHeaders(): RequestHandler {
  return helmet({
    // The API only serves JSON; lock everything down.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
  });
}

export function corsMiddleware(config: AppConfig): RequestHandler {
  return cors({
    origin(origin, callback) {
      // Non-browser clients (curl, server-to-server) send no Origin header.
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "RateLimit", "RateLimit-Policy", "Retry-After"],
    maxAge: 600,
  });
}

/**
 * Rejects state-changing requests whose Origin is not an allowed frontend
 * origin. Complements the CSRF token (defence in depth).
 */
export function originGuard(config: AppConfig): RequestHandler {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  return (req, _res, next) => {
    if (safeMethods.has(req.method)) return next();
    const origin = req.header("origin");
    if (origin && !config.allowedOrigins.includes(origin)) {
      return next(Errors.forbidden("Cross-origin request blocked.", "ORIGIN_NOT_ALLOWED"));
    }
    if (!origin && req.header("sec-fetch-site") === "cross-site") {
      return next(Errors.forbidden("Cross-origin request blocked.", "ORIGIN_NOT_ALLOWED"));
    }
    return next();
  };
}
