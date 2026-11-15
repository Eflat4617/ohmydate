import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin, onlineManager } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plannerClient } from '../src/api';
import { setLayoutClock } from '../src/layout/clock';
import {
  MONTH_COMMITMENT_DENTIST_ID,
  MONTH_TASK_SCHOLARSHIP_ID,
  TODAY_BLOCK_ONE_ID,
  TODAY_BLOCK_TWO_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_ONE_TITLE,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useOfflineStore } from '../src/stores/offline';
import PlannerView from '../src/views/PlannerView.vue';

/**
 * HOLO-02 플래너: the calendar screen's three views behind one address, the
 * week grid, the one floating detail card and the 약속 추가 dialog.
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul; its week is 11-09..11-15.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const TODAY = '2026-11-14';
const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/planner', name: 'planner', component: Stub },
      { path: '/month', name: 'month', component: Stub },
      { path: '/today', name: 'today', component: Stub },
      { path: '/commitments', name: 'commitments', component: Stub },
      { path: '/plans/new', name: 'plans-new', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/settings/ai', name: 'ai-settings', component: Stub },
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

async function mountPlanner(path = '/planner', options: { offline?: boolean; wait?: boolean } = {}): Promise<Mounted> {
  const router = testRouter();
  await router.push(path);
  const pinia = createPinia();
  // The owner is verified (GET /me) before any screen renders, as in AppShell.
  await useAuthStore(pinia).ensureOwnerConfirmed();
  if (options.offline === true) useOfflineStore(pinia).setOnline(false);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(PlannerView, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  if (options.wait !== false) await loaded(wrapper);
  return { wrapper, router, pinia, queryClient };
}

/** The view on show has read its range (no skeleton, no pending status). */
async function loaded(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(async () => {
    await flushPromises();
    expect(wrapper.find('[data-planner]').exists()).toBe(true);
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false);
    expect(wrapper.find('.planner-agenda-skeleton').exists()).toBe(false);
  });
  await nextTick();
}

function item(wrapper: VueWrapper, key: string) {
  return wrapper.get(`[data-item="${key}"]`);
}

const BLOCK_ONE = `block:${TODAY_BLOCK_ONE_ID}@${TODAY}`;
const BLOCK_TWO = `block:${TODAY_BLOCK_TWO_ID}@${TODAY}`;
const DEADLINE = `deadline:${MONTH_TASK_SCHOLARSHIP_ID}@${TODAY}`;

const DENTIST = `[data-item^="commitment:${MONTH_COMMITMENT_DENTIST_ID}:"]`;

function dentist(wrapper: VueWrapper) {
  return wrapper.get(DENTIST);
}

function card(wrapper: VueWrapper) {
  return wrapper.get('[data-planner-card]');
}

async function press(target: Element, key: string): Promise<void> {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
  await nextTick();
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-planner-add-dialog]');
  if (found === null) throw new Error('약속 추가 dialog is not open');
  return found;
}

function field<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const found = dialog().querySelector<T>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
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
  seedMonth(mockDb);
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setLayoutClock(null);
  onlineManager.setOnline(true);
  document.body.innerHTML = '';
});

