import { ValidationFailedError, type Instant } from '@ohmydate/domain';
import { normalizeRemoteInstant } from '../../src/time.js';
import { validateInstant, validateTaskCreate } from '../../src/validation.js';

describe('timestamp validation', () => {
  test('normalises an offset instant to UTC', () => {
    expect(validateInstant('2026-11-20T23:59:00+09:00')).toBe(
      '2026-11-20T14:59:00.000Z',
    );
  });

  test('rejects timezone-less and impossible calendar dates', () => {
    expect(() => validateInstant('2026-11-20T14:59:00')).toThrow(ValidationFailedError);
    expect(() => validateInstant('2026-02-30T00:00:00Z')).toThrow(
      ValidationFailedError,
    );
  });

  test('create validation rejects an impossible due date before any HTTP call', () => {
    expect(() =>
      validateTaskCreate({
        title: 'Impossible',
        dueAt: '2026-02-30T00:00:00Z' as Instant,
      }),
    ).toThrow(ValidationFailedError);
  });

  test('treats Vikunja zero dates as absent', () => {
    expect(normalizeRemoteInstant('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(normalizeRemoteInstant('2026-11-20T14:59:00Z')).toBe(
      '2026-11-20T14:59:00.000Z',
    );
  });
});
