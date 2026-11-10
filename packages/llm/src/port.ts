/**
 * The only LLM surface the application/domain layers know (ADR-008).
 * Provider SDKs live behind adapters; tests use `FakeLlm`.
 */

export interface LlmBudget {
  /** User-configured daily USD ceiling. */
  readonly dailyUsd: number;
  /** User-configured monthly USD ceiling. */
  readonly monthlyUsd: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-reported cost when available; absent for locally priced/fake calls. */
  readonly costUsd?: number;
}

export interface LlmCompleteRequest {
  readonly promptId: string;
  readonly version: string;
  readonly input: unknown;
  readonly schemaId: string;
  readonly budget?: LlmBudget;
  /** Aborted by the caller timeout; adapters must stop work when this fires. */
  readonly signal?: AbortSignal;
}

export interface LlmCompleteResponse {
  /** Raw provider output. Callers MUST validate it against `schemaId` before use. */
  readonly output: unknown;
  readonly usage: LlmUsage;
  readonly model: string;
  readonly latencyMs: number;
}

export interface LlmPort {
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
