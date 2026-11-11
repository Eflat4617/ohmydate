import type { ProblemCode } from '@ohmydate/contracts';

/**
 * M4 transport/domain failures that are not represented by the shared domain
 * error classes. The HTTP layer maps them to stable problem+json codes.
 */
export class DailyProblemError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail: string | undefined;

  constructor(init: {
    readonly status: number;
    readonly code: ProblemCode;
    readonly title: string;
    readonly detail?: string;
  }) {
    super(init.detail ?? init.title);
    this.name = 'DailyProblemError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
  }
}

export function activeSessionExists(): DailyProblemError {
  return new DailyProblemError({
    status: 409,
    code: 'active_session_exists',
    title: 'Active session exists',
    detail: 'an owner can have at most one active focus session',
  });
}

export function sessionStateConflict(detail: string): DailyProblemError {
  return new DailyProblemError({
    status: 409,
    code: 'session_state_conflict',
    title: 'Session state conflict',
    detail,
  });
}

export function proposalConflict(detail: string): DailyProblemError {
  return new DailyProblemError({
    status: 409,
    code: 'illegal_transition',
    title: 'State conflict',
    detail,
  });
}
