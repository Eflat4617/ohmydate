import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { nextTick } from 'vue';
import { plannerClient, type Availability, type AvailabilityPut, type AvailabilityRule } from '../src/api';
import AvailabilityWeekGrid from '../src/components/AvailabilityWeekGrid.vue';
import { exceptionSummary } from '../src/domain/availabilityExceptions';
import { mockDb } from '../src/mocks/db';
import { useOfflineStore } from '../src/stores/offline';
import AvailabilityView from '../src/views/AvailabilityView.vue';
import { mountWithPlugins, settle } from './planning-test-utils';

const PREFS: Availability['prefs'] = {
  maxDailyFocusMin: 300,
  breakAfterMin: 60,
  breakMin: 15,
  dayStartLocal: '08:00',
  dayEndLocal: '22:00',
  riskLevel: 'p50',
};

/** Slot index of a clock time (30-minute rows). */
const at = (clock: string): number => {
  const [hours, minutes] = clock.split(':').map(Number);
  return ((hours ?? 0) * 60 + (minutes ?? 0)) / 30;
};

function cell(wrapper: VueWrapper, day: number, clock: string) {
  return wrapper.get(`[data-day="${day}"][data-slot="${at(clock)}"]`);
}

function mountGrid(rules: AvailabilityRule[], readonly = false) {
  const wrapper: VueWrapper = mount(AvailabilityWeekGrid, {
    props: {
      rules,
      readonly,
      'onUpdate:rules': (next: AvailabilityRule[]) => {
        void wrapper.setProps({ rules: next });
      },
    },
    attachTo: document.body,
  });
  return wrapper;
}

function rulesOf(wrapper: VueWrapper): AvailabilityRule[] {
  return (wrapper.props() as { rules: AvailabilityRule[] }).rules;
}

/**
 * jsdom has no PointerEvent: send a MouseEvent of the pointer type and add
 * the pointer fields the grid reads.
 */
async function pointer(
  target: { element: Element },
  type: 'pointerdown' | 'pointerenter',
  init: { pointerId?: number; pointerType?: string; button?: number } = {},
): Promise<void> {
  const event = new MouseEvent(type, { bubbles: type !== 'pointerenter', cancelable: true, button: init.button ?? 0 });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 7 });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
  target.element.dispatchEvent(event);
  await nextTick();
}

async function press(wrapper: VueWrapper, day: number, clock: string): Promise<void> {
  await pointer(cell(wrapper, day, clock), 'pointerdown');
}

async function enter(wrapper: VueWrapper, day: number, clock: string, pointerId = 7): Promise<void> {
  await pointer(cell(wrapper, day, clock), 'pointerenter', { pointerId });
}

async function release(): Promise<void> {
  window.dispatchEvent(new Event('pointerup'));
  await nextTick();
}

