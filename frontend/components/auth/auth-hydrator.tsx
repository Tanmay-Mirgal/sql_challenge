"use client";

import { useEffect } from "react";
import { setCsrfToken } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";
import type { MeResponse } from "@/types/api";

/**
 * Seeds the client with the session the server already verified, and registers the
 * CSRF token used by the API client for state-changing requests.
 */
export function AuthHydrator({ session }: { session: MeResponse }) {
  // Plain module variable (not React state), so it is safe to set during render and
  // is ready before any child effect issues a POST.
  setCsrfToken(session.csrfToken);
  useEffect(() => {
    useAuthStore.getState().hydrate(session.user, session.csrfToken);
  }, [session]);
  return null;
}
