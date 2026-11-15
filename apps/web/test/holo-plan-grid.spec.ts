import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import WeekGrid from '../src/components/planner/WeekGrid.vue';
import {
  EDIT_GRID_MINUTES,
  activeDays,
  candidateDifference,
  candidateFigures,
  candidateLead,
  candidateRisk,
  dailyLoad,
  defaultHorizonDates,
  dragMinutes,
  finishAt,
  firstStartAt,
  horizonDates,
  loadWindow,
  movedInterval,
  resizedInterval,
  sameBlocks,
  withBlock,
  type CandidateFigures,
} from '../src/domain/planDraft';
import { availabilityBands, buildWeekGrid, type WeekAvailabilityInput, type WeekGridInput } from '../src/domain/weekGrid';

/**
 * HOLO-03A: the week grid is the product's one calendar. These cover what the
 * planning screens add to it — proposals, ghosts, availability bands and the
 * editing of a proposal — and the numbers the comparison is made of.
 * The week is 2026-11-09 (Mon) .. 11-15 (Sun) in Seoul unless a test says otherwise.
 */
const ZONE = 'Asia/Seoul';
const WEEK = '2026-11-09';
const TASK = '01900000-0000-7000-8000-000000000099';

function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function grid(overrides: Partial<WeekGridInput> = {}) {
  return buildWeekGrid({
    start: WEEK,
    timeZone: ZONE,
    today: '2026-11-08',
    nowMs: Date.parse('2026-11-08T03:00:00.000Z'),
    blocks: [],
    commitments: [],
    tasks: [{ id: TASK, title: '보고서 초안', status: 'todo' }],
    ...overrides,
  });
}

function rules(weekdays: readonly number[], kind = 'work'): WeekAvailabilityInput['rules'] {
  return weekdays.map((weekday) => ({ weekday, startLocal: '09:00', endLocal: '18:00', kind }));
}