describe('weekly grid editor: layout and names', () => {
  it('shows 월–일 columns, 30-minute rows from 06:00 and names each cell with its state', () => {
    const wrapper = mountGrid([{ weekday: 1, startLocal: '10:00', endLocal: '11:00', kind: 'work' }]);
    const grid = wrapper.get('[role="grid"]');
    expect(grid.attributes('aria-label')).toBe('주간 가용 시간 표');
    const heads = wrapper.findAll('.avail-dayhead');
    expect(heads.map((head) => head.find('.avail-dayhead-name').text())).toEqual(['월', '화', '수', '목', '금', '토', '일']);
    const rows = wrapper.findAll('[role="row"]');
    // Header + 06:00..23:30.
    expect(rows).toHaveLength(1 + 36);
    expect(rows[1]?.get('[role="rowheader"]').text()).toBe('06:00');
    expect(cell(wrapper, 0, '10:00').attributes('aria-label')).toBe('월요일 10:00~10:30, 작업');
    expect(cell(wrapper, 0, '11:00').attributes('aria-label')).toBe('월요일 11:00~11:30, 비어 있음');
    expect(cell(wrapper, 0, '10:00').attributes('data-state')).toBe('work');
    expect(wrapper.find('[data-slot="0"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows 00:00–06:00 on request, and by itself when a rule starts there', async () => {
    const wrapper = mountGrid([]);
    const toggle = wrapper.get('[data-early-toggle]');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('[data-slot="0"]').exists()).toBe(true);
    wrapper.unmount();

    const early = mountGrid([{ weekday: 3, startLocal: '05:00', endLocal: '07:00', kind: 'focus' }]);
    expect(early.find('[data-slot="0"]').exists()).toBe(true);
    expect(early.get('[data-early-toggle]').attributes('disabled')).toBeDefined();
    expect(cell(early, 2, '05:00').attributes('aria-label')).toBe('수요일 05:00~05:30, 집중');
    early.unmount();
  });

  it('does not show the early hours when no rule needs them (negative)', () => {
    const wrapper = mountGrid([{ weekday: 1, startLocal: '06:00', endLocal: '07:00', kind: 'work' }]);
    expect(wrapper.find('[data-slot="11"]').exists()).toBe(false);
    expect(wrapper.get('[data-early-toggle]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('marks a cell an off-grid rule only partly covers, with its minutes', () => {
    const wrapper = mountGrid([{ weekday: 2, startLocal: '09:15', endLocal: '10:00', kind: 'work' }]);
    const partial = cell(wrapper, 1, '09:00');
    expect(partial.attributes('data-state')).toBe('partial');
    expect(partial.attributes('aria-label')).toBe('화요일 09:00~09:30, 15분만 작업');
    const fill = partial.get('.avail-cell-fill').element as HTMLElement;
    expect(fill.style.top).toBe('50%');
    expect(fill.style.height).toBe('50%');
    expect(wrapper.get('[data-offgrid-note]').text()).toContain('화요일');
    expect(cell(wrapper, 1, '09:30').attributes('data-state')).toBe('work');
    wrapper.unmount();
  });
});

describe('weekly grid editor: pointer painting', () => {
  it('paints a cell on press and a range by dragging', async () => {
    const wrapper = mountGrid([]);
    await press(wrapper, 0, '09:00');
    expect(rulesOf(wrapper)).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '09:30', kind: 'work' }]);
    await enter(wrapper, 0, '10:30');
    expect(rulesOf(wrapper)).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '11:00', kind: 'work' }]);
    // Dragging across days paints the rectangle.
    await enter(wrapper, 2, '10:30');
    expect(rulesOf(wrapper).map((rule) => `${rule.weekday} ${rule.startLocal}-${rule.endLocal}`)).toEqual([
      '1 09:00-11:00',
      '2 09:00-11:00',
      '3 09:00-11:00',
    ]);
    // Back over Monday only: Tuesday and Wednesday return to what they were.
    await enter(wrapper, 0, '10:00');
    expect(rulesOf(wrapper)).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '10:30', kind: 'work' }]);
    await release();
    // After the stroke ends, moving over cells paints nothing.
    await enter(wrapper, 4, '15:00');
    expect(rulesOf(wrapper)).toHaveLength(1);
    wrapper.unmount();
  });

  it('erases when the press starts on a cell already painted with the brush', async () => {
    const wrapper = mountGrid([{ weekday: 1, startLocal: '09:00', endLocal: '12:00', kind: 'work' }]);
    await press(wrapper, 0, '10:00');
    await enter(wrapper, 0, '10:30');
    await release();
    expect(rulesOf(wrapper)).toEqual([
      { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      { weekday: 1, startLocal: '11:00', endLocal: '12:00', kind: 'work' },
    ]);
    wrapper.unmount();
  });

  it('paints focus with the focus brush and clears with 지우기', async () => {
    const wrapper = mountGrid([{ weekday: 6, startLocal: '09:00', endLocal: '11:00', kind: 'work' }]);
    await wrapper.get('input[data-brush="focus"]').setValue(true);
    await press(wrapper, 5, '09:00');
    await release();
    expect(rulesOf(wrapper)).toEqual([
      { weekday: 6, startLocal: '09:00', endLocal: '09:30', kind: 'focus' },
      { weekday: 6, startLocal: '09:30', endLocal: '11:00', kind: 'work' },
    ]);
    expect(cell(wrapper, 5, '09:00').attributes('aria-label')).toBe('토요일 09:00~09:30, 집중');
    await wrapper.get('input[data-brush="erase"]').setValue(true);
    await press(wrapper, 5, '09:00');
    await enter(wrapper, 5, '10:30');
    await release();
    expect(rulesOf(wrapper)).toEqual([]);
    wrapper.unmount();
  });

  it('ignores another pointer and a secondary mouse button (negative)', async () => {
    const wrapper = mountGrid([]);
    await pointer(cell(wrapper, 0, '09:00'), 'pointerdown', { pointerId: 1, button: 2 });
    expect(wrapper.emitted('update:rules')).toBeUndefined();
    await press(wrapper, 0, '09:00');
    await enter(wrapper, 0, '10:00', 99);
    await release();
    expect(rulesOf(wrapper)).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '09:30', kind: 'work' }]);
    wrapper.unmount();
  });
});

