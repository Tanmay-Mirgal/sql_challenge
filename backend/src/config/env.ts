import { z } from "zod";

/**
 * Environment validation. The process fails fast with actionable messages when
 * required configuration is missing or unsafe. Optional integrations (Google,
 * Groq, SQL execution) are allowed to be absent so the rest of the system can
 * start, but every dependent feature reports "not configured" explicitly.
 */

const csvList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  );

const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

const positiveInt = (defaultValue: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(1).max(max).default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: positiveInt(4000, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  /** Extra browser origins allowed by CORS / CSRF origin checks (comma separated). */
  CORS_ALLOWED_ORIGINS: csvList,
  BACKEND_PUBLIC_URL: z.string().url().default("http://localhost:4000"),

  MONGODB_URI: z
    .string({ error: "MONGODB_URI is required, e.g. mongodb://localhost:27017/sql_challenge" })
    .min(1)
    .refine((value) => /^mongodb(\+srv)?:\/\//.test(value), "MONGODB_URI must start with mongodb:// or mongodb+srv://"),

  // --- Google OAuth (optional until the operator supplies credentials) ---
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

  // --- Sessions / cookies ---
  SESSION_SECRET: z
    .string({
      error: "SESSION_SECRET is required. Generate one with: npm run secrets:generate",
    })
    .min(32, "SESSION_SECRET must be at least 32 characters. Generate one with: npm run secrets:generate"),
  COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{3,64}$/, "COOKIE_NAME may only contain letters, digits, '_', '.' and '-'")
    .default("sql_challenge_session"),
  COOKIE_SECURE: booleanFlag(false),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAMESITE: z.enum(["lax", "strict"]).default("lax"),
  SESSION_TTL_HOURS: positiveInt(72, 24 * 30),

  // --- Identity policy ---
  ALLOWED_COLLEGE_EMAIL_DOMAINS: csvList,
  ADMIN_EMAILS: csvList,

  // --- Groq ---
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().optional(),
  GROQ_TIMEOUT_MS: positiveInt(60_000, 300_000),
  GROQ_MAX_ATTEMPTS: positiveInt(3, 8),

  // --- SQL execution engine (PostgreSQL) ---
  /** Low-privilege `sql_runner` role. Used ONLY to execute participant SQL. */
  SQL_EXECUTOR_DATABASE_URL: z.string().optional(),
  /** `sql_setup` role. Used ONLY by trusted fixture provisioning code. */
  SQL_SETUP_DATABASE_URL: z.string().optional(),
  SQL_EXECUTOR_POOL_SIZE: positiveInt(5, 100),
  SQL_STATEMENT_TIMEOUT_MS: positiveInt(3000, 60_000),
  SQL_MAX_RESULT_ROWS: positiveInt(1000, 100_000),
  SQL_MAX_RESULT_BYTES: positiveInt(1_000_000, 50_000_000),
  SQL_MAX_QUERY_LENGTH: positiveInt(10_000, 200_000),
  SQL_MAX_CONCURRENT_JOBS: positiveInt(5, 100),
  SQL_MAX_CONCURRENT_JOBS_PER_USER: positiveInt(1, 10),
  SQL_MAX_QUEUED_JOBS: positiveInt(200, 100_000),

  // --- Rate limits (requests per window) ---
  RATE_LIMIT_AUTH_PER_15_MIN: positiveInt(40),
  RATE_LIMIT_API_PER_MINUTE: positiveInt(300),
  RATE_LIMIT_RUN_PER_MINUTE: positiveInt(20),
  RATE_LIMIT_SUBMIT_PER_MINUTE: positiveInt(10),
  RATE_LIMIT_GENERATION_PER_HOUR: positiveInt(20),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Treat empty strings (as found in `.env.example` placeholders) as unset. */
function stripEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") cleaned[key] = value.trim();
  }
  return cleaned;
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(stripEmpty(source));
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`));
  }
  const env = result.data;
  const problems: string[] = [];

  if (env.NODE_ENV === "production") {
    if (!env.COOKIE_SECURE) problems.push("COOKIE_SECURE must be 'true' in production (HTTPS only cookies).");
    if (!env.FRONTEND_URL.startsWith("https://")) problems.push("FRONTEND_URL must use https:// in production.");
    if (!env.BACKEND_PUBLIC_URL.startsWith("https://")) problems.push("BACKEND_PUBLIC_URL must use https:// in production.");
  }
  const googleVars = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL];
  if (googleVars.some(Boolean) && !googleVars.every(Boolean)) {
    problems.push(
      "Google OAuth is partially configured. Set all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL (or none).",
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return env;
}
