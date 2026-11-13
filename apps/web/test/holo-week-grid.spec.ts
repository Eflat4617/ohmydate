import { describe, expect, it } from 'vitest';
import {
  WEEK_GRID_FIRST_HOUR,
  WEEK_GRID_MIN_MINUTES,
  buildWeekGrid,
  initialItemKey,
  isWeekGridKey,
  itemAfterKey,
  placeCard,
  placeInLanes,
  spanPieces,
  type WeekGridInput,
  type WeekItem,
} from '../src/domain/weekGrid';
import {
  parseCivilDate,
  parsePlannerView,
  plannerDayOf,
  plannerLocation,
  plannerMonthOf,
  plannerQueryFix,
  plannerViewOf,
  plannerWeekOf,
} from '../src/domain/plannerRoute';

/**
 * HOLO-02 플래너: the week grid's layout (pure) and what an address means.
 * The week is 2026-11-09 (Mon) .. 11-15 (Sun); "now" is Sat 11-14 18:40 in Seoul.
 */
const ZONE = 'Asia/Seoul';
const WEEK = '2026-11-09';
const TODAY = '2026-11-14';
const NOW = Date.parse('2026-11-14T09:40:00.000Z');

function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function grid(overrides: Partial<WeekGridInput> = {}) {
  return buildWeekGrid({
    start: WEEK,
    timeZone: ZONE,
    today: TODAY,
    nowMs: NOW,
    blocks: [],
    commitments: [],
    tasks: [],
    ...overrides,
  });
}

function block(id: string, date: string, start: string, end: string, status = 'planned', endDate = date) {
  return { id, taskId: `task-${id}`, startAt: seoul(date, start), endAt: seoul(endDate, end), status, locked: false, version: 3 };
}

function itemsOf(result: ReturnType<typeof grid>, date: string): readonly WeekItem[] {
  return result.days.find((day) => day.date === date)?.items ?? [];
}

