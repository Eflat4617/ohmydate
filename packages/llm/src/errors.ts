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
  ) {
    super(message);
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
