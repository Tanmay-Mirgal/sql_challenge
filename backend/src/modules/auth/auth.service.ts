import { createHash } from "node:crypto";
import type { AppConfig } from "@/config";
import { now } from "@/utils/clock";
import { randomToken, safeEqual, signPayload, verifyPayload } from "@/utils/crypto";
import type { GoogleOAuthProvider } from "./google.provider";
import { LoginRejectedError, upsertFromGoogle } from "@/modules/users/users.service";
import type { UserDocument } from "@/modules/users/user.model";

export const OAUTH_TX_TTL_MS = 10 * 60_000;
export const DEFAULT_RETURN_TO = "/dashboard";
const ALLOWED_RETURN_PREFIXES = ["/dashboard", "/challenge", "/leaderboard", "/profile", "/results", "/admin"];

export type AuthFailureCode =
  | "auth_not_configured"
  | "invalid_state"
  | "oauth_denied"
  | "exchange_failed"
  | "email_unverified"
  | "domain_not_allowed"
  | "account_disabled"
  | "account_conflict";

export class AuthFlowError extends Error {
  constructor(readonly code: AuthFailureCode) {
    super(code);
    this.name = "AuthFlowError";
  }
}

interface OAuthTransaction {
  s: string; // state
  n: string; // nonce
  v: string; // PKCE code verifier
  r: string; // validated return path
  e: number; // expiry (epoch ms)
}

/**
 * Strict redirect allowlist: only same-site relative paths under known
 * application sections are accepted; everything else collapses to the default.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return DEFAULT_RETURN_TO;
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    return DEFAULT_RETURN_TO;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, "http://relative.invalid");
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (parsed.origin !== "http://relative.invalid") return DEFAULT_RETURN_TO;
  const allowed = ALLOWED_RETURN_PREFIXES.some(
    (prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`),
  );
  return allowed ? `${parsed.pathname}${parsed.search}` : DEFAULT_RETURN_TO;
}

export function beginLogin(
  config: AppConfig,
  provider: GoogleOAuthProvider,
  returnTo: unknown,
): { redirectUrl: string; transactionCookie: string } {
  if (!provider.isConfigured) throw new AuthFlowError("auth_not_configured");
  const state = randomToken(24);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(48);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const tx: OAuthTransaction = {
    s: state,
    n: nonce,
    v: codeVerifier,
    r: sanitizeReturnTo(returnTo),
    e: now().getTime() + OAUTH_TX_TTL_MS,
  };
  const domains = config.identity.allowedEmailDomains;
  return {
    redirectUrl: provider.buildAuthorizationUrl({
      state,
      nonce,
      codeChallenge,
      hostedDomainHint: domains.length === 1 ? domains[0] : undefined,
    }),
    transactionCookie: signPayload(config.session.secret, tx),
  };
}

export interface CallbackInput {
  code?: unknown;
  state?: unknown;
  error?: unknown;
  transactionCookie?: string;
}

/** Validates the OAuth callback and returns the authenticated user plus the return path. */
export async function completeLogin(
  config: AppConfig,
  provider: GoogleOAuthProvider,
  input: CallbackInput,
): Promise<{ user: UserDocument; isNew: boolean; returnTo: string }> {
  if (!provider.isConfigured) throw new AuthFlowError("auth_not_configured");

  const tx = verifyPayload<OAuthTransaction>(config.session.secret, input.transactionCookie);
  if (!tx || typeof tx.e !== "number" || tx.e < now().getTime()) throw new AuthFlowError("invalid_state");

  if (typeof input.error === "string" && input.error.length > 0) {
    throw new AuthFlowError(input.error === "access_denied" ? "oauth_denied" : "exchange_failed");
  }
  if (typeof input.state !== "string" || !safeEqual(input.state, tx.s)) throw new AuthFlowError("invalid_state");
  if (typeof input.code !== "string" || input.code.length === 0 || input.code.length > 2048) {
    throw new AuthFlowError("exchange_failed");
  }

  let identity;
  try {
    identity = await provider.exchangeCode({ code: input.code, codeVerifier: tx.v });
  } catch {
    throw new AuthFlowError("exchange_failed");
  }
  // Replay protection: the signed ID token must carry the nonce we generated for this browser.
  if (!identity.nonce || !safeEqual(identity.nonce, tx.n)) throw new AuthFlowError("invalid_state");

  try {
    const { user, isNew } = await upsertFromGoogle(config, identity);
    return { user, isNew, returnTo: tx.r };
  } catch (error) {
    if (error instanceof LoginRejectedError) throw new AuthFlowError(error.code);
    throw error;
  }
}
