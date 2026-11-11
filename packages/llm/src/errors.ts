export type LlmErrorCode =
  | 'llm_unavailable'
  | 'budget_exceeded'
  | 'schema_violation'
  | 'prompt_not_found'
  | 'unknown_schema';

export abstract class LlmError extends Error {
  abstract readonly code: LlmErrorCode;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LlmUnavailable extends LlmError {
  readonly code = 'llm_unavailable' as const;

  constructor(
    message = 'llm provider unavailable',
    readonly reason: 'provider' | 'timeout' | 'aborted' = 'provider',
    /**
     * False once the adapter has exhausted its own 429/5xx retries or hit a
     * non-retryable 4xx, so `runStructured` does not start a second retry loop.
     */
    readonly retryable = true,
  ) {
    super(message);
  }
}

/**
 * The gateway rejected `response_format: json_object`. The adapter turns this
 * into exactly one strict-instruction retry; it is never retried as an outage.
 */
export class ResponseFormatUnsupportedError extends LlmUnavailable {
  constructor(message = 'provider rejected response_format json_object') {
    super(message, 'provider', false);
  }
}

/**
 * A typed 4xx gateway rejection. Only the bounded `error.type` classification
 * is carried; raw gateway response bodies are never stored in the error.
 */
export class GatewayError extends LlmUnavailable {
  constructor(
    readonly status: number,
    readonly gatewayErrorType?: string,
  ) {
    super(
      gatewayErrorType === undefined
        ? `llm gateway rejected the request (HTTP ${status})`
        : `llm gateway rejected the request (HTTP ${status}, type ${gatewayErrorType})`,
      'provider',
      false,
    );
  }
}

/** OpenCode Go requires `x-opencode-session`; a 400 for it is never retried. */
export class MissingSessionIdError extends GatewayError {
  constructor(status = 400) {
    super(status, 'MissingSessionID');
  }
}

/** Timeout is reported as unavailability but `runStructured` does not retry it. */
export class LlmTimeoutError extends LlmUnavailable {
  constructor(readonly timeoutMs: number) {
    super(`llm request timed out after ${timeoutMs}ms`, 'timeout');
  }
}

export type BudgetLimitKind = 'daily' | 'monthly';

export type BudgetBlockReason =
  | 'not_configured'
  | 'invalid_limit'
  | 'invalid_estimate'
  | 'unpriced_usage'
  | 'limit_reached'
  | 'projected_limit';

/**
 * Budget is fail-closed (ADR-008): a missing/non-finite/non-positive limit, an already
 * reached ceiling, or a missing guard all block provider calls rather than allowing them.
 */
export class BudgetExceeded extends LlmError {
  readonly code = 'budget_exceeded' as const;

  constructor(
    readonly kind: BudgetLimitKind,
    readonly limitUsd: number,
    readonly spentUsd: number,
    readonly reason: BudgetBlockReason = 'limit_reached',
  ) {
    super(BudgetExceeded.messageFor(kind, limitUsd, spentUsd, reason));
  }

  private static messageFor(
    kind: BudgetLimitKind,
    limitUsd: number,
    spentUsd: number,
    reason: BudgetBlockReason,
  ): string {
    switch (reason) {
      case 'not_configured':
        return 'LLM budget is not configured; provider calls are disabled';
      case 'invalid_limit':
        return `${kind} LLM budget limit is missing, non-finite or non-positive`;
      case 'invalid_estimate':
        return `${kind} LLM budget estimate is non-finite or negative`;
      case 'unpriced_usage':
        return 'LLM usage had no finite cost; treating the budget as exhausted';
      case 'limit_reached':
        return `${kind} LLM budget reached: spent $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(4)}`;
      case 'projected_limit':
        return `${kind} LLM budget would be exceeded: spent $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(4)}`;
    }
  }
}

export class SchemaViolation extends LlmError {
  readonly code = 'schema_violation' as const;

  constructor(
    readonly schemaId: string,
    readonly errors: readonly string[],
  ) {
    super(`llm output does not match ${schemaId}: ${errors.join('; ')}`);
  }
}

export class PromptNotFoundError extends LlmError {
  readonly code = 'prompt_not_found' as const;

  constructor(
    readonly promptId: string,
    readonly version: string,
  ) {
    super(`prompt not found: ${promptId}@${version}`);
  }
}

export class UnknownSchemaError extends LlmError {
  readonly code = 'unknown_schema' as const;

  constructor(readonly schemaId: string) {
    super(`unknown llm schema: ${schemaId}`);
  }
}
