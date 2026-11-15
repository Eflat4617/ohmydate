/**
 * 계획 세우기 · 일정안 (HOLO-03A): everything the comparison screen says about
 * a candidate schedule is computed here from what the API returned — when it
 * ends, how the load falls on each day, how one candidate differs from
 * another — and so are the edits a person makes to a candidate's blocks.
 *
 * Pure: no I/O, no clock of its own. Wall-clock questions are answered in the
 * owner's IANA zone through `localParts`.
 */
import { addDaysToDate, localParts } from './time';

/** Every edit moves in steps of five minutes: the scheduler's own grid (H8). */
export const EDIT_GRID_MINUTES = 5;

const MINUTE_MS = 60_000;

export interface BlockInterval {
  readonly startAt: string;
  readonly endAt: string;
}

export interface DraftBlock extends BlockInterval {
  readonly taskId: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The block `deltaMin` later (earlier when negative); its length is kept. */
export function movedInterval(block: BlockInterval, deltaMin: number): BlockInterval {
  const delta = deltaMin * MINUTE_MS;
  return { startAt: iso(Date.parse(block.startAt) + delta), endAt: iso(Date.parse(block.endAt) + delta) };
}

/** The block with its end `deltaMin` later; it never gets shorter than one step. */
export function resizedInterval(block: BlockInterval, deltaMin: number): BlockInterval {
  const startMs = Date.parse(block.startAt);
  const endMs = Math.max(startMs + EDIT_GRID_MINUTES * MINUTE_MS, Date.parse(block.endAt) + deltaMin * MINUTE_MS);
  return { startAt: block.startAt, endAt: iso(endMs) };
}

/** How many minutes a drag of `dyPx` is, on an axis where an hour is `hourPx` tall, in whole steps. */
export function dragMinutes(dyPx: number, hourPx: number): number {
  if (!Number.isFinite(dyPx) || !Number.isFinite(hourPx) || hourPx <= 0) return 0;
  // `+ 0` turns a negative zero (a tiny upward drag) into zero.
  return Math.round(((dyPx / hourPx) * 60) / EDIT_GRID_MINUTES) * EDIT_GRID_MINUTES + 0;
}

/** A copy of `blocks` with the one at `index` replaced; an index that is not there changes nothing. */
export function withBlock<T extends DraftBlock>(blocks: readonly T[], index: number, next: BlockInterval): T[] {
  return blocks.map((block, position) => (position === index ? { ...block, ...next } : { ...block }));
}

export function sameBlocks(left: readonly DraftBlock[], right: readonly DraftBlock[]): boolean {
  return (
    left.length === right.length &&
    left.every((block, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        block.taskId === other.taskId &&
        Date.parse(block.startAt) === Date.parse(other.startAt) &&
        Date.parse(block.endAt) === Date.parse(other.endAt)
      );
    })
  );
}

function minutesOf(block: BlockInterval): number {
  const length = (Date.parse(block.endAt) - Date.parse(block.startAt)) / MINUTE_MS;
  return Number.isFinite(length) && length > 0 ? length : 0;
}

/** The instant the last block ends, or null without a readable block. */
export function finishAt(blocks: readonly BlockInterval[]): string | null {
  let last = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    const end = Date.parse(block.endAt);
    if (Number.isFinite(end) && end > last) last = end;
  }
  return Number.isFinite(last) ? iso(last) : null;
}

/** The instant the first block starts, or null without a readable block. */
export function firstStartAt(blocks: readonly BlockInterval[]): string | null {
  let first = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    const start = Date.parse(block.startAt);
    if (Number.isFinite(start) && start < first) first = start;
  }
  return Number.isFinite(first) ? iso(first) : null;
}

/** The civil days from the day `start` is on to the day before `end` (an end at midnight belongs to the day before). */
export function horizonDates(horizon: { readonly start: string; readonly end: string }, timeZone: string): string[] {
  if (!Number.isFinite(Date.parse(horizon.start)) || !Number.isFinite(Date.parse(horizon.end))) return [];
  const first = localParts(horizon.start, timeZone);
  const last = localParts(horizon.end, timeZone);
  const until = last.minutes === 0 && last.date > first.date ? addDaysToDate(last.date, -1) : last.date;
  const dates: string[] = [];
  // A horizon is at most 366 days (the scheduler's bound); the guard keeps a bad value from looping.
  for (let date = first.date; date <= until && dates.length < 400; date = addDaysToDate(date, 1)) dates.push(date);
  return dates;
}

/**
 * Minutes of focus on each of `dates`, in order. A block counts on the day it
 * starts (blocks are placed inside one day's hours; the scheduler's own daily
 * load counts them the same way).
 */
export function dailyLoad(blocks: readonly BlockInterval[], dates: readonly string[], timeZone: string): number[] {
  const index = new Map(dates.map((date, position) => [date, position]));
  const load = dates.map(() => 0);
  for (const block of blocks) {
    if (!Number.isFinite(Date.parse(block.startAt))) continue;
    const position = index.get(localParts(block.startAt, timeZone).date);
    if (position !== undefined) load[position] = (load[position] ?? 0) + minutesOf(block);
  }
  return load;
}

/** Days that hold at least one block. */
export function activeDays(load: readonly number[]): number {
  return load.reduce((count, minutes) => count + (minutes > 0 ? 1 : 0), 0);
}

/** The dates the strip of bars shows: from the first day to the last day any candidate uses. */
export function loadWindow(loads: readonly (readonly number[])[], dates: readonly string[]): { from: number; to: number } {
  let from = dates.length;
  let to = -1;
  for (const load of loads) {
    load.forEach((minutes, index) => {
      if (minutes <= 0) return;
      if (index < from) from = index;
      if (index > to) to = index;
    });
  }
  return to < from ? { from: 0, to: Math.max(0, Math.min(dates.length, 7) - 1) } : { from, to };
}

