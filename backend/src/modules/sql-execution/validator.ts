import { parse } from "libpg-query";
import type { SqlErrorCategory } from "./types";

/**
 * Allow-list SQL validation based on PostgreSQL's own parser (libpg_query), so the
 * grammar we check is exactly the grammar the server would execute.
 *
 * This is DEFENCE IN DEPTH. The security boundary is the database: a read-only
 * transaction, a role that can read exactly one dataset, statement timeouts and
 * resource limits. The validator exists to give participants fast, friendly
 * feedback and to shrink the attack surface (no function calls beyond a curated
 * list, no catalog access, no schema-qualified names, one SELECT only).
 */

export interface ValidationOptions {
  /** Tables of the challenge schema that the query may reference. */
  allowedTables: readonly string[];
  maxLength: number;
}

export interface QueryFeatures {
  join: boolean;
  outerJoin: boolean;
  groupBy: boolean;
  having: boolean;
  subquery: boolean;
  cte: boolean;
  caseExpr: boolean;
  window: boolean;
  distinct: boolean;
  aggregate: boolean;
  orderBy: boolean;
  limit: boolean;
  setOperation: boolean;
}

export type ValidationResult =
  | { ok: true; features: QueryFeatures; referencedTables: string[] }
  | { ok: false; category: Extract<SqlErrorCategory, "SQL_SYNTAX_ERROR" | "INVALID_QUERY">; message: string; line?: number; column?: number };

/** Node kinds that may appear in a participant's SELECT. Anything else is rejected. */
const ALLOWED_NODES = new Set([
  "SelectStmt",
  "ResTarget",
  "ColumnRef",
  "A_Star",
  "String",
  "Integer",
  "Float",
  "Boolean",
  "BitString",
  "A_Const",
  "TypeCast",
  "TypeName",
  "A_Expr",
  "BoolExpr",
  "FuncCall",
  "WindowDef",
  "SortBy",
  "RangeVar",
  "JoinExpr",
  "Alias",
  "RangeSubselect",
  "SubLink",
  "CaseExpr",
  "CaseWhen",
  "NullTest",
  "BooleanTest",
  "CoalesceExpr",
  "MinMaxExpr",
  "CommonTableExpr",
  "WithClause",
  "RowExpr",
  "List",
  "GroupingSet",
  "GroupingFunc",
  "SetToDefault",
]);

/** Scalar functions and aggregates a participant may call (names as stored by PostgreSQL's parser). */
const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "string_agg", "bool_and", "bool_or", "every",
  // numeric
  "abs", "ceil", "ceiling", "floor", "round", "trunc", "mod", "power", "pow", "sqrt", "sign", "div",
  // text
  "lower", "upper", "length", "char_length", "character_length", "octet_length", "trim", "ltrim", "rtrim", "btrim", "substr", "substring",
  "position", "strpos", "replace", "concat", "concat_ws", "left", "right", "lpad", "rpad", "initcap", "split_part", "reverse", "repeat",
  "starts_with", "like_escape", "translate", "overlay",
  // date / time (deterministic ones only — no now()/current_date)
  "date_part", "extract", "date_trunc", "age", "make_date", "to_char", "to_date", "timezone",
  // window
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
  // internal names the parser produces for SQL-standard syntax
  "btrim", "ltrim", "rtrim", "textpos", "overlaps", "is_normalized", "normalize", "timestamptz", "date", "timestamp",
]);

/** Target types accepted in CAST / :: expressions (internal PostgreSQL names). */
const ALLOWED_CAST_TYPES = new Set([
  "int2", "int4", "int8", "numeric", "float4", "float8", "text", "varchar", "bpchar", "bool", "date", "timestamp", "timestamptz", "time", "interval",
]);

const MAX_NODES = 5000;

export function emptyFeatures(): QueryFeatures {
  return {
    join: false,
    outerJoin: false,
    groupBy: false,
    having: false,
    subquery: false,
    cte: false,
    caseExpr: false,
    window: false,
    distinct: false,
    aggregate: false,
    orderBy: false,
    limit: false,
    setOperation: false,
  };
}

const AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "string_agg", "bool_and", "bool_or", "every"]);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isNodeKind = (key: string) => /^[A-Z]/.test(key);

function reject(message: string): ValidationResult {
  return { ok: false, category: "INVALID_QUERY", message };
}

