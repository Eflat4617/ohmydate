/**
 * The day timetable on Today: one row per hour, six ten-minute cells in a
 * row, and each block drawn as a highlighted run over the cells it covers.
 *
 * Pure geometry. A run is a pair of fractions of its hour (0..1), so a block
 * that starts at 19:05 is drawn from where it really starts, not snapped to
 * a cell. Wall-clock minutes come from `localParts`, in the day's IANA zone.
 */
import { localParts } from './time';

/** The page starts at 06:00 unless a block starts earlier. */
export const TIMETABLE_FIRST_HOUR = 6;
/** Highlighters used for blocks that are not the next one (series 1..n). */
export const TIMETABLE_OTHER_SERIES = 3;
/** A finished block is marked in mint, the colour for done everywhere else. */
export const TIMETABLE_DONE_SERIES = 4;

export interface TimetableBlock {
  readonly id: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status?: string;
}

/** One highlighted run inside one hour row. */
export interface TimetableRun {
  readonly blockId: string;
  readonly series: number;
  /** Fractions of the hour, `0 <= from < to <= 1`. */
  readonly from: number;
  readonly to: number;
}

/**
 * Time that is taken but is not planned work (a 약속, CAL-01): drawn as its
 * own mark under the block runs, never in a block's highlighter.
 */
export interface TimetableTakenRun {
  readonly id: string;
  /** Fractions of the hour, `0 <= from < to <= 1`. */
  readonly from: number;
  readonly to: number;
}

export interface TimetableRow {
  readonly hour: number;
  readonly runs: readonly TimetableRun[];
  /** 약속 on this hour (empty unless `taken` spans were given). */
  readonly taken: readonly TimetableTakenRun[];
}

/** Where "now" falls on the page: the hour row and the fraction inside it. */
export interface TimetableNow {
  readonly hour: number;
  readonly at: number;
}

const MINUTES_PER_DAY = 24 * 60;

function isInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Minutes since local midnight of `date`, clipped to that day. `null` when
 * the instant cannot belong to the day at all (a start after it, an end
 * before it).
 */
function minutesOnDate(instant: string, date: string, timeZone: string, edge: 'start' | 'end'): number | null {
  const parts = localParts(instant, timeZone);
  if (parts.date === date) return parts.minutes;
  if (parts.date < date) return edge === 'start' ? 0 : null;
  return edge === 'end' ? MINUTES_PER_DAY : null;
}

/** The part of a block that lies on `date`, in minutes since local midnight. */
function spanOnDate(block: TimetableBlock, date: string, timeZone: string): readonly [number, number] | null {
  if (!isInstant(block.startAt) || !isInstant(block.endAt)) return null;
  if (Date.parse(block.endAt) <= Date.parse(block.startAt)) return null;
  const start = minutesOnDate(block.startAt, date, timeZone, 'start');
  const end = minutesOnDate(block.endAt, date, timeZone, 'end');
  if (start === null || end === null || end <= start) return null;
  return [start, end];
}

/**
 * Which highlighter each block takes. The next block is always series 0
 * (yellow, the "current" mark) and a finished one is the done series (mint);
 * the others cycle through series 1..n in the order given, so a row in the
 * list and its run on the page share a colour.
 */
export function blockSeries(
  blocks: readonly { readonly id: string; readonly status?: string }[],
  nextBlockId: string | null,
): ReadonlyMap<string, number> {
  const series = new Map<string, number>();
  let others = 0;
  for (const block of blocks) {
    if (block.id === nextBlockId) {
      series.set(block.id, 0);
    } else if (block.status === 'done') {
      series.set(block.id, TIMETABLE_DONE_SERIES);
    } else {
      series.set(block.id, 1 + (others % TIMETABLE_OTHER_SERIES));
      others += 1;
    }
  }
  return series;
}

interface MinuteSpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

function spansOnDate(items: readonly TimetableBlock[], date: string, timeZone: string): MinuteSpan[] {
  const spans: MinuteSpan[] = [];
  for (const item of items) {
    const span = spanOnDate(item, date, timeZone);
    if (span !== null) spans.push({ id: item.id, start: span[0], end: span[1] });
  }
  return spans;
}

/** The part of `span` inside the hour that starts at `rowStart`, as fractions of it. */
function clipToHour(span: MinuteSpan, rowStart: number): { from: number; to: number } | null {
  const from = Math.max(span.start, rowStart);
  const to = Math.min(span.end, rowStart + 60);
  if (to <= from) return null;
  return { from: (from - rowStart) / 60, to: (to - rowStart) / 60 };
}

/**
 * Hour rows of `date` (to midnight) with the runs each block leaves on them,
 * and, when `taken` is given, the 약속 of the day as their own marks. Both
 * start the page early when they start before 06:00.
 */
export function dayTimetable(
  blocks: readonly TimetableBlock[],
  date: string,
  timeZone: string,
  nextBlockId: string | null,
  taken: readonly TimetableBlock[] = [],
): readonly TimetableRow[] {
  const series = blockSeries(blocks, nextBlockId);
  const spans = spansOnDate(blocks, date, timeZone);
  const takenSpans = spansOnDate(taken, date, timeZone);

  const earliest = [...spans, ...takenSpans].reduce(
    (min, span) => Math.min(min, Math.floor(span.start / 60)),
    TIMETABLE_FIRST_HOUR,
  );
  const rows: TimetableRow[] = [];
  for (let hour = earliest; hour < 24; hour += 1) {
    const rowStart = hour * 60;
    const runs: TimetableRun[] = [];
    for (const span of spans) {
      const part = clipToHour(span, rowStart);
      if (part !== null) runs.push({ blockId: span.id, series: series.get(span.id) ?? 1, ...part });
    }
    const takenRuns: TimetableTakenRun[] = [];
    for (const span of takenSpans) {
      const part = clipToHour(span, rowStart);
      if (part !== null) takenRuns.push({ id: span.id, ...part });
    }
    rows.push({ hour, runs, taken: takenRuns });
  }
  return rows;
}

/** The "now" mark, or `null` when now is not on `date` (or before the first row). */
export function timetableNow(nowMs: number, date: string, timeZone: string, firstHour: number): TimetableNow | null {
  if (!Number.isFinite(nowMs)) return null;
  const parts = localParts(new Date(nowMs).toISOString(), timeZone);
  if (parts.date !== date) return null;
  const hour = Math.floor(parts.minutes / 60);
  if (hour < firstHour) return null;
  return { hour, at: (parts.minutes - hour * 60) / 60 };
}
