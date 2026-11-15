import { sessionFocusedSec, type EstimateItem, type OverviewSession } from './overview';
import { addDaysToDate, localParts, startOfWeek, weekdayOfDate } from './time';

/**
 * AI 분석 (HOLO-03A): the numbers behind its charts. Every figure is counted
 * from records the owner already has — session reviews (the estimation
 * profile), work sessions and schedule blocks — and nothing is estimated,
 * smoothed or filled in. Where there are too few records a function returns
 * null (or zeros) and the screen says so.
 */

/** Fewer counted records than this and a trend is not drawn. */
export const TREND_MIN_POINTS = 3;

export interface EstimatePoint {
  /** When the record was made. */
  readonly at: string;
  /** Actual ÷ estimated: above 1 took longer than estimated. */
  readonly ratio: number;
  readonly estimatedMin: number;
  readonly actualMin: number;
}

/** A record the estimator counts: not taken out, not an outlier, with usable minutes. */
export function countedRecord(item: EstimateItem): boolean {
  return (
    !item.excluded &&
    item.quality === 'ok' &&
    Number.isFinite(item.actualFocusMin) &&
    Number.isFinite(item.estimatedP50) &&
    item.estimatedP50 > 0 &&
    item.actualFocusMin >= 0 &&
    Number.isFinite(item.ratio) &&
    Number.isFinite(Date.parse(item.createdAt))
  );
}

/** Estimate against actual over time: the counted records, oldest first, the last `limit` of them. */
export function estimateSeries(items: readonly EstimateItem[], limit: number): EstimatePoint[] {
  // `slice(-0)` is the whole list, so "none" is said outright.
  if (!(limit > 0)) return [];
  return items
    .filter(countedRecord)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-Math.floor(limit))
    .map((item) => ({
      at: item.createdAt,
      ratio: item.ratio,
      estimatedMin: item.estimatedP50,
      actualMin: item.actualFocusMin,
    }));
}

export type EstimateLean = 'over' | 'under' | 'even';

/**
 * Which way the estimates lean, in words: `over` took longer than estimated,
 * `under` took less. Within 5 % either way is "about as estimated".
 */
export function estimateLean(ratio: number): EstimateLean {
  if (!Number.isFinite(ratio)) return 'even';
  if (ratio > 1.05) return 'over';
  if (ratio < 0.95) return 'under';
  return 'even';
}

/** The Mondays of the last `weeks` weeks, oldest first, ending with the week of `today`. */
export function recentWeekStarts(today: string, weeks: number): string[] {
  const last = startOfWeek(today);
  const count = Math.max(0, Math.floor(weeks));
  return Array.from({ length: count }, (_, index) => addDaysToDate(last, -7 * (count - 1 - index)));
}

interface Started {
  readonly session: OverviewSession;
  readonly date: string;
  readonly hour: number;
}

/** Sessions with a readable start, at their local date and hour. A session counts where it STARTED. */
function started(sessions: readonly OverviewSession[], timeZone: string): Started[] {
  const result: Started[] = [];
  for (const session of sessions) {
    if (!Number.isFinite(Date.parse(session.startedAt))) continue;
    const parts = localParts(session.startedAt, timeZone);
    result.push({ session, date: parts.date, hour: parts.hour });
  }
  return result;
}

/** Focused seconds per week, one value per start in `starts` (Mondays). */
export function focusByWeek(
  sessions: readonly OverviewSession[],
  starts: readonly string[],
  timeZone: string,
  nowMs: number,
): number[] {
  const totals = starts.map(() => 0);
  for (const { session, date } of started(sessions, timeZone)) {
    const index = starts.indexOf(startOfWeek(date));
    if (index === -1) continue;
    totals[index] = (totals[index] ?? 0) + sessionFocusedSec(session, nowMs);
  }
  return totals;
}

/** Focused seconds per weekday, Monday first, over the sessions given. */
export function focusByWeekday(sessions: readonly OverviewSession[], timeZone: string, nowMs: number): number[] {
  const totals = [0, 0, 0, 0, 0, 0, 0];
  for (const { session, date } of started(sessions, timeZone)) {
    const index = weekdayOfDate(date) - 1;
    totals[index] = (totals[index] ?? 0) + sessionFocusedSec(session, nowMs);
  }
  return totals;
}

/** Hours of one bucket of the time-of-day chart. */
export const HOUR_BUCKET = 3;

/** Focused seconds per part of the day: buckets of `HOUR_BUCKET` hours from midnight. */
export function focusByHour(sessions: readonly OverviewSession[], timeZone: string, nowMs: number): number[] {
  const totals = Array.from({ length: 24 / HOUR_BUCKET }, () => 0);
  for (const { session, hour } of started(sessions, timeZone)) {
    const index = Math.min(totals.length - 1, Math.max(0, Math.floor(hour / HOUR_BUCKET)));
    totals[index] = (totals[index] ?? 0) + sessionFocusedSec(session, nowMs);
  }
  return totals;
}

/** The index of the largest value; null when nothing is above zero. Ties go to the earliest. */
export function peakIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  values.forEach((value, index) => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (best === null || value > (values[best] ?? 0)) best = index;
  });
  return best;
}

export interface KeepingBlock {
  readonly endAt: string;
  readonly status: 'planned' | 'done' | 'skipped' | 'moved' | 'superseded';
}

export interface PlanKeeping {
  /** Blocks finished as planned. */
  readonly done: number;
  /** Blocks moved to another time. */
  readonly moved: number;
  readonly skipped: number;
  /** Blocks whose time passed with nothing recorded. */
  readonly passed: number;
  readonly total: number;
  /** done ÷ total; null when no block's time has come yet. */
  readonly keptShare: number | null;
}

/**
 * "지킨 계획": of the confirmed blocks whose time has passed, how many were
 * done. A block replaced by a newer plan (superseded) was never the plan to
 * keep and is left out; a block still ahead is not counted either way.
 */
export function planKeeping(blocks: readonly KeepingBlock[], nowMs: number): PlanKeeping {
  let done = 0;
  let moved = 0;
  let skipped = 0;
  let passed = 0;
  for (const block of blocks) {
    if (block.status === 'superseded') continue;
    if (block.status === 'done') done += 1;
    else if (block.status === 'moved') moved += 1;
    else if (block.status === 'skipped') skipped += 1;
    else {
      const end = Date.parse(block.endAt);
      if (Number.isFinite(end) && end <= nowMs) passed += 1;
    }
  }
  const total = done + moved + skipped + passed;
  return { done, moved, skipped, passed, total, keptShare: total === 0 ? null : done / total };
}

/** How much of a personal record is used: n ÷ (n + k), the estimator's own weighting. */
export function recordWeight(sampleCount: number, shrinkageK: number): number {
  if (!Number.isFinite(sampleCount) || !Number.isFinite(shrinkageK) || sampleCount <= 0) return 0;
  const k = Math.max(0, shrinkageK);
  return sampleCount / (sampleCount + k);
}
