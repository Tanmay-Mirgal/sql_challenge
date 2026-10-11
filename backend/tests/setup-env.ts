// Runs in every test worker BEFORE application modules are imported.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SESSION_SECRET = "test-session-secret-test-session-secret-0123456789";
process.env.COOKIE_NAME = "sql_challenge_session";
process.env.FRONTEND_URL = "http://localhost:3000";
process.env.BACKEND_PUBLIC_URL = "http://localhost:4000";
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017/sql_challenge_test";
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_CALLBACK_URL = "http://localhost:4000/api/v1/auth/google/callback";
// Generous limits so functional tests never trip rate limiting; dedicated tests use their own config.
process.env.RATE_LIMIT_AUTH_PER_15_MIN = "100000";
process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
process.env.RATE_LIMIT_RUN_PER_MINUTE = "100000";
process.env.RATE_LIMIT_SUBMIT_PER_MINUTE = "100000";
process.env.RATE_LIMIT_GENERATION_PER_HOUR = "100000";
process.env.SQL_EXECUTOR_DATABASE_URL = process.env.TEST_SQL_RUNNER_URL ?? "";
process.env.SQL_SETUP_DATABASE_URL = process.env.TEST_SQL_SETUP_URL ?? "";
process.env.SQL_STATEMENT_TIMEOUT_MS = "1500";
process.env.SQL_MAX_RESULT_ROWS = "200";
