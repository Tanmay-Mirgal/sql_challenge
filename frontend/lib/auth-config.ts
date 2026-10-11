import type { ApiEnvelope, AuthConfig } from "@/types/api";
import { API_BASE_URL } from "@/lib/env";

const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? API_BASE_URL).replace(/\/$/, "");

/** Public, non-secret auth configuration (is Google configured? which college domains?). */
export async function getAuthConfig(): Promise<{ config: AuthConfig | null; unreachable: boolean }> {
  try {
    const response = await fetch(`${SERVER_API_URL}/auth/config`, { cache: "no-store" });
    if (!response.ok) return { config: null, unreachable: true };
    const body = (await response.json()) as ApiEnvelope<AuthConfig>;
    return { config: body.data, unreachable: false };
  } catch {
    return { config: null, unreachable: true };
  }
}

export const AUTH_ERROR_MESSAGES: Record<string, { title: string; body: string }> = {
  auth_not_configured: {
    title: "Google sign-in is not configured",
    body: "The administrator has not finished setting up Google OAuth on the server.",
  },
  invalid_state: {
    title: "Sign-in could not be verified",
    body: "Your sign-in attempt expired or did not originate from this browser. Please start again.",
  },
  oauth_denied: {
    title: "Sign-in was cancelled",
    body: "You declined access in Google. You can try again whenever you are ready.",
  },
  exchange_failed: {
    title: "Google rejected the sign-in",
    body: "We could not complete the sign-in with Google. Please try again.",
  },
  email_unverified: {
    title: "E-mail address not verified",
    body: "Google reports that this e-mail address is not verified. Use a verified Google account.",
  },
  domain_not_allowed: {
    title: "College account required",
    body: "This competition is limited to approved college e-mail addresses. Sign in with your college Google account.",
  },
  account_disabled: {
    title: "Account unavailable",
    body: "This account has been suspended. Please contact the organisers.",
  },
  account_conflict: {
    title: "Account conflict",
    body: "An account with this e-mail is already linked to a different Google identity. Contact the organisers.",
  },
  api_unreachable: {
    title: "Cannot reach the server",
    body: "The competition API is not responding. Check that the backend is running and try again.",
  },
};
