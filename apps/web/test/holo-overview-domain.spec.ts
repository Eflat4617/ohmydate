import { describe, expect, it } from 'vitest';
import { displayNameOf, initialOf } from '../src/domain/displayName';
import {
  ESTIMATE_MIN_SAMPLES,
  clockParts,
  dayRange,
  daySegments,
  daysBefore,
  durationParts,
  estimateTrend,
  focusByDay,
  greetingPeriod,
  minutesOfSeconds,
  minutesWithin,
  newestFirst,
  nextBlockOf,
  personalEstimate,
  planDeltaMinutes,
  plannedMinutes,
  projectHue,
  recentTaskSessions,
  remainingPlannedMinutes,
  sessionFocusedSec,
  sessionsWithin,
  totalSeconds,
  weekRange,
  type EstimateItem,
  type OverviewBlock,
  type OverviewSession,
} from '../src/domain/overview';

/**
 * HOLO-01: every number on 개요 comes from these pure functions. Zone edges
 * and DST are exercised with instants, never with the machine's own zone.
 */
function session(overrides: Partial<OverviewSession> & { startedAt: string }): OverviewSession {
  return {
    id: overrides.startedAt,
    taskId: 'task-a',
    focusedSec: 1800,
    pausedSec: 0,
    state: 'completed',
    ...overrides,
  };
}

function block(overrides: Partial<OverviewBlock> & { startAt: string; endAt: string }): OverviewBlock {
  return { id: overrides.startAt, taskId: 'task-a', title: '블록', status: 'planned', ...overrides };
}

describe('greeting by hour', () => {
  it('is morning from 5, afternoon from 12 and evening from 18', () => {
    expect([5, 8, 11].map(greetingPeriod)).toEqual(['morning', 'morning', 'morning']);
    expect([12, 15, 17].map(greetingPeriod)).toEqual(['afternoon', 'afternoon', 'afternoon']);
    expect([18, 21, 23].map(greetingPeriod)).toEqual(['evening', 'evening', 'evening']);
  });

  it('calls the small hours evening and never throws on a bad hour (negative)', () => {
    expect([0, 3, 4].map(greetingPeriod)).toEqual(['evening', 'evening', 'evening']);
    expect(greetingPeriod(Number.NaN)).toBe('evening');
    expect(greetingPeriod(11.9)).toBe('morning');
  });
});

