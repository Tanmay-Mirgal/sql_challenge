import type { CellValue, ComparisonPolicy } from "./types";
import { COMPARISON_DEFAULTS } from "./types";

/**
 * Result normalisation and comparison.
 *
 * Values are converted to a *typed canonical string* before comparison, so that:
 *  - integers, bigints, numerics and floats of the same value compare equal (5 = 5.00 = 5.0),
 *  - the number 1, the text '1' and the boolean true never compare equal,
 *  - NULL only equals NULL,
 *  - non-integer numbers are compared at a fixed precision rather than by float bit pattern.
 */

// PostgreSQL type OIDs we treat specially.
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);
const BOOL_OID = 16;
const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const TIME_OID = 1083;

export interface RawResult {
  columns: string[];
  /** One PostgreSQL type OID per column. */
  typeOids: number[];
  rows: CellValue[][];
}

export interface CanonicalTable {
  columns: string[];
  rows: string[][];
}

function stripZeros(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

export function canonicalNumber(value: number | string, scale: number): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      const negative = trimmed.startsWith("-");
      const digits = trimmed.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
      return digits === "0" ? "0" : `${negative ? "-" : ""}${digits}`;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Math.abs(parsed) < 1e15) return canonicalNumber(parsed, scale);
      return stripZeros(trimmed.replace(/^\+/, ""));
    }
    return trimmed; // NaN / Infinity / -Infinity
  }
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(value)) return String(value === 0 ? 0 : value);
  const fixed = stripZeros(value.toFixed(scale));
  return fixed === "-0" || fixed === "" ? "0" : fixed;
}

export function canonicalCell(value: CellValue, typeOid: number, scale: number): string {
  if (value === null || value === undefined) return "N";
  if (typeOid === BOOL_OID || typeof value === "boolean") return `b:${value === true || value === "true" || value === "t" ? "t" : "f"}`;
  if (NUMERIC_OIDS.has(typeOid) || typeof value === "number") return `n:${canonicalNumber(value as number | string, scale)}`;
  const text = String(value);
  if (typeOid === DATE_OID) return `d:${text}`;
  if (typeOid === TIMESTAMP_OID) return `t:${text.replace("T", " ").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
  if (typeOid === TIMESTAMPTZ_OID) return `z:${text.replace("T", " ").replace(/(\.\d*?)0+(?=[+-]|$)/, "$1").replace(/\.(?=[+-]|$)/, "")}`;
  if (typeOid === TIME_OID) return `m:${text}`;
  return `s:${text}`;
}

export function canonicalize(result: RawResult, policy: Pick<ComparisonPolicy, "numericScale"> = {}): CanonicalTable {
  const scale = policy.numericScale ?? COMPARISON_DEFAULTS.numericScale;
  return {
    columns: result.columns,
    rows: result.rows.map((row) => row.map((cell, index) => canonicalCell(cell, result.typeOids[index] ?? 25, scale))),
  };
}

export type MismatchReason = "column_count" | "column_names" | "row_count" | "values" | "order";

export interface Comparison {
  equal: boolean;
  reason?: MismatchReason;
  expectedRows: number;
  actualRows: number;
  expectedColumns: number;
  actualColumns: number;
}

const SEP = "\u0001";

/**
 * Compares a participant's canonical result with the expected one.
 * - `ordered`  : rows must appear in exactly the expected order.
 * - otherwise  : multiset comparison (duplicates matter, order does not).
 */
export function compareTables(actual: CanonicalTable, expected: CanonicalTable, policy: ComparisonPolicy): Comparison {
  const base = {
    expectedRows: expected.rows.length,
    actualRows: actual.rows.length,
    expectedColumns: expected.columns.length,
    actualColumns: actual.columns.length,
  };
  if (actual.columns.length !== expected.columns.length) return { ...base, equal: false, reason: "column_count" };
  if (policy.matchColumnNames) {
    const same = actual.columns.every((name, i) => name.toLowerCase() === (expected.columns[i] ?? "").toLowerCase());
    if (!same) return { ...base, equal: false, reason: "column_names" };
  }
  if (actual.rows.length !== expected.rows.length) return { ...base, equal: false, reason: "row_count" };

  const keys = (table: CanonicalTable) => table.rows.map((row) => row.join(SEP));
  const a = keys(actual);
  const e = keys(expected);

  if (policy.ordered) {
    if (a.every((key, i) => key === e[i])) return { ...base, equal: true };
    const sameMultiset = multisetEqual(a, e);
    return { ...base, equal: false, reason: sameMultiset ? "order" : "values" };
  }
  return multisetEqual(a, e) ? { ...base, equal: true } : { ...base, equal: false, reason: "values" };
}

function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const key of a) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const key of b) {
    const left = counts.get(key);
    if (!left) return false;
    counts.set(key, left - 1);
  }
  return true;
}

/** Participant-safe explanation of a mismatch. Only used for *public* test cases. */
export function describeMismatch(comparison: Comparison): string {
  switch (comparison.reason) {
    case "column_count":
      return `Expected ${comparison.expectedColumns} column${comparison.expectedColumns === 1 ? "" : "s"} but your query returned ${comparison.actualColumns}.`;
    case "column_names":
      return "The column names don’t match the ones the task asks for.";
    case "row_count":
      return `Expected ${comparison.expectedRows} row${comparison.expectedRows === 1 ? "" : "s"} but your query returned ${comparison.actualRows}.`;
    case "order":
      return "The right rows came back in the wrong order. This task needs an ORDER BY.";
    case "values":
      return "The number of rows is right, but some values differ from the expected output.";
    default:
      return "Output matches the expected result.";
  }
}