describe('플래너 — the address says the view and the dates', () => {
  it('opens on this week (주 is the default) with the head the three views share', async () => {
    const { wrapper } = await mountPlanner();
    expect(wrapper.get('[data-planner]').attributes('data-planner')).toBe('week');
    expect(wrapper.get('h1').text()).toBe('11월 9일 ~ 11월 15일');
    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(wrapper.get('.planner-summary').text()).toBe('블록 7개 · 약속 6개 · 마감 1개');
    const views = wrapper.findAll('[data-planner-view]');
    expect(views.map((button) => [button.text(), button.attributes('aria-pressed')])).toEqual([
      ['일', 'false'],
      ['주', 'true'],
      ['월', 'false'],
    ]);
    expect(wrapper.get('.planner-views').attributes('aria-label')).toBe('보기 바꾸기');
    // This week holds today: 오늘 has nowhere to go.
    expect(wrapper.get('[data-planner-current]').text()).toBe('오늘');
    expect(wrapper.get('[data-planner-current]').attributes('disabled')).toBeDefined();
    // One filled button on the screen: 약속 추가.
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.text()).toBe('약속 추가');
    expect(primaries[0]?.attributes('data-planner-add')).toBeDefined();
  });

  it('steps a week back and forth in the URL and reads only the week on show', async () => {
    const spy = vi.spyOn(plannerClient, 'listScheduleBlocks');
    const { wrapper, router } = await mountPlanner();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-11-08T15:00:00.000Z', to: '2026-11-15T15:00:00.000Z', limit: 100 }),
    );

    await wrapper.get('[data-planner-next]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?w=2026-11-16'));
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('11월 16일 ~ 11월 22일'));
    await vi.waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-11-15T15:00:00.000Z', to: '2026-11-22T15:00:00.000Z' }),
      ),
    );
    expect(wrapper.get('[data-planner-next]').attributes('aria-label')).toBe('다음 주');
    expect(wrapper.get('[data-planner-current]').attributes('disabled')).toBeUndefined();
    // The change is said once for assistive tech (after "loading" has given way to it).
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toBe('11월 16일 ~ 11월 22일 주'));

    await wrapper.get('[data-planner-current]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner'));
    await wrapper.get('[data-planner-previous]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?w=2026-11-02'));
    // Back in history is the week before the step.
    router.back();
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('11월 9일 ~ 11월 15일'));
  });

  it('switches the view through the URL and carries the day along', async () => {
    const { wrapper, router } = await mountPlanner('/planner?w=2026-11-16');
    await wrapper.get('[data-planner-view="day"]').trigger('click');
    // A week that does not hold today opens on its Monday.
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?view=day&d=2026-11-16'));
    await vi.waitFor(() => expect(wrapper.get('[data-planner]').attributes('data-planner')).toBe('day'));
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('11월 16일 (월)'));
    expect(wrapper.get('[data-planner-view="day"]').attributes('aria-pressed')).toBe('true');

    await wrapper.get('[data-planner-view="month"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?view=month'));
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('2026년 11월'));
    expect(wrapper.get('[data-planner]').attributes('data-planner')).toBe('month');
    expect(wrapper.find('[role="grid"]').exists()).toBe(true);
    // The month view steps inside /planner, not to /month.
    await wrapper.get('[data-planner-next]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?view=month&m=2026-12'));

    await wrapper.get('[data-planner-view="week"]').trigger('click');
    // December's picked day is its first: the week that holds 12-01.
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?w=2026-11-30'));
  });

  it('keeps /month as the month view, and leaves it for /planner when another view is picked', async () => {
    const { wrapper, router } = await mountPlanner('/month?m=2026-12');
    expect(wrapper.get('[data-planner]').attributes('data-planner')).toBe('month');
    expect(wrapper.get('h1').text()).toBe('2026년 12월');
    expect(wrapper.get('[data-planner-view="month"]').attributes('aria-pressed')).toBe('true');
    await wrapper.get('[data-planner-previous]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/month'));
    // In this month today is picked: the day view opens on today.
    await wrapper.get('[data-planner-view="day"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?view=day'));
  });

  it('corrects an address it cannot mean, once, without a history entry (negative)', async () => {
    const bad = await mountPlanner('/planner?view=year');
    await vi.waitFor(() => expect(bad.router.currentRoute.value.fullPath).toBe('/planner'));
    expect(bad.wrapper.get('[data-planner]').attributes('data-planner')).toBe('week');

    const wednesday = await mountPlanner('/planner?w=2026-11-18');
    await vi.waitFor(() => expect(wednesday.router.currentRoute.value.fullPath).toBe('/planner?w=2026-11-16'));
    expect(wednesday.wrapper.get('h1').text()).toBe('11월 16일 ~ 11월 22일');

    const noDay = await mountPlanner('/planner?view=day&d=2026-02-30');
    await vi.waitFor(() => expect(noDay.router.currentRoute.value.fullPath).toBe('/planner?view=day'));
    expect(noDay.wrapper.get('h1').text()).toBe('11월 14일 (토)');
  });
});