/** Converts a 1-based character offset into 1-based line/column within `sql`. */
export function lineColumn(sql: string, position: number): { line: number; column: number } {
  const upTo = sql.slice(0, Math.max(0, position - 1));
  const lines = upTo.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

interface ParserError {
  message?: string;
  sqlDetails?: { message?: string; cursorPosition?: number };
}

function describeStatement(kind: string): string {
  const friendly: Record<string, string> = {
    InsertStmt: "INSERT",
    UpdateStmt: "UPDATE",
    DeleteStmt: "DELETE",
    MergeStmt: "MERGE",
    DropStmt: "DROP",
    CreateStmt: "CREATE TABLE",
    AlterTableStmt: "ALTER TABLE",
    TruncateStmt: "TRUNCATE",
    GrantStmt: "GRANT",
    VariableSetStmt: "SET",
    VariableShowStmt: "SHOW",
    ExplainStmt: "EXPLAIN",
    CopyStmt: "COPY",
    DoStmt: "DO",
    CallStmt: "CALL",
    TransactionStmt: "transaction control",
    CreateFunctionStmt: "CREATE FUNCTION",
    IndexStmt: "CREATE INDEX",
  };
  return friendly[kind] ?? kind.replace(/Stmt$/, "").toUpperCase();
}

export async function validateSql(sql: unknown, options: ValidationOptions): Promise<ValidationResult> {
  if (typeof sql !== "string" || sql.trim().length === 0) return reject("Write a query before running it.");
  if (sql.length > options.maxLength) return reject(`The query is too long (maximum ${options.maxLength} characters).`);
  if (sql.includes("\u0000")) return reject("The query contains an invalid character.");

  let tree: { stmts?: Array<{ stmt?: Json }> };
  try {
    tree = (await parse(sql)) as typeof tree;
  } catch (error) {
    const details = (error as ParserError).sqlDetails;
    // Not a PostgreSQL syntax error (e.g. the parser ran out of stack on pathological nesting).
    if (!details) return reject("The query is too complex to analyse. Simplify it and try again.");
    const position = details.cursorPosition; // 0-based character offset
    return {
      ok: false,
      category: "SQL_SYNTAX_ERROR",
      message: (details.message ?? "syntax error").slice(0, 300),
      ...(typeof position === "number" && position >= 0 ? lineColumn(sql, position + 1) : {}),
    };
  }

  const statements = tree.stmts ?? [];
  if (statements.length === 0) return reject("Write a query before running it.");
  if (statements.length > 1) return reject("Only one SQL statement is allowed. Remove the extra statements after the first semicolon.");

  const root = statements[0]?.stmt;
  const rootKind = root ? Object.keys(root)[0] : undefined;
  if (!root || rootKind !== "SelectStmt") {
    return reject(`Only SELECT queries are allowed (found ${rootKind ? describeStatement(rootKind) : "an unsupported statement"}).`);
  }

  // Pass 1: collect CTE names so references to them are not mistaken for unknown tables.
  const cteNames = new Set<string>();
  let nodeCount = 0;
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "CommonTableExpr" && isObject(child) && typeof child.ctename === "string") cteNames.add(child.ctename);
      collect(child);
    }
  };
  try {
    collect(root);
  } catch (error) {
    if (error instanceof RangeError) return reject("The query is too complex to analyse. Simplify it and try again.");
    throw error;
  }

  const allowedTables = new Set(options.allowedTables);
  const referenced = new Set<string>();
  const features = emptyFeatures();
  let failure: ValidationResult | null = null;
  const fail = (message: string) => {
    failure ??= reject(message);
  };

  const visit = (kind: string, node: Json): void => {
    if (!ALLOWED_NODES.has(kind)) {
      switch (kind) {
        case "RangeFunction":
        case "RangeTableFunc":
        case "RangeTableSample":
          return fail("Functions and table samples are not allowed in the FROM clause. Select from the challenge tables instead.");
        case "SQLValueFunction":
          return fail("Functions like CURRENT_DATE, CURRENT_USER or NOW() are not available here. Use the dates in the data.");
        case "ParamRef":
          return fail("Query parameters ($1, $2, …) are not supported. Write the values directly in the query.");
        case "CollateClause":
          return fail("COLLATE is not supported in this challenge.");
        case "LockingClause":
          return fail("Row locking (FOR UPDATE / FOR SHARE) is not allowed.");
        case "InsertStmt":
        case "UpdateStmt":
        case "DeleteStmt":
        case "MergeStmt":
          return fail("Data-changing statements are not allowed, even inside a WITH clause.");
        default:
          return fail(`This SQL construct (${kind}) is not supported in the challenge.`);
      }
    }

    switch (kind) {
      case "SelectStmt": {
        if (node.intoClause) fail("SELECT … INTO is not allowed.");
        if (Array.isArray(node.lockingClause) && node.lockingClause.length > 0) fail("Row locking (FOR UPDATE / FOR SHARE) is not allowed.");
        if (Array.isArray(node.groupClause) && node.groupClause.length > 0) features.groupBy = true;
        if (node.havingClause) features.having = true;
        if (Array.isArray(node.distinctClause)) features.distinct = true;
        if (Array.isArray(node.sortClause) && node.sortClause.length > 0) features.orderBy = true;
        if (node.limitCount || node.limitOffset) features.limit = true;
        if (typeof node.op === "string" && node.op !== "SETOP_NONE") features.setOperation = true;
        break;
      }
      case "RangeVar": {
        if (node.schemaname || node.catalogname) {
          return fail("Schema-qualified table names are not allowed. Refer to the tables by name only, e.g. FROM students.");
        }
        const name = String(node.relname ?? "");
        if (cteNames.has(name)) break;
        if (!allowedTables.has(name)) {
          const list = [...allowedTables].join(", ");
          return fail(`Unknown table "${name}".${list ? ` Available tables: ${list}.` : ""}`);
        }
        referenced.add(name);
        break;
      }
      case "FuncCall": {
        const parts = (Array.isArray(node.funcname) ? node.funcname : [])
          .map((part) => (isObject(part) && isObject(part.String) ? String(part.String.sval) : ""))
          .filter(Boolean);
        const name = parts.length === 2 && parts[0] === "pg_catalog" ? parts[1] : parts.length === 1 ? parts[0] : undefined;
        if (!name || !ALLOWED_FUNCTIONS.has(name)) {
          return fail(`The function ${parts.join(".") || "(unknown)"}() is not available in this challenge.`);
        }
        if (AGGREGATES.has(name)) features.aggregate = true;
        if (node.over) features.window = true;
        break;
      }
      case "TypeCast": {
        const type = isObject(node.typeName) ? node.typeName : {};
        const names = (Array.isArray(type.names) ? type.names : []).map((part) => (isObject(part) && isObject(part.String) ? String(part.String.sval) : ""));
        const last = names[names.length - 1] ?? "";
        const qualifiedOk = names.length === 1 || (names.length === 2 && names[0] === "pg_catalog");
        if (!qualifiedOk || !ALLOWED_CAST_TYPES.has(last) || type.setof || (Array.isArray(type.arrayBounds) && type.arrayBounds.length > 0)) {
          return fail(`Casting to the type "${names.join(".")}" is not supported.`);
        }
        break;
      }
      case "JoinExpr":
        features.join = true;
        if (typeof node.jointype === "string" && node.jointype !== "JOIN_INNER") features.outerJoin = true;
        break;
      case "SubLink":
        features.subquery = true;
        break;
      case "RangeSubselect":
        features.subquery = true;
        break;
      case "CommonTableExpr":
        features.cte = true;
        break;
      case "CaseExpr":
        features.caseExpr = true;
        break;
      default:
        break;
    }
  };

  const walk = (value: unknown): void => {
    if (failure) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (isNodeKind(key) && isObject(child)) {
        nodeCount += 1;
        if (nodeCount > MAX_NODES) return fail("The query is too complex.");
        visit(key, child);
        if (failure) return;
      } else if (isNodeKind(key)) {
        // node kinds with an empty/boolean payload still need an allow-list check
        nodeCount += 1;
        visit(key, {});
      }
      walk(child);
      if (failure) return;
    }
  };

  try {
    walk(root);
  } catch (error) {
    if (error instanceof RangeError) return reject("The query is too complex to analyse. Simplify it and try again.");
    throw error;
  }
  if (failure) return failure;
  return { ok: true, features, referencedTables: [...referenced].sort() };
}
