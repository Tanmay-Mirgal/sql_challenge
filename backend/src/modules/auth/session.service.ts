import type { CookieOptions, Response } from "express";
import type { HydratedDocument } from "mongoose";
import type { AppConfig } from "@/config";
import { now } from "@/utils/clock";
import { randomToken, sha256Hex } from "@/utils/crypto";
import { type ISession, Session } from "./session.model";
import { User, type UserDocument } from "@/modules/users/user.model";

/** Sessions are touched (and their expiry extended) at most this often. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export function sessionCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: config.session.cookieSameSite,
    domain: config.session.cookieDomain,
    path: "/",
    maxAge: config.session.ttlMs,
  };
}

export function setSessionCookie(res: Response, config: AppConfig, token: string): void {
  res.cookie(config.session.cookieName, token, sessionCookieOptions(config));
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(config);
  res.clearCookie(config.session.cookieName, options);
}

export async function createSession(
  config: AppConfig,
  user: UserDocument,
  userAgent?: string,
): Promise<{ token: string; session: HydratedDocument<ISession> }> {
  const token = randomToken(32);
  const createdAt = now();
  const session = await Session.create({
    tokenHash: sha256Hex(token),
    userId: user._id,
    csrfToken: randomToken(24),
    userAgent: userAgent?.slice(0, 300),
    createdAt,
    lastSeenAt: createdAt,
    expiresAt: new Date(createdAt.getTime() + config.session.ttlMs),
  });
  return { token, session };
}

export interface ResolvedSession {
  session: HydratedDocument<ISession>;
  user: UserDocument;
  /** True when the sliding expiry was extended and the cookie should be re-issued. */
  extended: boolean;
}

export async function resolveSession(config: AppConfig, token: string): Promise<ResolvedSession | null> {
  const session = await Session.findOne({ tokenHash: sha256Hex(token) });
  if (!session) return null;
  const current = now();
  if (session.expiresAt.getTime() <= current.getTime()) {
    await session.deleteOne();
    return null;
  }
  const user = await User.findById(session.userId);
  if (!user || user.status !== "active") {
    await session.deleteOne();
    return null;
  }
  let extended = false;
  if (current.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    session.lastSeenAt = current;
    session.expiresAt = new Date(current.getTime() + config.session.ttlMs);
    await session.save();
    extended = true;
  }
  return { session, user, extended };
}

export async function destroySession(token: string): Promise<void> {
  await Session.deleteOne({ tokenHash: sha256Hex(token) });
}

export async function destroyAllSessionsForUser(userId: string): Promise<number> {
  const result = await Session.deleteMany({ userId });
  return result.deletedCount;
}
