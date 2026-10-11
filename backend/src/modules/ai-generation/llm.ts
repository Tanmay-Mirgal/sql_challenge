import Groq from "groq-sdk";
import type { AppConfig } from "@/config";

export interface LlmRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "transient" | "timeout" | "rate_limited" | "fatal",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "timeout" || this.kind === "rate_limited";
  }
}

/** Provider-agnostic text-generation port. The Groq adapter below is the only production implementation. */
export interface LlmClient {
  readonly configured: boolean;
  readonly model: string;
  generateJson(request: LlmRequest): Promise<LlmResponse>;
}

export class UnconfiguredLlm implements LlmClient {
  readonly configured = false;
  readonly model = "unconfigured";
  generateJson(): Promise<LlmResponse> {
    return Promise.reject(
      new LlmError("AI generation is not configured. Set GROQ_API_KEY (and optionally GROQ_MODEL) in backend/.env and restart the API.", "not_configured"),
    );
  }
}

/**
 * Groq adapter (official `groq-sdk`). The API key lives only in the backend process.
 * JSON mode is used for the transport; the content is still validated with Zod and
 * the SQL pipeline — the model is never trusted.
 */
export class GroqLlmClient implements LlmClient {
  readonly configured = true;
  private readonly client: Groq;
  readonly model: string;

  constructor(private readonly config: NonNullable<AppConfig["groq"]>) {
    this.client = new Groq({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 0 });
    this.model = config.model;
  }

  async generateJson(request: LlmRequest): Promise<LlmResponse> {
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.config.model,
          temperature: request.temperature ?? 0.6,
          max_completion_tokens: request.maxTokens ?? 6000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        },
        { signal: request.signal },
      );
      const text = completion.choices[0]?.message?.content;
      if (!text) throw new LlmError("The model returned an empty response.", "transient");
      return {
        text,
        model: completion.model ?? this.config.model,
        usage: { promptTokens: completion.usage?.prompt_tokens, completionTokens: completion.usage?.completion_tokens },
      };
    } catch (error) {
      throw classifyGroqError(error);
    }
  }
}

function classifyGroqError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const e = error as { status?: number; name?: string; message?: string; headers?: Headers | Record<string, string> };
  const retryHeader = typeof e.headers?.get === "function" ? (e.headers as Headers).get("retry-after") : undefined;
  const retryAfterMs = retryHeader && Number.isFinite(Number(retryHeader)) ? Number(retryHeader) * 1000 : undefined;
  if (e.name === "APIConnectionTimeoutError" || e.name === "AbortError") return new LlmError("The AI provider timed out.", "timeout");
  if (e.status === 429) return new LlmError("The AI provider rate-limited the request.", "rate_limited", retryAfterMs);
  if (e.status === 401 || e.status === 403) return new LlmError("The AI provider rejected the API key (check GROQ_API_KEY).", "fatal");
  if (e.status === 404) return new LlmError("The configured model was not found (check GROQ_MODEL).", "fatal");
  if (e.status === 400) return new LlmError(`The AI provider rejected the request: ${(e.message ?? "").slice(0, 200)}`, "fatal");
  if (typeof e.status === "number" && e.status >= 500) return new LlmError(`The AI provider is unavailable (HTTP ${e.status}).`, "transient");
  if (e.name === "APIConnectionError") return new LlmError("Could not reach the AI provider.", "transient");
  return new LlmError("The AI provider failed unexpectedly.", "transient");
}

export function createLlmClient(config: AppConfig["groq"]): LlmClient {
  return config ? new GroqLlmClient(config) : new UnconfiguredLlm();
}
