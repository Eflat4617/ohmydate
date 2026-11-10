import { Temporal } from 'temporal-polyfill';
import type { Block, ScheduleInput } from '../src/index.js';

const MINUTE_MS = 60 * 1000;

interface LocalMinute {
  date: string;
  weekday: number;
  minuteOfDay: number;
}

function instantMs(value: string): number {
  return Temporal.Instant.from(value).epochMilliseconds;
}

function localMinute(epochMs: number, timeZone: string): LocalMinute {
  const zoned = Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone);
  return {
    date: zoned.toPlainDate().toString(),
    weekday: zoned.dayOfWeek,
    minuteOfDay: zoned.hour * 60 + zoned.minute,
  };
}

function clockMinutes(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) {
    return undefined;
  }
  return hour * 60 + minute;
}

function rangeContains(
  startLocal: string | undefined,
  endLocal: string | undefined,
  minuteOfDay: number,
): boolean {
  const start = clockMinutes(startLocal);
  const end = clockMinutes(endLocal);
  if (start === undefined || end === undefined || end <= start) {
    return false;
  }
  return minuteOfDay >= start && minuteOfDay < end;
}

/**
 * The packet's independent oracle: classify one UTC minute by converting it to
 * a local PlainDateTime and testing raw local rule membership. It shares no
 * splitting logic with production code.
 */
export function isMinuteLocallyAvailable(
  input: ScheduleInput,
  epochMs: number,
): boolean {
  const local = localMinute(epochMs, input.timeZone);
  const exceptions = input.exceptions.filter(
    (exception) => exception.date === local.date,
  );
  if (
    exceptions.some(
      (exception) =>
        exception.kind === 'off' &&
        exception.startLocal === undefined &&
        exception.endLocal === undefined,
    )
  ) {
    return false;
  }

  const fromRule = input.availability.some(
    (rule) =>
      rule.weekday === local.weekday &&
      rangeContains(rule.startLocal, rule.endLocal, local.minuteOfDay),
  );
  const fromExtra = exceptions.some(
    (exception) =>
      exception.kind === 'extra' &&
      (exception.startLocal === undefined &&
      exception.endLocal === undefined
        ? true
        : rangeContains(
            exception.startLocal,
            exception.endLocal,
            local.minuteOfDay,
          )),
  );
  const fromOff = exceptions.some(
    (exception) =>
      exception.kind === 'off' &&
      exception.startLocal !== undefined &&
      exception.endLocal !== undefined &&
      rangeContains(
        exception.startLocal,
        exception.endLocal,
        local.minuteOfDay,
      ),
  );
  return (fromRule || fromExtra) && !fromOff;
}

/** True when every whole UTC minute of `[startMs, endMs)` is locally available. */
export function isCoveredByMinutes(
  input: ScheduleInput,
  startMs: number,
  endMs: number,
): boolean {
  for (let cursor = startMs; cursor < endMs; cursor += MINUTE_MS) {
    if (!isMinuteLocallyAvailable(input, cursor)) {
      return false;
    }
  }
  return true;
}

/** Count every locally available minute in a block that is not blocked. */
export function availableSlotMinutes(input: ScheduleInput): number {
  const horizonStartMs = instantMs(input.horizon.start);
  const horizonEndMs = instantMs(input.horizon.end);
  const blocked = [
    ...input.commitments,
    ...input.lockedBlocks,
  ].map((block) => ({
    startMs: instantMs(block.start),
    endMs: instantMs(block.end),
  }));

  let total = 0;
  for (let cursor = horizonStartMs; cursor < horizonEndMs; cursor += MINUTE_MS) {
    if (!isMinuteLocallyAvailable(input, cursor)) {
      continue;
    }
    const blockedHere = blocked.some(
      (block) => cursor >= block.startMs && cursor < block.endMs,
    );
    if (!blockedHere) {
      total += 1;
    }
  }
  return total;
}

/**
 * Minute-walk slot total including the public inward 5-minute grid contract.
 * Contiguous available minutes are grouped into UTC runs first, then each run
 * is aligned inward exactly like `computeAvailableSlots`. Date partitioning is
 * still derived solely from the one-minute local-time walk.
 */
export function alignedAvailableSlotMinutes(input: ScheduleInput): number {
  const horizonStartMs = instantMs(input.horizon.start);
  const horizonEndMs = instantMs(input.horizon.end);
  const gridMs = 5 * MINUTE_MS;
  const blocked = [
    ...input.commitments,
    ...input.lockedBlocks,
  ].map((block) => ({
    startMs: instantMs(block.start),
    endMs: instantMs(block.end),
  }));

  const runs: Array<{ startMs: number; endMs: number }> = [];
  let runStart: number | undefined;
  for (let cursor = horizonStartMs; cursor < horizonEndMs; cursor += MINUTE_MS) {
    const blockedHere = blocked.some(
      (block) => cursor >= block.startMs && cursor < block.endMs,
    );
    const available = isMinuteLocallyAvailable(input, cursor) && !blockedHere;
    if (available && runStart === undefined) {
      runStart = cursor;
    } else if (!available && runStart !== undefined) {
      runs.push({ startMs: runStart, endMs: cursor });
      runStart = undefined;
    }
  }
  if (runStart !== undefined) {
    runs.push({ startMs: runStart, endMs: horizonEndMs });
  }

  const aligned = runs
    .map((run) => ({
      startMs: Math.ceil(run.startMs / gridMs) * gridMs,
      endMs: Math.floor(run.endMs / gridMs) * gridMs,
    }))
    .filter((run) => run.endMs > run.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const run of aligned) {
    const last = merged[merged.length - 1];
    if (last !== undefined && run.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, run.endMs);
    } else {
      merged.push({ ...run });
    }
  }

  return merged.reduce(
    (total, run) => total + (run.endMs - run.startMs) / MINUTE_MS,
    0,
  );
}

/** Aggregate block minutes by local date with a one-minute UTC walk. */
export function dailyLoadsByMinute(
  blocks: Block[],
  timeZone: string,
): Map<string, number> {
  const loads = new Map<string, number>();
  for (const block of blocks) {
    const blockEndMs = instantMs(block.end);
    for (let cursor = instantMs(block.start); cursor < blockEndMs; cursor += MINUTE_MS) {
      const date = localMinute(cursor, timeZone).date;
      loads.set(date, (loads.get(date) ?? 0) + 1);
    }
  }
  return loads;
}

export function hasDailyCapViolationByMinute(
  input: ScheduleInput,
  blocks: Block[],
): boolean {
  for (const minutes of dailyLoadsByMinute(blocks, input.timeZone).values()) {
    if (minutes > input.prefs.maxDailyFocusMin) {
      return true;
    }
  }
  return false;
}
