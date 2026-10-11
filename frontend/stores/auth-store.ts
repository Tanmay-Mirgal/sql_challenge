"use client";

import { create } from "zustand";
import { setCsrfToken } from "@/lib/api-client";
import type { SelfUser } from "@/types/api";

interface AuthState {
  user: SelfUser | null;
  hydrate: (user: SelfUser | null, csrfToken: string | null) => void;
  setUser: (user: SelfUser) => void;
  clear: () => void;
}

/**
 * Client mirror of the server session. The server (cookie + /auth/me) remains the
 * source of truth: this store only avoids re-fetching for display purposes and is
 * never used to make an authorisation decision.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  hydrate: (user, csrfToken) => {
    setCsrfToken(csrfToken);
    set({ user });
  },
  setUser: (user) => set({ user }),
  clear: () => {
    setCsrfToken(null);
    set({ user: null });
  },
}));
