import {
  assertIanaTimeZone,
  assertInstant,
  assertUuidV7,
  assertVersion,
  isIanaTimeZone,
  isInstant,
  isUuidV7,
  isVersion,
  ValidationFailedError,
} from '../src/index.js';

const V7 = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const V4 = '0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c55';

test('isUuidV7 accepts version 7 and rejects version 4', () => {
  expect(isUuidV7(V7)).toBe(true);
  expect(isUuidV7(V4)).toBe(false);
});

test('isUuidV7 rejects invalid variant bits and malformed strings', () => {
  expect(isUuidV7('0193a8f2-6c1e-7b41-ca2e-1f1d6a0b3c55')).toBe(false);
  expect(isUuidV7('not-a-uuid')).toBe(false);
  expect(isUuidV7(42)).toBe(false);
});

test('assertUuidV7 throws validation_failed with the path', () => {
  expect(() => assertUuidV7(V4, 'task.id')).toThrow(ValidationFailedError);
  try {
    assertUuidV7(V4, 'task.id');
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).code).toBe('validation_failed');
    expect((error as ValidationFailedError).issues[0]?.path).toBe('task.id');
  }
});

test('Instant is an ISO-8601 UTC string', () => {
  expect(isInstant('2026-11-20T14:59:00.000Z')).toBe(true);
  expect(isInstant('2026-11-20T23:59:00+09:00')).toBe(false);
  expect(isInstant('2026-02-30T00:00:00Z')).toBe(false);
  expect(isInstant('2026-11-20T14:59:00')).toBe(false);
  expect(() => assertInstant('2026-11-20T23:59:00+09:00')).toThrow(ValidationFailedError);
});

test('IanaTimeZone uses Intl validation', () => {
  expect(isIanaTimeZone('Asia/Seoul')).toBe(true);
  expect(isIanaTimeZone('UTC')).toBe(true);
  expect(isIanaTimeZone('Mars/Olympus')).toBe(false);
  expect(isIanaTimeZone('')).toBe(false);
  expect(() => assertIanaTimeZone('Mars/Olympus')).toThrow(ValidationFailedError);
});

test('Version is a positive integer', () => {
  expect(isVersion(1)).toBe(true);
  expect(isVersion(0)).toBe(false);
  expect(isVersion(-2)).toBe(false);
  expect(isVersion(1.5)).toBe(false);
  expect(isVersion('1')).toBe(false);
  expect(() => assertVersion(0)).toThrow(ValidationFailedError);
});

test('validators narrow to branded types', () => {
  const id = assertUuidV7(V7);
  const instant = assertInstant('2026-11-20T14:59:00.000Z');
  const timeZone = assertIanaTimeZone('Asia/Seoul');
  const version = assertVersion(3);
  expect([id.length, instant.endsWith('Z'), timeZone, version]).toEqual([36, true, 'Asia/Seoul', 3]);
});