describe('week grid: proposals and ghosts', () => {
  it('places a proposal by its wall clock, names its task and remembers where it came from', () => {
    const result = grid({
      proposals: [
        { index: 0, taskId: TASK, startAt: seoul('2026-11-10', '09:00'), endAt: seoul('2026-11-10', '10:30') },
        { index: 3, taskId: TASK, startAt: seoul('2026-11-12', '14:00'), endAt: seoul('2026-11-12', '15:00'), invalid: true },
      ],
    });
    const tuesday = result.days[1];
    expect(tuesday?.items).toHaveLength(1);
    expect(tuesday?.items[0]).toMatchObject({
      key: 'proposal:0@2026-11-10',
      kind: 'proposal',
      title: '보고서 초안',
      startMin: 540,
      endMin: 630,
      proposalIndex: 0,
      invalid: false,
      block: null,
    });
    expect(tuesday?.counts.proposal).toBe(1);
    expect(result.days[3]?.items[0]).toMatchObject({ proposalIndex: 3, invalid: true });
    expect(result.empty).toBe(false);
  });

  it('an approved block is never a proposal: it keeps its own kind and carries no proposal index (negative)', () => {
    const result = grid({
      blocks: [
        { id: 'b1', taskId: TASK, startAt: seoul('2026-11-10', '09:00'), endAt: seoul('2026-11-10', '10:00'), status: 'planned', locked: true, version: 2 },
      ],
      proposals: [{ index: 0, taskId: TASK, startAt: seoul('2026-11-10', '09:30'), endAt: seoul('2026-11-10', '10:30') }],
    });
    const items = result.days[1]?.items ?? [];
    expect(items.map((item) => item.kind)).toEqual(['block', 'proposal']);
    expect(items[0]).toMatchObject({ proposalIndex: null, invalid: false, change: null });
    expect(items[0]?.block?.locked).toBe(true);
    // What overlaps sits side by side, so neither hides the other.
    expect(items.map((item) => [item.lane, item.lanes])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it('draws where a block stood as a ghost with what the 재계획 does to it', () => {
    const result = grid({
      ghosts: [{ key: 'old', taskId: TASK, startAt: seoul('2026-11-11', '19:00'), endAt: seoul('2026-11-11', '20:00'), change: 'moved' }],
      proposals: [{ index: 0, taskId: TASK, startAt: seoul('2026-11-12', '19:00'), endAt: seoul('2026-11-12', '20:00'), change: 'moved' }],
    });
    expect(result.days[2]?.items[0]).toMatchObject({ key: 'ghost:old@2026-11-11', kind: 'ghost', change: 'moved', proposalIndex: null });
    expect(result.days[3]?.items[0]).toMatchObject({ kind: 'proposal', change: 'moved' });
    expect(result.days[2]?.counts.ghost).toBe(1);
  });

  it('places proposals by local wall clock across the America/New_York fall-back (2026-11-01)', () => {
    const result = buildWeekGrid({
      start: '2026-11-01',
      days: 2,
      timeZone: 'America/New_York',
      today: '2026-10-30',
      nowMs: Date.parse('2026-10-30T12:00:00.000Z'),
      blocks: [],
      commitments: [],
      tasks: [],
      proposals: [
        { index: 0, taskId: TASK, startAt: '2026-11-01T04:30:00.000Z', endAt: '2026-11-01T05:30:00.000Z' },
        // Starts at 01:30 EDT and ends at 01:30 EST: the repeated hour, one real hour long.
        { index: 1, taskId: TASK, startAt: '2026-11-01T05:30:00.000Z', endAt: '2026-11-01T06:30:00.000Z' },
        { index: 2, taskId: TASK, startAt: '2026-11-02T05:30:00.000Z', endAt: '2026-11-02T06:30:00.000Z' },
      ],
    });
    const sunday = result.days[0]?.items ?? [];
    expect(sunday.map((item) => [item.startMin, item.endMin])).toEqual([
      [30, 90],
      [90, 150],
    ]);
    expect(result.days[1]?.items.map((item) => [item.startMin, item.endMin])).toEqual([[30, 90]]);
  });
});

describe('week grid: available hours, focus windows and 쉼', () => {
  const weekdays = { rules: rules([1, 2, 3, 4, 5]), exceptions: [] } satisfies WeekAvailabilityInput;

  it('draws the weekly rule of a weekday and nothing on a day no rule covers', () => {
    expect(availabilityBands('2026-11-10', weekdays)).toEqual([{ kind: 'work', startMin: 540, endMin: 1080, allDay: false }]);
    expect(availabilityBands('2026-11-14', weekdays)).toEqual([]);
    const result = grid({ availability: weekdays });
    expect(result.days.map((day) => day.bands.length)).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(result.days.every((day) => !day.off)).toBe(true);
  });

  it('draws a 쉼 band on a day without any weekly rule, and marks the day', () => {
    const bands = availabilityBands('2026-11-14', {
      rules: weekdays.rules,
      exceptions: [{ date: '2026-11-14', kind: 'off', startLocal: '10:00', endLocal: '18:00' }],
    });
    expect(bands).toEqual([{ kind: 'off', startMin: 600, endMin: 1080, allDay: false }]);
    const result = grid({
      availability: { rules: weekdays.rules, exceptions: [{ date: '2026-11-14', kind: 'off', startLocal: '10:00', endLocal: '18:00' }] },
    });
    expect(result.days[5]?.off).toBe(true);
    expect(result.days[4]?.off).toBe(false);
  });

  it('a 쉼 without times covers the whole day', () => {
    expect(availabilityBands('2026-11-15', { rules: [], exceptions: [{ date: '2026-11-15', kind: 'off' }] })).toEqual([
      { kind: 'off', startMin: 0, endMin: 1440, allDay: true },
    ]);
  });

  it('a 쉼 cuts the available hours of a rule day and stays a band of its own', () => {
    const bands = availabilityBands('2026-11-10', {
      rules: weekdays.rules,
      exceptions: [{ date: '2026-11-10', kind: 'off', startLocal: '12:00', endLocal: '14:00' }],
    });
    expect(bands).toEqual([
      { kind: 'work', startMin: 540, endMin: 720, allDay: false },
      { kind: 'off', startMin: 720, endMin: 840, allDay: false },
      { kind: 'work', startMin: 840, endMin: 1080, allDay: false },
    ]);
  });

  it('a 추가 is more available time, never a 쉼; a focus rule is its own kind (negative)', () => {
    const bands = availabilityBands('2026-11-14', {
      rules: [{ weekday: 6, startLocal: '08:00', endLocal: '10:00', kind: 'focus' }],
      exceptions: [{ date: '2026-11-14', kind: 'extra', startLocal: '13:00', endLocal: '15:00' }],
    });
    expect(bands.map((band) => band.kind)).toEqual(['focus', 'extra']);
    expect(bands.some((band) => band.kind === 'off')).toBe(false);
  });

  it('without availability a day has no band at all (negative)', () => {
    expect(grid().days.every((day) => day.bands.length === 0 && !day.off)).toBe(true);
    expect(grid({ availability: null }).days.every((day) => day.bands.length === 0)).toBe(true);
  });

  it('ignores a rule or exception it cannot read instead of drawing it somewhere (negative)', () => {
    expect(
      availabilityBands('2026-11-10', {
        rules: [
          { weekday: 2, startLocal: 'soon', endLocal: '18:00', kind: 'work' },
          { weekday: 2, startLocal: '18:00', endLocal: '09:00', kind: 'work' },
        ],
        exceptions: [{ date: '2026-11-10', kind: 'off', startLocal: '14:00', endLocal: '12:00' }],
      }),
    ).toEqual([]);
  });
});

describe('editing a candidate block (pure)', () => {
  const block = { taskId: TASK, startAt: seoul('2026-11-10', '09:00'), endAt: seoul('2026-11-10', '10:00') };

  it('moves a block and keeps its length', () => {
    expect(movedInterval(block, EDIT_GRID_MINUTES)).toEqual({
      startAt: seoul('2026-11-10', '09:05'),
      endAt: seoul('2026-11-10', '10:05'),
    });
    expect(movedInterval(block, -30)).toEqual({ startAt: seoul('2026-11-10', '08:30'), endAt: seoul('2026-11-10', '09:30') });
  });

  it('resizes from the end, and never below one step (negative)', () => {
    expect(resizedInterval(block, 15)).toEqual({ startAt: block.startAt, endAt: seoul('2026-11-10', '10:15') });
    expect(resizedInterval(block, -600)).toEqual({ startAt: block.startAt, endAt: seoul('2026-11-10', '09:05') });
  });

  it('turns a drag into whole five-minute steps; a tiny drag or a bad axis is no move (negative)', () => {
    expect(dragMinutes(52, 52)).toBe(60);
    expect(dragMinutes(-13, 52)).toBe(-15);
    expect(dragMinutes(1.5, 52)).toBe(0);
    expect(Object.is(dragMinutes(-1, 52), 0)).toBe(true);
    expect(dragMinutes(40, 0)).toBe(0);
    expect(dragMinutes(Number.NaN, 52)).toBe(0);
  });

  it('replaces one block of a list and leaves the list it was given alone', () => {
    const blocks = [block, { ...block, startAt: seoul('2026-11-11', '09:00'), endAt: seoul('2026-11-11', '10:00') }];
    const next = withBlock(blocks, 1, movedInterval(blocks[1] ?? block, 5));
    expect(next[0]).toEqual(blocks[0]);
    expect(next[1]?.startAt).toBe(seoul('2026-11-11', '09:05'));
    expect(blocks[1]?.startAt).toBe(seoul('2026-11-11', '09:00'));
    expect(sameBlocks(blocks, next)).toBe(false);
    expect(sameBlocks(blocks, withBlock(blocks, 9, movedInterval(block, 5)))).toBe(true);
  });
});

describe('what a candidate card says (pure)', () => {
  const horizon = { start: seoul('2026-11-09', '00:00'), end: seoul('2026-11-16', '00:00') };
  const dates = horizonDates(horizon, ZONE);

  function candidate(blocks: [string, string, string][], metrics: Partial<CandidateFigures> = {}, feasible = true) {
    return {
      feasible,
      deficitMin: metrics.deficitMin ?? 0,
      blocks: blocks.map(([date, start, end]) => ({ startAt: seoul(date, start), endAt: seoul(date, end) })),
      metrics: {
        minSlackMin: metrics.minSlackMin ?? 600,
        maxDailyLoadMin: metrics.maxDailyLoadMin ?? 120,
        totalFocusMin: metrics.totalFocusMin ?? 240,
        contextSwitches: metrics.contextSwitches ?? 2,
        p90CoverageRatio: metrics.p90Coverage ?? 1,
      },
    };
  }

  it('lists the days of a horizon; an end at midnight belongs to the day before', () => {
    expect(dates).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(horizonDates({ start: 'nonsense', end: horizon.end }, ZONE)).toEqual([]);
  });

  it('adds up the minutes of each day and knows when the schedule starts and ends', () => {
    const front = candidate([
      ['2026-11-09', '09:00', '11:00'],
      ['2026-11-09', '14:00', '15:00'],
      ['2026-11-10', '09:00', '10:00'],
    ]);
    const load = dailyLoad(front.blocks, dates, ZONE);
    expect(load).toEqual([180, 60, 0, 0, 0, 0, 0]);
    expect(activeDays(load)).toBe(2);
    expect(finishAt(front.blocks)).toBe(seoul('2026-11-10', '10:00'));
    expect(firstStartAt(front.blocks)).toBe(seoul('2026-11-09', '09:00'));
    expect(candidateFigures(front, dates, ZONE)).toMatchObject({ finishDate: '2026-11-10', days: 2, maxDailyLoadMin: 120 });
  });

  it('a schedule without blocks has no end and no load (negative)', () => {
    const none = candidate([], { deficitMin: 90 }, false);
    expect(finishAt(none.blocks)).toBeNull();
    expect(firstStartAt(none.blocks)).toBeNull();
    expect(dailyLoad(none.blocks, dates, ZONE).every((minutes) => minutes === 0)).toBe(true);
    expect(candidateFigures(none, dates, ZONE)).toMatchObject({ finishAt: null, finishDate: null, days: 0 });
  });

  it('shows the strip from the first to the last day any candidate uses', () => {
    expect(
      loadWindow(
        [
          [0, 60, 0, 0, 0, 0, 0],
          [0, 0, 30, 0, 90, 0, 0],
        ],
        dates,
      ),
    ).toEqual({ from: 1, to: 4 });
    expect(loadWindow([[0, 0, 0, 0, 0, 0, 0]], dates)).toEqual({ from: 0, to: 6 });
  });

  it('reads the risk off the numbers, the worst first', () => {
    const base = { feasible: true, deficitMin: 0, minSlackMin: 300, p90Coverage: 1 };
    expect(candidateRisk(base)).toBe('ok');
    expect(candidateRisk({ ...base, p90Coverage: 0.82 })).toBe('tight');
    expect(candidateRisk({ ...base, minSlackMin: -30, p90Coverage: 0.5 })).toBe('late');
    expect(candidateRisk({ ...base, feasible: false })).toBe('unplaced');
    expect(candidateRisk({ ...base, deficitMin: 45, minSlackMin: -30 })).toBe('unplaced');
  });

  it('says how a candidate differs from the picked one, and what it alone is best at', () => {
    const early = candidateFigures(candidate([['2026-11-10', '09:00', '13:00']], { maxDailyLoadMin: 240, minSlackMin: 4000, contextSwitches: 3 }), dates, ZONE);
    const even = candidateFigures(
      candidate(
        [
          ['2026-11-10', '09:00', '10:00'],
          ['2026-11-13', '09:00', '10:00'],
        ],
        { maxDailyLoadMin: 60, minSlackMin: 1000, contextSwitches: 3 },
      ),
      dates,
      ZONE,
    );
    const blocked = candidateFigures(candidate([['2026-11-13', '09:00', '11:00']], { maxDailyLoadMin: 120, minSlackMin: 1000, contextSwitches: 1 }), dates, ZONE);
    expect(candidateDifference(even, early)).toEqual({ finishDays: 3, maxDailyLoadMin: -180, slackMin: -3000 });
    expect(candidateLead(0, [early, even, blocked])).toBe('earliest');
    expect(candidateLead(1, [early, even, blocked])).toBe('lightest');
    expect(candidateLead(2, [early, even, blocked])).toBe('fewestSwitches');
  });

  it('a shared lead is no lead, and one candidate alone leads in nothing (negative)', () => {
    const one = candidateFigures(candidate([['2026-11-10', '09:00', '10:00']]), dates, ZONE);
    expect(candidateLead(0, [one, one])).toBeNull();
    expect(candidateLead(0, [one])).toBeNull();
    expect(candidateLead(4, [one, one])).toBeNull();
    const none = candidateFigures(candidate([], {}, false), dates, ZONE);
    expect(candidateDifference(none, one).finishDays).toBeNull();
  });

  it('a new plan covers a fortnight, or up to the due day when that is later, never past the bound', () => {
    expect(defaultHorizonDates('2026-11-14', null)).toEqual({ start: '2026-11-14', end: '2026-11-27' });
    expect(defaultHorizonDates('2026-11-14', '2026-11-20')).toEqual({ start: '2026-11-14', end: '2026-11-27' });
    expect(defaultHorizonDates('2026-11-14', '2026-12-10')).toEqual({ start: '2026-11-14', end: '2026-12-10' });
    expect(defaultHorizonDates('2026-11-14', '2027-11-01')).toEqual({ start: '2026-11-14', end: '2027-02-11' });
    expect(defaultHorizonDates('2026-11-14', 'someday')).toEqual({ start: '2026-11-14', end: '2026-11-27' });
  });
});

/** jsdom has no PointerEvent: a mouse event of that name carries what the grid reads (button, clientY). */
function press(element: Element, clientY: number): void {
  element.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientY, bubbles: true }));
}

