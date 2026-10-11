/**
 * Types shared by challenge authoring, the SQL execution engine and the
 * evaluator. Keep this file free of runtime dependencies.
 */

/** A single cell as stored in fixtures / returned by the engine. */
export type CellValue = string | number | boolean | null;

export interface ColumnSpec {
  name: string;
  /** e.g. `integer`, `varchar(50)`, `numeric(10,2)`, `date`. See SQL_TYPE_PATTERN. */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  references?: { table: string; column: string } | null;
  description?: string;
}

export interface TableSpec {
  name: string;
  description: string;
  columns: ColumnSpec[];
}

export interface SchemaSpec {
  tables: TableSpec[];
}

/** Row data per table; each row is an array aligned with the table's column order. */
export type DatasetRows = Record<string, CellValue[][]>;

export interface ResultTable {
  columns: string[];
  rows: CellValue[][];
}

export const COMPARISON_DEFAULTS = {
  ordered: false,
  matchColumnNames: false,
  /** Decimal places used when canonicalising non-integer numbers. */
  numericScale: 6,
} as const;

export interface ComparisonPolicy {
  /** True when the order of rows is part of the expected behaviour (ORDER BY required). */
  ordered: boolean;
  /** True when result column names must match the expected names (case-insensitively). */
  matchColumnNames: boolean;
  numericScale?: number;
}

export type TestCategory =
  | "sample"
  | "normal"
  | "empty_result"
  | "duplicates"
  | "nulls"
  | "boundary"
  | "multiple_matches"
  | "missing_relation"
  | "aggregation"
  | "join";

export const TEST_CATEGORIES: readonly TestCategory[] = [
  "sample",
  "normal",
  "empty_result",
  "duplicates",
  "nulls",
  "boundary",
  "multiple_matches",
  "missing_relation",
  "aggregation",
  "join",
];

export type SqlErrorCategory =
  | "SQL_SYNTAX_ERROR"
  | "QUERY_TIMEOUT"
  | "INVALID_QUERY"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "EXECUTION_ERROR"
  | "INTERNAL_ERROR";

export interface SqlFailure {
  ok: false;
  category: SqlErrorCategory;
  /** Safe to show to participants: contains no hidden data, credentials or internal names. */
  message: string;
  /** 1-based line/column inside the participant's query when known. */
  line?: number;
  column?: number;
  durationMs: number;
  /** Internal hint: the dataset objects are missing in PostgreSQL and should be re-provisioned. */
  datasetMissing?: boolean;
}

export interface SqlSuccess {
  ok: true;
  columns: string[];
  rows: CellValue[][];
  rowCount: number;
  /** True when output was cut at the row/byte limit (only used for previews, never for scoring). */
  truncated: boolean;
  durationMs: number;
}

export type SqlOutcome = SqlSuccess | SqlFailure;

export interface DatasetRef {
  /** PostgreSQL schema holding the dataset tables. */
  schema: string;
  /** NOLOGIN role that can read exactly this dataset. */
  role: string;
  key: string;
}