describe('weekly grid editor: keyboard', () => {
  it('keeps one tab stop, moves with arrows and toggles with Space / Enter', async () => {
    const wrapper = mountGrid([]);
    const stops = wrapper.findAll('[role="gridcell"][tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.attributes('aria-label')).toBe('월요일 09:00~09:30, 비어 있음');

    await cell(wrapper, 0, '09:00').trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(document.activeElement).toBe(cell(wrapper, 0, '09:30').element);
    expect(cell(wrapper, 0, '09:30').attributes('tabindex')).toBe('0');
    expect(cell(wrapper, 0, '09:00').attributes('tabindex')).toBe('-1');
    // Moving alone paints nothing.
    expect(wrapper.emitted('update:rules')).toBeUndefined();

    await cell(wrapper, 0, '09:30').trigger('keydown', { key: ' ' });
    expect(rulesOf(wrapper)).toEqual([{ weekday: 1, startLocal: '09:30', endLocal: '10:00', kind: 'work' }]);
    expect(wrapper.get('[role="status"]').text()).toBe('월요일 09:30~10:00, 작업');
    await cell(wrapper, 0, '09:30').trigger('keydown', { key: 'Enter' });
    expect(rulesOf(wrapper)).toEqual([]);

    await cell(wrapper, 0, '09:30').trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    expect(document.activeElement).toBe(cell(wrapper, 1, '09:30').element);
    wrapper.unmount();
  });

  it('extends painting with Shift+arrows', async () => {
    const wrapper = mountGrid([]);
    await cell(wrapper, 0, '09:00').trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    await nextTick();
    await cell(wrapper, 0, '09:30').trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    await nextTick();
    expect(rulesOf(wrapper)).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '10:30', kind: 'work' }]);
    await cell(wrapper, 0, '10:00').trigger('keyup', { key: 'Shift' });
    // Without Shift the next arrow only moves.
    await cell(wrapper, 0, '10:00').trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(rulesOf(wrapper)).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '10:30', kind: 'work' }]);
    expect(document.activeElement).toBe(cell(wrapper, 0, '10:30').element);
    wrapper.unmount();
  });

  it('stops at the grid edges (negative)', async () => {
    const wrapper = mountGrid([]);
    await cell(wrapper, 0, '09:00').trigger('keydown', { key: 'ArrowLeft' });
    await nextTick();
    expect(document.activeElement).toBe(cell(wrapper, 0, '09:00').element);
    await cell(wrapper, 0, '09:00').trigger('keydown', { key: 'End' });
    await nextTick();
    await cell(wrapper, 0, '23:30').trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(document.activeElement).toBe(cell(wrapper, 0, '23:30').element);
    wrapper.unmount();
  });
});

