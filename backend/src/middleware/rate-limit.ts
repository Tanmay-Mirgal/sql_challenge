import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { Errors } from "@/utils/errors";

interface LimiterOptions {
  windowMs: number;
  limit: number;
  /** Bucket by authenticated user instead of IP when available. */
  perUser?: boolean;
  message?: string;
}

function keyFor(req: Request, perUser: boolean): string {
  if (perUser && req.auth) return `u:${req.auth.user.id}`;
  return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
}

export function createLimiter(options: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => keyFor(req, options.perUser ?? false),
    handler: (_req, _res, next) => next(Errors.tooManyRequests(options.message)),
  });
}