describe('sessions → day buckets', () => {
  const WEEK = '2026-11-09'; // Monday

  it('puts each session on the local day it started, Monday to Sunday', () => {
    const buckets = focusByDay(
      [
        session({ startedAt: '2026-11-09T10:00:00.000Z', focusedSec: 3120 }), // Mon 19:00 Seoul
        session({ startedAt: '2026-11-10T10:00:00.000Z', focusedSec: 4680 }), // Tue
        session({ startedAt: '2026-11-14T01:05:00.000Z', focusedSec: 3720 }), // Sat 10:05
        session({ startedAt: '2026-11-14T07:20:00.000Z', focusedSec: 2460 }), // Sat 16:20
      ],
      WEEK,
      'Asia/Seoul',
      Date.parse('2026-11-14T09:40:00.000Z'),
    );
    expect(buckets).toEqual([3120, 4680, 0, 0, 0, 6180, 0]);
    expect(totalSeconds(buckets)).toBe(13_980);
    expect(minutesOfSeconds(totalSeconds(buckets))).toBe(233);
  });

  it('decides the day in the owner zone, not in UTC (zone edge)', () => {
    // 15:30 UTC on Sunday the 8th is already 00:30 on Monday the 9th in Seoul…
    const lateSunday = session({ startedAt: '2026-11-08T15:30:00.000Z', focusedSec: 600 });
    expect(focusByDay([lateSunday], WEEK, 'Asia/Seoul', 0)).toEqual([600, 0, 0, 0, 0, 0, 0]);
    // …and still Sunday the 8th in New York, which is outside this week.
    expect(focusByDay([lateSunday], WEEK, 'America/New_York', 0)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // 14:59 UTC on Sunday the 15th is 23:59 on Sunday in Seoul: the last bucket.
    const sundayNight = session({ startedAt: '2026-11-15T14:59:00.000Z', focusedSec: 300 });
    expect(focusByDay([sundayNight], WEEK, 'Asia/Seoul', 0)[6]).toBe(300);
  });

  it('keeps seven local days across a DST change (a 25-hour and a 23-hour day)', () => {
    // US clocks go back on Sunday 2026-11-01: that local day lasts 25 hours.
    const fallWeek = '2026-10-26';
    const range = weekRange(fallWeek, 'America/New_York');
    expect((Date.parse(range.to) - Date.parse(range.from)) / 3_600_000).toBe(7 * 24 + 1);
    const sunday = dayRange('2026-11-01', 'America/New_York');
    expect((Date.parse(sunday.to) - Date.parse(sunday.from)) / 3_600_000).toBe(25);
    const buckets = focusByDay(
      [
        session({ startedAt: '2026-11-01T05:30:00.000Z', focusedSec: 900 }), // 01:30 EDT, first pass
        session({ startedAt: '2026-11-01T06:30:00.000Z', focusedSec: 900 }), // 01:30 EST, second pass
        session({ startedAt: '2026-11-02T04:30:00.000Z', focusedSec: 900 }), // 23:30 EST, still Sunday
        session({ startedAt: '2026-11-02T05:00:00.000Z', focusedSec: 60 }), // Monday 00:00: next week
      ],
      fallWeek,
      'America/New_York',
      0,
    );
    expect(buckets).toEqual([0, 0, 0, 0, 0, 0, 2700]);

    // US clocks go forward on Sunday 2026-03-08: that local day lasts 23 hours.
    const springWeek = '2026-03-02';
    const spring = weekRange(springWeek, 'America/New_York');
    expect((Date.parse(spring.to) - Date.parse(spring.from)) / 3_600_000).toBe(7 * 24 - 1);
    expect(
      focusByDay([session({ startedAt: '2026-03-08T07:30:00.000Z', focusedSec: 1200 })], springWeek, 'America/New_York', 0),
    ).toEqual([0, 0, 0, 0, 0, 0, 1200]);
  });

  it('leaves out sessions of other weeks and unreadable starts (negative)', () => {
    const buckets = focusByDay(
      [
        session({ startedAt: '2026-11-02T10:00:00.000Z', focusedSec: 999 }),
        session({ startedAt: '2026-11-16T10:00:00.000Z', focusedSec: 999 }),
        session({ startedAt: 'not a date', focusedSec: 999 }),
      ],
      WEEK,
      'Asia/Seoul',
      0,
    );
    expect(buckets).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(totalSeconds(buckets)).toBe(0);
    expect(totalSeconds([10, Number.NaN, -5])).toBe(10);
  });

  it('counts a running session up to now and a paused one as stored', () => {
    const startedAt = '2026-11-14T09:15:00.000Z';
    const now = Date.parse('2026-11-14T09:40:00.000Z');
    const running = session({ startedAt, focusedSec: 0, pausedSec: 0, state: 'active' });
    expect(sessionFocusedSec(running, now)).toBe(25 * 60);
    // Ten minutes were focused and five paused before it resumed.
    const resumed = session({ startedAt, focusedSec: 600, pausedSec: 300, state: 'active' });
    expect(sessionFocusedSec(resumed, now)).toBe(600 + 10 * 60);
    expect(sessionFocusedSec(session({ startedAt, focusedSec: 600, state: 'paused' }), now)).toBe(600);
    // A clock behind the session's last event never subtracts (negative).
    expect(sessionFocusedSec(resumed, Date.parse(startedAt))).toBe(600);
  });
});

describe('today against the plan', () => {
  it('reports how far today is from what was planned', () => {
    expect(planDeltaMinutes(150 * 60, 130)).toBe(20);
    expect(planDeltaMinutes(90 * 60, 130)).toBe(-40);
    expect(planDeltaMinutes(130 * 60, 130)).toBe(0);
  });

  it('makes no comparison unless both exist (negative)', () => {
    expect(planDeltaMinutes(0, 130)).toBeNull();
    expect(planDeltaMinutes(59, 130)).toBeNull();
    expect(planDeltaMinutes(3600, 0)).toBeNull();
    expect(planDeltaMinutes(3600, Number.NaN)).toBeNull();
  });

  it('adds up the plan, what is left of it, and finds the next block', () => {
    const blocks = [
      block({ startAt: '2026-11-14T10:00:00.000Z', endAt: '2026-11-14T11:30:00.000Z' }),
      block({ startAt: '2026-11-14T12:00:00.000Z', endAt: '2026-11-14T12:40:00.000Z', title: '둘째' }),
      block({ startAt: '2026-11-14T01:00:00.000Z', endAt: '2026-11-14T02:00:00.000Z', status: 'done' }),
      block({ startAt: '2026-11-14T03:00:00.000Z', endAt: '2026-11-14T04:00:00.000Z', status: 'moved' }),
    ];
    expect(plannedMinutes(blocks)).toBe(90 + 40 + 60);
    expect(remainingPlannedMinutes(blocks)).toBe(130);
    expect(nextBlockOf(blocks, Date.parse('2026-11-14T09:40:00.000Z'))?.startAt).toBe('2026-11-14T10:00:00.000Z');
    // A block under way is still the next thing to start; one that ended is not.
    expect(nextBlockOf(blocks, Date.parse('2026-11-14T11:00:00.000Z'))?.startAt).toBe('2026-11-14T10:00:00.000Z');
    expect(nextBlockOf(blocks, Date.parse('2026-11-14T11:45:00.000Z'))?.title).toBe('둘째');
    expect(nextBlockOf(blocks, Date.parse('2026-11-14T13:00:00.000Z'))).toBeNull();
    expect(nextBlockOf([], 0)).toBeNull();
  });
});

describe('ring segments (오늘 요약)', () => {
  it('shares the ring between the kinds that have time, in a fixed order', () => {
    const segments = daySegments({ remainingPlannedMin: 130, commitmentMin: 70, focusedMin: 100 });
    expect(segments.map((segment) => segment.kind)).toEqual(['planned', 'commitment', 'focused']);
    expect(segments.map((segment) => segment.minutes)).toEqual([130, 70, 100]);
    expect(segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1, 10);
    expect(segments[0]?.share).toBeCloseTo(130 / 300, 10);
  });

  it('drops empty kinds and returns nothing for an empty day (negative)', () => {
    expect(daySegments({ remainingPlannedMin: 0, commitmentMin: 45, focusedMin: 0 })).toEqual([
      { kind: 'commitment', minutes: 45, share: 1 },
    ]);
    expect(daySegments({ remainingPlannedMin: 0, commitmentMin: 0, focusedMin: 0 })).toEqual([]);
    expect(daySegments({ remainingPlannedMin: Number.NaN, commitmentMin: -20, focusedMin: 0 })).toEqual([]);
  });

  it('clips 약속 to the day', () => {
    const day = dayRange('2026-11-14', 'Asia/Seoul');
    expect(
      minutesWithin(
        [
          { startAt: '2026-11-14T06:00:00.000Z', endAt: '2026-11-14T06:40:00.000Z' }, // inside: 40
          { startAt: '2026-11-13T14:30:00.000Z', endAt: '2026-11-13T15:30:00.000Z' }, // crosses midnight in: 30
          { startAt: '2026-11-14T14:45:00.000Z', endAt: '2026-11-14T16:00:00.000Z' }, // crosses out: 15
          { startAt: '2026-11-15T03:00:00.000Z', endAt: '2026-11-15T04:00:00.000Z' }, // tomorrow: 0
        ],
        day.from,
        day.to,
      ),
    ).toBe(85);
    expect(minutesWithin([{ startAt: 'bad', endAt: 'worse' }], day.from, day.to)).toBe(0);
  });
});

describe('session lists', () => {
  const sessions = [
    session({ id: 's1', taskId: 'a', startedAt: '2026-11-10T10:00:00.000Z' }),
    session({ id: 's2', taskId: 'b', startedAt: '2026-11-12T10:00:00.000Z' }),
    session({ id: 's3', taskId: 'a', startedAt: '2026-11-13T10:00:00.000Z' }),
    session({ id: 's4', taskId: 'c', startedAt: '2026-11-14T01:00:00.000Z' }),
  ];

  it('orders newest first and keeps the last session of each recent task', () => {
    expect(newestFirst(sessions).map((item) => item.id)).toEqual(['s4', 's3', 's2', 's1']);
    expect(recentTaskSessions(sessions, 3).map((item) => item.id)).toEqual(['s4', 's3', 's2']);
    expect(recentTaskSessions(sessions, 2).map((item) => item.taskId)).toEqual(['c', 'a']);
    expect(recentTaskSessions([], 3)).toEqual([]);
  });

  it('keeps only the sessions that started inside the range', () => {
    const week = weekRange('2026-11-09', 'Asia/Seoul');
    expect(sessionsWithin(sessions, week.from, week.to)).toHaveLength(4);
    const day = dayRange('2026-11-14', 'Asia/Seoul');
    expect(sessionsWithin(sessions, day.from, day.to).map((item) => item.id)).toEqual(['s4']);
    expect(sessionsWithin([session({ startedAt: 'nope' })], week.from, week.to)).toEqual([]);
  });
});

describe('personal estimate (내 패턴)', () => {
  function item(estimated: number, actual: number, overrides: Partial<EstimateItem> = {}): EstimateItem {
    return {
      estimatedP50: estimated,
      actualFocusMin: actual,
      ratio: actual / estimated,
      excluded: false,
      quality: 'ok',
      createdAt: '2026-11-10T00:00:00.000Z',
      ...overrides,
    };
  }

  it('divides the minutes actually focused by the minutes estimated', () => {
    const estimate = personalEstimate([item(60, 85), item(30, 35), item(45, 60), item(60, 75)]);
    expect(estimate?.samples).toBe(4);
    expect(estimate?.ratio).toBeCloseTo(255 / 195, 10);
  });

  it('says nothing with too few records, and never counts excluded ones or outliers (negative)', () => {
    expect(ESTIMATE_MIN_SAMPLES).toBe(3);
    expect(personalEstimate([item(60, 85), item(30, 35)])).toBeNull();
    expect(
      personalEstimate([
        item(60, 85),
        item(30, 35),
        item(120, 480, { quality: 'outlier' }),
        item(90, 100, { excluded: true }),
      ]),
    ).toBeNull();
    expect(personalEstimate([])).toBeNull();
    expect(personalEstimate([item(0, 10), item(0, 20), item(0, 30)])).toBeNull();
  });

  it('gives the trend oldest first, the last few counted records only', () => {
    const items = [
      item(60, 90, { createdAt: '2026-11-13T00:00:00.000Z' }),
      item(60, 60, { createdAt: '2026-11-11T00:00:00.000Z' }),
      item(60, 75, { createdAt: '2026-11-12T00:00:00.000Z' }),
      item(60, 600, { createdAt: '2026-11-14T00:00:00.000Z', quality: 'outlier' }),
    ];
    expect(estimateTrend(items, 8)).toEqual([1, 1.25, 1.5]);
    expect(estimateTrend(items, 2)).toEqual([1.25, 1.5]);
    expect(estimateTrend([], 8)).toEqual([]);
  });
});

describe('figures', () => {
  it('splits a duration into the parts a numeral is set in', () => {
    expect(durationParts(400)).toEqual([
      { value: 6, unit: 'hour' },
      { value: 40, unit: 'minute' },
    ]);
    expect(durationParts(45)).toEqual([{ value: 45, unit: 'minute' }]);
    expect(durationParts(120)).toEqual([{ value: 2, unit: 'hour' }]);
    expect(durationParts(0)).toEqual([{ value: 0, unit: 'minute' }]);
    // Days never appear: a long week stays in hours (and bad input is zero).
    expect(durationParts(26 * 60)).toEqual([{ value: 26, unit: 'hour' }]);
    expect(durationParts(Number.NaN)).toEqual([{ value: 0, unit: 'minute' }]);
    expect(durationParts(-30)).toEqual([{ value: 0, unit: 'minute' }]);
  });

  it('always shows hours on the tracker clock', () => {
    expect(clockParts(0)).toEqual({ hours: '00', minutes: '00', seconds: '00' });
    expect(clockParts(25 * 60 + 7)).toEqual({ hours: '00', minutes: '25', seconds: '07' });
    expect(clockParts(3 * 3600 + 5)).toEqual({ hours: '03', minutes: '00', seconds: '05' });
    expect(clockParts(-4)).toEqual({ hours: '00', minutes: '00', seconds: '00' });
  });

  it('counts whole days between two civil dates', () => {
    expect(daysBefore('2026-11-14', '2026-11-14')).toBe(0);
    expect(daysBefore('2026-11-13', '2026-11-14')).toBe(1);
    expect(daysBefore('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysBefore('2026-11-15', '2026-11-14')).toBe(-1);
    expect(daysBefore('garbage', '2026-11-14')).toBe(0);
  });

  it('gives a project the same hue every time', () => {
    const one = projectHue('01900000-0000-7000-8000-000000000003');
    expect(projectHue('01900000-0000-7000-8000-000000000003')).toBe(one);
    expect(['cyan', 'violet', 'orange', 'sky']).toContain(one);
    expect(['cyan', 'violet', 'orange', 'sky']).toContain(projectHue(''));
  });
});

describe('what the app calls the user', () => {
  it('uses the part of the address before the @', () => {
    expect(displayNameOf('planner@example.test')).toBe('planner');
    expect(initialOf('planner')).toBe('P');
    expect(initialOf('한결')).toBe('한');
  });

  it('never invents a name (negative)', () => {
    expect(displayNameOf(null)).toBe('');
    expect(displayNameOf(undefined)).toBe('');
    expect(displayNameOf('  ')).toBe('');
    expect(displayNameOf('no-at-sign')).toBe('no-at-sign');
    expect(displayNameOf('@leading.example')).toBe('@leading.example');
    expect(initialOf('')).toBe('');
  });
});