describe('플래너 · 주 — the week grid', () => {
  it('draws Monday to Sunday with each item in its day, in time order, by kind', async () => {
    const { wrapper } = await mountPlanner();
    const days = wrapper.findAll('.wg-day');
    expect(days.map((day) => day.attributes('data-date'))).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
    expect(wrapper.findAll('.wg-day-head').map((head) => [head.get('.wg-weekday').text(), head.get('.wg-daynum').text()])).toEqual([
      ['월', '9'],
      ['화', '10'],
      ['수', '11'],
      ['목', '12'],
      ['금', '13'],
      ['토', '14'],
      ['일', '15'],
    ]);
    const today = wrapper.get(`.wg-day[data-date="${TODAY}"]`);
    expect(today.classes()).toContain('wg-day--today');
    expect(wrapper.findAll('.wg-day--today')).toHaveLength(1);
    expect(wrapper.get(`.wg-day-head[data-date="${TODAY}"]`).classes()).toContain('wg-day-head--today');
    expect(today.findAll('.wg-item').map((entry) => [entry.attributes('data-kind'), entry.get('.wg-item-title').text()])).toEqual([
      ['commitment', '치과 예약'],
      ['block', TODAY_TASK_ONE_TITLE],
      ['block', '발표 개요 초안'],
      ['commitment', '가족 통화'],
      ['deadline', '장학금 신청서 제출'],
    ]);
    // Finished blocks read as done; planned ones do not (negative).
    expect(wrapper.get('.wg-day[data-date="2026-11-10"] [data-kind="block"]').classes()).toContain('wg-item--done');
    expect(item(wrapper, BLOCK_ONE).classes()).not.toContain('wg-item--done');
    // The now line is on today's column only, and the grid starts at 06:00.
    expect(today.find('[data-week-now]').exists()).toBe(true);
    expect(wrapper.findAll('[data-week-now]')).toHaveLength(1);
    expect(wrapper.findAll('.wg-hour')).toHaveLength(18);
    expect(wrapper.get('.wg-hour').text()).toBe('오전 6시');
  });

  it('names the grid, every day and every item with what it is and when', async () => {
    const { wrapper } = await mountPlanner();
    expect(wrapper.get('[data-week-body]').attributes('aria-label')).toBe('11월 9일 ~ 11월 15일 주간 일정');
    expect(wrapper.get('[data-week-body]').attributes('aria-describedby')).toBe('week-grid-hint');
    expect(wrapper.get('#week-grid-hint').text()).toContain('Enter나 Space로 자세히 보고 Esc로 닫아요.');
    expect(wrapper.get(`.wg-day[data-date="${TODAY}"]`).attributes('aria-label')).toBe(
      '11월 14일 토요일, 오늘, 블록 2개, 약속 2개, 마감 1개',
    );
    expect(wrapper.get('.wg-day[data-date="2026-11-15"]').attributes('aria-label')).toBe('11월 15일 일요일, 블록 1개');
    expect(item(wrapper, BLOCK_ONE).attributes('aria-label')).toBe('블록, 연구 노트 요약, 11월 14일 (토) 오후 7:00~8:30');
    expect(dentist(wrapper).attributes('aria-label')).toBe('약속, 치과 예약, 11월 14일 (토) 오후 3:00~3:40');
    expect(item(wrapper, DEADLINE).attributes('aria-label')).toBe('마감, 장학금 신청서 제출, 11월 14일 (토) 오후 11:00까지');
    expect(wrapper.get('.wg-day[data-date="2026-11-10"] [data-kind="block"]').attributes('aria-label')).toMatch(/^끝낸 블록, /);
    // The day names are for the eye; the column's name says them once.
    expect(wrapper.get('.wg-day-head').attributes('aria-hidden')).toBe('true');
  });

  it('is one tab stop: the arrows move between items and nothing else is tabbable in the grid', async () => {
    const { wrapper } = await mountPlanner();
    const stops = wrapper.findAll('.wg-item[tabindex="0"]');
    expect(stops).toHaveLength(1);
    // Now is 18:40: today's next item is the 19:00 block.
    expect(stops[0]?.attributes('data-item')).toBe(BLOCK_ONE);
    expect(wrapper.findAll('.wg-item').every((entry) => entry.element.tagName === 'BUTTON')).toBe(true);
    expect(wrapper.get('[data-week-body]').attributes('tabindex')).toBeUndefined();

    const first = item(wrapper, BLOCK_ONE).element as HTMLElement;
    first.focus();
    await press(first, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-item')).toBe(BLOCK_TWO);
    expect(wrapper.findAll('.wg-item[tabindex="0"]')).toHaveLength(1);
    expect(item(wrapper, BLOCK_TWO).attributes('tabindex')).toBe('0');
    expect(item(wrapper, BLOCK_ONE).attributes('tabindex')).toBe('-1');

    await press(document.activeElement as Element, 'End');
    expect(document.activeElement?.getAttribute('data-item')).toBe(DEADLINE);
    await press(document.activeElement as Element, 'Home');
    expect(document.activeElement).toBe(dentist(wrapper).element);
    // Left from Saturday 15:00: Friday's only item.
    await press(document.activeElement as Element, 'ArrowLeft');
    expect(document.activeElement?.closest('.wg-day')?.getAttribute('data-date')).toBe('2026-11-13');
    await press(document.activeElement as Element, 'ArrowRight');
    expect(document.activeElement?.closest('.wg-day')?.getAttribute('data-date')).toBe(TODAY);
    // At the grid's edge the focus stays; a modifier is not the grid's key (negative).
    (item(wrapper, DEADLINE).element as HTMLElement).focus();
    await press(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-item')).toBe(DEADLINE);
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true }));
    await nextTick();
    expect(document.activeElement?.getAttribute('data-item')).toBe(DEADLINE);
  });

  it('shows the hours before 06:00 on demand, and by itself when something is there', async () => {
    const { wrapper } = await mountPlanner();
    const toggle = wrapper.get('[data-week-early]');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(toggle.attributes('aria-label')).toBe('오전 6시 이전 시간 보기');
    await toggle.trigger('click');
    expect(wrapper.findAll('.wg-hour')).toHaveLength(24);
    expect(wrapper.get('.wg-hour').text()).toBe('오전 12시');
    expect(wrapper.get('[data-week-early]').attributes('aria-pressed')).toBe('true');
    await wrapper.get('[data-week-early]').trigger('click');
    expect(wrapper.findAll('.wg-hour')).toHaveLength(18);
  });

  it('says an empty week in one line and keeps the grid one tab stop', async () => {
    mockDb.commitments.clear();
    const { wrapper } = await mountPlanner('/planner?w=2027-01-04');
    const empty = wrapper.get('[data-planner-empty]');
    expect(empty.text()).toContain('이 주에는 블록도, 약속도, 마감도 없어요.');
    expect(empty.get('a').attributes('href')).toBe('/plan/schedule');
    expect(wrapper.findAll('.wg-item')).toHaveLength(0);
    expect(wrapper.find('.planner-summary').exists()).toBe(false);
    expect(wrapper.get('[data-week-body]').attributes('tabindex')).toBe('0');
    expect(wrapper.find('[data-week-now]').exists()).toBe(false);
  });

  it('does not call a planned week empty (negative)', async () => {
    const { wrapper } = await mountPlanner();
    expect(wrapper.find('[data-planner-empty]').exists()).toBe(false);
  });

  it('shows a skeleton while it loads, an error with retry, and what it had when a re-read fails', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failing = false;
    server.use(
      http.get(/\/api\/v1\/schedule-blocks(\?.*)?$/, async () => {
        await held;
        return failing ? forbidden() : HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    const { wrapper, queryClient } = await mountPlanner('/planner', { wait: false });
    await vi.waitFor(() => expect(wrapper.find('[data-week-grid]').attributes('aria-busy')).toBe('true'));
    expect(wrapper.findAll('.wg-skeleton').length).toBeGreaterThan(6);
    expect(wrapper.get('[role="status"]').text()).toBe('이 주 일정을 불러오는 중…');
    expect(wrapper.find('[data-planner-empty]').exists()).toBe(false);
    release();
    await loaded(wrapper);
    expect(wrapper.find('.wg-skeleton').exists()).toBe(false);
    expect(wrapper.find(DENTIST).exists()).toBe(true);

    failing = true;
    await queryClient.refetchQueries();
    await vi.waitFor(() => expect(wrapper.text()).toContain('최신 일정을 다시 불러오지 못했어요.'));
    expect(wrapper.find(DENTIST).exists()).toBe(true);
    failing = false;
    await wrapper.get('[data-planner-retry]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('최신 일정을 다시 불러오지 못했어요.'));
  });

  it('says when the week cannot be read at all, and reads it on retry', async () => {
    let failing = true;
    server.use(http.get('*/api/v1/commitments', () => (failing ? forbidden() : HttpResponse.json({ items: [], nextCursor: null }))));
    const { wrapper } = await mountPlanner('/planner', { wait: false });
    await vi.waitFor(() => expect(wrapper.text()).toContain('이 주 일정을 불러오지 못했어요.'));
    expect(wrapper.find('[data-planner-empty]').exists()).toBe(false);
    failing = false;
    await wrapper.get('[data-planner-retry]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('이 주 일정을 불러오지 못했어요.'));
    await vi.waitFor(() => expect(wrapper.find(`[data-item="${BLOCK_ONE}"]`).exists()).toBe(true));
  });

  it('offline without data: says so, reads nothing, and adding is off', async () => {
    onlineManager.setOnline(false);
    const { wrapper } = await mountPlanner('/planner', { offline: true, wait: false });
    await flushPromises();
    expect(wrapper.text()).toContain('오프라인이라 이 주 일정을 불러올 수 없어요.');
    expect(wrapper.text()).toContain('오프라인 · 읽기 전용');
    expect(wrapper.find('.wg-skeleton').exists()).toBe(false);
    expect(wrapper.get('[data-planner-add]').attributes('disabled')).toBeDefined();
  });
});

describe('플래너 — one floating detail card', () => {
  it('opens for a block with its title, time, project and actions; none of them is filled', async () => {
    const { wrapper } = await mountPlanner();
    expect(wrapper.find('[data-planner-card]').exists()).toBe(false);
    const block = item(wrapper, BLOCK_ONE);
    expect(block.attributes('aria-haspopup')).toBe('dialog');
    expect(block.attributes('aria-expanded')).toBe('false');
    await block.trigger('click');
    await flushPromises();

    const panel = card(wrapper);
    expect(panel.attributes('role')).toBe('dialog');
    expect(panel.attributes('aria-labelledby')).toBe('planner-card-title');
    expect(panel.get('#planner-card-title').text()).toBe(TODAY_TASK_ONE_TITLE);
    expect(panel.get('#planner-card-when').text()).toContain('11월 14일 (토) 오후 7:00~8:30');
    expect(panel.get('#planner-card-when').text()).toContain('1시간 30분');
    expect(panel.get('[data-planner-card-kind]').text()).toBe('블록');
    await vi.waitFor(() => expect(panel.get('[data-planner-card-project]').text()).toBe('인박스'));
    expect(panel.get('[data-planner-card-start]').text()).toBe('집중 시작');
    expect(panel.get('[data-block-lock]').text()).toBe('블록 고정');
    expect(panel.get('[data-block-lock]').attributes('aria-pressed')).toBe('false');
    expect(panel.get('[data-planner-card-task]').attributes('href')).toBe(`/tasks/${TODAY_TASK_ONE_ID}`);
    expect(panel.get('[data-planner-card-task]').text()).toBe('작업 열기');
    expect(panel.find('[data-planner-card-commitments]').exists()).toBe(false);
    // The screen keeps its one filled button (약속 추가); the card adds none.
    expect(panel.findAll('.btn--primary')).toHaveLength(0);
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1);
    expect(block.attributes('aria-expanded')).toBe('true');
    expect(block.classes()).toContain('wg-item--open');
    // Focus is in the card.
    expect(panel.element.contains(document.activeElement)).toBe(true);
  });

  it('is only ever one: another item replaces it, the same item closes it', async () => {
    const { wrapper } = await mountPlanner();
    await item(wrapper, BLOCK_ONE).trigger('click');
    await flushPromises();
    await item(wrapper, DEADLINE).trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-planner-card]')).toHaveLength(1);
    expect(card(wrapper).attributes('data-planner-card')).toBe('deadline');
    expect(card(wrapper).get('#planner-card-title').text()).toBe('장학금 신청서 제출');
    expect(item(wrapper, BLOCK_ONE).attributes('aria-expanded')).toBe('false');
    await item(wrapper, DEADLINE).trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-planner-card]').exists()).toBe(false);
  });

  it('closes on Escape and on 닫기 and gives the focus back to its item', async () => {
    const { wrapper } = await mountPlanner();
    const block = item(wrapper, BLOCK_ONE);
    await block.trigger('click');
    await flushPromises();
    await press(card(wrapper).element, 'Escape');
    expect(wrapper.find('[data-planner-card]').exists()).toBe(false);
    expect(document.activeElement).toBe(block.element);

    await block.trigger('click');
    await flushPromises();
    await card(wrapper).get('[data-planner-card-close]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-planner-card]').exists()).toBe(false);
    expect(document.activeElement).toBe(block.element);
  });

  it('closes on a press outside it, but not on a press inside (negative)', async () => {
    const { wrapper } = await mountPlanner();
    await item(wrapper, BLOCK_ONE).trigger('click');
    await flushPromises();
    card(wrapper).get('#planner-card-title').element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(wrapper.find('[data-planner-card]').exists()).toBe(true);
    wrapper.get('h1').element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(wrapper.find('[data-planner-card]').exists()).toBe(false);
  });

  it('집중 시작 starts a session on the block and opens the Focus screen', async () => {
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountPlanner();
    await item(wrapper, BLOCK_ONE).trigger('click');
    await flushPromises();
    await card(wrapper).get('[data-planner-card-start]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: TODAY_TASK_ONE_ID, blockId: TODAY_BLOCK_ONE_ID });
    expect(String(router.currentRoute.value.params['sessionId'])).toBe(mockDb.activeSessionId);
  });

  it('블록 고정 locks the block with its version and shows it pressed after the re-read', async () => {
    const lock = vi.spyOn(plannerClient, 'setScheduleBlockLock');
    const blocks = vi.spyOn(plannerClient, 'listScheduleBlocks');
    const { wrapper } = await mountPlanner();
    await item(wrapper, BLOCK_ONE).trigger('click');
    await flushPromises();
    const readsBefore = blocks.mock.calls.length;
    await card(wrapper).get('button[data-block-lock]').trigger('click');
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(1));
    expect(lock.mock.calls[0]?.slice(0, 2)).toEqual([TODAY_BLOCK_ONE_ID, true]);
    expect(lock.mock.calls[0]?.[3]).toBe(1);
    await vi.waitFor(() => expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)?.locked).toBe(true));
    // The week was read again, and the toggle (no longer pending) shows what the server has.
    await vi.waitFor(() => expect(blocks.mock.calls.length).toBeGreaterThan(readsBefore));
    await vi.waitFor(() => expect(card(wrapper).get('button[data-block-lock]').attributes('aria-busy')).toBeUndefined());
    expect(card(wrapper).get('button[data-block-lock]').attributes('data-block-lock')).toBe('locked');
    expect(card(wrapper).get('button[data-block-lock]').attributes('aria-pressed')).toBe('true');
  });

  it('a finished block cannot be started or locked (negative)', async () => {
    const { wrapper } = await mountPlanner();
    await wrapper.get('.wg-day[data-date="2026-11-10"] [data-kind="block"]').trigger('click');
    await flushPromises();
    const panel = card(wrapper);
    expect(panel.get('[data-planner-card-kind]').text()).toBe('끝낸 블록');
    expect(panel.find('[data-planner-card-start]').exists()).toBe(false);
    expect(panel.find('button[data-block-lock]').exists()).toBe(false);
    expect(panel.get('[data-planner-card-task]').attributes('href')).toMatch(/^\/tasks\//);
  });

  it('a 약속 leads to the 약속 screen and nowhere else; one from Google says so', async () => {
    const { wrapper } = await mountPlanner();
    await dentist(wrapper).trigger('click');
    await flushPromises();
    let panel = card(wrapper);
    expect(panel.attributes('data-planner-card')).toBe('commitment');
    expect(panel.get('[data-planner-card-kind]').text()).toBe('약속');
    expect(panel.get('#planner-card-when').text()).toContain('오후 3:00~3:40');
    expect(panel.get('[data-planner-card-commitments]').attributes('href')).toBe('/commitments');
    expect(panel.get('[data-planner-card-commitments]').text()).toBe('약속 화면에서 열기');
    expect(panel.find('[data-planner-card-start]').exists()).toBe(false);
    expect(panel.find('[data-block-lock]').exists()).toBe(false);
    expect(panel.find('[data-planner-card-task]').exists()).toBe(false);
    expect(panel.find('[data-planner-card-google]').exists()).toBe(false);
    await press(panel.element, 'Escape');

    const stored = mockDb.commitments.get(MONTH_COMMITMENT_DENTIST_ID);
    if (stored === undefined) throw new Error('missing 약속');
    mockDb.commitments.set(stored.id, { ...stored, source: 'google' });
    const google = await mountPlanner();
    await dentist(google.wrapper).trigger('click');
    await flushPromises();
    panel = card(google.wrapper);
    expect(dentist(google.wrapper).attributes('aria-label')).toMatch(/^약속 · 구글 캘린더, 치과 예약, /);
    expect(panel.get('[data-planner-card-source]').text()).toBe('구글 캘린더');
    expect(panel.get('[data-planner-card-google]').text()).toContain('구글 캘린더에서 바꿔 주세요');
    expect(panel.findAll('a, button').map((control) => control.text() || control.attributes('aria-label'))).toEqual([
      '닫기',
      '약속 화면에서 열기',
    ]);
  });

  it('a deadline leads to its task only', async () => {
    const { wrapper } = await mountPlanner();
    await item(wrapper, DEADLINE).trigger('click');
    await flushPromises();
    const panel = card(wrapper);
    expect(panel.get('[data-planner-card-kind]').text()).toBe('마감');
    expect(panel.get('#planner-card-when').text()).toBe('11월 14일 (토) 오후 11:00까지');
    expect(panel.get('[data-planner-card-task]').attributes('href')).toBe(`/tasks/${MONTH_TASK_SCHOLARSHIP_ID}`);
    expect(panel.find('[data-planner-card-start]').exists()).toBe(false);
    expect(panel.find('[data-planner-card-commitments]').exists()).toBe(false);
    // Not overdue yet at 18:40 (negative).
    expect(panel.text()).not.toContain('지났어요');
  });

  it('offline: the card still opens, but nothing can be started or locked', async () => {
    const { wrapper, pinia } = await mountPlanner();
    useOfflineStore(pinia).setOnline(false);
    await nextTick();
    await item(wrapper, BLOCK_ONE).trigger('click');
    await flushPromises();
    const panel = card(wrapper);
    expect(panel.get('[data-planner-card-start]').attributes('disabled')).toBeDefined();
    expect(panel.get('button[data-block-lock]').attributes('disabled')).toBeDefined();
    expect(panel.get('[data-planner-card-task]').attributes('href')).toBe(`/tasks/${TODAY_TASK_ONE_ID}`);
  });
});