describe('weekly grid editor: read-only (offline)', () => {
  it('changes nothing by pointer, click or keyboard and says it is read-only', async () => {
    const rules: AvailabilityRule[] = [{ weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' }];
    const wrapper = mountGrid(rules, true);
    expect(wrapper.get('[role="grid"]').attributes('aria-readonly')).toBe('true');
    expect(wrapper.get('fieldset.avail-brush').attributes('disabled')).toBeDefined();
    await press(wrapper, 0, '12:00');
    await enter(wrapper, 0, '13:00');
    await release();
    await cell(wrapper, 0, '09:00').trigger('keydown', { key: ' ' });
    await cell(wrapper, 0, '09:00').trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    await cell(wrapper, 2, '09:00').trigger('click');
    expect(wrapper.emitted('update:rules')).toBeUndefined();
    expect(rulesOf(wrapper)).toEqual(rules);
    // Navigation still works.
    await nextTick();
    expect(document.activeElement).toBe(cell(wrapper, 0, '09:30').element);
    wrapper.unmount();
  });

  it('paints from a plain click when nothing pressed first (assistive tech)', async () => {
    const wrapper = mountGrid([]);
    await cell(wrapper, 2, '14:00').trigger('click');
    expect(rulesOf(wrapper)).toEqual([{ weekday: 3, startLocal: '14:00', endLocal: '14:30', kind: 'work' }]);
    wrapper.unmount();
  });
});

describe('weekly grid editor: totals', () => {
  it('shows each day total under its header and the weekly total', () => {
    const wrapper = mountGrid([
      { weekday: 1, startLocal: '09:00', endLocal: '13:30', kind: 'work' },
      { weekday: 3, startLocal: '10:00', endLocal: '12:00', kind: 'focus' },
    ]);
    const heads = wrapper.findAll('.avail-dayhead');
    expect(heads[0]?.find('.avail-dayhead-total').text()).toBe('4시간 30분');
    expect(heads[0]?.attributes('aria-label')).toBe('월요일 합계 4시간 30분');
    expect(heads[1]?.find('.avail-dayhead-total').text()).toBe('0분');
    expect(wrapper.get('[data-week-total]').text()).toBe('주간 합계 6시간 30분 · 작업 4시간 30분 · 집중 2시간');
    wrapper.unmount();
  });

  it('updates the totals after painting and not before (negative)', async () => {
    const wrapper = mountGrid([]);
    expect(wrapper.get('[data-week-total]').text()).toBe('주간 합계 0분 · 작업 0분 · 집중 0분');
    await press(wrapper, 4, '18:00');
    await release();
    await nextTick();
    expect(wrapper.findAll('.avail-dayhead')[4]?.find('.avail-dayhead-total').text()).toBe('30분');
    expect(wrapper.get('[data-week-total]').text()).toBe('주간 합계 30분 · 작업 30분 · 집중 0분');
    wrapper.unmount();
  });
});

// ── AvailabilityView: load → display → save ─────────────────────────────
const OFF_GRID: Availability = {
  version: 1,
  timeZone: 'Asia/Seoul',
  rules: [
    { weekday: 2, startLocal: '08:10', endLocal: '12:05', kind: 'focus' },
    { weekday: 1, startLocal: '09:15', endLocal: '17:45', kind: 'work' },
    { weekday: 1, startLocal: '13:00', endLocal: '15:00', kind: 'focus' },
    { weekday: 3, startLocal: '09:00', endLocal: '12:00', kind: 'work' },
    { weekday: 3, startLocal: '11:00', endLocal: '24:00', kind: 'work' },
    { weekday: 5, startLocal: '10:00', endLocal: '16:00', kind: 'work' },
  ],
  exceptions: [
    { date: '2026-11-14', kind: 'off', startLocal: '10:00', endLocal: '18:00' },
    { date: '2026-11-15', kind: 'off' },
    { date: '2026-11-20', kind: 'extra', startLocal: '19:00', endLocal: '24:00' },
  ],
  prefs: PREFS,
};

function seed(value: Availability): void {
  mockDb.availability = JSON.parse(JSON.stringify(value)) as Availability;
  mockDb.availabilityVersion = value.version;
}

async function mountView(pinia = createPinia()) {
  const wrapper = mountWithPlugins(AvailabilityView, { pinia });
  await settle();
  await vi.waitFor(() => {
    expect(wrapper.find('form.settings-form').exists()).toBe(true);
  });
  return wrapper;
}

function expectedPayload(value: Availability): AvailabilityPut {
  return { timeZone: value.timeZone, rules: value.rules, exceptions: value.exceptions, prefs: value.prefs };
}

describe('availability view: off-grid and overlapping rules survive load → save', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves the identical payload when nothing was edited', async () => {
    seed(OFF_GRID);
    const put = vi.spyOn(plannerClient, 'putAvailability');
    const wrapper = await mountView();
    expect(wrapper.get('[data-offgrid-note]').text()).toContain('월요일, 화요일 및 수요일');
    expect(wrapper.get('[data-offgrid-note]').text()).not.toContain('금요일');
    expect((wrapper.get('#rule-end-4').element as HTMLInputElement).value).toBe('24:00');
    expect((wrapper.get('#exception-end-2').element as HTMLInputElement).value).toBe('24:00');

    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('가용 시간을 저장했어요 (버전 2)');
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toEqual(expectedPayload(OFF_GRID));
    expect(mockDb.availability.rules).toEqual(OFF_GRID.rules);
    expect(mockDb.availability.exceptions).toEqual(OFF_GRID.exceptions);
    wrapper.unmount();
  });

  it('rewrites only the painted weekday and says so beforehand (negative)', async () => {
    seed(OFF_GRID);
    const put = vi.spyOn(plannerClient, 'putAvailability');
    const wrapper = await mountView();
    await press(wrapper, 0, '20:00');
    await release();
    await wrapper.get('form').trigger('submit');
    // Wait for the save itself: an in-flight PUT would land in the next test's mock DB.
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('가용 시간을 저장했어요 (버전 2)');
    });
    expect(put).toHaveBeenCalledTimes(1);
    const rules = put.mock.calls[0]?.[0].rules ?? [];
    expect(rules).not.toEqual(OFF_GRID.rules);
    expect(rules.filter((rule) => rule.weekday === 1)).toEqual([
      { weekday: 1, startLocal: '09:15', endLocal: '13:00', kind: 'work' },
      { weekday: 1, startLocal: '13:00', endLocal: '15:00', kind: 'focus' },
      { weekday: 1, startLocal: '15:00', endLocal: '17:45', kind: 'work' },
      { weekday: 1, startLocal: '20:00', endLocal: '20:30', kind: 'work' },
    ]);
    for (const weekday of [2, 3, 5]) {
      expect(rules.filter((rule) => rule.weekday === weekday)).toEqual(
        OFF_GRID.rules.filter((rule) => rule.weekday === weekday),
      );
    }
    wrapper.unmount();
  });

  it('keeps the precise row editor reachable and bound to the same draft', async () => {
    seed(OFF_GRID);
    const wrapper = await mountView();
    const direct = wrapper.get('details[data-direct-entry]');
    expect(direct.get('summary').text()).toBe('시간 직접 입력');
    const start = wrapper.get('#rule-start-5');
    await start.setValue('930');
    await start.trigger('blur');
    expect((start.element as HTMLInputElement).value).toBe('09:30');
    expect(cell(wrapper, 4, '09:30').attributes('data-state')).toBe('work');
    expect(cell(wrapper, 4, '09:00').attributes('data-state')).toBe('empty');
    expect(wrapper.text()).toContain('저장하지 않은 변경');
    wrapper.unmount();
  });
});

