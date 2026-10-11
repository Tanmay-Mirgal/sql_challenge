import { z } from "zod";
import { contentHash } from "@/utils/crypto";
import type { CellValue, DatasetRows, SchemaSpec, TableSpec } from "./types";

/** Identifiers: lower_snake_case only, so they never need quoting for participants. */
export const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/;

/** Allowed column types (kept deliberately small — this is an undergraduate syllabus). */
export const SQL_TYPE =
  /^(integer|bigint|smallint|text|boolean|date|timestamp|real|double precision|varchar\(\d{1,4}\)|numeric\(\d{1,2},\d{1,2}\))$/;

/** PostgreSQL reserved words that would force participants to quote identifiers. */
const RESERVED_WORDS = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross " +
    "current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false " +
    "fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime " +
    "localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some " +
    "symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with"
  ).split(" "),
);

export const MAX_TABLES = 8;
export const MAX_COLUMNS_PER_TABLE = 20;
export const MAX_ROWS_PER_TABLE = 200;

export function isValidIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

const identifier = z
  .string()
  .regex(IDENTIFIER, "Use lower_snake_case: start with a letter; letters, digits and underscores only (max 40).")
  .refine((value) => !RESERVED_WORDS.has(value), "This name is a reserved SQL word; choose another.");

export const columnSpecSchema = z.strictObject({
  name: identifier,
  type: z.string().regex(SQL_TYPE, "Unsupported column type."),
  nullable: z.boolean().default(true),
  primaryKey: z.boolean().default(false),
  references: z.strictObject({ table: identifier, column: identifier }).nullable().optional(),
  description: z.string().max(300).optional(),
});

export const tableSpecSchema = z
  .strictObject({
    name: identifier,
    description: z.string().max(400).default(""),
    columns: z.array(columnSpecSchema).min(1).max(MAX_COLUMNS_PER_TABLE),
  })
  .superRefine((table, ctx) => {
    const seen = new Set<string>();
    for (const [i, column] of table.columns.entries()) {
      if (seen.has(column.name)) ctx.addIssue({ code: "custom", message: `Duplicate column "${column.name}".`, path: ["columns", i, "name"] });
      seen.add(column.name);
    }
  });

export const schemaSpecSchema = z
  .strictObject({ tables: z.array(tableSpecSchema).min(1).max(MAX_TABLES) })
  .superRefine((schema, ctx) => {
    const names = new Set<string>();
    for (const [i, table] of schema.tables.entries()) {
      if (names.has(table.name)) ctx.addIssue({ code: "custom", message: `Duplicate table "${table.name}".`, path: ["tables", i, "name"] });
      names.add(table.name);
    }
    for (const [ti, table] of schema.tables.entries()) {
      for (const [ci, column] of table.columns.entries()) {
        if (!column.references) continue;
        const target = schema.tables.find((t) => t.name === column.references?.table);
        const targetColumn = target?.columns.find((c) => c.name === column.references?.column);
        if (!target || !targetColumn) {
          ctx.addIssue({
            code: "custom",
            message: `Foreign key ${table.name}.${column.name} references unknown ${column.references.table}.${column.references.column}.`,
            path: ["tables", ti, "columns", ci, "references"],
          });
        } else if (baseType(targetColumn.type) !== baseType(column.type)) {
          ctx.addIssue({
            code: "custom",
            message: `Foreign key ${table.name}.${column.name} (${column.type}) has a different type than ${target.name}.${targetColumn.name} (${targetColumn.type}).`,
            path: ["tables", ti, "columns", ci, "type"],
          });
        } else if (!targetColumn.primaryKey || target.columns.filter((c) => c.primaryKey).length !== 1) {
          ctx.addIssue({
            code: "custom",
            message: `Foreign key ${table.name}.${column.name} must reference a single-column primary key.`,
            path: ["tables", ti, "columns", ci, "references"],
          });
        }
      }
    }
  });

export type ParsedSchema = z.infer<typeof schemaSpecSchema>;