describe('플래너 — 약속 추가', () => {
  async function openDialog(wrapper: VueWrapper): Promise<void> {
    await wrapper.get('[data-planner-add]').trigger('click');
    await flushPromises();
    await nextTick();
  }

  it('offers both ways in: 말로 적기 on top, 직접 입력 under it, the technical fields behind 고급', async () => {
    const { wrapper } = await mountPlanner();
    await openDialog(wrapper);
    const panel = dialog();
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.querySelector('#planner-add-title')?.textContent).toBe('약속 추가');
    const headings = [...panel.querySelectorAll('h3')].map((heading) => heading.textContent?.trim());
    expect(headings).toEqual(['말로 적기', '직접 입력']);
    expect(panel.querySelector('#commitment-note')).not.toBeNull();
    // What a person fills in is on show…
    for (const id of ['planner-commitment-title', 'planner-commitment-start', 'planner-commitment-end']) {
      expect(panel.querySelector(`#${id}`)?.closest('details')).toBeNull();
    }
    expect(panel.querySelectorAll('[data-planner-add-day]')).toHaveLength(7);
    // …the time zone and the raw rule are folded away.
    const advanced = field<HTMLDetailsElement>('[data-planner-add-advanced]');
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')?.textContent).toBe('고급 · 시간대와 반복 규칙');
    expect(advanced.querySelector('#planner-commitment-timezone')).not.toBeNull();
    expect(advanced.querySelector('#planner-commitment-rrule')).not.toBeNull();
    expect(field('#planner-commitment-timezone').value).toBe('Asia/Seoul');
    // It starts on the day on show, at the next full hour (now is 18:40).
    expect(field('#planner-commitment-start').value).toBe('2026-11-14T19:00');
    expect(field('#planner-commitment-end').value).toBe('2026-11-14T20:00');
  });

  it('starts at 09:00 on a day that is not today', async () => {
    const { wrapper } = await mountPlanner('/planner?view=day&d=2026-11-20');
    await openDialog(wrapper);
    expect(field('#planner-commitment-start').value).toBe('2026-11-20T09:00');
    expect(field('#planner-commitment-end').value).toBe('2026-11-20T10:00');
  });

  it('gives the dialog one filled button: 읽기, then 약속 추가 once a title is typed', async () => {
    const { wrapper } = await mountPlanner();
    await openDialog(wrapper);
    const read = field<HTMLButtonElement>('form.nl-entry-form button[type="submit"]');
    const save = field<HTMLButtonElement>('[data-planner-add-save]');
    expect(read.classList.contains('btn--primary')).toBe(true);
    expect(save.classList.contains('btn--primary')).toBe(false);
    await type(field('#planner-commitment-title'), '스터디');
    expect(save.classList.contains('btn--primary')).toBe(true);
    expect(read.classList.contains('btn--primary')).toBe(false);
    expect(dialog().querySelectorAll('.btn--primary')).toHaveLength(1);
  });

  it('refuses a 약속 without a title or with an end before its start, and sends nothing (negative)', async () => {
    const create = vi.spyOn(plannerClient, 'createCommitment');
    const { wrapper } = await mountPlanner();
    await openDialog(wrapper);
    field<HTMLFormElement>('[data-planner-add-manual]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(dialog().querySelector('#planner-commitment-title-error')?.textContent).toContain('제목을 입력해 주세요.');
    expect(field('#planner-commitment-title').getAttribute('aria-invalid')).toBe('true');

    await type(field('#planner-commitment-title'), '스터디');
    await type(field('#planner-commitment-end'), '2026-11-14T18:00');
    field<HTMLFormElement>('[data-planner-add-manual]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(dialog().querySelector('#planner-commitment-title-error')).toBeNull();
    expect(dialog().querySelector('#planner-commitment-end-error')?.textContent).toContain('종료가 시작보다 늦어야 해요.');

    await type(field('#planner-commitment-end'), '');
    field<HTMLFormElement>('[data-planner-add-manual]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(dialog().querySelector('#planner-commitment-end-error')?.textContent).toContain(
      '시작과 종료를 올바른 현지 시각으로 입력해 주세요.',
    );
    expect(create).not.toHaveBeenCalled();
    expect(document.querySelector('[data-planner-add-dialog]')).not.toBeNull();
  });

  it('saves a 약속 from the manual fields with the existing create call, closes and refreshes the planner', async () => {
    const create = vi.spyOn(plannerClient, 'createCommitment');
    const blocks = vi.spyOn(plannerClient, 'listScheduleBlocks');
    const { wrapper } = await mountPlanner();
    const readsBefore = blocks.mock.calls.length;
    await openDialog(wrapper);
    await type(field('#planner-commitment-title'), '  주간 스터디  ');
    await type(field('#planner-commitment-start'), '2026-11-12T12:00');
    await type(field('#planner-commitment-end'), '2026-11-12T13:30');
    field('[data-planner-add-day="TH"]').click();
    await nextTick();
    // The weekday chips write the rule the advanced field shows.
    expect(field('#planner-commitment-rrule').value).toBe('FREQ=WEEKLY;BYDAY=TH');
    field<HTMLFormElement>('[data-planner-add-manual]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toEqual({
      title: '주간 스터디',
      startAt: '2026-11-12T03:00:00.000Z',
      endAt: '2026-11-12T04:30:00.000Z',
      timeZone: 'Asia/Seoul',
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
    });
    await vi.waitFor(() => expect(document.querySelector('[data-planner-add-dialog]')).toBeNull());
    // The week re-read its lists and the new 약속 is on Thursday.
    await vi.waitFor(() => expect(blocks.mock.calls.length).toBeGreaterThan(readsBefore));
    await vi.waitFor(() =>
      expect(
        wrapper
          .findAll('.wg-day[data-date="2026-11-12"] [data-kind="commitment"] .wg-item-title')
          .map((title) => title.text()),
      ).toContain('주간 스터디'),
    );
  });

  it('keeps the dialog and says why when the save fails (negative)', async () => {
    server.use(http.post('*/api/v1/commitments', () => forbidden()));
    const { wrapper } = await mountPlanner();
    await openDialog(wrapper);
    await type(field('#planner-commitment-title'), '스터디');
    field<HTMLFormElement>('[data-planner-add-manual]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dialog().querySelector('[data-planner-add-error]')).not.toBeNull());
    expect(dialog().querySelector('[data-planner-add-error]')?.getAttribute('role')).toBe('alert');
    expect(field('#planner-commitment-title').value).toBe('스터디');
    expect(field<HTMLButtonElement>('[data-planner-add-save]').disabled).toBe(false);
  });

  it('말로 적기: reads the note, adds the draft with the same create call and refreshes the planner', async () => {
    const create = vi.spyOn(plannerClient, 'createCommitment');
    const parse = vi.spyOn(plannerClient, 'parseCommitments');
    const commitments = vi.spyOn(plannerClient, 'listCommitments');
    const { wrapper } = await mountPlanner();
    await openDialog(wrapper);
    await type(field<HTMLTextAreaElement>('#commitment-note'), '내일 오후 3시에 치과');
    field<HTMLFormElement>('form.nl-entry-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dialog().querySelectorAll('[data-testid="nl-draft"]')).toHaveLength(1));
    expect(parse).toHaveBeenCalledTimes(1);
    // Reading saved nothing.
    expect(create).not.toHaveBeenCalled();
    const readsBefore = commitments.mock.calls.length;
    const add = [...dialog().querySelectorAll<HTMLButtonElement>('[data-testid="nl-draft"] button')].find((button) =>
      button.textContent?.trim().endsWith('추가'),
    );
    if (add === undefined) throw new Error('missing 추가');
    // The draft's add is the dialog's one filled button now.
    expect(add.classList.contains('btn--primary')).toBe(true);
    add.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ title: '치과', timeZone: 'Asia/Seoul' });
    await vi.waitFor(() => expect(commitments.mock.calls.length).toBeGreaterThan(readsBefore));
    // The dialog stays open on the read result (more drafts may wait).
    expect(dialog().querySelector('[data-testid="nl-draft"]')?.textContent).toContain('추가했어요');
  });

  it('고치기 moves a read draft into the manual fields', async () => {
    const { wrapper } = await mountPlanner();
    await openDialog(wrapper);
    await type(field<HTMLTextAreaElement>('#commitment-note'), '내일 오후 3시에 치과');
    field<HTMLFormElement>('form.nl-entry-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dialog().querySelectorAll('[data-testid="nl-draft"]')).toHaveLength(1));
    const edit = [...dialog().querySelectorAll<HTMLButtonElement>('[data-testid="nl-draft"] button')].find((button) =>
      button.textContent?.trim().endsWith('고치기'),
    );
    if (edit === undefined) throw new Error('missing 고치기');
    edit.click();
    await flushPromises();
    expect(field('#planner-commitment-title').value).toBe('치과');
    expect(field('#planner-commitment-start').value).toMatch(/T15:00$/);
    expect(dialog().querySelectorAll('[data-testid="nl-draft"]')).toHaveLength(0);
    expect(field<HTMLButtonElement>('[data-planner-add-save]').classList.contains('btn--primary')).toBe(true);
  });

  it('closes with 취소 and Escape without saving (negative)', async () => {
    const create = vi.spyOn(plannerClient, 'createCommitment');
    const { wrapper } = await mountPlanner();
    await openDialog(wrapper);
    await type(field('#planner-commitment-title'), '스터디');
    const cancel = [...dialog().querySelectorAll<HTMLButtonElement>('.dialog-actions button')].find(
      (button) => button.textContent?.trim() === '취소',
    );
    cancel?.click();
    await flushPromises();
    expect(document.querySelector('[data-planner-add-dialog]')).toBeNull();
    await openDialog(wrapper);
    // A new dialog starts clean.
    expect(field('#planner-commitment-title').value).toBe('');
    await press(dialog(), 'Escape');
    expect(document.querySelector('[data-planner-add-dialog]')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('플래너 · 일 — the day', () => {
  it('lists the day in time order beside its timetable, and steps a day at a time', async () => {
    const { wrapper, router } = await mountPlanner('/planner?view=day');
    expect(wrapper.get('h1').text()).toBe('11월 14일 (토)');
    expect(wrapper.get('.planner-summary').text()).toBe('블록 2개 · 약속 2개 · 마감 1개');
    expect(wrapper.get('[data-planner-day-list] h2').text()).toBe('오늘 일정');
    const rows = wrapper.findAll('.planner-agenda-item');
    expect(rows.map((row) => row.attributes('data-kind'))).toEqual(['commitment', 'block', 'block', 'commitment', 'deadline']);
    expect(rows[0]?.text()).toContain('오후 3:00~3:40');
    expect(rows[0]?.text()).toContain('치과 예약');
    expect(rows[1]?.text()).toContain('블록');
    expect(rows[4]?.text()).toContain('오후 11:00까지');
    expect(rows[4]?.text()).toContain('장학금 신청서 제출');
    // Today's list leads to 오늘.
    expect(wrapper.get('[data-planner-open-today]').attributes('href')).toBe('/today');

    const table = wrapper.get('.day-timetable');
    expect(table.get('.tt').attributes('aria-label')).toBe('오늘 블록 2개를 10분 칸에 칠하고 약속 2개를 빗금으로 그린 표');
    expect(table.findAll('[data-timetable-commitment]')).toHaveLength(2);

    expect(wrapper.get('[data-planner-current]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-planner-next]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?view=day&d=2026-11-15'));
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('11월 15일 (일)'));
    await loaded(wrapper);
    expect(wrapper.get('[data-planner-day-list] h2').text()).toBe('이날 일정');
    expect(wrapper.find('[data-planner-open-today]').exists()).toBe(false);
    expect(wrapper.get('.day-timetable .tt').attributes('aria-label')).toBe('이날 블록 1개를 10분 칸에 칠한 표');
    await wrapper.get('[data-planner-current]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/planner?view=day'));
  });

  it('opens the same detail card from a row of the list', async () => {
    const { wrapper } = await mountPlanner('/planner?view=day');
    const row = wrapper.get(`.planner-agenda-item[data-item="${BLOCK_ONE}"]`);
    await row.trigger('click');
    await flushPromises();
    const panel = card(wrapper);
    expect(panel.get('#planner-card-title').text()).toBe(TODAY_TASK_ONE_TITLE);
    expect(panel.get('[data-planner-card-start]').text()).toBe('집중 시작');
    expect(row.attributes('aria-expanded')).toBe('true');
    await press(panel.element, 'Escape');
    expect(document.activeElement).toBe(row.element);
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1);
  });

  it('says an empty day and draws an empty timetable (negative)', async () => {
    mockDb.commitments.clear();
    const { wrapper } = await mountPlanner('/planner?view=day&d=2027-01-06');
    expect(wrapper.get('[data-planner-empty]').text()).toBe('이날은 비어 있어요.');
    expect(wrapper.findAll('.planner-agenda-item')).toHaveLength(0);
    expect(wrapper.find('.planner-summary').exists()).toBe(false);
    expect(wrapper.get('.day-timetable .tt').attributes('aria-label')).toBe('이날 블록 0개를 10분 칸에 칠한 표');
  });
});