describe('week grid: days, kinds and the visible hours', () => {
  it('lays seven days from Monday, marks today and the days gone, and starts at 06:00', () => {
    const result = grid();
    expect(result.days.map((day) => day.date)).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
    expect(result.days.map((day) => day.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.days.filter((day) => day.today).map((day) => day.date)).toEqual([TODAY]);
    expect(result.days.filter((day) => day.past)).toHaveLength(5);
    expect(result.startHour).toBe(WEEK_GRID_FIRST_HOUR);
    expect(result.endHour).toBe(24);
    expect(result.hasEarly).toBe(false);
    expect(result.empty).toBe(true);
    expect(result.now).toEqual({ date: TODAY, minutes: 18 * 60 + 40 });
  });

  it('puts a block, a 약속 and a deadline where they are on the wall clock, each with what it needs', () => {
    const result = grid({
      blocks: [block('b1', TODAY, '19:00', '20:30'), { ...block('b2', '2026-11-10', '19:00', '20:00', 'done'), locked: true }],
      commitments: [
        { id: 'c1', title: '치과 예약', source: 'google', occurrences: [{ startAt: seoul(TODAY, '15:00'), endAt: seoul(TODAY, '15:40') }] },
      ],
      tasks: [
        { id: 'task-b1', title: '연구 노트 요약', status: 'todo', projectId: 'p1' },
        { id: 'due', title: '장학금 신청서 제출', status: 'todo', projectId: 'p2', dueAt: seoul(TODAY, '23:00') },
      ],
    });
    const today = itemsOf(result, TODAY);
    expect(today.map((item) => [item.kind, item.title, item.startMin, item.endMin])).toEqual([
      ['commitment', '치과 예약', 900, 940],
      ['block', '연구 노트 요약', 1140, 1230],
      ['deadline', '장학금 신청서 제출', 1380, 1380],
    ]);
    expect(today[0]).toMatchObject({ fromGoogle: true, commitmentId: 'c1', taskId: null, block: null });
    expect(today[1]).toMatchObject({
      taskId: 'task-b1',
      projectId: 'p1',
      done: false,
      block: { id: 'b1', locked: false, version: 3, status: 'planned' },
    });
    // A deadline is a point; it is drawn as tall as a line of text.
    expect(today[2]).toMatchObject({ endAt: null, taskId: 'due', projectId: 'p2', top: 1380, bottom: 1380 + WEEK_GRID_MIN_MINUTES });
    // The block whose task is not in the list has no title (the view names it), and done reads as done.
    const tuesday = itemsOf(result, '2026-11-10');
    expect(tuesday[0]).toMatchObject({ title: null, done: true, block: { locked: true } });
    expect(result.days.find((day) => day.date === TODAY)?.counts).toEqual({ block: 1, commitment: 1, deadline: 1 });
    expect(result.empty).toBe(false);
  });

  it('leaves out what is not on the page: other weeks, skipped blocks, done tasks (negative)', () => {
    const result = grid({
      blocks: [
        block('next-week', '2026-11-16', '10:00', '11:00'),
        block('skipped', TODAY, '10:00', '11:00', 'skipped'),
        block('moved', TODAY, '12:00', '13:00', 'moved'),
        block('superseded', TODAY, '14:00', '15:00', 'superseded'),
        block('backwards', TODAY, '16:00', '15:00'),
      ],
      commitments: [{ id: 'c', title: '다음 주', occurrences: [{ startAt: seoul('2026-11-17', '09:00'), endAt: seoul('2026-11-17', '10:00') }] }],
      tasks: [
        { id: 'done', title: '끝낸 일', status: 'done', dueAt: seoul(TODAY, '18:00') },
        { id: 'later', title: '다음 주 마감', status: 'todo', dueAt: seoul('2026-11-16', '00:00') },
        { id: 'broken', title: '날짜가 아닌 마감', status: 'todo', dueAt: 'soon' },
        { id: 'none', title: '마감 없음', status: 'todo' },
      ],
    });
    expect(result.days.flatMap((day) => day.items)).toEqual([]);
    expect(result.empty).toBe(true);
  });

  it('opens the early hours when something is there, or when they are asked for', () => {
    const early = grid({ commitments: [{ id: 'run', title: '새벽 달리기', occurrences: [{ startAt: seoul('2026-11-10', '05:20'), endAt: seoul('2026-11-10', '06:10') }] }] });
    expect(early.startHour).toBe(5);
    expect(early.hasEarly).toBe(true);
    const asked = grid({ showEarly: true });
    expect(asked.startHour).toBe(0);
    expect(asked.hasEarly).toBe(false);
    // Nothing early and not asked for: the page keeps its 06:00 start (negative).
    expect(grid({ blocks: [block('b', TODAY, '06:00', '07:00')] }).startHour).toBe(6);
  });

  it('has no now line when today is not on show, or now is before the first hour (negative)', () => {
    expect(grid({ start: '2026-11-16' }).now).toBeNull();
    expect(grid({ nowMs: Date.parse(seoul(TODAY, '04:10')) }).now).toBeNull();
    expect(grid({ nowMs: Date.parse(seoul(TODAY, '04:10')), showEarly: true }).now).toEqual({ date: TODAY, minutes: 250 });
    expect(grid({ nowMs: Number.NaN }).now).toBeNull();
  });

  it('gives a single day its items and its all-day labels', () => {
    const result = grid({
      start: TODAY,
      days: 1,
      blocks: [block('b1', TODAY, '19:00', '20:30'), block('other', '2026-11-15', '10:00', '11:00')],
      dayEvents: [
        { id: 'trip', title: '가족 여행', startDate: '2026-11-13', endDate: '2026-11-16', calendarName: '가족' },
        { id: 'gone', title: '지난 휴일', startDate: '2026-11-10', endDate: '2026-11-11', calendarName: null },
      ],
    });
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.items.map((item) => item.key)).toEqual([`block:b1@${TODAY}`]);
    expect(result.days[0]?.labels).toEqual([
      { key: 'day:trip', title: '가족 여행', calendarName: '가족', firstDate: '2026-11-13', lastDate: '2026-11-15', multiDay: true },
    ]);
    // A label never makes a day busy.
    expect(grid({ dayEvents: [{ id: 'h', title: '휴일', startDate: TODAY, endDate: '2026-11-15', calendarName: null }] }).empty).toBe(true);
  });
});

