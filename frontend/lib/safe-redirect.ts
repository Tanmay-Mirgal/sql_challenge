/**
 * Accept only same-site relative paths for post-login redirects. The API applies its own
 * allowlist as well; this keeps obviously unsafe values out of links and router calls.
 */
export function safeNextPath(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 200) return fallback;
  return value;
}
