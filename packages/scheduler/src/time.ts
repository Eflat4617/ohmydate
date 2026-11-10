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

export interface WallInterval {
  startMs: number;
  endMs: number;
}

interface OffsetPoint {
  startMs: number;
  offsetMs: number;
}

/**
 * Project a local wall-clock window on one local date into exact UTC
 * intervals.
 *
 * The local date is split into constant-offset segments at every time-zone
 * transition. Intersecting the requested wall window with each segment:
 * - clips nonexistent spring-forward wall time (02:30-03:30 NY on 2026-03-08
 *   becomes 07:00Z-07:30Z), and
 * - preserves both repetitions of autumn-fold wall time as disjoint intervals
 *   (01:15-01:45 NY on 2026-11-01 becomes 05:15Z-05:45Z and 06:15Z-06:45Z).
 *
 * Single-rule overnight windows are intentionally unsupported; callers must
 * split them at midnight (23:00-01:00 => 23:00-24:00 plus 00:00-01:00).
 */
export function projectWallWindowToIntervals(
  timeZone: IanaTz,
  date: Temporal.PlainDate,
  startLocal: string,
  endLocal: string,
): WallInterval[] {
  const startMinute = clockMinutes(parseClock(startLocal));
  const endMinute = clockMinutes(parseClock(endLocal));
  if (endMinute <= startMinute) {
    return [];
  }

  const dayStart = zonedAtLocalMidnight(timeZone, date);
  const dayEnd = zonedAtLocalMidnight(timeZone, date.add({ days: 1 }));
  const offsetPoints = collectOffsetPoints(dayStart, dayEnd.epochMilliseconds);
  const wallMidnight = Temporal.ZonedDateTime.from({
    timeZone: 'UTC',
    year: date.year,
    month: date.month,
    day: date.day,
    hour: 0,
    minute: 0,
  }).epochMilliseconds;

  const intervals: WallInterval[] = [];
  for (let index = 0; index < offsetPoints.length; index += 1) {
    const point = offsetPoints[index];
    const next = offsetPoints[index + 1];
    if (point === undefined || next === undefined) {
      continue;
    }
    const wallStart = (point.startMs + point.offsetMs - wallMidnight) / MINUTE_MS;
    const wallEnd = (next.startMs + point.offsetMs - wallMidnight) / MINUTE_MS;
    const intersectStart = Math.max(startMinute, wallStart);
    const intersectEnd = Math.min(endMinute, wallEnd);
    if (intersectEnd > intersectStart) {
      intervals.push({
        startMs: wallMidnight + intersectStart * MINUTE_MS - point.offsetMs,
        endMs: wallMidnight + intersectEnd * MINUTE_MS - point.offsetMs,
      });
    }
  }

  return mergeWallIntervals(intervals);
}

function zonedAtLocalMidnight(
  timeZone: IanaTz,
  date: Temporal.PlainDate,
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: 0,
      minute: 0,
    },
    { disambiguation: 'compatible' },
  );
}

function collectOffsetPoints(
  dayStart: Temporal.ZonedDateTime,
  dayEndMs: number,
): OffsetPoint[] {
  const points: OffsetPoint[] = [
    { startMs: dayStart.epochMilliseconds, offsetMs: offsetMsOf(dayStart) },
  ];
  let cursor = dayStart;
  for (let guard = 0; guard < 16; guard += 1) {
    const transition = cursor.getTimeZoneTransition('next');
    if (transition === null || transition.epochMilliseconds >= dayEndMs) {
      break;
    }
    points.push({
      startMs: transition.epochMilliseconds,
      offsetMs: offsetMsOf(transition),
    });
    cursor = transition;
  }
  points.push({ startMs: dayEndMs, offsetMs: points[points.length - 1]?.offsetMs ?? 0 });
  return points;
}

function offsetMsOf(zoned: Temporal.ZonedDateTime): number {
  return Math.trunc(zoned.offsetNanoseconds / 1_000_000);
}

function mergeWallIntervals(intervals: WallInterval[]): WallInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: WallInterval[] = [];
  for (const interval of sorted) {
    if (interval.endMs <= interval.startMs) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ startMs: interval.startMs, endMs: interval.endMs });
    }
  }
  return merged;
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