describe('week grid: midnight and daylight-saving days', () => {
  it('draws an item that crosses midnight once on each day it touches', () => {
    const result = grid({ blocks: [block('late', '2026-11-13', '23:00', '01:30', 'planned', TODAY)] });
    const friday = itemsOf(result, '2026-11-13')[0];
    const saturday = itemsOf(result, TODAY)[0];
    expect(friday).toMatchObject({ key: 'block:late@2026-11-13', startMin: 1380, endMin: 1440, continued: false, continues: true });
    expect(saturday).toMatchObject({ key: `block:late@${TODAY}`, startMin: 0, endMin: 90, continued: true, continues: false });
    // The whole item is the same on both pieces.
    expect(friday?.startAt).toBe(saturday?.startAt);
    expect(friday?.endAt).toBe(saturday?.endAt);
    // The piece after midnight is before 06:00, so the early hours open by themselves.
    expect(result.startHour).toBe(0);
  });

  it('does not touch the next day when it ends at exactly midnight (negative)', () => {
    const result = grid({ blocks: [block('evening', '2026-11-13', '22:00', '00:00', 'planned', TODAY)] });
    expect(itemsOf(result, '2026-11-13')[0]).toMatchObject({ startMin: 1320, endMin: 1440, continues: false });
    expect(itemsOf(result, TODAY)).toEqual([]);
  });

  it('clips an item that began before the first day and one that runs past the last', () => {
    expect(spanPieces(seoul('2026-11-08', '22:00'), seoul(WEEK, '02:00'), ZONE, WEEK, '2026-11-15')).toEqual([
      { date: WEEK, startMin: 0, endMin: 120, continued: true, continues: false },
    ]);
    expect(spanPieces(seoul('2026-11-15', '22:00'), seoul('2026-11-16', '02:00'), ZONE, WEEK, '2026-11-15')).toEqual([
      { date: '2026-11-15', startMin: 1320, endMin: 1440, continued: false, continues: true },
    ]);
    expect(spanPieces('not-a-time', seoul(WEEK, '02:00'), ZONE, WEEK, '2026-11-15')).toEqual([]);
    expect(spanPieces('2026-11-09', '2026-11-10', ZONE, WEEK, '2026-11-15')).toEqual([]);
  });

  it('places by the wall clock on the day the clocks go forward (a 23-hour day)', () => {
    // New York, 2026-03-08: 02:00 does not exist. 01:00 EST → 04:00 EDT is two real hours.
    const result = buildWeekGrid({
      start: '2026-03-02',
      timeZone: 'America/New_York',
      today: '2026-03-08',
      nowMs: Date.parse('2026-03-08T16:00:00.000Z'),
      blocks: [{ id: 'gap', taskId: 't', startAt: '2026-03-08T06:00:00.000Z', endAt: '2026-03-08T08:00:00.000Z', status: 'planned' }],
      commitments: [],
      tasks: [],
    });
    const sunday = itemsOf(result, '2026-03-08');
    expect(sunday[0]).toMatchObject({ startMin: 60, endMin: 240 });
    // Noon that day is 12:00 on the wall, whatever the day's length.
    expect(result.now).toEqual({ date: '2026-03-08', minutes: 12 * 60 });
  });

  it('keeps an item of the repeated hour as long as it really lasts when the clocks go back', () => {
    // New York, 2026-11-01: 01:30 EDT → 01:15 EST reads "earlier", but lasts 45 minutes.
    const pieces = spanPieces('2026-11-01T05:30:00.000Z', '2026-11-01T06:15:00.000Z', 'America/New_York', '2026-10-26', '2026-11-01');
    expect(pieces).toEqual([{ date: '2026-11-01', startMin: 90, endMin: 135, continued: false, continues: false }]);
    // A plain item across the same night is placed by the wall clock: 00:30 → 03:00.
    expect(spanPieces('2026-11-01T04:30:00.000Z', '2026-11-01T08:00:00.000Z', 'America/New_York', '2026-10-26', '2026-11-01')).toEqual([
      { date: '2026-11-01', startMin: 30, endMin: 180, continued: false, continues: false },
    ]);
  });
});

