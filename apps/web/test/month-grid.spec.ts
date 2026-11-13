import { describe, expect, it } from 'vitest';
import {
  MONTH_CELL_LINES,
  buildMonthGrid,
  cellOverflow,
  dateAfterKey,
  daysInMonth,
  isMonthGridKey,
  monthGridRange,
  monthOfDate,
  monthWeeks,
  parseMonthKey,
  sameDayInMonth,
  shiftMonth,
  type MonthBlockInput,
  type MonthCommitmentInput,
  type MonthGridInput,
  type MonthTaskInput,
} from '../src/domain/monthGrid';
import { weekdayOfDate } from '../src/domain/time';

const SEOUL = 'Asia/Seoul';
const NEW_YORK = 'America/New_York';

/** A Seoul wall-clock time (UTC+9, no DST) as an instant. */
function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function grid(overrides: Partial<MonthGridInput> = {}) {
  return buildMonthGrid({
    month: '2026-11',
    timeZone: SEOUL,
    today: '2026-11-14',
    blocks: [],
    commitments: [],
    tasks: [],
    ...overrides,
  });
}

function dayOf(result: ReturnType<typeof grid>, date: string) {
  const day = result.weeks.flat().find((entry) => entry.date === date);
  if (day === undefined) throw new Error(`no cell for ${date}`);
  return day;
}

function block(id: string, startAt: string, endAt: string, status = 'planned', taskId = 'task-a'): MonthBlockInput {
  return { id, taskId, startAt, endAt, status };
}

const TASKS: MonthTaskInput[] = [
  { id: 'task-a', title: '연구 노트 요약', status: 'todo' },
  { id: 'task-b', title: '발표 개요 초안', status: 'in_progress' },
];

describe('month keys', () => {
  it('reads a month from the URL and refuses anything else (negative)', () => {
    expect(parseMonthKey('2026-11')).toBe('2026-11');
    expect(parseMonthKey('2027-01')).toBe('2027-01');
    for (const value of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', 'abc', '', '0999-05', undefined, null, 202611, ['2026-11']]) {
      expect(parseMonthKey(value), String(value)).toBeNull();
    }
  });

  it('moves across years and clamps a day to a shorter month', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-11', 13)).toBe('2027-12');
    expect(shiftMonth('2026-11', -23)).toBe('2024-12');
    expect(monthOfDate('2026-11-14')).toBe('2026-11');
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(sameDayInMonth('2026-03-31', '2026-02')).toBe('2026-02-28');
    expect(sameDayInMonth('2026-01-15', '2026-02')).toBe('2026-02-15');
    expect(() => shiftMonth('2026-13', 1)).toThrow(RangeError);
  });
});

describe('monthWeeks', () => {
  it('has one Monday-first row per week that touches the month: 6, 5 and 4 rows', () => {
    const november = monthWeeks('2026-11');
    expect(november).toHaveLength(6);
    expect(november[0]?.[0]).toBe('2026-10-26');
    expect(november.at(-1)?.at(-1)).toBe('2026-12-06');

    const december = monthWeeks('2026-12');
    expect(december).toHaveLength(5);
    expect(december[0]?.[0]).toBe('2026-11-30');
    expect(december.at(-1)?.at(-1)).toBe('2027-01-03');

    // February 2027 starts on a Monday and has 28 days.
    const february = monthWeeks('2027-02');
    expect(february).toHaveLength(4);
    expect(february[0]?.[0]).toBe('2027-02-01');
    expect(february.at(-1)?.at(-1)).toBe('2027-02-28');
  });

  it('never adds a row that lies wholly outside the month, and every row runs Monday to Sunday (negative)', () => {
    for (const month of ['2026-03', '2026-08', '2026-11', '2027-02', '2027-05']) {
      for (const week of monthWeeks(month)) {
        expect(week).toHaveLength(7);
        expect(weekdayOfDate(week[0] ?? '')).toBe(1);
        expect(weekdayOfDate(week[6] ?? '')).toBe(7);
        expect(week.some((date) => monthOfDate(date) === month)).toBe(true);
      }
    }
  });

  it('bounds the grid in the owner zone, at most 42 days, DST included', () => {
    expect(monthGridRange('2026-11', SEOUL)).toEqual({
      from: '2026-10-25T15:00:00.000Z',
      to: '2026-12-06T15:00:00.000Z',
    });
    // New York leaves daylight time on 2026-11-01: the grid starts at EDT
    // (UTC−4) and ends at EST (UTC−5).
    const range = monthGridRange('2026-11', NEW_YORK);
    expect(range).toEqual({ from: '2026-10-26T04:00:00.000Z', to: '2026-12-07T05:00:00.000Z' });
    expect(Date.parse(range.to) - Date.parse(range.from)).toBeLessThanOrEqual(42 * 24 * 3_600_000 + 3_600_000);
  });
});