describe('WeekGrid: proposals on the page', () => {
  function mountGrid(props: Record<string, unknown> = {}, input: Partial<WeekGridInput> = {}) {
    return mount(WeekGrid, {
      attachTo: document.body,
      props: {
        grid: grid({
          proposals: [
            { index: 0, taskId: TASK, startAt: seoul('2026-11-10', '09:00'), endAt: seoul('2026-11-10', '10:30') },
            { index: 1, taskId: TASK, startAt: seoul('2026-11-12', '14:00'), endAt: seoul('2026-11-12', '15:00') },
          ],
          ...input,
        }),
        timeZone: ZONE,
        label: '11월 9일 ~ 11월 15일 주간 일정',
        ...props,
      },
    });
  }

  it('a proposal is drawn as a proposal and says so; an approved block keeps the fill', () => {
    const wrapper = mountGrid(
      {},
      {
        blocks: [
          { id: 'b1', taskId: TASK, startAt: seoul('2026-11-11', '09:00'), endAt: seoul('2026-11-11', '10:00'), status: 'planned', locked: true, version: 2 },
        ],
      },
    );
    const proposal = wrapper.get('[data-item="proposal:0@2026-11-10"]');
    expect(proposal.classes()).toContain('wg-item--proposal');
    expect(proposal.classes()).not.toContain('wg-item--block');
    expect(proposal.attributes('aria-label')).toBe('일정안 블록, 보고서 초안, 11월 10일 (화) 오전 9:00~10:30');
    const approved = wrapper.get('[data-kind="block"]');
    expect(approved.classes()).toContain('wg-item--block');
    expect(approved.classes()).toContain('wg-item--locked');
    expect(approved.classes()).not.toContain('wg-item--proposal');
    expect(approved.attributes('aria-label')).toMatch(/^고정된 블록, 보고서 초안, /);
    expect(wrapper.get('[data-date="2026-11-10"][role="group"]').attributes('aria-label')).toContain('일정안 블록 1개');
    wrapper.unmount();
  });

  it('a block the server refused is marked invalid in its name and for assistive technology', () => {
    const wrapper = mountGrid(
      {},
      { proposals: [{ index: 0, taskId: TASK, startAt: seoul('2026-11-10', '09:00'), endAt: seoul('2026-11-10', '10:30'), invalid: true }] },
    );
    const item = wrapper.get('[data-item="proposal:0@2026-11-10"]');
    expect(item.attributes('aria-invalid')).toBe('true');
    expect(item.attributes('aria-label')).toMatch(/^확인이 필요한 일정안 블록, /);
    expect(item.classes()).toContain('wg-item--invalid');
    wrapper.unmount();
  });

  it('Alt + arrows move a proposal five minutes, with Shift its length; the grid only says what it would become', async () => {
    const wrapper = mountGrid({ editable: true });
    const item = wrapper.get('[data-item="proposal:0@2026-11-10"]');
    await item.trigger('keydown', { key: 'ArrowDown', altKey: true });
    await item.trigger('keydown', { key: 'ArrowUp', altKey: true });
    await item.trigger('keydown', { key: 'ArrowDown', altKey: true, shiftKey: true });
    const edits = wrapper.emitted('edit') ?? [];
    expect(edits.map((edit) => edit[1])).toEqual([
      { startAt: seoul('2026-11-10', '09:05'), endAt: seoul('2026-11-10', '10:35') },
      { startAt: seoul('2026-11-10', '08:55'), endAt: seoul('2026-11-10', '10:25') },
      { startAt: seoul('2026-11-10', '09:00'), endAt: seoul('2026-11-10', '10:35') },
    ]);
    expect((edits[0]?.[0] as { proposalIndex: number }).proposalIndex).toBe(0);
    wrapper.unmount();
  });

  it('plain arrows only walk the grid: they never edit (negative)', async () => {
    const wrapper = mountGrid({ editable: true });
    await wrapper.get('[data-item="proposal:0@2026-11-10"]').trigger('keydown', { key: 'ArrowRight' });
    await wrapper.get('[data-item="proposal:0@2026-11-10"]').trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.emitted('edit')).toBeUndefined();
    expect(document.activeElement?.getAttribute('data-item')).toBe('proposal:1@2026-11-12');
    wrapper.unmount();
  });

  it('while editing is off every try is refused and reported, and nothing changes (negative)', async () => {
    const wrapper = mountGrid({ editable: false, proposalDescribedBy: 'why-not' });
    const item = wrapper.get('[data-item="proposal:0@2026-11-10"]');
    expect(item.attributes('aria-describedby')).toBe('why-not');
    expect(item.find('[data-resize]').exists()).toBe(false);
    await item.trigger('keydown', { key: 'ArrowDown', altKey: true });
    press(item.element, 100);
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 160 }));
    expect(wrapper.emitted('edit')).toBeUndefined();
    expect(wrapper.emitted('edit-blocked')).toHaveLength(2);
    wrapper.unmount();
  });

  it('an approved block or a 약속 cannot be edited whatever is pressed (negative)', async () => {
    const wrapper = mountGrid(
      { editable: true },
      {
        proposals: [],
        blocks: [{ id: 'b1', taskId: TASK, startAt: seoul('2026-11-11', '09:00'), endAt: seoul('2026-11-11', '10:00'), status: 'planned', version: 1 }],
      },
    );
    const block = wrapper.get('[data-kind="block"]');
    await block.trigger('keydown', { key: 'ArrowDown', altKey: true });
    press(block.element, 100);
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 200 }));
    expect(wrapper.emitted('edit')).toBeUndefined();
    expect(wrapper.emitted('edit-blocked')).toBeUndefined();
    wrapper.unmount();
  });

  it('a drag moves a proposal by the axis, its lower edge resizes, and the press that dragged opens no card', async () => {
    const wrapper = mountGrid({ editable: true });
    const body = wrapper.get('[data-week-body]').element as HTMLElement;
    // 18 hours on the page (06:00–24:00): one hour is 50px tall here.
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 900 });
    const item = wrapper.get('[data-item="proposal:0@2026-11-10"]');

    press(item.element, 100);
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 125 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientY: 125 }));
    await item.trigger('click');
    expect((wrapper.emitted('edit') ?? []).map((edit) => edit[1])).toEqual([
      { startAt: seoul('2026-11-10', '09:30'), endAt: seoul('2026-11-10', '11:00') },
    ]);
    expect(wrapper.emitted('open')).toBeUndefined();

    press(item.get('[data-resize]').element, 300);
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 275 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientY: 275 }));
    expect((wrapper.emitted('edit') ?? []).map((edit) => edit[1])[1]).toEqual({
      startAt: seoul('2026-11-10', '09:00'),
      endAt: seoul('2026-11-10', '10:00'),
    });

    // A press without a move is a click: the card opens.
    press(item.element, 100);
    window.dispatchEvent(new MouseEvent('pointerup', { clientY: 100 }));
    await item.trigger('click');
    expect(wrapper.emitted('open')).toHaveLength(1);
    wrapper.unmount();
  });

  it('draws the 쉼 of a day as a labelled band and says so in the day’s head and name', () => {
    const wrapper = mountGrid(
      {},
      {
        proposals: [],
        availability: {
          rules: rules([1, 2, 3, 4, 5]),
          exceptions: [
            { date: '2026-11-14', kind: 'off', startLocal: '10:00', endLocal: '18:00' },
            { date: '2026-11-15', kind: 'off' },
          ],
        },
      },
    );
    const saturday = wrapper.get('.wg-day[data-date="2026-11-14"]');
    expect(saturday.findAll('[data-band="work"]')).toHaveLength(0);
    expect(saturday.get('[data-band="off"]').text()).toBe('쉼 10:00~18:00');
    expect(wrapper.get('.wg-day[data-date="2026-11-15"] [data-band="off"]').text()).toBe('쉼 하루 종일');
    expect(wrapper.get('.wg-day-head[data-date="2026-11-14"] [data-day-off]').text()).toBe('쉼');
    expect(saturday.attributes('aria-label')).toContain('쉼');
    expect(wrapper.find('.wg-day-head[data-date="2026-11-10"] [data-day-off]').exists()).toBe(false);
    expect(wrapper.get('.wg-day[data-date="2026-11-10"]').findAll('[data-band="work"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it('an empty week keeps a focusable, labelled grid; arrow keys there edit nothing (negative)', async () => {
    const wrapper = mountGrid({ editable: true }, { proposals: [] });
    const body = wrapper.get('[data-week-body]');
    expect(body.attributes('tabindex')).toBe('0');
    expect(body.attributes('aria-label')).toBe('11월 9일 ~ 11월 15일 주간 일정');
    await body.trigger('keydown', { key: 'ArrowDown', altKey: true });
    expect(wrapper.emitted('edit')).toBeUndefined();
    wrapper.unmount();
  });
});
