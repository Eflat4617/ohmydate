import type { Violation } from '@ohmydate/contracts';

/** `If-Match: W/"availability:<n>"` does not match the locked version. */
export class AvailabilityChangedError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`availability changed: expected ${expected}, found ${actual}`);
    this.name = 'AvailabilityChangedError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** Scheduler H1-H8 findings returned as 422 `constraint_violation`. */
export class ConstraintViolationError extends Error {
  readonly violations: readonly Violation[];

  constructor(violations: readonly Violation[]) {
    super('the plan violates scheduling constraints');
    this.name = 'ConstraintViolationError';
    this.violations = violations;
  }
}

/**
 * Plan-shape race (another approval committed between the request's snapshot
 * and the transaction lock). Maps to 409: the state transition cannot be
 * applied on the observed plan version.
 */
export class PlanConflictError extends Error {
  constructor(message = 'the plan changed while the request was being processed') {
    super(message);
    this.name = 'PlanConflictError';
  }
}
