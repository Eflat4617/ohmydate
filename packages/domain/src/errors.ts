import type { Id, Version } from './brand.js';

export type DomainErrorCode =
  | 'not_found'
  | 'version_conflict'
  | 'validation_failed'
  | 'provider_unavailable'
  | 'dependency_cycle'
  | 'idempotency_mismatch'
  | 'cursor_invalidated';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found' as const;

  constructor(resource = 'resource', id?: string) {
    super(id === undefined ? `${resource} not found` : `${resource} not found: ${id}`);
  }
}

export class VersionConflictError extends DomainError {
  readonly code = 'version_conflict' as const;
  readonly expected: Version;

  constructor(expected: Version, readonly actual?: Version) {
    super(
      actual === undefined
        ? `expected version ${expected}`
        : `expected version ${expected} but found ${actual}`,
    );
    this.expected = expected;
  }
}

export class ValidationFailedError extends DomainError {
  readonly code = 'validation_failed' as const;

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`validation failed: ${issues.map((issue) => issue.path).join(', ')}`);
  }
}

export class ProviderUnavailableError extends DomainError {
  readonly code = 'provider_unavailable' as const;

  /**
   * Non-secret cause discriminator (for example `provider_auth`). It is safe
   * to surface in problem details and logs; never put tokens or bodies here.
   */
  constructor(
    readonly provider?: string,
    readonly reason?: string,
  ) {
    const base = provider === undefined ? 'provider unavailable' : `provider unavailable: ${provider}`;
    super(reason === undefined ? base : `${base} (${reason})`);
  }
}

export class DependencyCycleError extends DomainError {
  readonly code = 'dependency_cycle' as const;

  constructor(readonly cycle: readonly Id[]) {
    super(`dependency cycle detected: ${cycle.join(' -> ')}`);
  }
}

export class IdempotencyMismatchError extends DomainError {
  readonly code = 'idempotency_mismatch' as const;

  constructor(message = 'idempotency key reused with a different request body') {
    super(message);
  }
}

/**
 * A change-feed cursor can no longer be honoured (e.g. issued by a previous adapter
 * instance/epoch or compacted history). Consumers must perform a full resync by calling
 * listChangedSince(ownerId, null) and reconciling all returned tasks. Internal only: not an
 * HTTP problem code.
 */
export class CursorInvalidatedError extends DomainError {
  readonly code = 'cursor_invalidated' as const;

  constructor(message = 'change cursor is no longer valid; full resync required') {
    super(message);
  }
}
