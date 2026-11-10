import {
  DomainError,
  DependencyCycleError,
  IdempotencyMismatchError,
  CursorInvalidatedError,
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
  VersionConflictError,
  type Id,
  type Version,
} from '../src/index.js';

test('domain errors expose stable codes', () => {
  expect(new NotFoundError('task').code).toBe('not_found');
  expect(new VersionConflictError(3 as Version).code).toBe('version_conflict');
  expect(new ValidationFailedError([{ path: 'title', message: 'required' }]).code).toBe(
    'validation_failed',
  );
  expect(new ProviderUnavailableError('vikunja').code).toBe('provider_unavailable');
  expect(new DependencyCycleError(['a', 'b', 'a'] as Id[]).code).toBe('dependency_cycle');
  expect(new IdempotencyMismatchError().code).toBe('idempotency_mismatch');
  expect(new CursorInvalidatedError().code).toBe('cursor_invalidated');
});

test('all domain errors extend DomainError and Error', () => {
  const errors = [
    new NotFoundError(),
    new VersionConflictError(1 as Version),
    new ValidationFailedError([]),
    new ProviderUnavailableError(),
    new DependencyCycleError([]),
    new IdempotencyMismatchError(),
  ];
  for (const error of errors) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(error.constructor.name);
  }
});

test('version conflict carries expected and actual versions', () => {
  const error = new VersionConflictError(4 as Version, 7 as Version);
  expect(error.expected).toBe(4);
  expect(error.actual).toBe(7);
  expect(error.message).toContain('4');
  expect(error.message).toContain('7');
});

test('validation failure carries issues', () => {
  const error = new ValidationFailedError([{ path: 'priority', message: 'must be 1..4' }]);
  expect(error.issues).toEqual([{ path: 'priority', message: 'must be 1..4' }]);
});

test('dependency cycle carries the cycle path', () => {
  const cycle = ['a', 'b', 'a'] as Id[];
  expect(new DependencyCycleError(cycle).cycle).toBe(cycle);
});
