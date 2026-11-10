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

/** Timeout is a kind of unavailability; callers may retry it like a provider outage. */
export class LlmTimeoutError extends LlmUnavailable {
  constructor(readonly timeoutMs: number) {
    super(`llm request timed out after ${timeoutMs}ms`, 'timeout');
  }
}

export type BudgetLimitKind = 'daily' | 'monthly';

export class BudgetExceeded extends LlmError {
  readonly code = 'budget_exceeded' as const;

  constructor(
    readonly kind: BudgetLimitKind,
    readonly limitUsd: number,
    readonly spentUsd: number,
  ) {
    super(`${kind} LLM budget exceeded: spent $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(4)}`);
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