describe('week grid: what overlaps sits side by side', () => {
  it('gives two overlapping items a lane each and leaves a lone item the whole width', () => {
    const result = grid({
      blocks: [block('a', TODAY, '10:00', '12:00'), block('b', TODAY, '11:00', '13:00'), block('alone', TODAY, '15:00', '16:00')],
    });
    const lanes = Object.fromEntries(itemsOf(result, TODAY).map((item) => [item.block?.id, [item.lane, item.lanes, item.span]]));
    expect(lanes).toEqual({ a: [0, 2, 1], b: [1, 2, 1], alone: [0, 1, 1] });
  });

  it('shares one number of lanes across a chain, reuses a freed lane and widens into free ones', () => {
    // a 10–12, b 11–13, c 12–14 (touches b, not a), d 10–10:30 short next to a.
    const result = grid({
      blocks: [
        block('a', TODAY, '10:00', '12:00'),
        block('b', TODAY, '11:00', '13:00'),
        block('c', TODAY, '12:00', '14:00'),
      ],
    });
    const byId = new Map(itemsOf(result, TODAY).map((item) => [item.block?.id, item]));
    expect(byId.get('a')).toMatchObject({ lane: 0, lanes: 2 });
    expect(byId.get('b')).toMatchObject({ lane: 1, lanes: 2 });
    // c starts when a ends: it takes a's lane back.
    expect(byId.get('c')).toMatchObject({ lane: 0, lanes: 2, span: 1 });

    const wide = grid({
      blocks: [block('long', TODAY, '10:00', '14:00'), block('x', TODAY, '10:00', '11:00'), block('y', TODAY, '10:30', '11:30'), block('z', TODAY, '13:00', '14:00')],
    });
    const wideById = new Map(itemsOf(wide, TODAY).map((item) => [item.block?.id, item]));
    expect(wideById.get('long')).toMatchObject({ lane: 0, lanes: 3, span: 1 });
    // z overlaps only the long one: it widens over the two lanes beside it.
    expect(wideById.get('z')).toMatchObject({ lane: 1, lanes: 3, span: 2 });
  });

  it('counts a short item and a deadline by the height they are drawn at', () => {
    // 10:00–10:10 is drawn to 10:30, so 10:15 is beside it, not on it.
    const result = grid({
      blocks: [block('short', TODAY, '10:00', '10:10'), block('next', TODAY, '10:15', '11:00')],
      tasks: [{ id: 'due', title: '마감', status: 'todo', dueAt: seoul(TODAY, '10:50') }],
    });
    const items = itemsOf(result, TODAY);
    expect(items.map((item) => [item.kind, item.lane, item.lanes])).toEqual([
      ['block', 0, 2],
      ['block', 1, 2],
      ['deadline', 0, 2],
    ]);
    // An item at the very end of the day is drawn inside the day.
    const late = grid({ tasks: [{ id: 'late', title: '자정 직전', status: 'todo', dueAt: seoul(TODAY, '23:50') }] });
    expect(itemsOf(late, TODAY)[0]).toMatchObject({ startMin: 1430, top: 1410, bottom: 1440 });
  });

  it('does not set items of different days, or items that only touch, side by side (negative)', () => {
    const result = grid({
      blocks: [block('mon', WEEK, '10:00', '12:00'), block('tue', '2026-11-10', '10:00', '12:00'), block('after', WEEK, '12:00', '13:00')],
    });
    expect(result.days.flatMap((day) => day.items).every((item) => item.lanes === 1 && item.lane === 0)).toBe(true);
    expect(placeInLanes([])).toEqual([]);
  });
});

