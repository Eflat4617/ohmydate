import { Temporal } from 'temporal-polyfill';
import type { Block, ScheduleInput, Slot } from './types.js';
import {
  alignDownToGrid,
  alignUpToGrid,
  instantToUtc,
  localWindowToMs,
  parseInstant,
} from './time.js';

interface IntervalMs {
  startMs: number;
  endMs: number;
}

interface WindowException {
  date: string;
  kind: 'off' | 'extra';
  startLocal?: string;
  endLocal?: string;
}

function compareIntervals(a: IntervalMs, b: IntervalMs): number {
  return a.startMs - b.startMs || a.endMs - b.endMs;
}

function mergeIntervals(intervals: IntervalMs[]): IntervalMs[] {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort(compareIntervals);
  const merged: IntervalMs[] = [];
  for (const current of sorted) {
    if (current.endMs <= current.startMs) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (last !== undefined && current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ startMs: current.startMs, endMs: current.endMs });
    }
  }
  return merged;
}

function subtractIntervals(bases: IntervalMs[], cuts: IntervalMs[]): IntervalMs[] {
  const mergedCuts = mergeIntervals(cuts);
  if (mergedCuts.length === 0) {
    return mergeIntervals(bases);
  }
  const result: IntervalMs[] = [];
  for (const base of mergeIntervals(bases)) {
    let cursor = base.startMs;
    for (const cut of mergedCuts) {
      if (cut.endMs <= cursor || cut.startMs >= base.endMs) {
        continue;
      }
      if (cut.startMs > cursor) {
        result.push({ startMs: cursor, endMs: Math.min(cut.startMs, base.endMs) });
      }
      cursor = Math.max(cursor, cut.endMs);
      if (cursor >= base.endMs) {
        break;
      }
    }
    if (cursor < base.endMs) {
      result.push({ startMs: cursor, endMs: base.endMs });
    }
  }
  return result;
}

function clipIntervals(
  intervals: IntervalMs[],
  startMs: number,
  endMs: number,
): IntervalMs[] {
  return mergeIntervals(
    intervals
      .map((interval) => ({
        startMs: Math.max(startMs, interval.startMs),
        endMs: Math.min(endMs, interval.endMs),
      }))
      .filter((interval) => interval.endMs > interval.startMs),
  );
}

function alignIntervals(intervals: IntervalMs[]): IntervalMs[] {
  return mergeIntervals(
    intervals
      .map((interval) => ({
        startMs: alignUpToGrid(interval.startMs),
        endMs: alignDownToGrid(interval.endMs),
      }))
      .filter((interval) => interval.endMs > interval.startMs),
  );
}

function fullDayWindow(
  input: ScheduleInput,
  date: Temporal.PlainDate,
): IntervalMs {
  return localWindowToMs(input.timeZone, date, '00:00', '24:00');
}

function exceptionsForDate(input: ScheduleInput, date: string): WindowException[] {
  return input.exceptions.filter((exception) => exception.date === date);
}

function intervalForException(
  input: ScheduleInput,
  date: Temporal.PlainDate,
  exception: WindowException,
): IntervalMs | undefined {
  const hasStart = exception.startLocal !== undefined;
  const hasEnd = exception.endLocal !== undefined;
  if (!hasStart && !hasEnd) {
    return fullDayWindow(input, date);
  }
  if (!hasStart || !hasEnd) {
    return undefined;
  }
  const interval = localWindowToMs(
    input.timeZone,
    date,
    exception.startLocal as string,
    exception.endLocal as string,
  );
  return interval.endMs > interval.startMs ? interval : undefined;
}

function cutIntervalsOf(blocks: Array<Pick<Block, 'start' | 'end'>>): IntervalMs[] {
  const cuts: IntervalMs[] = [];
  for (const block of blocks) {
    const startMs = parseInstant(block.start);
    const endMs = parseInstant(block.end);
    if (endMs > startMs) {
      cuts.push({ startMs, endMs });
    }
  }
  return cuts;
}

/**
 * Compute merged, UTC availability intervals for the horizon.
 *
 * A day is built from weekly availability rules, then:
 * `+ exceptions(extra)`, `- exceptions(off)`, `- commitments - lockedBlocks`.
 * Only intervals that survive horizon clipping and inward 5-minute grid
 * alignment are returned. The implementation walks days and subtracts
 * interval sets; `validate.ts` deliberately audits using point checks instead.
 */
export function computeAvailableSlots(input: ScheduleInput): Slot[] {
  const horizonStartMs = parseInstant(input.horizon.start);
  const horizonEndMs = parseInstant(input.horizon.end);
  if (horizonEndMs <= horizonStartMs) {
    return [];
  }

  const firstDate = Temporal.Instant.fromEpochMilliseconds(horizonStartMs)
    .toZonedDateTimeISO(input.timeZone)
    .toPlainDate();
  const lastDate = Temporal.Instant.fromEpochMilliseconds(horizonEndMs)
    .toZonedDateTimeISO(input.timeZone)
    .toPlainDate();

  const windows: IntervalMs[] = [];
  for (
    let date = firstDate;
    Temporal.PlainDate.compare(date, lastDate) <= 0;
    date = date.add({ days: 1 })
  ) {
    const dateString = date.toString();
    const exceptions = exceptionsForDate(input, dateString);
    if (exceptions.some((exception) => exception.kind === 'off' && !hasTimeRange(exception))) {
      continue;
    }

    const dayWindows: IntervalMs[] = [];
    for (const rule of input.availability) {
      if (rule.weekday !== date.dayOfWeek) {
        continue;
      }
      const window = localWindowToMs(
        input.timeZone,
        date,
        rule.startLocal,
        rule.endLocal,
      );
      if (window.endMs > window.startMs) {
        dayWindows.push(window);
      }
    }

    for (const exception of exceptions) {
      if (exception.kind !== 'extra') {
        continue;
      }
      const window = intervalForException(input, date, exception);
      if (window !== undefined) {
        dayWindows.push(window);
      }
    }

    const offCuts: IntervalMs[] = [];
    for (const exception of exceptions) {
      if (exception.kind !== 'off') {
        continue;
      }
      const window = intervalForException(input, date, exception);
      if (window !== undefined) {
        offCuts.push(window);
      }
    }

    windows.push(...subtractIntervals(dayWindows, offCuts));
  }

  const blockedCuts = [
    ...cutIntervalsOf(input.commitments),
    ...cutIntervalsOf(input.lockedBlocks),
  ];

  const available = subtractIntervals(windows, blockedCuts);
  const clipped = clipIntervals(available, horizonStartMs, horizonEndMs);
  const aligned = alignIntervals(clipped);

  return aligned.map((interval) => ({
    start: instantToUtc(interval.startMs),
    end: instantToUtc(interval.endMs),
  }));
}

function hasTimeRange(exception: WindowException): boolean {
  return exception.startLocal !== undefined || exception.endLocal !== undefined;
}

export function slotTotalMin(slots: Slot[]): number {
  return slots.reduce(
    (total, slot) =>
      total + (parseInstant(slot.end) - parseInstant(slot.start)) / 60000,
    0,
  );
}

export function maxContiguousMin(slots: Slot[]): number {
  let maximum = 0;
  for (const slot of slots) {
    const minutes =
      (parseInstant(slot.end) - parseInstant(slot.start)) / 60000;
    maximum = Math.max(maximum, minutes);
  }
  return maximum;
}
