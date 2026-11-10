import { ValidationFailedError } from './errors.js';

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Id = Brand<string, 'Id'>;

/**
 * Instant is represented as an ISO-8601 UTC string ending in `Z`
 * (for example `2026-11-20T14:59:00.000Z`). Offsets are normalised before
 * crossing the domain boundary; the domain never stores epoch milliseconds.
 */
export type Instant = Brand<string, 'Instant'>;

export type IanaTimeZone = Brand<string, 'IanaTimeZone'>;

export type Version = Brand<number, 'Version'>;

/** Lowest supported Instant: 1970-01-01T00:00:00.000Z. */
export const MIN_INSTANT_MS = 0;

/** Highest supported Instant: 9999-12-31T23:59:59.999Z. */
export const MAX_INSTANT_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

const IANA_TIME_ZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
  'Etc/UTC',
]);

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export function isUuidV7(value: unknown): value is Id {
  return typeof value === 'string' && UUID_V7_PATTERN.test(value);
}

export function assertUuidV7(value: unknown, path = 'id'): Id {
  if (!isUuidV7(value)) {
    throw new ValidationFailedError([{ path, message: 'expected a UUIDv7 string' }]);
  }
  return value;
}

export function isInstant(value: unknown): value is Instant {
  if (typeof value !== 'string') return false;
  const match = INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp < MIN_INSTANT_MS || timestamp > MAX_INSTANT_MS) return false;
  const parsed = new Date(timestamp);
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second)
  );
}

export function assertInstant(value: unknown, path = 'instant'): Instant {
  if (!isInstant(value)) {
    throw new ValidationFailedError([
      { path, message: 'expected an ISO-8601 UTC instant ending in Z' },
    ]);
  }
  return value;
}

export function isIanaTimeZone(value: unknown): value is IanaTimeZone {
  return typeof value === 'string' && IANA_TIME_ZONES.has(value);
}

export function assertIanaTimeZone(value: unknown, path = 'timeZone'): IanaTimeZone {
  if (!isIanaTimeZone(value)) {
    throw new ValidationFailedError([
      { path, message: 'expected an IANA time zone identifier' },
    ]);
  }
  return value;
}

export function isVersion(value: unknown): value is Version {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function assertVersion(value: unknown, path = 'version'): Version {
  if (!isVersion(value)) {
    throw new ValidationFailedError([
      { path, message: 'expected a positive integer version' },
    ]);
  }
  return value;
}