describe('week grid: the keyboard walks items', () => {
  const result = grid({
    blocks: [
      block('mon-am', WEEK, '09:00', '10:00'),
      block('mon-pm', WEEK, '19:00', '20:00'),
      block('wed', '2026-11-11', '18:30', '19:30'),
      block('sat-am', TODAY, '10:00', '11:00'),
      block('sat-pm', TODAY, '19:00', '20:30'),
      block('sat-late', TODAY, '21:00', '21:40'),
    ],
  });
  const key = (id: string, date: string): string => `block:${id}@${date}`;

  it('goes up and down through a day, and to its ends with Home and End', () => {
    expect(itemAfterKey(result.days, key('mon-am', WEEK), 'ArrowDown')).toBe(key('mon-pm', WEEK));
    expect(itemAfterKey(result.days, key('mon-pm', WEEK), 'ArrowUp')).toBe(key('mon-am', WEEK));
    expect(itemAfterKey(result.days, key('sat-am', TODAY), 'End')).toBe(key('sat-late', TODAY));
    expect(itemAfterKey(result.days, key('sat-late', TODAY), 'Home')).toBe(key('sat-am', TODAY));
  });

  it('goes left and right to the nearest day that holds anything, landing on the closest start', () => {
    // From Monday evening: Tuesday is empty, Wednesday has one at 18:30.
    expect(itemAfterKey(result.days, key('mon-pm', WEEK), 'ArrowRight')).toBe(key('wed', '2026-11-11'));
    // From Wednesday 18:30 to Saturday: 19:00 is closer than 10:00 or 21:00.
    expect(itemAfterKey(result.days, key('wed', '2026-11-11'), 'ArrowRight')).toBe(key('sat-pm', TODAY));
    expect(itemAfterKey(result.days, key('sat-am', TODAY), 'ArrowLeft')).toBe(key('wed', '2026-11-11'));
  });

  it('stays where it is at an edge, and knows only its own keys (negative)', () => {
    expect(itemAfterKey(result.days, key('mon-am', WEEK), 'ArrowUp')).toBeNull();
    expect(itemAfterKey(result.days, key('mon-am', WEEK), 'ArrowLeft')).toBeNull();
    expect(itemAfterKey(result.days, key('sat-late', TODAY), 'ArrowDown')).toBeNull();
    expect(itemAfterKey(result.days, key('sat-late', TODAY), 'ArrowRight')).toBeNull();
    expect(itemAfterKey(result.days, key('sat-am', TODAY), 'Home')).toBeNull();
    expect(itemAfterKey(result.days, 'block:nope@2026-11-09', 'ArrowDown')).toBeNull();
    expect(isWeekGridKey('ArrowDown')).toBe(true);
    expect(isWeekGridKey('Enter')).toBe(false);
    expect(isWeekGridKey('PageDown')).toBe(false);
  });

  it('starts the tab stop on today’s next item, else on the first item there is', () => {
    // Now is 18:40: the 10:00 block is over, 19:00 is next.
    expect(initialItemKey(result)).toBe(key('sat-pm', TODAY));
    const evening = grid({ nowMs: Date.parse(seoul(TODAY, '23:30')), blocks: [block('sat-am', TODAY, '10:00', '11:00')] });
    expect(initialItemKey(evening)).toBe(key('sat-am', TODAY));
    const otherWeek = grid({ start: '2026-11-16', blocks: [block('next', '2026-11-18', '10:00', '11:00')] });
    expect(initialItemKey(otherWeek)).toBe(key('next', '2026-11-18'));
    expect(initialItemKey(grid())).toBeNull();
  });
});