describe('buildMonthGrid: placement', () => {
  it('puts a block at 23:30–00:30 on both days it touches, the second as a continuation', () => {
    const result = grid({
      blocks: [block('late', seoul('2026-11-14', '23:30'), seoul('2026-11-15', '00:30'))],
      tasks: TASKS,
    });
    const tonight = dayOf(result, '2026-11-14').items;
    const tomorrow = dayOf(result, '2026-11-15').items;
    expect(tonight).toHaveLength(1);
    expect(tonight[0]).toMatchObject({ kind: 'block', title: '연구 노트 요약', minutes: 23 * 60 + 30, continued: false });
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]).toMatchObject({ kind: 'block', minutes: 0, continued: true });
    expect(dayOf(result, '2026-11-15').counts.block).toBe(1);
  });

  it('keeps a block that ends at midnight off the next day (negative)', () => {
    const result = grid({ blocks: [block('to-midnight', seoul('2026-11-14', '23:00'), seoul('2026-11-15', '00:00'))] });
    expect(dayOf(result, '2026-11-14').items).toHaveLength(1);
    expect(dayOf(result, '2026-11-15').items).toHaveLength(0);
  });

  it('places a 약속 occurrence near midnight on the Seoul day, not the UTC day', () => {
    const commitment: MonthCommitmentInput = {
      id: 'c1',
      title: '심야 통화',
      occurrences: [
        // 00:10 on 11-15 in Seoul is still 11-14 in UTC.
        { commitmentId: 'c1', startAt: '2026-11-14T15:10:00.000Z', endAt: '2026-11-14T15:40:00.000Z' },
        // 23:50 on 11-16 in Seoul is 11-16 in UTC.
        { commitmentId: 'c1', startAt: '2026-11-16T14:50:00.000Z', endAt: '2026-11-16T14:59:00.000Z' },
      ],
    };
    const result = grid({ commitments: [commitment] });
    expect(dayOf(result, '2026-11-14').items).toHaveLength(0);
    expect(dayOf(result, '2026-11-15').items[0]).toMatchObject({ kind: 'commitment', title: '심야 통화', minutes: 10 });
    expect(dayOf(result, '2026-11-16').items[0]).toMatchObject({ kind: 'commitment', minutes: 23 * 60 + 50 });
  });

  it('follows the wall clock across the DST change in New York', () => {
    const commitment: MonthCommitmentInput = {
      id: 'c2',
      title: '야간 근무',
      occurrences: [
        // 01:30 happens twice on 2026-11-01: first in EDT, then in EST.
        { commitmentId: 'c2', startAt: '2026-11-01T05:30:00.000Z', endAt: '2026-11-01T05:45:00.000Z' },
        { commitmentId: 'c2', startAt: '2026-11-01T06:30:00.000Z', endAt: '2026-11-01T06:45:00.000Z' },
      ],
    };
    const tasks: MonthTaskInput[] = [
      // 23:30 EST on 11-01 — it would be 00:30 on 11-02 under the summer offset.
      { id: 'due', title: '보고서', status: 'todo', dueAt: '2026-11-02T04:30:00.000Z' },
    ];
    const result = grid({ timeZone: NEW_YORK, today: '2026-11-10', commitments: [commitment], tasks });
    const first = dayOf(result, '2026-11-01');
    expect(first.items.map((item) => [item.kind, item.minutes])).toEqual([
      ['commitment', 90],
      ['commitment', 90],
      ['deadline', 23 * 60 + 30],
    ]);
    expect(dayOf(result, '2026-11-02').items).toHaveLength(0);
  });

  it('lists deadlines of unfinished tasks only, on the day they are due', () => {
    const tasks: MonthTaskInput[] = [
      { id: 'due', title: '장학금 신청서 제출', status: 'todo', dueAt: seoul('2026-11-14', '23:00') },
      { id: 'working', title: '발표 자료', status: 'in_progress', dueAt: seoul('2026-11-20', '14:00') },
      { id: 'finished', title: '끝난 일', status: 'done', dueAt: seoul('2026-11-14', '12:00') },
      { id: 'open-ended', title: '마감 없는 일', status: 'todo' },
      { id: 'far', title: '내년 일', status: 'todo', dueAt: seoul('2027-03-01', '09:00') },
      { id: 'broken', title: '이상한 마감', status: 'todo', dueAt: 'not-a-date' },
    ];
    const result = grid({ tasks });
    expect(dayOf(result, '2026-11-14').items.map((item) => item.title)).toEqual(['장학금 신청서 제출']);
    expect(dayOf(result, '2026-11-14').items[0]).toMatchObject({ kind: 'deadline', endAt: null, taskId: 'due' });
    expect(dayOf(result, '2026-11-20').counts.deadline).toBe(1);
    const all = result.weeks.flat().flatMap((day) => day.items.map((item) => item.title));
    expect(all).not.toContain('끝난 일');
    expect(all).not.toContain('마감 없는 일');
    expect(all).not.toContain('내년 일');
    expect(all).not.toContain('이상한 마감');
  });

  it('shows planned and finished blocks, never skipped, moved or superseded ones (negative)', () => {
    const at = (time: string) => seoul('2026-11-18', time);
    const result = grid({
      tasks: TASKS,
      blocks: [
        block('planned', at('09:00'), at('10:00'), 'planned'),
        block('done', at('10:00'), at('11:00'), 'done', 'task-b'),
        block('skipped', at('11:00'), at('12:00'), 'skipped'),
        block('moved', at('12:00'), at('13:00'), 'moved'),
        block('superseded', at('13:00'), at('14:00'), 'superseded'),
        block('backwards', at('15:00'), at('14:00')),
        block('broken', 'not-a-date', at('16:00')),
        block('unknown-task', at('17:00'), at('18:00'), 'planned', 'task-missing'),
      ],
    });
    const items = dayOf(result, '2026-11-18').items;
    expect(items.map((item) => item.key)).toEqual(['block:planned', 'block:done', 'block:unknown-task']);
    expect(items.map((item) => item.done)).toEqual([false, true, false]);
    expect(items[2]?.title).toBeNull();
  });

  it('treats every 약속 source the same (a later Google import included)', () => {
    const imported = {
      id: 'g1',
      title: '구글에서 온 약속',
      source: 'caldav' as const,
      occurrences: [{ commitmentId: 'g1', startAt: seoul('2026-11-19', '10:00'), endAt: seoul('2026-11-19', '11:00') }],
    };
    const result = grid({ commitments: [imported] });
    expect(dayOf(result, '2026-11-19').items[0]).toMatchObject({ kind: 'commitment', commitmentId: 'g1' });
  });

  it('draws the neighbouring weeks too, but only the month itself decides "nothing planned" (negative)', () => {
    const outside = grid({ blocks: [block('october', seoul('2026-10-27', '19:00'), seoul('2026-10-27', '20:00'))] });
    expect(dayOf(outside, '2026-10-27').items).toHaveLength(1);
    expect(dayOf(outside, '2026-10-27').inMonth).toBe(false);
    expect(outside.empty).toBe(true);

    const inside = grid({ blocks: [block('november', seoul('2026-11-27', '19:00'), seoul('2026-11-27', '20:00'))] });
    expect(inside.empty).toBe(false);
    expect(grid().empty).toBe(true);
  });

  it('marks today and the days before it', () => {
    const result = grid();
    expect(dayOf(result, '2026-11-14')).toMatchObject({ today: true, past: false, inMonth: true, day: 14, weekday: 6 });
    expect(dayOf(result, '2026-11-13')).toMatchObject({ today: false, past: true });
    expect(dayOf(result, '2026-11-15')).toMatchObject({ today: false, past: false });
    expect(result.weeks.flat().filter((day) => day.today)).toHaveLength(1);
  });
});

