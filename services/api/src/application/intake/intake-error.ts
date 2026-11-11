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
    readonly headers?: Readonly<Record<string, string>>,
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

/**
 * ADR-020 §6: the dedicated approval lock connection died while this request
 * was still running. The approver must not call the provider, write the
 * approval ledger, or complete the session after this point. Surfaced as 503 so
 * the idempotency reservation is released and a retry can resume.
 */
export class IntakeApprovalOwnershipLostError extends IntakeError {
  constructor() {
    super(
      503,
      'provider_unavailable',
      'Approval ownership lost',
      'the approval lock connection was lost; approval can be retried',
    );
    this.name = 'IntakeApprovalOwnershipLostError';
  }
}