export function baseType(type: string): "int" | "numeric" | "text" | "boolean" | "date" | "timestamp" {
  if (/^(integer|bigint|smallint)$/.test(type)) return "int";
  if (/^(real|double precision|numeric)/.test(type)) return "numeric";
  if (type === "boolean") return "boolean";
  if (type === "date") return "date";
  if (type === "timestamp") return "timestamp";
  return "text";
}

// ---------------------------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(:\d{2})?$/;

function validDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function cellProblem(column: { name: string; type: string; nullable: boolean; primaryKey: boolean }, value: unknown): string | null {
  if (value === null) return column.nullable && !column.primaryKey ? null : `${column.name} must not be NULL`;
  const type = baseType(column.type);
  switch (type) {
    case "int":
      return typeof value === "number" && Number.isSafeInteger(value) ? null : `${column.name} expects an integer`;
    case "numeric":
      return typeof value === "number" && Number.isFinite(value) ? null : `${column.name} expects a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${column.name} expects true/false`;
    case "date": {
      const match = typeof value === "string" ? DATE_RE.exec(value) : null;
      return match && validDate(Number(match[1]), Number(match[2]), Number(match[3])) ? null : `${column.name} expects a date as YYYY-MM-DD`;
    }
    case "timestamp": {
      const match = typeof value === "string" ? TIMESTAMP_RE.exec(value) : null;
      return match && validDate(Number(match[1]), Number(match[2]), Number(match[3])) ? null : `${column.name} expects a timestamp as YYYY-MM-DD HH:MM[:SS]`;
    }
    default: {
      if (typeof value !== "string") return `${column.name} expects text`;
      const length = /^varchar\((\d+)\)$/.exec(column.type);
      if (length && value.length > Number(length[1])) return `${column.name} is longer than ${length[1]} characters`;
      if (value.length > 500) return `${column.name} is too long`;
      // NUL bytes cannot be stored by PostgreSQL text
      return value.includes("\u0000") ? `${column.name} contains an invalid character` : null;
    }
  }
}

export const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const datasetRowsSchema = z.record(z.string(), z.array(z.array(cellSchema)));

/**
 * Checks fixture rows against the schema: shape, value types, primary-key uniqueness and
 * foreign-key integrity. Returns human-readable problems (empty array = valid).
 */
export function validateDatasetRows(schema: SchemaSpec, rows: DatasetRows, label = "dataset"): string[] {
  const problems: string[] = [];
  const tableNames = new Set(schema.tables.map((table) => table.name));

  for (const name of Object.keys(rows)) {
    if (!tableNames.has(name)) problems.push(`${label}: rows supplied for unknown table "${name}".`);
  }
  const keyValues = new Map<string, Set<string>>();

  for (const table of schema.tables) {
    const tableRows = rows[table.name] ?? [];
    if (tableRows.length > MAX_ROWS_PER_TABLE) problems.push(`${label}: table "${table.name}" has more than ${MAX_ROWS_PER_TABLE} rows.`);
    const pkColumns = table.columns.map((column, index) => ({ column, index })).filter(({ column }) => column.primaryKey);
    const seenPk = new Set<string>();

    for (const [rowIndex, row] of tableRows.entries()) {
      if (row.length !== table.columns.length) {
        problems.push(`${label}: ${table.name} row ${rowIndex + 1} has ${row.length} values; expected ${table.columns.length}.`);
        continue;
      }
      for (const [colIndex, column] of table.columns.entries()) {
        const problem = cellProblem(column, row[colIndex]);
        if (problem) problems.push(`${label}: ${table.name} row ${rowIndex + 1}: ${problem}.`);
      }
      if (pkColumns.length > 0) {
        const key = JSON.stringify(pkColumns.map(({ index }) => row[index]));
        if (seenPk.has(key)) problems.push(`${label}: ${table.name} row ${rowIndex + 1}: duplicate primary key ${key}.`);
        seenPk.add(key);
      }
    }
    if (pkColumns.length === 1) {
      keyValues.set(
        table.name,
        new Set(tableRows.map((row) => JSON.stringify(row[pkColumns[0]!.index]))),
      );
    }
  }
  for (const table of schema.tables) {
    for (const [colIndex, column] of table.columns.entries()) {
      if (!column.references) continue;
      const valid = keyValues.get(column.references.table);
      for (const [rowIndex, row] of (rows[table.name] ?? []).entries()) {
        const value = row[colIndex];
        if (value !== null && value !== undefined && valid && !valid.has(JSON.stringify(value))) {
          problems.push(`${label}: ${table.name} row ${rowIndex + 1}: ${column.name}=${JSON.stringify(value)} has no matching ${column.references.table}.${column.references.column}.`);
        }
      }
    }
  }
  return problems;
}

