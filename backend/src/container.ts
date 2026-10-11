import type { AppConfig } from "@/config";
import type { LlmClient } from "@/modules/ai-generation/llm";
import type { GoogleOAuthProvider } from "@/modules/auth/google.provider";
import type { SqlExecutionService } from "@/modules/sql-execution/service";

/**
 * Explicit dependency container. Production wiring lives in `server.ts`; tests
 * build their own container with fakes (Google, LLM) and a test database.
 */
export interface Container {
  config: AppConfig;
  google: GoogleOAuthProvider;
  /** Isolated PostgreSQL execution environment (validation, provisioning, execution). */
  sql: SqlExecutionService;
  /** Text-generation provider used only by the admin challenge-generation workflow. */
  llm: LlmClient;
}
