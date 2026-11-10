import { Temporal } from 'temporal-polyfill';
import type { Instant, IanaTz } from './types.js';

export const GRID_MINUTES = 5;
export const GRID_MS = GRID_MINUTES * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

export interface Clock {
  hour: number;
  minute: number;
}

export interface LocalDaySegment {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  startMs: number;
  endMs: number;
}

export function parseInstant(value: Instant): number {
  return Temporal.Instant.from(value).epochMilliseconds;
}

export function instantToUtc(epochMs: number): Instant {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toString();
}

export function parsePlainDate(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(value);
}

export function instantToZoned(epochMs: number, timeZone: IanaTz): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
}

export function localDateOf(epochMs: number, timeZone: IanaTz): string {
  return instantToZoned(epochMs, timeZone).toPlainDate().toString();
}

/**
 * Parse `HH:mm`. `24:00` is accepted and reported as minute 1440; callers
 * decide whether that means the following midnight.
 */
export function parseClock(value: string): Clock {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new RangeError(`Invalid local clock value: ${value}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) {
    throw new RangeError(`Invalid local clock value: ${value}`);
  }
  if (hour === 24 && minute === 0) {
    return { hour: 24, minute: 0 };
  }
  if (hour < 0 || hour > 23) {
    throw new RangeError(`Invalid local clock value: ${value}`);
  }
  return { hour, minute };
}

export function clockMinutes(clock: Clock): number {
  return clock.hour * 60 + clock.minute;
}

/**
 * Convert a local wall-clock window on a local date into UTC milliseconds.
 *
 * A start that falls in a DST fold selects the earlier occurrence; a start in
 * a gap moves forward to the first valid wall clock. An end uses the later
 * occurrence so a window spanning an autumn fold covers both repetitions.
 */
export function localWindowToMs(
  timeZone: IanaTz,
  date: Temporal.PlainDate,
  startLocal: string,
  endLocal: string,
): { startMs: number; endMs: number } {
  const startClock = parseClock(startLocal);
  const endClock = parseClock(endLocal);

  const startDate = startClock.hour === 24 ? date.add({ days: 1 }) : date;
  const startHour = startClock.hour === 24 ? 0 : startClock.hour;
  const endDate = endClock.hour === 24 ? date.add({ days: 1 }) : date;
  const endHour = endClock.hour === 24 ? 0 : endClock.hour;

  const start = Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: startDate.year,
      month: startDate.month,
      day: startDate.day,
      hour: startHour,
      minute: startClock.minute,
    },
    { disambiguation: 'compatible' },
  );
  const end = Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: endDate.year,
      month: endDate.month,
      day: endDate.day,
      hour: endHour,
      minute: endClock.minute,
    },
    { disambiguation: 'later' },
  );

  return { startMs: start.epochMilliseconds, endMs: end.epochMilliseconds };
}

/** Split a UTC interval at local midnights so daily aggregates stay in local time. */
export function splitByLocalDay(
  startMs: number,
  endMs: number,
  timeZone: IanaTz,
): LocalDaySegment[] {
  const segments: LocalDaySegment[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const zoned = instantToZoned(cursor, timeZone);
    const nextMidnight = zoned.startOfDay().add({ days: 1 }).epochMilliseconds;
    const segmentEnd = Math.min(endMs, nextMidnight);
    segments.push({
      date: zoned.toPlainDate().toString(),
      startMs: cursor,
      endMs: segmentEnd,
    });
    if (segmentEnd <= cursor) {
      break;
    }
    cursor = segmentEnd;
  }
  return segments;
}

export function alignUpToGrid(epochMs: number): number {
  return Math.ceil(epochMs / GRID_MS) * GRID_MS;
}

export function alignDownToGrid(epochMs: number): number {
  return Math.floor(epochMs / GRID_MS) * GRID_MS;
}

export function isGridAligned(epochMs: number): boolean {
  return epochMs % GRID_MS === 0;
}

export function overlapMs(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function isValidTimeZone(timeZone: IanaTz): boolean {
  try {
    Temporal.ZonedDateTime.from({
      timeZone,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    });
    return true;
  } catch {
    return false;
  }
}
