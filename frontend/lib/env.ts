/** Public (browser-visible) configuration. Only non-secret values may live here. */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1").replace(/\/$/, "");
export const SOCKET_URL = (process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000").replace(/\/$/, "");
