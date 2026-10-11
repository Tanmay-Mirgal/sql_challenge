import { cache } from "react";
import { redirect } from "next/navigation";
import { serverApi } from "@/lib/api-server";
import type { MeResponse } from "@/types/api";

/** Resolved once per request. Returns null when the visitor is not signed in. */
export const getSession = cache(async (): Promise<{ session: MeResponse | null; apiDown: boolean }> => {
  const { data, error } = await serverApi<MeResponse>("/auth/me");
  if (data) return { session: data, apiDown: false };
  return { session: null, apiDown: error?.code === "NETWORK_ERROR" };
});

/** Server-side guard for participant pages. The backend still re-checks every API call. */
export async function requireSession(): Promise<MeResponse> {
  const { session, apiDown } = await getSession();
  if (apiDown) redirect("/login?error=api_unreachable");
  if (!session) redirect("/login");
  if (session.user.status !== "active") redirect("/unauthorized");
  return session;
}

export async function requireAdminSession(): Promise<MeResponse> {
  const session = await requireSession();
  if (session.user.role !== "admin") redirect("/unauthorized");
  return session;
}