describe('the floating card stands beside its item, inside the frame', () => {
  const frame = { left: 0, top: 0, width: 800, height: 600 };
  const card = { width: 320, height: 200 };

  it('stands to the right when it fits, else to the left, else below, else above', () => {
    expect(placeCard({ left: 100, top: 50, width: 100, height: 60 }, card, frame)).toEqual({ left: 208, top: 50, side: 'right' });
    expect(placeCard({ left: 600, top: 50, width: 100, height: 60 }, card, frame)).toEqual({ left: 272, top: 50, side: 'left' });
    const narrow = { left: 0, top: 0, width: 360, height: 600 };
    expect(placeCard({ left: 120, top: 50, width: 110, height: 60 }, card, narrow)).toEqual({ left: 32, top: 118, side: 'below' });
    expect(placeCard({ left: 120, top: 500, width: 110, height: 60 }, card, narrow)).toEqual({ left: 32, top: 292, side: 'above' });
  });

  it('slides along the other axis to stay in the frame, also in a scrolled frame', () => {
    // Near the bottom: the card moves up so its foot is inside.
    expect(placeCard({ left: 100, top: 560, width: 100, height: 30 }, card, frame).top).toBe(392);
    // The visible part of a scrolled grid starts at (300, 900).
    const scrolled = { left: 300, top: 900, width: 800, height: 600 };
    expect(placeCard({ left: 320, top: 880, width: 100, height: 60 }, card, scrolled)).toEqual({ left: 428, top: 908, side: 'right' });
  });

  it('never leaves the frame when nothing fits whole (negative)', () => {
    const tiny = { left: 0, top: 0, width: 300, height: 220 };
    const placed = placeCard({ left: 100, top: 100, width: 100, height: 60 }, card, tiny);
    expect(placed.side).toBe('below');
    expect(placed.top).toBeGreaterThanOrEqual(8);
    expect(placed.left).toBeGreaterThanOrEqual(-28);
  });
});

