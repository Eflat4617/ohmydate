import { DailyProblemError } from './daily-errors.js';

/**
 * 409 `proposal_state_conflict`: the replan proposal is not pending (approved,
 * rejected, expired, superseded) or its base plan version moved on.
 */
export function proposalStateConflict(detail: string): DailyProblemError {
  return new DailyProblemError({
    status: 409,
    code: 'proposal_state_conflict',
    title: 'Proposal state conflict',
    detail,
  });
}

/**
 * 409 `replan_suppressed` with `Retry-After` (05 §11): the reason is inside its
 * 24 h post-rejection window, or the owner already reached the daily cap.
 *
 * Deliberately not a stored idempotent result: the condition is time-bounded,
 * so the same Idempotency-Key may retry after `Retry-After` (like the transient
 * `approval_in_progress` rule in 08 §1).
 */
export class ReplanSuppressedError extends Error {
  readonly retryAfterSec: number;
  readonly cause_: 'suppressed' | 'daily_cap';

  constructor(cause: 'suppressed' | 'daily_cap', retryAfterSec: number) {
    super(
      cause === 'suppressed'
        ? 'this replan reason was rejected within the last 24 hours'
        : 'the daily replan proposal limit is reached',
    );
    this.name = 'ReplanSuppressedError';
    this.cause_ = cause;
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterSec));
  }
}