describe('buildMonthGrid: order', () => {
  it('sorts by time, then a continuation, 약속, 블록, 마감, then by title', () => {
    const at = (time: string) => seoul('2026-11-21', time);
    const result = grid({
      tasks: [...TASKS, { id: 'due', title: '가 마감', status: 'todo', dueAt: at('10:00') }],
      blocks: [
        block('b-ten', at('10:00'), at('11:00'), 'planned', 'task-b'),
        block('a-ten', at('10:00'), at('11:00'), 'planned', 'task-a'),
        block('evening', at('19:00'), at('20:00')),
        block('overnight', seoul('2026-11-20', '23:00'), at('01:00')),
      ],
      commitments: [
        { id: 'c', title: '요가', occurrences: [{ commitmentId: 'c', startAt: at('10:00'), endAt: at('10:30') }] },
        { id: 'm', title: '자정 약속', occurrences: [{ commitmentId: 'm', startAt: at('00:00'), endAt: at('00:30') }] },
      ],
    });
    expect(dayOf(result, '2026-11-21').items.map((item) => item.key)).toEqual([
      'block:overnight',
      'commitment:m:' + at('00:00'),
      'commitment:c:' + at('10:00'),
      'block:b-ten', // 발표 개요 초안
      'block:a-ten', // 연구 노트 요약
      'deadline:due',
      'block:evening',
    ]);
  });
});

