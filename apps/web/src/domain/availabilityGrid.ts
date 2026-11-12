/**
 * Weekly availability grid (FU-97): the model behind the 월–일 × 30-minute
 * editor in AvailabilityView.
 *
 * The draft's `rules` stay the single source of truth. A day is read as a
 * minute-precise list of non-overlapping intervals, so a rule that is not on
 * the 30-minute grid (the API allows any HH:mm) keeps its exact edges until
 * the user paints over that part of the day. Painting rewrites only the
 * painted weekday's rules; every other weekday keeps its original rule
 * objects, order and values.
 */
import type { AvailabilityRule } from '../api';

export type AvailabilityKind = AvailabilityRule['kind'];
export type Brush = AvailabilityKind | 'erase';

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const SLOT_MINUTES = 30;
export const DAY_MINUTES = 24 * 60;
export const SLOTS_PER_DAY = DAY_MINUTES / SLOT_MINUTES;
/** First slot of the default view (06:00); earlier slots show on demand. */
export const DEFAULT_FIRST_SLOT = (6 * 60) / SLOT_MINUTES;

export interface DayInterval {
  /** Minutes from local midnight, inclusive. */
  start: number;
  /** Minutes from local midnight, exclusive; 1440 is `24:00`. */
  end: number;
  kind: AvailabilityKind;
}

export interface CellState {
  /** Covering kind: the one with most minutes in the cell (focus on a tie). */
  kind: AvailabilityKind | null;
  /** Minutes of the cell covered by any availability (0..30). */
  covered: number;
  /** The whole cell is one kind. */
  full: boolean;
}

const CLOCK = /^(\d{2}):(\d{2})$/;

/** Minutes from midnight of `HH:mm` (`24:00` → 1440), or `null` when malformed. */
export function parseClock(value: string): number | null {
  const match = CLOCK.exec(value);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours === 24 && minutes === 0) return DAY_MINUTES;
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

/** `HH:mm` of minutes from midnight; 1440 is written `24:00`. */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** Precedence where two rules overlap: focus is the narrower promise. */
function rank(kind: AvailabilityKind): number {
  return kind === 'focus' ? 2 : 1;
}

/**
 * The weekday's rules as sorted, non-overlapping, merged intervals. Where
 * rules overlap the union is kept; a focus rule wins over a work rule on the
 * overlapping minutes. Malformed or empty rules are skipped.
 */
export function dayIntervals(rules: readonly AvailabilityRule[], weekday: number): DayInterval[] {
  const ranked: DayInterval[] = [];
  for (const rule of rules) {
    if (rule.weekday !== weekday) continue;
    const start = parseClock(rule.startLocal);
    const end = parseClock(rule.endLocal);
    if (start === null || end === null) continue;
    const from = Math.max(0, start);
    const to = Math.min(DAY_MINUTES, end);
    if (to <= from) continue;
    ranked.push({ start: from, end: to, kind: rule.kind });
  }
  if (ranked.length === 0) return [];
  const points = [...new Set(ranked.flatMap((interval) => [interval.start, interval.end]))].sort(
    (left, right) => left - right,
  );
  const pieces: DayInterval[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index] as number;
    const end = points[index + 1] as number;
    let kind: AvailabilityKind | null = null;
    for (const interval of ranked) {
      if (interval.start <= start && interval.end >= end && (kind === null || rank(interval.kind) > rank(kind))) {
        kind = interval.kind;
      }
    }
    if (kind !== null) pieces.push({ start, end, kind });
  }
  return mergeIntervals(pieces);
}

