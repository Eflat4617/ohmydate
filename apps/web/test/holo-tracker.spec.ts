import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin, onlineManager } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plannerClient } from '../src/api';
import {
  NO_FILTER,
  PICKER_LIMIT,
  defaultPickerTask,
  filterRows,
  focusedTotal,
  groupByDay,
  isFiltered,
  pickerOptions,
  projectsOf,
  trackerRows,
  type TrackerTask,
} from '../src/domain/tracker';
import type { OverviewSession } from '../src/domain/overview';
import { setLayoutClock } from '../src/layout/clock';
import {
  MONTH_TASK_THESIS_ID,
  SAMPLE_PROJECT_ID,
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_ONE_TITLE,
  TODAY_TASK_TWO_ID,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { OVERVIEW_RUNNING_SESSION_ID, seedOverviewSessions } from '../src/mocks/overview-seed';
import { server } from '../src/mocks/server';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useOfflineStore } from '../src/stores/offline';
import TrackerView from '../src/views/TrackerView.vue';

/**
 * HOLO-02 타임 트래커: the timer card (the picker's default, starting,
 * a running session) and 기록 (the week's sessions by day, filters,
 * subtotals, restart), with its loading, empty, error and offline states.
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const ZONE = 'Asia/Seoul';
const Stub = defineComponent({ template: '<div />' });

function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

// ── Pure helpers ───────────────────────────────────────────────────────────
function session(id: string, taskId: string, date: string, start: string, focusedMin: number, state: OverviewSession['state'] = 'completed'): OverviewSession {
  const startedAt = seoul(date, start);
  return {
    id,
    taskId,
    startedAt,
    ...(state === 'active' || state === 'paused' ? {} : { endedAt: new Date(Date.parse(startedAt) + (focusedMin + 5) * 60_000).toISOString() }),
    focusedSec: focusedMin * 60,
    pausedSec: 0,
    state,
  };
}

function task(id: string, title: string, projectId = 'inbox', status = 'todo'): TrackerTask {
  return { id, title, status, projectId };
}

describe('tracker rows, filters and subtotals', () => {
  const tasks = new Map([
    ['t1', task('t1', '논문 초고', 'thesis')],
    ['t2', task('t2', '영어 과제')],
  ]);
  const sessions = [
    session('s1', 't1', '2026-11-12', '20:00', 85),
    session('s2', 't2', '2026-11-11', '21:00', 22, 'abandoned'),
    session('s3', 't1', '2026-11-14', '10:05', 62),
    session('s4', 'gone', '2026-11-14', '16:20', 41),
  ];

  it('makes a row per session, newest first, with its task, project and local day', () => {
    const rows = trackerRows(sessions, tasks, ZONE, NOW);
    expect(rows.map((row) => row.id)).toEqual(['s4', 's3', 's1', 's2']);
    expect(rows[1]).toMatchObject({ title: '논문 초고', projectId: 'thesis', date: '2026-11-14', focusedSec: 62 * 60, state: 'completed' });
    // A session whose task is gone keeps its row, without a title or a project.
    expect(rows[0]).toMatchObject({ title: null, projectId: null });
    expect(rows[3]?.endedAt).not.toBeNull();
  });

  it('counts a session on the day it started in the owner zone, and keeps a running one counting', () => {
    // 00:30 on the 14th in Seoul is still the 13th in UTC.
    const late = trackerRows([session('n', 't1', '2026-11-14', '00:30', 10)], tasks, ZONE, NOW);
    expect(late[0]?.date).toBe('2026-11-14');
    expect(trackerRows([session('n', 't1', '2026-11-14', '00:30', 10)], tasks, 'UTC', NOW)[0]?.date).toBe('2026-11-13');
    const running = { ...session('r', 't1', '2026-11-14', '18:30', 0, 'active') };
    const row = trackerRows([running], tasks, ZONE, NOW)[0];
    expect(row?.focusedSec).toBe(10 * 60);
    expect(row?.endedAt).toBeNull();
  });

  it('leaves out a session whose start cannot be read (negative)', () => {
    expect(trackerRows([{ ...session('x', 't1', '2026-11-14', '10:00', 5), startedAt: 'never' }], tasks, ZONE, NOW)).toEqual([]);
    expect(trackerRows([], tasks, ZONE, NOW)).toEqual([]);
  });

  it('filters by project, by state, and by both', () => {
    const rows = trackerRows(sessions, tasks, ZONE, NOW);
    expect(filterRows(rows, NO_FILTER)).toHaveLength(4);
    expect(filterRows(rows, { project: 'thesis', state: 'all' }).map((row) => row.id)).toEqual(['s3', 's1']);
    expect(filterRows(rows, { project: 'all', state: 'abandoned' }).map((row) => row.id)).toEqual(['s2']);
    expect(filterRows(rows, { project: 'inbox', state: 'completed' })).toEqual([]);
    // A row without a project matches no project filter (negative).
    expect(filterRows(rows, { project: 'thesis', state: 'all' }).some((row) => row.id === 's4')).toBe(false);
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ project: 'thesis', state: 'all' })).toBe(true);
    expect(isFiltered({ project: 'all', state: 'paused' })).toBe(true);
  });

  it('groups by day, newest day first, with a subtotal each and a total', () => {
    const rows = trackerRows(sessions, tasks, ZONE, NOW);
    const days = groupByDay(rows);
    expect(days.map((day) => [day.date, day.rows.map((row) => row.id), day.focusedSec / 60])).toEqual([
      ['2026-11-14', ['s4', 's3'], 103],
      ['2026-11-12', ['s1'], 85],
      ['2026-11-11', ['s2'], 22],
    ]);
    expect(focusedTotal(rows)).toBe(210 * 60);
    expect(groupByDay([])).toEqual([]);
    expect(focusedTotal([])).toBe(0);
  });

  it('lists the projects that have a row, in the given order', () => {
    const rows = trackerRows(sessions, tasks, ZONE, NOW);
    expect(projectsOf(rows, ['inbox', 'thesis'])).toEqual(['inbox', 'thesis']);
    expect(projectsOf(rows, ['thesis'])).toEqual(['thesis', 'inbox']);
    expect(projectsOf([], ['thesis'])).toEqual([]);
  });
});

describe('task picker: what it offers', () => {
  const tasks = [
    task('a', '졸업 논문 3장 초고'),
    task('b', '세미나 발표 자료'),
    task('c', '세미나 논문 요약', 'inbox', 'done'),
    task('d', '영어 회화 과제'),
    task('e', 'Weekly Report'),
  ];

  it('offers open tasks by title, the next block’s task first', () => {
    // Korean collation: Hangul titles, then Latin ones.
    expect(pickerOptions(tasks, '').options.map((item) => item.id)).toEqual(['b', 'd', 'a', 'e']);
    expect(pickerOptions(tasks, '', 'a').options.map((item) => item.id)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('matches every word typed, whatever its case or spacing', () => {
    expect(pickerOptions(tasks, '논문').options.map((item) => item.id)).toEqual(['a']);
    expect(pickerOptions(tasks, '  세미나   자료 ').options.map((item) => item.id)).toEqual(['b']);
    expect(pickerOptions(tasks, 'weekly REPORT').options.map((item) => item.id)).toEqual(['e']);
  });

  it('never offers a finished task or a title that does not match (negative)', () => {
    expect(pickerOptions(tasks, '요약').options).toEqual([]);
    expect(pickerOptions(tasks, '세미나 과제').options).toEqual([]);
    expect(pickerOptions([], '').options).toEqual([]);
  });

  it('lists up to the limit and says how many more match', () => {
    const many = Array.from({ length: 12 }, (_, index) => task(`m${index}`, `작업 ${String(index).padStart(2, '0')}`));
    const result = pickerOptions(many, '작업');
    expect(result.options).toHaveLength(PICKER_LIMIT);
    expect(result.more).toBe(4);
    expect(pickerOptions(many, '작업 03')).toMatchObject({ more: 0 });
    expect(pickerOptions(many, '', null, 3).options.map((item) => item.id)).toEqual(['m0', 'm1', 'm2']);
  });

  it('starts on the next block’s task only while it is open (negative)', () => {
    const byId = new Map(tasks.map((item) => [item.id, item]));
    expect(defaultPickerTask('a', byId)).toBe('a');
    expect(defaultPickerTask('c', byId)).toBeNull();
    expect(defaultPickerTask('unknown', byId)).toBeNull();
    expect(defaultPickerTask(null, byId)).toBeNull();
  });
});

// ── The screen ─────────────────────────────────────────────────────────────
function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tracker', name: 'tracker', component: Stub },
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
    ],
  });
}

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
  readonly queryClient: QueryClient;
}

const mounted: VueWrapper[] = [];

async function mountTracker(options: { offline?: boolean; wait?: boolean } = {}): Promise<Mounted> {
  const router = testRouter();
  await router.push('/tracker');
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  if (options.offline === true) useOfflineStore(pinia).setOnline(false);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(TrackerView, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  if (options.wait !== false) await settled(wrapper);
  return { wrapper, router, pinia, queryClient };
}

async function settled(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(async () => {
    await flushPromises();
    expect(wrapper.get('[data-tracker-log]').attributes('data-state')).toBe('ready');
    // The picker (there while nothing runs) has its tasks.
    const field = wrapper.find('#tracker-task');
    if (field.exists()) expect(field.attributes('disabled')).toBeUndefined();
  });
  await nextTick();
}

function compact(node: { text(): string }): string {
  return node.text().replace(/\s+/g, '');
}

function seedWeek(options: { running?: boolean } = {}): void {
  seedMonth(mockDb);
  seedOverviewSessions(mockDb, options);
}

function picker(wrapper: VueWrapper) {
  return wrapper.get('#tracker-task');
}

function pickerValue(wrapper: VueWrapper): string {
  return (picker(wrapper).element as HTMLInputElement).value;
}

async function typeInto(wrapper: VueWrapper, text: string): Promise<void> {
  const input = picker(wrapper).element as HTMLInputElement;
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

async function press(wrapper: VueWrapper, key: string): Promise<void> {
  picker(wrapper).element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await nextTick();
}

function dayGroups(wrapper: VueWrapper) {
  return wrapper.findAll('[data-tracker-table] tbody').map((group) => ({
    date: group.attributes('data-day'),
    subtotal: compact(group.get('[data-day-total]')),
    rows: group.findAll('tr[data-session]').map((row) => row.get('th').text()),
  }));
}

function forbidden(): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'no' },
    { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  setLayoutClock({ now: () => NOW });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setLayoutClock(null);
  onlineManager.setOnline(true);
  document.body.innerHTML = '';
});

describe('타임 트래커 — the timer card', () => {
  it('waits at 00:00:00 with the next block’s task picked, and one filled button', async () => {
    seedWeek();
    const { wrapper } = await mountTracker();
    expect(wrapper.get('h1').text()).toBe('타임 트래커');
    expect(wrapper.get('[data-tracker-timer]').attributes('data-status')).toBe('idle');
    expect(wrapper.get('[data-tracker-status]').text()).toBe('대기 중');
    expect(wrapper.get('[data-timer] .visually-hidden').text()).toBe('00:00:00');
    expect(wrapper.get('.task-finder-label').text()).toBe('무엇을 하고 있나요?');
    // Now is 18:40: the next planned block is 연구 노트 요약 at 19:00.
    expect(pickerValue(wrapper)).toBe(TODAY_TASK_ONE_TITLE);
    expect(wrapper.get('[data-tracker-hint]').text()).toBe('다음 블록이에요 · 오후 7:00~8:30');
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.text()).toBe('집중 시작');
    expect(primaries[0]?.attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-tracker-running]').exists()).toBe(false);
  });

  it('집중 시작 starts a session on the picked block and opens the Focus screen (no second timer)', async () => {
    seedWeek();
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountTracker();
    await wrapper.get('[data-tracker-idle]').trigger('submit');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: TODAY_TASK_ONE_ID, blockId: TODAY_BLOCK_ONE_ID });
    expect(String(router.currentRoute.value.params['sessionId'])).toBe(mockDb.activeSessionId);
  });

  it('searches the open tasks, picks with the keyboard, and starts that task without a block', async () => {
    seedWeek();
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountTracker();
    const input = picker(wrapper);
    expect(input.attributes('role')).toBe('combobox');
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(input.attributes('aria-controls')).toBe('tracker-task-list');

    await typeInto(wrapper, '졸업 초고');
    expect(input.attributes('aria-expanded')).toBe('true');
    const options = wrapper.findAll('#tracker-task-list [role="option"]');
    expect(options.map((option) => option.get('.task-finder-option-title').text())).toEqual(['졸업 논문 3장 초고']);
    expect(input.attributes('aria-activedescendant')).toBe('tracker-task-option-0');
    expect(wrapper.get('.task-finder [role="status"]').text()).toBe('작업 1개');
    // Its project is tagged; a finished task is never offered (negative).
    expect(options[0]?.text()).toContain('졸업 논문');
    await typeInto(wrapper, '세미나 논문 요약');
    expect(wrapper.findAll('#tracker-task-list [role="option"]')).toHaveLength(0);
    expect(wrapper.get('#tracker-task-list').text()).toContain('맞는 작업이 없어요.');

    await typeInto(wrapper, '졸업');
    await press(wrapper, 'Enter');
    expect(pickerValue(wrapper)).toBe('졸업 논문 3장 초고');
    expect(input.attributes('aria-expanded')).toBe('false');
    // Not the next block any more: the hint goes.
    expect(wrapper.find('[data-tracker-hint]').exists()).toBe(false);

    await wrapper.get('[data-tracker-idle]').trigger('submit');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: MONTH_TASK_THESIS_ID });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('blockId');
  });

  it('walks the list with the arrows, marks the next block, and Escape puts the picked title back', async () => {
    seedWeek();
    const { wrapper } = await mountTracker();
    await press(wrapper, 'ArrowDown');
    const input = picker(wrapper);
    expect(input.attributes('aria-expanded')).toBe('true');
    const options = wrapper.findAll('#tracker-task-list [role="option"]');
    expect(options.length).toBeGreaterThan(3);
    // The next block's task leads the list, is the picked one, and says so.
    expect(options[0]?.attributes('data-task')).toBe(TODAY_TASK_ONE_ID);
    expect(options[0]?.attributes('aria-selected')).toBe('true');
    expect(options[0]?.text()).toContain('다음 블록');
    expect(options.filter((option) => option.attributes('aria-selected') === 'true')).toHaveLength(1);
    await press(wrapper, 'ArrowDown');
    expect(input.attributes('aria-activedescendant')).toBe('tracker-task-option-1');
    await press(wrapper, 'ArrowUp');
    await press(wrapper, 'ArrowUp');
    expect(input.attributes('aria-activedescendant')).toBe(`tracker-task-option-${options.length - 1}`);

    await typeInto(wrapper, '없는 작업 이름');
    await press(wrapper, 'Escape');
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(pickerValue(wrapper)).toBe(TODAY_TASK_ONE_TITLE);
    // Enter with the list closed picks nothing (negative).
    await press(wrapper, 'Enter');
    expect(pickerValue(wrapper)).toBe(TODAY_TASK_ONE_TITLE);
  });

  it('cannot start until a task is picked (negative)', async () => {
    seedWeek();
    // Every block of today is over: nothing is picked for the person.
    setLayoutClock({ now: () => Date.parse(seoul('2026-11-14', '23:30')) });
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper } = await mountTracker();
    expect(pickerValue(wrapper)).toBe('');
    expect(picker(wrapper).attributes('placeholder')).toBe('작업 이름으로 찾기');
    expect(wrapper.get('[data-tracker-start]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('작업을 고르면 시작할 수 있어요.');
    await wrapper.get('[data-tracker-idle]').trigger('submit');
    await flushPromises();
    expect(create).not.toHaveBeenCalled();

    // Emptying the field takes a pick back.
    await typeInto(wrapper, '발표');
    await press(wrapper, 'Enter');
    expect(wrapper.get('[data-tracker-start]').attributes('disabled')).toBeUndefined();
    await typeInto(wrapper, '');
    expect(wrapper.get('[data-tracker-start]').attributes('disabled')).toBeDefined();
  });

  it('shows a running session live and offers only the way back into it', async () => {
    seedWeek({ running: true });
    const { wrapper, router } = await mountTracker();
    await vi.waitFor(() => expect(wrapper.get('[data-tracker-timer]').attributes('data-status')).toBe('active'));
    expect(wrapper.get('[data-tracker-status]').text()).toBe('집중하는 중');
    // Started 18:15, now 18:40.
    expect(wrapper.get('[data-timer] .visually-hidden').text()).toBe('00:25:00');
    expect(wrapper.get('[data-tracker-running]').text()).toContain(TODAY_TASK_ONE_TITLE);
    expect(wrapper.find('#tracker-task').exists()).toBe(false);
    expect(wrapper.find('[data-tracker-start]').exists()).toBe(false);
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries.map((button) => button.text())).toEqual(['이어서 보기']);
    // One session at a time: nothing offers a start the server would refuse.
    expect(wrapper.findAll('[data-restart]').every((button) => button.attributes('disabled') !== undefined)).toBe(true);
    await primaries[0]?.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/focus/${OVERVIEW_RUNNING_SESSION_ID}`));
  });

  it('says so when the server already has a running session, and leads to it', async () => {
    seedWeek();
    const { wrapper } = await mountTracker();
    // Another device started one after this screen read the state.
    seedOverviewSessions(mockDb, { running: true });
    await wrapper.get('[data-tracker-idle]').trigger('submit');
    await vi.waitFor(() => expect(wrapper.find('[data-tracker-error]').exists()).toBe(true));
    expect(wrapper.get('[data-tracker-error]').text()).toContain('이미 돌아가는 세션이 있어요.');
    await vi.waitFor(() => expect(wrapper.find('[data-tracker-running]').exists()).toBe(true));
  });
});

describe('타임 트래커 — 기록', () => {
  it('lists the week’s sessions by day with a subtotal each and the week’s total', async () => {
    seedWeek();
    const { wrapper } = await mountTracker();
    expect(wrapper.get('[data-week]').text()).toBe('11월 9일 (월) ~ 11월 15일 (일)');
    expect(compact(wrapper.get('[data-tracker-total] .duration-numeral'))).toBe('6시간38분');
    expect(wrapper.get('.tracker-total-label').text()).toContain('이번 주 집중 시간');
    expect(wrapper.get('.tracker-total-label').text()).toContain('세션 7개');
    expect(wrapper.get('[data-tracker-table] caption').text()).toBe('11월 9일 (월) ~ 11월 15일 (일) 집중 세션');
    expect(wrapper.findAll('[data-tracker-table] thead th').map((head) => head.text())).toEqual([
      '작업',
      '프로젝트',
      '시간',
      '집중',
      '상태',
      '할 수 있는 일',
    ]);
    expect(dayGroups(wrapper)).toEqual([
      { date: '2026-11-14', subtotal: '이날합계1시간43분', rows: ['발표 개요 초안', '졸업 논문 3장 초고'] },
      { date: '2026-11-13', subtotal: '이날합계58분', rows: ['세미나 발표 자료'] },
      { date: '2026-11-12', subtotal: '이날합계1시간25분', rows: ['졸업 논문 3장 초고'] },
      { date: '2026-11-11', subtotal: '이날합계22분', rows: ['영어 회화 과제'] },
      { date: '2026-11-10', subtotal: '이날합계1시간18분', rows: ['세미나 발표 자료'] },
      { date: '2026-11-09', subtotal: '이날합계52분', rows: ['세미나 논문 요약'] },
    ]);
    const today = wrapper.get('tbody[data-day="2026-11-14"]');
    expect(today.get('.tracker-day-date').text()).toContain('11월 14일 (토)');
    expect(today.get('.tracker-day-date').text()).toContain('오늘');
    expect(wrapper.get('tbody[data-day="2026-11-13"] .tracker-day-date').text()).not.toContain('오늘');
    const row = today.findAll('tr[data-session]')[1];
    expect(row?.text()).toContain('졸업 논문');
    expect(row?.text()).toContain('오전 10:05~11:12');
    expect(row?.text()).toContain('1시간 2분');
    expect(row?.text()).toContain('완료');
    expect(row?.get('[data-open-task]').attributes('href')).toBe(`/tasks/${MONTH_TASK_THESIS_ID}`);
    expect(wrapper.get('tbody[data-day="2026-11-11"] tr[data-session]').attributes('data-session')).toBe('abandoned');
    expect(wrapper.find('[data-tracker-truncated]').exists()).toBe(false);
  });

  it('filters by project and by state: the rows, the subtotals and the total follow', async () => {
    seedWeek();
    const { wrapper } = await mountTracker();
    const project = wrapper.get('[data-filter-project]');
    expect(project.findAll('option').map((option) => option.text())).toEqual(['모든 프로젝트', '인박스', '졸업 논문']);
    await project.setValue(SAMPLE_PROJECT_ID);
    expect(dayGroups(wrapper)).toEqual([
      { date: '2026-11-14', subtotal: '이날합계1시간2분', rows: ['졸업 논문 3장 초고'] },
      { date: '2026-11-12', subtotal: '이날합계1시간25분', rows: ['졸업 논문 3장 초고'] },
    ]);
    expect(compact(wrapper.get('[data-tracker-total] .duration-numeral'))).toBe('2시간27분');
    expect(wrapper.get('.tracker-total-label').text()).toContain('세션 2개');
    expect(wrapper.get('.tracker-total-label').text()).toContain('거른 결과');

    // The two filters together can leave nothing: say so and offer the way back.
    const state = wrapper.get('[data-filter-state]');
    expect(state.findAll('option').map((option) => option.text())).toEqual(['모든 상태', '진행 중', '멈춤', '완료', '중단']);
    await state.setValue('abandoned');
    expect(wrapper.find('[data-tracker-table]').exists()).toBe(false);
    expect(wrapper.get('[data-tracker-no-match]').text()).toContain('조건에 맞는 기록이 없어요.');
    expect(wrapper.find('[data-empty]').exists()).toBe(false);
    expect(compact(wrapper.get('[data-tracker-total] .duration-numeral'))).toBe('0분');

    await wrapper.get('[data-filter-clear]').trigger('click');
    expect(dayGroups(wrapper)).toHaveLength(6);
    await state.setValue('abandoned');
    expect(dayGroups(wrapper)).toEqual([{ date: '2026-11-11', subtotal: '이날합계22분', rows: ['영어 회화 과제'] }]);
    expect(wrapper.get('.tracker-total-label').text()).toContain('세션 1개');
  });

  it('steps back a week and never forward past this one', async () => {
    seedWeek();
    const { wrapper } = await mountTracker();
    expect(wrapper.get('[data-week-next]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-week-previous]').trigger('click');
    await settled(wrapper);
    expect(wrapper.get('[data-week]').text()).toBe('11월 2일 (월) ~ 11월 8일 (일)');
    expect(compact(wrapper.get('[data-tracker-total] .duration-numeral'))).toBe('5시간15분');
    expect(wrapper.get('.tracker-total-label').text()).toContain('이 주의 집중 시간');
    expect(dayGroups(wrapper).map((day) => day.date)).toEqual(['2026-11-07', '2026-11-05', '2026-11-04', '2026-11-02']);
    expect(wrapper.find('.tracker-day-today').exists()).toBe(false);
    expect(wrapper.get('[data-tracker-log] [role="status"]').text()).toBe('11월 2일 (월) ~ 11월 8일 (일) 기록');
    await wrapper.get('[data-week-next]').trigger('click');
    await settled(wrapper);
    expect(wrapper.get('[data-week-next]').attributes('disabled')).toBeDefined();
    expect(dayGroups(wrapper)).toHaveLength(6);
  });

  it('다시 시작 starts a session on that row’s task', async () => {
    seedWeek();
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountTracker();
    const restart = wrapper.get('tbody[data-day="2026-11-14"] tr[data-session]:nth-of-type(3) [data-restart]');
    expect(restart.attributes('aria-label')).toBe('‘졸업 논문 3장 초고’ 다시 시작');
    await restart.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: MONTH_TASK_THESIS_ID });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('blockId');
  });

  it('offers no restart for a session whose task is gone (negative)', async () => {
    seedWeek();
    mockDb.tasks.delete(TODAY_TASK_TWO_ID);
    const { wrapper } = await mountTracker();
    const row = wrapper.get('tbody[data-day="2026-11-14"] tr[data-session]');
    expect(row.get('th').text()).toBe('지워진 작업');
    expect(row.find('[data-restart]').exists()).toBe(false);
    expect(row.find('[data-open-task]').exists()).toBe(false);
  });

  it('says an empty week, with no table and no filter result line (negative)', async () => {
    seedMonth(mockDb);
    const { wrapper } = await mountTracker();
    expect(wrapper.get('[data-empty]').text()).toContain('이 주에는 집중 기록이 없어요.');
    expect(wrapper.find('[data-tracker-table]').exists()).toBe(false);
    expect(wrapper.find('[data-tracker-no-match]').exists()).toBe(false);
    expect(compact(wrapper.get('[data-tracker-total] .duration-numeral'))).toBe('0분');
    expect(wrapper.get('[data-filter-project]').findAll('option')).toHaveLength(1);
  });

  it('shows a skeleton while it loads, then the rows', async () => {
    seedWeek();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(/\/api\/v1\/sessions(\?.*)?$/, async ({ request }) => {
        if (new URL(request.url).searchParams.has('state')) return HttpResponse.json({ items: [], nextCursor: null });
        await held;
        return HttpResponse.json({ items: [...mockDb.sessions.values()].reverse(), nextCursor: null });
      }),
    );
    const { wrapper } = await mountTracker({ wait: false });
    await vi.waitFor(() => expect(wrapper.get('[data-tracker-log]').attributes('aria-busy')).toBe('true'));
    expect(wrapper.find('.tracker-log-skeleton').exists()).toBe(true);
    expect(wrapper.get('[data-tracker-log] [role="status"]').text()).toBe('기록을 불러오는 중…');
    expect(wrapper.find('[data-empty]').exists()).toBe(false);
    release();
    await settled(wrapper);
    expect(wrapper.find('.tracker-log-skeleton').exists()).toBe(false);
    expect(dayGroups(wrapper)).toHaveLength(6);
  });

  it('says when the record cannot be read, keeps the timer card, and reads again on retry', async () => {
    seedWeek();
    let failing = true;
    server.use(
      http.get(/\/api\/v1\/sessions(\?.*)?$/, ({ request }) => {
        if (new URL(request.url).searchParams.has('state')) return HttpResponse.json({ items: [], nextCursor: null });
        return failing ? forbidden() : HttpResponse.json({ items: [...mockDb.sessions.values()].reverse(), nextCursor: null });
      }),
    );
    const { wrapper } = await mountTracker({ wait: false });
    await vi.waitFor(() => expect(wrapper.get('[data-tracker-log]').attributes('data-state')).toBe('error'));
    expect(wrapper.get('[data-tracker-log] [role="alert"]').text()).toContain('기록을 불러오지 못했어요.');
    // The rest of the screen is there: the timer card with its picker.
    await vi.waitFor(() => expect(pickerValue(wrapper)).toBe(TODAY_TASK_ONE_TITLE));
    expect(wrapper.find('[data-tracker-table]').exists()).toBe(false);
    failing = false;
    await wrapper.get('[data-retry]').trigger('click');
    await settled(wrapper);
    expect(dayGroups(wrapper)).toHaveLength(6);
  });

  it('says when the list was too long to read whole', async () => {
    seedWeek();
    // Every page is full and points to another: the read stops at its bound.
    const page = [...mockDb.sessions.values()].filter((item) => item.startedAt >= seoul('2026-11-09', '00:00'));
    let calls = 0;
    server.use(
      http.get(/\/api\/v1\/sessions(\?.*)?$/, ({ request }) => {
        if (new URL(request.url).searchParams.has('state')) return HttpResponse.json({ items: [], nextCursor: null });
        calls += 1;
        return HttpResponse.json({ items: page, nextCursor: `page-${calls}` });
      }),
    );
    const { wrapper } = await mountTracker();
    expect(wrapper.get('[data-tracker-truncated]').text()).toContain('최근 2,000개까지만 읽었어요.');
    // 20 pages for the week on show (the overview's bound), not one more.
    expect(calls).toBe(20);
  });

  it('offline: read-only, nothing can be started, and what was read stays', async () => {
    seedWeek();
    const { wrapper, pinia } = await mountTracker();
    useOfflineStore(pinia).setOnline(false);
    await nextTick();
    expect(wrapper.text()).toContain('오프라인 · 읽기 전용');
    expect(wrapper.get('[data-tracker-start]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('오프라인에서는 집중을 시작할 수 없어요.');
    expect(wrapper.findAll('[data-restart]').every((button) => button.attributes('disabled') !== undefined)).toBe(true);
    expect(dayGroups(wrapper)).toHaveLength(6);
    const create = vi.spyOn(plannerClient, 'createSession');
    await wrapper.get('[data-tracker-idle]').trigger('submit');
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
  });

  it('offline without data: says so instead of loading forever', async () => {
    seedWeek();
    onlineManager.setOnline(false);
    const { wrapper } = await mountTracker({ offline: true, wait: false });
    await flushPromises();
    expect(wrapper.get('[data-tracker-log]').attributes('data-state')).toBe('offline');
    expect(wrapper.get('[data-tracker-offline]').text()).toContain('오프라인이라 기록을 불러올 수 없어요.');
    expect(wrapper.find('.tracker-log-skeleton').exists()).toBe(false);
  });
});
