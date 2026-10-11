import { cookies } from "next/headers";
import { ApiError } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/env";
import type { ApiEnvelope, ApiErrorBody } from "@/types/api";

/**
 * Server-side API access for Server Components. The browser's session cookie is
 * forwarded so the backend authorises the request as the signed-in user.
 *
 * `API_INTERNAL_URL` lets the Next.js server reach the API over a private
 * network (e.g. Docker) while the browser uses the public URL.
 */
const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? API_BASE_URL).replace(/\/$/, "");
export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "sql_challenge_session";

export async function serverApi<T>(path: string): Promise<{ data: T | null; error: ApiError | null }> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!session) return { data: null, error: new ApiError(401, "UNAUTHENTICATED", "Not signed in.") };

  let response: Response;
  try {
    response = await fetch(`${SERVER_API_URL}${path}`, {
      headers: { Accept: "application/json", Cookie: `${SESSION_COOKIE_NAME}=${session}` },
      cache: "no-store",
    });
  } catch {
    return { data: null, error: new ApiError(0, "NETWORK_ERROR", "The API is unreachable.") };
  }
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | ApiErrorBody | null;
  if (!response.ok) {
    const err = (payload as ApiErrorBody | null)?.error;
    return {
      data: null,
      error: new ApiError(response.status, err?.code ?? "HTTP_ERROR", err?.message ?? "Request failed.", err?.details, err?.requestId),
    };
  }
  return { data: (payload as ApiEnvelope<T>).data, error: null };
}
