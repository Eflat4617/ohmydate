import {
  HOUR_BUCKET,
  countedRecord,
  estimateLean,
  estimateSeries,
  focusByHour,
  focusByWeek,
  focusByWeekday,
  peakIndex,
  planKeeping,
  recentWeekStarts,
  recordWeight,
  type KeepingBlock,
} from '../src/domain/insights';
import type { EstimateItem, OverviewSession } from '../src/domain/overview';

/**
 * AI 분석 (HOLO-03A): the numbers behind the charts are counted from records
 * the owner has. These tests pin what is counted — and that nothing is made up
 * where there is no record.
 */
const ZONE = 'Asia/Seoul';
const NOW = Date.parse('2026-11-14T09:40:00.000Z');

function record(createdAt: string, estimated: number, actual: number, more: Partial<EstimateItem> = {}): EstimateItem {
  return {
    createdAt,
    estimatedP50: estimated,
    actualFocusMin: actual,
    ratio: actual / estimated,
    excluded: false,
    quality: 'ok',
    ...more,
  };
}

function session(startedAt: string, focusedSec: number, more: Partial<OverviewSession> = {}): OverviewSession {
  return { id: startedAt, taskId: 't', startedAt, focusedSec, pausedSec: 0, state: 'completed', ...more };
}

describe('estimate against actual over time', () => {
  const items = [
    record('2026-11-13T12:30:00Z', 60, 85),
    record('2026-11-10T13:00:00Z', 120, 480, { quality: 'outlier' }),
    record('2026-11-09T10:00:00Z', 90, 100, { excluded: true }),
    record('2026-11-11T08:15:00Z', 45, 60),
    record('2026-11-08T09:00:00Z', 60, 75),
  ];

  it('draws the counted records oldest first, with the minutes behind each ratio', () => {
    expect(estimateSeries(items, 20)).toEqual([
      { at: '2026-11-08T09:00:00Z', ratio: 1.25, estimatedMin: 60, actualMin: 75 },
      { at: '2026-11-11T08:15:00Z', ratio: 60 / 45, estimatedMin: 45, actualMin: 60 },
      { at: '2026-11-13T12:30:00Z', ratio: 85 / 60, estimatedMin: 60, actualMin: 85 },
    ]);
    // `limit` keeps the newest.
    expect(estimateSeries(items, 2).map((point) => point.at)).toEqual(['2026-11-11T08:15:00Z', '2026-11-13T12:30:00Z']);
  });

  it('leaves out what the estimator leaves out, and what cannot be drawn (negative)', () => {
    expect(countedRecord(record('2026-11-10T13:00:00Z', 120, 480, { quality: 'outlier' }))).toBe(false);
    expect(countedRecord(record('2026-11-09T10:00:00Z', 90, 100, { excluded: true }))).toBe(false);
    expect(countedRecord(record('2026-11-09T10:00:00Z', 0, 100))).toBe(false);
    expect(countedRecord(record('2026-11-09T10:00:00Z', 60, -1))).toBe(false);
    expect(countedRecord(record('not a date', 60, 70))).toBe(false);
    expect(countedRecord(record('2026-11-09T10:00:00Z', 60, 70, { ratio: Number.NaN }))).toBe(false);
    expect(estimateSeries([], 20)).toEqual([]);
    expect(estimateSeries(items, 0)).toEqual([]);
  });

  it('says which way the estimates lean, and "about as estimated" within 5 %', () => {
    expect(estimateLean(1.3)).toBe('over');
    expect(estimateLean(0.8)).toBe('under');
    expect(estimateLean(1.05)).toBe('even');
    expect(estimateLean(0.95)).toBe('even');
    expect(estimateLean(Number.NaN)).toBe('even');
  });
});

