import { GRID_MINUTES } from './time.js';
import type { AutoSplitReason, Preferences } from './types.js';

export interface LegalSessionLimit {
  /** Longest single block, in minutes on the 5-minute grid, that H6 allows. */
  readonly capMin: number;
  /** The H6 limit that sets `capMin`. */
  readonly reason: AutoSplitReason;
}

/**
 * FU-96 (06 §3): the longest block that satisfies H6 on its own.
 *
 * - H6 break rule: a continuous run longer than `breakAfterMin` needs a break,
 *   and one block is a continuous run, so a block may last at most
 *   `breakAfterMin` minutes. The rule is off when `breakAfterMin <= 0`.
 * - H6 daily cap: a block can never be longer than `maxDailyFocusMin`.
 *
 * The smaller limit wins (`break_after` on a tie) and is floored to the
 * 5-minute grid. `undefined` means no block of at least 5 minutes is legal
 * (or the preferences are not finite), so there is nothing to split into.
 */
export function maxLegalSessionMin(
  prefs: Pick<Preferences, 'breakAfterMin' | 'maxDailyFocusMin'>,
): LegalSessionLimit | undefined {
  const breakAfterMin =
    prefs.breakAfterMin > 0 ? prefs.breakAfterMin : Number.POSITIVE_INFINITY;
  const dailyMin = prefs.maxDailyFocusMin;
  const limitMin = Math.min(breakAfterMin, dailyMin);
  if (!Number.isFinite(limitMin)) {
    return undefined;
  }
  const capMin = Math.floor(limitMin / GRID_MINUTES) * GRID_MINUTES;
  if (capMin < GRID_MINUTES) {
    return undefined;
  }
  return {
    capMin,
    reason: breakAfterMin <= dailyMin ? 'break_after' : 'daily_cap',
  };
}

/**
 * FU-96: shortest session for a task auto-split into sessions of at most
 * `capMin`: the caller's default minimum, but never more than half the cap
 * (on the grid, at least one grid cell). With `min <= cap / 2` (or a
 * one-cell cap, where min = cap) every remaining length above the cap divides
 * into whole-grid sessions inside `[min, cap]`, so an auto-split task never
 * fails on its session bounds alone (`heuristic_session_bounds_infeasible`).
 */
export function autoSplitMinSessionMin(capMin: number, defaultMinSessionMin: number): number {
  const halfCapMin = Math.floor(capMin / 2 / GRID_MINUTES) * GRID_MINUTES;
  return Math.max(GRID_MINUTES, Math.min(defaultMinSessionMin, halfCapMin));
}
