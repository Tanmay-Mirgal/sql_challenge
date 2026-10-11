import { API_BASE_URL } from "@/lib/env";
import type { ApiEnvelope, ApiErrorBody, MeResponse, PaginationMeta } from "@/types/api";

/** Error thrown for any non-2xx API response or network failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

// The CSRF token is bound to the server-side session; it is delivered by GET /auth/me
// and attached to every state-changing request.
let csrfToken: string | null = null;
let csrfInflight: Promise<string | null> | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function ensureCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  csrfInflight ??= fetch(`${API_BASE_URL}/auth/me`, { credentials: "include", cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as ApiEnvelope<MeResponse>;
      csrfToken = body.data.csrfToken;
      return csrfToken;
    })
    .catch(() => null)
    .finally(() => {
      csrfInflight = null;
    });
  return csrfInflight;
}

function buildUrl(path: string, query?: Query): string {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function request<T>(method: string, path: string, options: RequestOptions = {}, retried = false): Promise<ApiEnvelope<T>> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE.has(method)) {
    const token = await ensureCsrfToken();
    if (token) headers["X-CSRF-Token"] = token;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.");
  }

  if (response.status === 204) return { data: undefined as T };

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error page */
  }
  if (!response.ok) {
    const body = payload as Partial<ApiErrorBody> | null;
    const err = body?.error;
    // A stale CSRF token (e.g. the session was rotated): refresh once and retry.
    if (response.status === 403 && err?.code === "CSRF_INVALID" && !retried) {
      csrfToken = null;
      return request<T>(method, path, options, true);
    }
    throw new ApiError(
      response.status,
      err?.code ?? "HTTP_ERROR",
      err?.message ?? `Request failed with status ${response.status}.`,
      err?.details,
      err?.requestId,
    );
  }
  return payload as ApiEnvelope<T>;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "body">) => request<T>("GET", path, options).then((r) => r.data),
  /** Like `get` but also returns pagination metadata. */
  list: <T>(path: string, options?: Omit<RequestOptions, "body">) =>
    request<T>("GET", path, options).then((r) => ({ data: r.data, meta: r.meta as PaginationMeta | undefined })),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">) =>
    request<T>("POST", path, { ...options, body: body ?? {} }).then((r) => r.data),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">) =>
    request<T>("PATCH", path, { ...options, body: body ?? {} }).then((r) => r.data),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">) =>
    request<T>("PUT", path, { ...options, body: body ?? {} }).then((r) => r.data),
  delete: <T>(path: string, options?: Omit<RequestOptions, "body">) => request<T>("DELETE", path, options).then((r) => r.data),
};

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}
