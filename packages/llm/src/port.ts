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
  /** Provider-reported cached prompt tokens, when the provider exposes them. */
  readonly cachedInputTokens?: number;
  /**
   * Provider-reported cost. Real adapters MUST return a finite, non-negative costUsd;
   * omitting it makes the BudgetGuard fail closed (05 §8, ADR-008). Fake/local pricing may
   * omit it only when the model is a fake model.
   */
  readonly costUsd?: number;
}

export interface LlmCompleteRequest {
  readonly promptId: string;
  readonly version: string;
  readonly input: unknown;
  readonly schemaId: string;
  /** Owner whose settings provide consent + budget limits (05 §12, ADR-022). */
  readonly ownerId?: string;
  /**
   * Logical conversation key (the intake session id). Adapters may derive a
   * non-identifying provider session header from `ownerId + sessionKey`.
   */
  readonly sessionKey?: string;
  readonly budget?: LlmBudget;
  /** Aborted by the caller timeout; adapters must stop work when this fires. */
  readonly signal?: AbortSignal;
  /**
   * M6-01 audit hook: provider adapters call this immediately before the
   * prompt leaves the process (every network attempt; `FakeLlm` on every
   * simulated call). Policy wrappers pass it through untouched, so a call
   * refused by the consent/budget gate never fires it. Callers use it to
   * record which note sections were actually sent (note_ai_usage). It must
   * not throw and must not be serialised into the prompt.
   */
  readonly onDispatch?: () => void;
  /**
   * Per-call output bound (prompt limits). Policy reservation and the adapter's
   * `max_tokens` both use it (see `effectiveMaxOutputTokens`); absent -> configured default.
   */
  readonly maxOutputTokens?: number;
  /** Per-call provider attempt timeout; absent -> the adapter's configured timeout. */
  readonly timeoutMs?: number;
}

export interface LlmCompleteResponse {
  /** Raw provider output. Callers MUST validate it against `schemaId` before use. */
  readonly output: unknown;
  readonly usage: LlmUsage;
  readonly model: string;
  /** Provider id used for agent_run metadata (e.g. `deepseek`). */
  readonly provider?: string;
  readonly latencyMs: number;
}

/**
 * Provider boundary. Real adapters MUST populate `usage.costUsd` for pricing/budgeting;
 * `FakeLlm` is the only implementation allowed to omit it.
 */
export interface LlmPort {
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
