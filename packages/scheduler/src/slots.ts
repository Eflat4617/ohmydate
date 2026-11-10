import type { Block, ScheduleInput, Slot } from './types.js';
import type { LocalDaySegment } from './time.js';
import {
  DAY_MS,
  alignDownToGrid,
  alignUpToGrid,
  instantToUtc,
  parseInstant,
  partitionByLocalDate,
  projectWindowOnSegment,
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
 * ADR-017: the horizon is partitioned at every IANA offset transition and then
 * at local midnights inside each constant-offset piece. Every resulting
 * segment belongs to exactly one local date, so rules and exceptions are
 * projected with that segment's offset and clipped to the segment. A date may
 * appear in several disjoint segments after a backward transition; all of them
 * contribute.
 *
 * Then: `+ exceptions(extra)`, `- exceptions(off)`, `- commitments
 * - lockedBlocks`. Only intervals that survive horizon clipping and inward
 * 5-minute grid alignment are returned. `validate.ts` implements the ADR-017
 * partition separately: its date/weekday labels come from converting each
 * segment start with Temporal in the target zone (not wall-clock arithmetic),
 * and H2 audits raw local membership.
 */
export function computeAvailableSlots(input: ScheduleInput): Slot[] {
  const horizonStartMs = parseInstant(input.horizon.start);
  const horizonEndMs = parseInstant(input.horizon.end);
  if (horizonEndMs <= horizonStartMs) {
    return [];
  }

  const segments = partitionByLocalDate(
    horizonStartMs,
    horizonEndMs,
    input.timeZone,
  );

  const windows: IntervalMs[] = [];
  for (const segment of segments) {
    const exceptions = exceptionsForDate(input, segment.date);
    if (
      exceptions.some(
        (exception) => exception.kind === 'off' && !hasTimeRange(exception),
      )
    ) {
      continue;
    }

    const dayWindows: IntervalMs[] = [];
    for (const rule of input.availability) {
      if (rule.weekday !== segment.weekday) {
        continue;
      }
      dayWindows.push(
        ...projectWindowOnSegment(segment, rule.startLocal, rule.endLocal),
      );
    }

    for (const exception of exceptions) {
      if (exception.kind !== 'extra') {
        continue;
      }
      dayWindows.push(...intervalsForException(segment, exception));
    }

    const offCuts: IntervalMs[] = [];
    for (const exception of exceptions) {
      if (exception.kind !== 'off') {
        continue;
      }
      offCuts.push(...intervalsForException(segment, exception));
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

function exceptionsForDate(
  input: ScheduleInput,
  date: string,
): WindowException[] {
  return input.exceptions.filter((exception) => exception.date === date);
}

function intervalsForException(
  segment: LocalDaySegment,
  exception: WindowException,
): IntervalMs[] {
  const hasStart = exception.startLocal !== undefined;
  const hasEnd = exception.endLocal !== undefined;
  if (!hasStart && !hasEnd) {
    return [
      {
        startMs: Math.max(segment.startMs, segment.localMidnightMs),
        endMs: Math.min(segment.endMs, segment.localMidnightMs + DAY_MS),
      },
    ].filter((interval) => interval.endMs > interval.startMs);
  }
  if (!hasStart || !hasEnd) {
    return [];
  }
  return projectWindowOnSegment(
    segment,
    exception.startLocal as string,
    exception.endLocal as string,
  );
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
