import { type Env, parseEnv } from "./env";

export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

export interface AppConfig {
  env: Env["NODE_ENV"];
  isProduction: boolean;
  isTest: boolean;
  port: number;
  logLevel: Env["LOG_LEVEL"];
  trustProxy: number;
  frontendUrl: string;
  backendPublicUrl: string;
  /** Normalised browser origins permitted for CORS and CSRF origin checks. */
  allowedOrigins: string[];
  mongoUri: string;
  google: { clientId: string; clientSecret: string; callbackUrl: string } | null;
  session: {
    secret: string;
    cookieName: string;
    cookieSecure: boolean;
    cookieDomain: string | undefined;
    cookieSameSite: "lax" | "strict";
    ttlMs: number;
  };
  identity: { allowedEmailDomains: string[]; adminEmails: string[] };
  groq: { apiKey: string; model: string; timeoutMs: number; maxAttempts: number } | null;
  sql: {
    executorUrl: string | null;
    setupUrl: string | null;
    poolSize: number;
    statementTimeoutMs: number;
    maxResultRows: number;
    maxResultBytes: number;
    maxQueryLength: number;
    maxConcurrentJobs: number;
    maxConcurrentJobsPerUser: number;
    maxQueuedJobs: number;
  };
  rateLimits: {
    authPer15Min: number;
    apiPerMinute: number;
    runPerMinute: number;
    submitPerMinute: number;
    generationPerHour: number;
  };
}

export function buildConfig(env: Env): AppConfig {
  const origin = (url: string) => new URL(url).origin;
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL
      ? {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          callbackUrl: env.GOOGLE_CALLBACK_URL,
        }
      : null;
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    frontendUrl: env.FRONTEND_URL.replace(/\/$/, ""),
    backendPublicUrl: env.BACKEND_PUBLIC_URL.replace(/\/$/, ""),
    allowedOrigins: [...new Set([origin(env.FRONTEND_URL), ...env.CORS_ALLOWED_ORIGINS.map(origin)])],
    mongoUri: env.MONGODB_URI,
    google,
    session: {
      secret: env.SESSION_SECRET,
      cookieName: env.COOKIE_NAME,
      cookieSecure: env.COOKIE_SECURE,
      cookieDomain: env.COOKIE_DOMAIN,
      cookieSameSite: env.COOKIE_SAMESITE,
      ttlMs: env.SESSION_TTL_HOURS * 3_600_000,
    },
    identity: {
      allowedEmailDomains: env.ALLOWED_COLLEGE_EMAIL_DOMAINS,
      adminEmails: env.ADMIN_EMAILS,
    },
    groq: env.GROQ_API_KEY
      ? {
          apiKey: env.GROQ_API_KEY,
          model: env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL,
          timeoutMs: env.GROQ_TIMEOUT_MS,
          maxAttempts: env.GROQ_MAX_ATTEMPTS,
        }
      : null,
    sql: {
      executorUrl: env.SQL_EXECUTOR_DATABASE_URL ?? null,
      setupUrl: env.SQL_SETUP_DATABASE_URL ?? null,
      poolSize: env.SQL_EXECUTOR_POOL_SIZE,
      statementTimeoutMs: env.SQL_STATEMENT_TIMEOUT_MS,
      maxResultRows: env.SQL_MAX_RESULT_ROWS,
      maxResultBytes: env.SQL_MAX_RESULT_BYTES,
      maxQueryLength: env.SQL_MAX_QUERY_LENGTH,
      maxConcurrentJobs: env.SQL_MAX_CONCURRENT_JOBS,
      maxConcurrentJobsPerUser: env.SQL_MAX_CONCURRENT_JOBS_PER_USER,
      maxQueuedJobs: env.SQL_MAX_QUEUED_JOBS,
    },
    rateLimits: {
      authPer15Min: env.RATE_LIMIT_AUTH_PER_15_MIN,
      apiPerMinute: env.RATE_LIMIT_API_PER_MINUTE,
      runPerMinute: env.RATE_LIMIT_RUN_PER_MINUTE,
      submitPerMinute: env.RATE_LIMIT_SUBMIT_PER_MINUTE,
      generationPerHour: env.RATE_LIMIT_GENERATION_PER_HOUR,
    },
  };
}

let cached: AppConfig | undefined;

/** Lazily parsed, validated configuration singleton. */
export function getConfig(): AppConfig {
  cached ??= buildConfig(parseEnv());
  return cached;
}

/** Test helper: replace the cached configuration. */
export function setConfigForTests(config: AppConfig | undefined): void {
  cached = config;
}
