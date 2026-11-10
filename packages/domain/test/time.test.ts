import {
  MAX_INSTANT_MS,
  MIN_INSTANT_MS,
  ValidationFailedError,
  epochMsToInstant,
  instantToEpochMs,
  isInstant,
  type Instant,
} from '../src/index.js';

test('supported Instant range is 1970-01-01 through 9999-12-31', () => {
  expect(MIN_INSTANT_MS).toBe(0);
  expect(MAX_INSTANT_MS).toBe(253_402_300_799_999);
  expect(epochMsToInstant(MIN_INSTANT_MS)).toBe('1970-01-01T00:00:00.000Z');
  expect(epochMsToInstant(MAX_INSTANT_MS)).toBe('9999-12-31T23:59:59.999Z');
});

test('instant and epoch milliseconds round trip at boundaries', () => {
  const samples = [MIN_INSTANT_MS, 1, Date.UTC(2026, 10, 11, 0, 0, 0, 0), MAX_INSTANT_MS];
  for (const ms of samples) {
    const instant = epochMsToInstant(ms);
    expect(isInstant(instant)).toBe(true);
    expect(instantToEpochMs(instant)).toBe(ms);
  }
});

test('epoch conversion rejects values outside the supported range', () => {
  expect(() => epochMsToInstant(MIN_INSTANT_MS - 1)).toThrow(RangeError);
  expect(() => epochMsToInstant(MAX_INSTANT_MS + 1)).toThrow(RangeError);
  expect(() => epochMsToInstant(Number.NaN)).toThrow(RangeError);
  expect(() => epochMsToInstant(1.5)).toThrow(RangeError);
});

test('instant conversion rejects years before 1970 without early-year misparse', () => {
  expect(isInstant('0099-01-01T00:00:00Z')).toBe(false);
  expect(() => instantToEpochMs('0099-01-01T00:00:00Z' as Instant)).toThrow(
    ValidationFailedError,
  );
  expect(() => instantToEpochMs('1969-12-31T23:59:59.999Z' as Instant)).toThrow(
    ValidationFailedError,
  );
  expect(() => instantToEpochMs('10000-01-01T00:00:00.000Z' as Instant)).toThrow(
    ValidationFailedError,
  );
});