export interface CandidateFigures {
  readonly feasible: boolean;
  /** Minutes that could not be placed. */
  readonly deficitMin: number;
  /** When the last block ends; null without blocks. */
  readonly finishAt: string | null;
  /** The civil day of `finishAt`. */
  readonly finishDate: string | null;
  /** Slack of the tightest deadline, in minutes (negative: past it). */
  readonly minSlackMin: number;
  readonly maxDailyLoadMin: number;
  readonly totalFocusMin: number;
  readonly contextSwitches: number;
  /** Share of the cautious (P90) estimates the schedule holds, 0..1 and above. */
  readonly p90Coverage: number;
  /** Days with at least one block. */
  readonly days: number;
}

export interface CandidateInput {
  readonly feasible: boolean;
  readonly deficitMin: number;
  readonly blocks: readonly BlockInterval[];
  readonly metrics: {
    readonly minSlackMin: number;
    readonly maxDailyLoadMin: number;
    readonly totalFocusMin: number;
    readonly contextSwitches: number;
    readonly p90CoverageRatio: number;
  };
}

/** The numbers a candidate's card shows: the server's metrics, plus when its blocks end. */
export function candidateFigures(candidate: CandidateInput, dates: readonly string[], timeZone: string): CandidateFigures {
  const end = finishAt(candidate.blocks);
  return {
    feasible: candidate.feasible,
    deficitMin: candidate.deficitMin,
    finishAt: end,
    finishDate: end === null ? null : finishDateOf(end, timeZone),
    minSlackMin: candidate.metrics.minSlackMin,
    maxDailyLoadMin: candidate.metrics.maxDailyLoadMin,
    totalFocusMin: candidate.metrics.totalFocusMin,
    contextSwitches: candidate.metrics.contextSwitches,
    p90Coverage: candidate.metrics.p90CoverageRatio,
    days: activeDays(dailyLoad(candidate.blocks, dates, timeZone)),
  };
}

/** The day a schedule ends on: an end at exactly midnight is the day before. */
function finishDateOf(end: string, timeZone: string): string {
  const parts = localParts(end, timeZone);
  return parts.minutes === 0 ? addDaysToDate(parts.date, -1) : parts.date;
}

/** How risky a candidate is, from its own numbers; the worst that applies. */
export type CandidateRisk = 'unplaced' | 'late' | 'tight' | 'ok';

/**
 * - `unplaced`: some work does not fit (not feasible, or minutes left over);
 * - `late`: everything fits, but something ends after its deadline;
 * - `tight`: it fits on the usual estimates, not on the cautious ones;
 * - `ok`: it fits even if every step takes its cautious estimate.
 */
export function candidateRisk(figures: Pick<CandidateFigures, 'feasible' | 'deficitMin' | 'minSlackMin' | 'p90Coverage'>): CandidateRisk {
  if (!figures.feasible || figures.deficitMin > 0) return 'unplaced';
  if (figures.minSlackMin < 0) return 'late';
  if (figures.p90Coverage < 1) return 'tight';
  return 'ok';
}

function civilDayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export interface CandidateDifference {
  /** Days this one ends after the other (negative: earlier); null when either has no end. */
  readonly finishDays: number | null;
  /** Minutes its heaviest day is above the other's (negative: lighter). */
  readonly maxDailyLoadMin: number;
  /** Minutes of slack it has over the other (negative: less). */
  readonly slackMin: number;
}

/** How `candidate` differs from `other` (the one that is picked), in the three numbers a person weighs. */
export function candidateDifference(candidate: CandidateFigures, other: CandidateFigures): CandidateDifference {
  return {
    finishDays:
      candidate.finishDate === null || other.finishDate === null
        ? null
        : civilDayNumber(candidate.finishDate) - civilDayNumber(other.finishDate),
    maxDailyLoadMin: candidate.maxDailyLoadMin - other.maxDailyLoadMin,
    slackMin: candidate.minSlackMin - other.minSlackMin,
  };
}

/**
 * What a candidate is best at among `all`, by a clear margin: the only one
 * that ends earliest, has the lightest heaviest day, or switches tasks least.
 * Null when it leads in nothing (or shares every lead).
 */
export type CandidateLead = 'earliest' | 'lightest' | 'fewestSwitches';

export function candidateLead(index: number, all: readonly CandidateFigures[]): CandidateLead | null {
  const own = all[index];
  if (own === undefined || all.length < 2) return null;
  const others = all.filter((_, position) => position !== index);
  const finish = own.finishDate;
  if (finish !== null && others.every((other) => other.finishDate !== null && other.finishDate > finish)) return 'earliest';
  if (others.every((other) => other.maxDailyLoadMin > own.maxDailyLoadMin)) return 'lightest';
  if (others.every((other) => other.contextSwitches > own.contextSwitches)) return 'fewestSwitches';
  return null;
}

/**
 * The days a new plan covers when nothing else was chosen: from today for a
 * fortnight, or up to the day the work is due when that is later — never
 * longer than `maxDays` (the scheduler refuses more than a year).
 */
export function defaultHorizonDates(
  today: string,
  dueDate: string | null,
  options: { readonly days?: number; readonly maxDays?: number } = {},
): { start: string; end: string } {
  const days = options.days ?? 14;
  const maxDays = options.maxDays ?? 90;
  const usual = addDaysToDate(today, days - 1);
  const latest = addDaysToDate(today, maxDays - 1);
  let end = usual;
  if (dueDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && dueDate > usual) end = dueDate > latest ? latest : dueDate;
  return { start: today, end };
}