function mergeIntervals(intervals: readonly DayInterval[]): DayInterval[] {
  const merged: DayInterval[] = [];
  for (const interval of [...intervals].sort((left, right) => left.start - right.start)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.kind === interval.kind && last.end >= interval.start) {
      last.end = Math.max(last.end, interval.end);
    } else if (interval.end > interval.start) {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Sets `[start, end)` of a day to `kind`, or clears it when `kind` is `null`. */
export function paintInterval(
  intervals: readonly DayInterval[],
  start: number,
  end: number,
  kind: AvailabilityKind | null,
): DayInterval[] {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(DAY_MINUTES, Math.max(start, end));
  const kept: DayInterval[] = [];
  for (const interval of intervals) {
    if (interval.end <= from || interval.start >= to) {
      kept.push({ ...interval });
      continue;
    }
    if (interval.start < from) kept.push({ ...interval, end: from });
    if (interval.end > to) kept.push({ ...interval, start: to });
  }
  if (kind !== null && to > from) kept.push({ start: from, end: to, kind });
  return mergeIntervals(kept);
}

/** Paints whole slots `fromSlot..toSlot` (inclusive, either order). */
export function paintSlots(
  intervals: readonly DayInterval[],
  fromSlot: number,
  toSlot: number,
  kind: AvailabilityKind | null,
): DayInterval[] {
  const first = Math.max(0, Math.min(fromSlot, toSlot));
  const last = Math.min(SLOTS_PER_DAY - 1, Math.max(fromSlot, toSlot));
  return paintInterval(intervals, first * SLOT_MINUTES, (last + 1) * SLOT_MINUTES, kind);
}

/** Rules of one weekday from its intervals (`24:00` for a run that reaches midnight). */
export function intervalsToRules(weekday: number, intervals: readonly DayInterval[]): AvailabilityRule[] {
  return intervals.map((interval) => ({
    weekday,
    startLocal: formatClock(interval.start),
    endLocal: formatClock(interval.end),
    kind: interval.kind,
  }));
}

/**
 * Replaces one weekday's rules and leaves every other rule as it was (same
 * object, same position). The new rules go where that weekday's first rule
 * was, or after the last rule of an earlier weekday when it had none.
 */
export function replaceDayRules(
  rules: readonly AvailabilityRule[],
  weekday: number,
  dayRules: readonly AvailabilityRule[],
): AvailabilityRule[] {
  const firstIndex = rules.findIndex((rule) => rule.weekday === weekday);
  const others = rules.filter((rule) => rule.weekday !== weekday);
  let insertAt: number;
  if (firstIndex >= 0) {
    insertAt = rules.slice(0, firstIndex).filter((rule) => rule.weekday !== weekday).length;
  } else {
    const after = others.findIndex((rule) => rule.weekday > weekday);
    insertAt = after < 0 ? others.length : after;
  }
  return [...others.slice(0, insertAt), ...dayRules, ...others.slice(insertAt)];
}

/** What one 30-minute cell shows. */
export function cellState(intervals: readonly DayInterval[], slot: number): CellState {
  const start = slot * SLOT_MINUTES;
  const end = start + SLOT_MINUTES;
  let work = 0;
  let focus = 0;
  for (const interval of intervals) {
    const overlap = Math.min(end, interval.end) - Math.max(start, interval.start);
    if (overlap <= 0) continue;
    if (interval.kind === 'focus') focus += overlap;
    else work += overlap;
  }
  const covered = work + focus;
  if (covered === 0) return { kind: null, covered: 0, full: false };
  const kind: AvailabilityKind = focus >= work ? 'focus' : 'work';
  return { kind, covered, full: covered === SLOT_MINUTES && (work === 0 || focus === 0) };
}

/** A weekday has an edge or overlap the 30-minute grid cannot show exactly. */
export function dayIsOffGrid(rules: readonly AvailabilityRule[], weekday: number): boolean {
  const intervals = dayIntervals(rules, weekday);
  if (intervals.some((interval) => interval.start % SLOT_MINUTES !== 0 || interval.end % SLOT_MINUTES !== 0)) {
    return true;
  }
  const own = rules.filter((rule) => rule.weekday === weekday);
  const canonical = intervalsToRules(weekday, intervals);
  return (
    own.length !== canonical.length ||
    own.some((rule, index) => {
      const other = canonical[index];
      return (
        other === undefined ||
        rule.startLocal !== other.startLocal ||
        rule.endLocal !== other.endLocal ||
        rule.kind !== other.kind
      );
    })
  );
}

export interface DayTotals {
  work: number;
  focus: number;
  total: number;
}

/** Available minutes of one weekday (overlaps counted once). */
export function dayTotals(rules: readonly AvailabilityRule[], weekday: number): DayTotals {
  let work = 0;
  let focus = 0;
  for (const interval of dayIntervals(rules, weekday)) {
    if (interval.kind === 'focus') focus += interval.end - interval.start;
    else work += interval.end - interval.start;
  }
  return { work, focus, total: work + focus };
}

export function weekTotals(rules: readonly AvailabilityRule[]): DayTotals {
  return WEEKDAYS.reduce<DayTotals>(
    (sum, weekday) => {
      const day = dayTotals(rules, weekday);
      return { work: sum.work + day.work, focus: sum.focus + day.focus, total: sum.total + day.total };
    },
    { work: 0, focus: 0, total: 0 },
  );
}

/** Earliest available minute of the week, or `null` when there is none. */
export function earliestMinute(rules: readonly AvailabilityRule[]): number | null {
  let earliest: number | null = null;
  for (const weekday of WEEKDAYS) {
    const first = dayIntervals(rules, weekday)[0];
    if (first !== undefined && (earliest === null || first.start < earliest)) earliest = first.start;
  }
  return earliest;
}

/**
 * What a press on a cell does with the current brush: the same kind again
 * clears the cell (click a filled cell to erase it), anything else paints.
 */
export function strokeKind(brush: Brush, cell: CellState): AvailabilityKind | null {
  if (brush === 'erase') return null;
  if (cell.full && cell.kind === brush) return null;
  return brush;
}

/**
 * Normalises a typed clock value: `9` → `09:00`, `930` → `09:30`,
 * `9:5` → `09:05`, `24` → `24:00`. Returns the input unchanged when it cannot
 * be read, so the field keeps what the user typed and validation says why.
 */
export function normaliseClockInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  let hours: string;
  let minutes: string;
  const colon = /^(\d{1,2}):(\d{1,2})$/.exec(trimmed);
  if (colon !== null) {
    hours = colon[1] as string;
    minutes = (colon[2] as string).padStart(2, '0');
  } else if (/^\d{1,4}$/.test(trimmed)) {
    if (trimmed.length <= 2) {
      hours = trimmed;
      minutes = '00';
    } else {
      hours = trimmed.slice(0, trimmed.length - 2);
      minutes = trimmed.slice(-2);
    }
  } else {
    return value;
  }
  const candidate = `${hours.padStart(2, '0')}:${minutes}`;
  return parseClock(candidate) === null ? value : candidate;
}