describe('what a planner address means', () => {
  it('reads the view: 주 by default, `view` when it names one, and 월 on /month', () => {
    expect(plannerViewOf('planner', {})).toBe('week');
    expect(plannerViewOf('planner', { view: 'day' })).toBe('day');
    expect(plannerViewOf('planner', { view: 'month' })).toBe('month');
    expect(plannerViewOf('month', {})).toBe('month');
    // /month stays the month view whatever its query says.
    expect(plannerViewOf('month', { view: 'day' })).toBe('month');
    expect(parsePlannerView('week')).toBe('week');
  });

  it('falls back when the view or a date is not one (negative)', () => {
    expect(plannerViewOf('planner', { view: 'year' })).toBe('week');
    expect(plannerViewOf('planner', { view: ['day', 'month'] })).toBe('week');
    expect(parsePlannerView(undefined)).toBeNull();
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '0999-01-01', 'today', '', null, undefined, ['2026-11-14']]) {
      expect(parseCivilDate(bad), String(bad)).toBeNull();
    }
    expect(parseCivilDate('2028-02-29')).toBe('2028-02-29');
    expect(plannerDayOf({ d: '2026-02-30' }, TODAY)).toBe(TODAY);
    expect(plannerWeekOf({ w: 'next' }, TODAY)).toBe(WEEK);
    expect(plannerMonthOf({ m: '2026-13' }, TODAY)).toBe('2026-11');
  });

  it('reads the day, the week (from any of its days) and the month', () => {
    expect(plannerDayOf({}, TODAY)).toBe(TODAY);
    expect(plannerDayOf({ d: '2026-11-20' }, TODAY)).toBe('2026-11-20');
    expect(plannerWeekOf({}, TODAY)).toBe(WEEK);
    expect(plannerWeekOf({ w: '2026-11-16' }, TODAY)).toBe('2026-11-16');
    expect(plannerWeekOf({ w: '2026-11-18' }, TODAY)).toBe('2026-11-16');
    expect(plannerMonthOf({}, TODAY)).toBe('2026-11');
    expect(plannerMonthOf({ m: '2027-01' }, TODAY)).toBe('2027-01');
  });

  it('writes the address of a view and a date, leaving out what is the default', () => {
    expect(plannerLocation('week', TODAY, TODAY)).toEqual({ name: 'planner', query: {} });
    expect(plannerLocation('week', '2026-11-18', TODAY)).toEqual({ name: 'planner', query: { w: '2026-11-16' } });
    expect(plannerLocation('day', TODAY, TODAY)).toEqual({ name: 'planner', query: { view: 'day' } });
    expect(plannerLocation('day', '2026-11-20', TODAY)).toEqual({ name: 'planner', query: { view: 'day', d: '2026-11-20' } });
    expect(plannerLocation('month', TODAY, TODAY)).toEqual({ name: 'planner', query: { view: 'month' } });
    expect(plannerLocation('month', '2026-12-25', TODAY)).toEqual({ name: 'planner', query: { view: 'month', m: '2026-12' } });
    // On /month the month view keeps its own address; leaving it goes to /planner.
    expect(plannerLocation('month', '2026-12-25', TODAY, 'month')).toEqual({ name: 'month', query: { m: '2026-12' } });
    expect(plannerLocation('month', TODAY, TODAY, 'month')).toEqual({ name: 'month', query: {} });
    expect(plannerLocation('week', TODAY, TODAY, 'month')).toEqual({ name: 'planner', query: {} });
  });

  it('round-trips: the address it writes means what was asked', () => {
    for (const [view, anchor] of [
      ['day', '2026-12-31'],
      ['week', '2027-01-01'],
      ['month', '2027-02-10'],
    ] as const) {
      const location = plannerLocation(view, anchor, TODAY);
      expect(plannerViewOf(location.name, location.query)).toBe(view);
      if (view === 'day') expect(plannerDayOf(location.query, TODAY)).toBe(anchor);
      if (view === 'week') expect(plannerWeekOf(location.query, TODAY)).toBe('2026-12-28');
      if (view === 'month') expect(plannerMonthOf(location.query, TODAY)).toBe('2027-02');
    }
  });

  it('says what to correct in an address, and nothing when it is sound', () => {
    expect(plannerQueryFix('planner', {})).toBeNull();
    expect(plannerQueryFix('planner', { view: 'week', w: '2026-11-16' })).toBeNull();
    expect(plannerQueryFix('planner', { view: 'day', d: '2026-11-20' })).toBeNull();
    expect(plannerQueryFix('month', { m: '2026-12' })).toBeNull();
    // A key the view does not read is left alone, even when it is nonsense.
    expect(plannerQueryFix('planner', { view: 'day', w: 'x', m: 'y' })).toBeNull();

    expect(plannerQueryFix('planner', { view: 'year' })).toEqual({ drop: ['view'], set: {} });
    expect(plannerQueryFix('planner', { view: 'day', d: '2026-02-30' })).toEqual({ drop: ['d'], set: {} });
    expect(plannerQueryFix('planner', { w: 'soon' })).toEqual({ drop: ['w'], set: {} });
    // A week given by a Wednesday is moved to its Monday.
    expect(plannerQueryFix('planner', { w: '2026-11-18' })).toEqual({ drop: [], set: { w: '2026-11-16' } });
    expect(plannerQueryFix('planner', { view: 'month', m: '2026-13' })).toEqual({ drop: ['m'], set: {} });
    expect(plannerQueryFix('month', { m: '2026-13' })).toEqual({ drop: ['m'], set: {} });
    // /month ignores `view`, so a strange one there is not this screen's to correct.
    expect(plannerQueryFix('month', { view: 'year' })).toBeNull();
  });
});
