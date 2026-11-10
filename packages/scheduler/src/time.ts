import { Temporal } from 'temporal-polyfill';
import type { Instant, IanaTz } from './types.js';

export const GRID_MINUTES = 5;
export const GRID_MS = GRID_MINUTES * 60 * 1000;
export const GRID_NS = 300_000_000_000n;
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** Hard cap for the transition walk; a runaway walk is a programming error. */
export const MAX_TRANSITIONS = 4096;

export interface Clock {
  hour: number;
  minute: number;
}

/**
 * A UTC interval that maps to exactly one local calendar date. ADR-017
 * produces these by splitting at every offset transition (constant offset
 * pieces) and every local midnight inside a piece (using that piece's offset).
 */
export interface LocalDaySegment {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** ISO weekday of `date`, Monday = 1 ... Sunday = 7. */
  weekday: number;
  /** UTC offset in milliseconds in effect for the whole segment. */
  offsetMs: number;
  startMs: number;
  endMs: number;
  /**
   * UTC instant of this local date's midnight under `offsetMs`. It is a
   * virtual instant for skipped midnights, but local clock arithmetic
   * (`localMidnightMs + minute * MINUTE_MS`) stays exact inside the segment.
   */
  localMidnightMs: number;
}

export function instantNanoseconds(value: Instant): bigint {
  return Temporal.Instant.from(value).epochNanoseconds;
}

export function parseInstant(value: Instant): number {
  const nanoseconds = instantNanoseconds(value);
  if (nanoseconds % 1_000_000n !== 0n) {
    throw new RangeError(`Instant has sub-millisecond precision: ${value}`);
  }
  return Number(nanoseconds / 1_000_000n);
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

interface ConstantOffsetPiece {
  startMs: number;
  endMs: number;
  offsetMs: number;
}

function offsetMsAt(epochMs: number, timeZone: IanaTz): number {
  return Math.trunc(
    Temporal.Instant.fromEpochMilliseconds(epochMs)
      .toZonedDateTimeISO(timeZone).offsetNanoseconds / 1_000_000,
  );
}

/**
 * ADR-017 steps 1-2: split `[startMs, endMs)` at every IANA offset transition,
 * then split each constant-offset piece at local midnights computed with that
 * piece's offset. Every returned segment lies on exactly one local date, and
 * the same date may appear in several disjoint segments after a backward
 * transition.
 */
export function partitionByLocalDate(
  startMs: number,
  endMs: number,
  timeZone: IanaTz,
): LocalDaySegment[] {
  if (endMs <= startMs) {
    return [];
  }

  const boundaries: number[] = [startMs];
  let cursor = instantToZoned(startMs, timeZone);
  for (let guard = 0; ; guard += 1) {
    if (guard >= MAX_TRANSITIONS) {
      throw new RangeError(
        `Time zone transition walk exceeded ${MAX_TRANSITIONS} steps for ${timeZone}.`,
      );
    }
    const transition = cursor.getTimeZoneTransition('next');
    if (transition === null) {
      break;
    }
    const transitionMs = transition.epochMilliseconds;
    if (transitionMs >= endMs) {
      break;
    }
    if (transitionMs > startMs) {
      boundaries.push(transitionMs);
    }
    cursor = transition;
  }
  boundaries.push(endMs);
  boundaries.sort((a, b) => a - b);

  const segments: LocalDaySegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const pieceStart = boundaries[index];
    const pieceEnd = boundaries[index + 1];
    if (pieceStart === undefined || pieceEnd === undefined || pieceEnd <= pieceStart) {
      continue;
    }
    const piece: ConstantOffsetPiece = {
      startMs: pieceStart,
      endMs: pieceEnd,
      offsetMs: offsetMsAt(pieceStart, timeZone),
    };
    for (const segment of splitPieceAtLocalMidnights(piece)) {
      segments.push(segment);
    }
  }
  return segments;
}

function splitPieceAtLocalMidnights(
  piece: ConstantOffsetPiece,
): LocalDaySegment[] {
  const localStartMs = piece.startMs + piece.offsetMs;
  let nextLocalMidnightMs =
    (Math.floor(localStartMs / DAY_MS) + 1) * DAY_MS;

  const boundaries: number[] = [piece.startMs];
  while (nextLocalMidnightMs - piece.offsetMs < piece.endMs) {
    const midnightMs = nextLocalMidnightMs - piece.offsetMs;
    if (midnightMs > piece.startMs) {
      boundaries.push(midnightMs);
    }
    nextLocalMidnightMs += DAY_MS;
  }
  boundaries.push(piece.endMs);

  const segments: LocalDaySegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    if (startMs === undefined || endMs === undefined || endMs <= startMs) {
      continue;
    }
    const localMidnightMs =
      Math.floor((startMs + piece.offsetMs) / DAY_MS) * DAY_MS -
      piece.offsetMs;
    const wall = Temporal.Instant.fromEpochMilliseconds(
      startMs + piece.offsetMs,
    ).toZonedDateTimeISO('UTC');
    segments.push({
      date: wall.toPlainDate().toString(),
      weekday: wall.dayOfWeek,
      offsetMs: piece.offsetMs,
      startMs,
      endMs,
      localMidnightMs,
    });
  }
  return segments;
}

/**
 * Project a local wall-clock window on a segment's own local date into UTC and
 * intersect it with the segment. Local clock arithmetic is linear because the
 * segment has a constant offset; transitions were already handled by the
 * partition.
 */
export function projectWindowOnSegment(
  segment: LocalDaySegment,
  startLocal: string,
  endLocal: string,
): Array<{ startMs: number; endMs: number }> {
  const startMinute = clockMinutes(parseClock(startLocal));
  const endMinute = clockMinutes(parseClock(endLocal));
  if (endMinute <= startMinute) {
    return [];
  }
  const startMs = Math.max(
    segment.startMs,
    segment.localMidnightMs + startMinute * MINUTE_MS,
  );
  const endMs = Math.min(
    segment.endMs,
    segment.localMidnightMs + endMinute * MINUTE_MS,
  );
  return endMs > startMs ? [{ startMs, endMs }] : [];
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