/** Normalises rows so every table is present (as an empty array when omitted). */
export function normalizeRows(schema: SchemaSpec, rows: DatasetRows): DatasetRows {
  return Object.fromEntries(schema.tables.map((table) => [table.name, rows[table.name] ?? []]));
}

// ---------------------------------------------------------------------------------------------
// DDL / DML generation (trusted code path — all identifiers are validated + quoted)
// ---------------------------------------------------------------------------------------------

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Refusing to quote unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** Tables ordered so that referenced tables come first. Throws on dependency cycles. */
export function orderTables(schema: SchemaSpec): TableSpec[] {
  const remaining = new Map(schema.tables.map((table) => [table.name, table]));
  const ordered: TableSpec[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((table) =>
      table.columns.every((column) => !column.references || column.references.table === table.name || !remaining.has(column.references.table)),
    );
    if (ready.length === 0) throw new Error("Foreign keys form a cycle between tables.");
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table.name);
    }
  }
  return ordered;
}

export function createTableSql(schemaName: string, table: TableSpec): string {
  const columns = table.columns.map((column) => {
    const parts = [quoteIdent(column.name), column.type];
    if (!column.nullable || column.primaryKey) parts.push("NOT NULL");
    return parts.join(" ");
  });
  const pk = table.columns.filter((column) => column.primaryKey).map((column) => quoteIdent(column.name));
  if (pk.length > 0) columns.push(`PRIMARY KEY (${pk.join(", ")})`);
  for (const column of table.columns) {
    if (column.references) {
      columns.push(
        `FOREIGN KEY (${quoteIdent(column.name)}) REFERENCES ${quoteIdent(schemaName)}.${quoteIdent(column.references.table)} (${quoteIdent(column.references.column)})`,
      );
    }
  }
  return `CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(table.name)} (\n  ${columns.join(",\n  ")}\n)`;
}

export function insertStatements(schemaName: string, table: TableSpec, rows: CellValue[][], chunkSize = 100): Array<{ text: string; values: CellValue[] }> {
  const statements: Array<{ text: string; values: CellValue[] }> = [];
  const columnList = table.columns.map((column) => quoteIdent(column.name)).join(", ");
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: CellValue[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((cell) => {
        values.push(cell);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    statements.push({
      text: `INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(table.name)} (${columnList}) VALUES ${tuples.join(", ")}`,
      values,
    });
  }
  return statements;
}

// ---------------------------------------------------------------------------------------------
// Dataset identity
// ---------------------------------------------------------------------------------------------

/** Content-addressed key: identical schema + rows always map to the same PostgreSQL schema/role. */
export function datasetKey(schema: SchemaSpec, rows: DatasetRows): string {
  const normalizedSchema = schema.tables.map((table) => ({
    name: table.name,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable && !column.primaryKey,
      primaryKey: column.primaryKey,
      references: column.references ?? null,
    })),
  }));
  return contentHash({ v: 1, schema: normalizedSchema, rows: normalizeRows(schema, rows) }).slice(0, 24);
}

export const schemaNameFor = (key: string) => `ds_${key}`;
export const roleNameFor = (key: string) => `dsr_${key}`;
