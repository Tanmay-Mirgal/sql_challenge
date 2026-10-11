import type { SqlFailure } from "./types";
import { lineColumn } from "./validator";

interface PgErrorLike {
  code?: string;
  message?: string;
  position?: string | number;
  severity?: string;
}

/** Strip our internal dataset identifiers from anything shown to participants. */
export function scrubMessage(message: string): string {
  return message
    .replace(/\b(ds|dsr)_[0-9a-f]{24}\b/g, "<dataset>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** True when the failure means "the dataset is missing in PostgreSQL" (e.g. the engine DB was reset). */
export function isMissingDatasetError(error: unknown): boolean {
  const code = (error as PgErrorLike).code;
  const message = (error as PgErrorLike).message ?? "";
  // `SET ROLE` to a dropped dataset role raises 22023; a dropped schema surfaces as 42P01/3F000.
  // Participant typos can't reach 42P01: the validator only admits tables that exist in the schema.
  return (
    code === "42704" ||
    code === "3F000" ||
    code === "42P01" ||
    (code === "22023" && /role "dsr_[0-9a-f]+" does not exist/.test(message))
  );
}

/**
 * Maps a PostgreSQL driver error to a participant-safe failure. Raw server
 * messages are only passed through for SQLSTATE classes that describe the
 * participant's own query (syntax/semantic/data errors) and are scrubbed first.
 */
export function mapPgError(error: unknown, sql: string, durationMs: number, timedOutByWatchdog = false): SqlFailure {
  const e = error as PgErrorLike;
  const code = e.code ?? "";
  const base = { ok: false as const, durationMs };

  if (timedOutByWatchdog || code === "57014") {
    return { ...base, category: "QUERY_TIMEOUT", message: "The query took too long and was stopped. Simplify it or add filters/joins that reduce the work." };
  }
  if (code === "42601") {
    const position = Number(e.position);
    return {
      ...base,
      category: "SQL_SYNTAX_ERROR",
      message: scrubMessage(e.message ?? "syntax error"),
      ...(Number.isFinite(position) && position > 0 ? lineColumn(sql, position) : {}),
    };
  }
  if (code === "42501" || code === "25006" || code === "0A000") {
    return { ...base, category: "INVALID_QUERY", message: "This query tried to do something that isn’t permitted in the challenge sandbox." };
  }
  if (/^53(1|2|4)/.test(code) || code === "53000" || /^54/.test(code) || code === "53400") {
    return { ...base, category: "RESOURCE_LIMIT_EXCEEDED", message: "The query used too many resources. Reduce the amount of data it processes." };
  }
  if (/^(08|57P|53300|58|XX|28|3D|3F)/.test(code) || code === "" || code === "ECONNRESET" || code === "ECONNREFUSED") {
    return { ...base, category: "INTERNAL_ERROR", message: "The SQL engine is temporarily unavailable. Please try again." };
  }
  // 42xxx (syntax errors / access rule violations such as undefined column), 22xxx (data exceptions), 23xxx etc.
  const position = Number(e.position);
  return {
    ...base,
    category: "EXECUTION_ERROR",
    message: scrubMessage(e.message ?? "The query failed to execute."),
    ...(Number.isFinite(position) && position > 0 ? lineColumn(sql, position) : {}),
  };
}
