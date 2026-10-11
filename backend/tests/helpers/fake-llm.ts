import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "@/modules/ai-generation/llm";

export type FakeReply = string | object | Error | ((request: LlmRequest) => string | object);

/** Scripted LLM: each call consumes the next reply (strings are returned verbatim, objects are JSON-encoded). */
export class FakeLlm implements LlmClient {
  readonly configured = true;
  readonly model = "fake-model";
  readonly requests: LlmRequest[] = [];
  private readonly replies: FakeReply[];

  constructor(replies: FakeReply[] = []) {
    this.replies = [...replies];
  }

  enqueue(...replies: FakeReply[]): void {
    this.replies.push(...replies);
  }

  generateJson(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (next === undefined) return Promise.reject(new LlmError("No scripted reply left.", "fatal"));
    if (next instanceof Error) return Promise.reject(next);
    const value = typeof next === "function" ? next(request) : next;
    return Promise.resolve({ text: typeof value === "string" ? value : JSON.stringify(value), model: this.model });
  }
}
