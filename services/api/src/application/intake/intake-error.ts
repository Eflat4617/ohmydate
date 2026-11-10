import type { ProblemCode } from '@ohmydate/contracts';

/**
 * Application-level failure with an HTTP representation. Keeping the status and
 * stable problem code here lets the intake use-cases signal 409/503 outcomes
 * without importing the HTTP layer.
 */
export class IntakeError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProblemCode,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'IntakeError';
  }

  static illegalTransition(from: string, event: string): IntakeError {
    return new IntakeError(
      409,
      'illegal_transition',
      'Illegal intake transition',
      `cannot apply ${event} while the intake session is ${from}`,
    );
  }

  static llmUnavailable(detail: string): IntakeError {
    return new IntakeError(503, 'llm_unavailable', 'LLM unavailable', detail);
  }

  static budgetExceeded(detail: string): IntakeError {
    return new IntakeError(503, 'budget_exceeded', 'LLM budget exceeded', detail);
  }
}
