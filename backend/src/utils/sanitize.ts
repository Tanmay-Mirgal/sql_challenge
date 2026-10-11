// C0/C1 control characters plus the Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

/**
 * Make untrusted text safe to place in a log line: strips control characters
 * (including newlines and ANSI escapes) and bounds the length.
 */
export function safeLogText(input: unknown, max = 200): string {
  const text = typeof input === "string" ? input : String(input ?? "");
  const cleaned = text.replace(CONTROL_CHARS, " ");
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

/** Normalise an email for uniqueness checks. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/** Escape regex metacharacters. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * CSV cell escaping with spreadsheet formula-injection protection: cells that
 * start with = + - @ tab or CR are prefixed with a single quote.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