describe('focus time by week, weekday and time of day', () => {
  const sessions = [
    // Saturday 2026-11-14 19:00 KST, 90 min.
    session('2026-11-14T10:00:00Z', 5_400),
    // Monday 2026-11-09 09:30 KST, 30 min.
    session('2026-11-09T00:30:00Z', 1_800),
    // Sunday 2026-11-08 23:30 KST (15:30Z... 14:30Z) — the week before, 20 min.
    session('2026-11-08T14:30:00Z', 1_200),
    // Monday 2026-11-02 00:10 KST: UTC still says Sunday the 1st.
    session('2026-11-01T15:10:00Z', 600),
  ];

  it('lists the Mondays of the last weeks, oldest first, ending with this week', () => {
    expect(recentWeekStarts('2026-11-14', 4)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    expect(recentWeekStarts('2026-11-09', 1)).toEqual(['2026-11-09']);
    expect(recentWeekStarts('2026-11-14', 0)).toEqual([]);
  });

  it('counts a session in the week, weekday and part of the day it started in — in the owner’s zone', () => {
    const starts = recentWeekStarts('2026-11-14', 3);
    expect(starts).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    // 10-26 week: nothing. 11-02 week: 00:10 Monday + 23:30 Sunday. 11-09 week: Monday + Saturday.
    expect(focusByWeek(sessions, starts, ZONE, NOW)).toEqual([0, 1_800, 7_200]);
    // Monday first: Mon = 1800 + 600, Sat = 5400, Sun = 1200.
    expect(focusByWeekday(sessions, ZONE, NOW)).toEqual([2_400, 0, 0, 0, 0, 5_400, 1_200]);
    // 3-hour parts from midnight: 00:10 → 0, 09:30 → 3, 19:00 → 6, 23:30 → 7.
    expect(HOUR_BUCKET).toBe(3);
    expect(focusByHour(sessions, ZONE, NOW)).toEqual([600, 0, 0, 1_800, 0, 0, 5_400, 1_200]);
  });

  it('a running session counts up to now; one with an unreadable start counts nowhere (negative)', () => {
    const running = session('2026-11-14T09:00:00Z', 0, { state: 'active' });
    expect(focusByWeek([running], ['2026-11-09'], ZONE, NOW)).toEqual([2_400]);
    const broken = session('nonsense', 3_600);
    expect(focusByWeek([broken], ['2026-11-09'], ZONE, NOW)).toEqual([0]);
    expect(focusByWeekday([broken], ZONE, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(focusByHour([broken], ZONE, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // A session outside the weeks asked for is in none of them.
    expect(focusByWeek(sessions, ['2026-10-19'], ZONE, NOW)).toEqual([0]);
  });

  it('names the peak only when there is one (negative: all zero is no peak)', () => {
    expect(peakIndex([0, 3, 9, 9])).toBe(2);
    expect(peakIndex([0, 0, 0])).toBeNull();
    expect(peakIndex([])).toBeNull();
    expect(peakIndex([Number.NaN, -1])).toBeNull();
  });
});

describe('지킨 계획', () => {
  function block(status: KeepingBlock['status'], endAt = '2026-11-13T10:00:00Z'): KeepingBlock {
    return { status, endAt };
  }

  it('counts the blocks whose time has come: done, moved, skipped, and passed without a record', () => {
    const keeping = planKeeping(
      [block('done'), block('done'), block('done'), block('moved'), block('skipped'), block('planned')],
      NOW,
    );
    expect(keeping).toEqual({ done: 3, moved: 1, skipped: 1, passed: 1, total: 6, keptShare: 0.5 });
  });

  it('leaves out a block still ahead and one a newer plan replaced (negative)', () => {
    const keeping = planKeeping(
      [block('planned', '2026-11-15T10:00:00Z'), block('superseded'), block('planned', 'nonsense')],
      NOW,
    );
    expect(keeping).toEqual({ done: 0, moved: 0, skipped: 0, passed: 0, total: 0, keptShare: null });
    // A block that ends exactly now has had its time.
    expect(planKeeping([block('planned', new Date(NOW).toISOString())], NOW).passed).toBe(1);
  });
});

describe('how much of a personal record is used', () => {
  it('is n ÷ (n + k): half at k records, more as they grow, nothing without records (negative)', () => {
    expect(recordWeight(5, 5)).toBe(0.5);
    expect(recordWeight(15, 5)).toBe(0.75);
    expect(recordWeight(0, 5)).toBe(0);
    expect(recordWeight(-2, 5)).toBe(0);
    expect(recordWeight(Number.NaN, 5)).toBe(0);
    expect(recordWeight(3, 0)).toBe(1);
  });
});