describe('availability view: read-only while offline', () => {
  it('does not paint or mark the draft dirty', async () => {
    seed(OFF_GRID);
    const pinia = createPinia();
    const wrapper = await mountView(pinia);
    useOfflineStore(pinia).setOnline(false);
    await nextTick();
    expect(wrapper.get('[role="grid"]').attributes('aria-readonly')).toBe('true');
    await press(wrapper, 5, '09:00');
    await release();
    await cell(wrapper, 5, '09:00').trigger('keydown', { key: 'Enter' });
    await nextTick();
    expect(cell(wrapper, 5, '09:00').attributes('data-state')).toBe('empty');
    expect(wrapper.text()).not.toContain('저장하지 않은 변경');
    expect(wrapper.get('#availability-save').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

describe('availability view: exceptions are readable and keep their values', () => {
  it('summarises each exception next to its inputs', async () => {
    seed(OFF_GRID);
    const wrapper = await mountView();
    const summaries = wrapper.findAll('[data-exception-summary]').map((item) => item.text());
    expect(summaries).toEqual([
      '11월 14일 (토) · 쉼 · 10:00~18:00',
      '11월 15일 (일) · 쉼 · 하루 종일',
      '11월 20일 (금) · 추가 · 19:00~24:00',
    ]);
    const group = wrapper.findAll('.exception-item')[0];
    expect(group?.attributes('role')).toBe('group');
    expect(group?.attributes('aria-labelledby')).toBe('exception-summary-0');
    expect((wrapper.get('#exception-date-0').element as HTMLInputElement).value).toBe('2026-11-14');
    expect((wrapper.get('#exception-start-0').element as HTMLInputElement).value).toBe('10:00');
    expect((wrapper.get('#exception-end-0').element as HTMLInputElement).value).toBe('18:00');

    await wrapper.get('#exception-kind-2').setValue('off');
    expect(wrapper.findAll('[data-exception-summary]')[2]?.text()).toBe('11월 20일 (금) · 쉼 · 19:00~24:00');
    wrapper.unmount();
  });

  it('blocks a time window with only one end instead of saving a no-op 쉼 (negative)', async () => {
    seed({ ...OFF_GRID, exceptions: [] });
    const put = vi.spyOn(plannerClient, 'putAvailability');
    const wrapper = await mountView();
    await wrapper.findAll('button').find((button) => button.text().includes('예외 추가'))?.trigger('click');
    expect(wrapper.get('[data-exception-summary]').text()).toBe('날짜 미정 · 쉼 · 하루 종일');
    await wrapper.get('#exception-date-0').setValue('2026-11-21');
    await wrapper.get('#exception-start-0').setValue('10:00');
    expect(wrapper.get('[data-exception-summary]').text()).toBe('11월 21일 (토) · 쉼 · 시작과 종료를 함께 입력해 주세요');
    expect(wrapper.text()).toContain('예외 1: 시작과 종료를 함께 입력하거나 둘 다 비워 주세요');
    expect(wrapper.get('#availability-save').attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(put).not.toHaveBeenCalled();

    await wrapper.get('#exception-end-0').setValue('24');
    await wrapper.get('#exception-end-0').trigger('blur');
    expect(wrapper.text()).not.toContain('시작과 종료를 함께');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('가용 시간을 저장했어요 (버전 2)');
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0].exceptions).toEqual([
      { date: '2026-11-21', kind: 'off', startLocal: '10:00', endLocal: '24:00' },
    ]);
    vi.restoreAllMocks();
    wrapper.unmount();
  });

  it('formats the summary in one place for the list and the calendar', () => {
    expect(exceptionSummary({ date: '2026-11-14', kind: 'off', startLocal: '10:00', endLocal: '18:00' })).toBe(
      '11월 14일 (토) · 쉼 · 10:00~18:00',
    );
    expect(exceptionSummary({ date: '2026-11-15', kind: 'extra' })).toBe('11월 15일 (일) · 추가 · 하루 종일');
    expect(exceptionSummary({ date: '2026-11-15', kind: 'extra' })).not.toContain('쉼');
    expect(exceptionSummary({ date: '2026-11-15', kind: 'off', startLocal: '', endLocal: '' })).toBe(
      '11월 15일 (일) · 쉼 · 하루 종일',
    );
  });
});