describe('cellOverflow', () => {
  it('shows everything that fits, otherwise one line less and the rest as a count', () => {
    const four = ['a', 'b', 'c', 'd'];
    expect(cellOverflow(four)).toEqual({ shown: four, hidden: 0 });
    expect(MONTH_CELL_LINES).toBe(4);
    expect(cellOverflow([...four, 'e'])).toEqual({ shown: ['a', 'b', 'c'], hidden: 2 });
    expect(cellOverflow([], 4)).toEqual({ shown: [], hidden: 0 });
  });

  it('never hides an item without counting it, whatever the room (negative)', () => {
    for (const lines of [0, 1, 2, 3.7]) {
      const { shown, hidden } = cellOverflow(['a', 'b', 'c'], lines);
      expect(shown.length + hidden).toBe(3);
      expect(shown.length).toBeLessThanOrEqual(Math.max(1, Math.floor(lines)));
    }
  });
});

describe('dateAfterKey', () => {
  it('moves by a day, a week, to the ends of the week and by a month', () => {
    expect(dateAfterKey('2026-11-14', 'ArrowLeft')).toBe('2026-11-13');
    expect(dateAfterKey('2026-11-30', 'ArrowRight')).toBe('2026-12-01');
    expect(dateAfterKey('2026-11-03', 'ArrowUp')).toBe('2026-10-27');
    expect(dateAfterKey('2026-11-28', 'ArrowDown')).toBe('2026-12-05');
    expect(dateAfterKey('2026-11-14', 'Home')).toBe('2026-11-09');
    expect(dateAfterKey('2026-11-14', 'End')).toBe('2026-11-15');
    expect(dateAfterKey('2026-03-31', 'PageUp')).toBe('2026-02-28');
    expect(dateAfterKey('2026-12-15', 'PageDown')).toBe('2027-01-15');
  });

  it('only claims the keys of the grid (negative)', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(isMonthGridKey(key)).toBe(true);
    }
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 't', 'm']) expect(isMonthGridKey(key)).toBe(false);
  });
});
