import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin, onlineManager } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plannerClient } from '../src/api';
import MonthView from '../src/views/MonthView.vue';
import { setLayoutClock } from '../src/layout/clock';
import {
  MONTH_COMMITMENT_SEMINAR_ID,
  MONTH_TASK_SLIDES_ID,
  TODAY_TASK_ONE_TITLE,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { useOfflineStore } from '../src/stores/offline';

const Stub = defineComponent({ template: '<div />' });
/** 2026-11-14 18:40 in Seoul, the mock's day. */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/month', name: 'month', component: Stub },
      { path: '/today', name: 'today', component: Stub },
      { path: '/commitments', name: 'commitments', component: Stub },
      { path: '/plans/new', name: 'plans-new', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
    ],
  });
}

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly queryClient: QueryClient;
}

const mounted: VueWrapper[] = [];

async function mountMonth(path = '/month', options: { waitForData?: boolean } = {}): Promise<Mounted> {
  const router = testRouter();
  await router.push(path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const pinia = createPinia();
  const wrapper = mount(MonthView, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  if (options.waitForData !== false) {
    await vi.waitFor(() => expect(wrapper.find('[data-month-title]').exists()).toBe(true));
    await vi.waitFor(() => expect(wrapper.find('.month-grid').attributes('aria-busy')).toBeUndefined());
  }
  return { wrapper, router, queryClient };
}

function cell(wrapper: VueWrapper, date: string) {
  return wrapper.get(`[role="gridcell"][data-date="${date}"]`);
}

function activeDate(): string | null {
  return document.activeElement instanceof HTMLElement ? (document.activeElement.dataset['date'] ?? null) : null;
}

async function press(wrapper: VueWrapper, key: string): Promise<void> {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) throw new Error('nothing has focus');
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
  await nextTick();
  void wrapper;
}

describe('한달 (MonthView)', () => {
  beforeEach(() => {
    setLayoutClock({ now: () => NOW });
    seedMonth(mockDb);
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.unmount();
    setLayoutClock(null);
    onlineManager.setOnline(true);
  });

  it('opens on this month in the owner zone, Monday first, with every week that touches it', async () => {
    const { wrapper } = await mountMonth();
    expect(wrapper.get('h1').text()).toBe('2026년 11월');
    expect(wrapper.findAll('[role="columnheader"]').map((head) => head.text())).toEqual(['월', '화', '수', '목', '금', '토', '일']);
    expect(wrapper.findAll('[role="columnheader"]')[0]?.attributes('aria-label')).toBe('월요일');
    expect(wrapper.findAll('[role="row"]')).toHaveLength(7);
    const dates = wrapper.findAll('[role="gridcell"]').map((item) => item.attributes('data-date'));
    expect(dates[0]).toBe('2026-10-26');
    expect(dates.at(-1)).toBe('2026-12-06');
    expect(cell(wrapper, '2026-10-26').classes()).toContain('month-cell--other');
    expect(cell(wrapper, '2026-11-13').classes()).toContain('month-cell--past');
    expect(cell(wrapper, '2026-11-14').classes()).toContain('month-cell--today');
    expect(wrapper.get('.month-summary').text()).toBe('이 달 · 블록 30개 · 약속 17개 · 마감 4개');
  });

  it('puts blocks, 약속 and deadlines on their days, in time order', async () => {
    const { wrapper } = await mountMonth();
    const today = cell(wrapper, '2026-11-14');
    const kinds = today.findAll('.month-item').map((item) => item.attributes('data-kind'));
    // 15:00 치과 예약, 19:00 and 21:00 blocks, then "+2개" (22:00 통화, 23:00 마감).
    expect(kinds).toEqual(['commitment', 'block', 'block']);
    expect(today.text()).toContain('15:00');
    expect(today.text()).toContain('치과 예약');
    expect(today.text()).toContain(TODAY_TASK_ONE_TITLE);
    expect(today.get('.month-more').text()).toBe('+2개');

    const friday = cell(wrapper, '2026-11-20');
    expect(friday.findAll('.month-item').map((item) => item.attributes('data-kind'))).toEqual(['deadline', 'commitment', 'block']);
    expect(friday.text()).toContain('세미나 발표 자료');

    // A finished block reads as done; the task that is done has no deadline mark (negative).
    const tenth = cell(wrapper, '2026-11-10');
    expect(tenth.find('.month-item--done').exists()).toBe(true);
    expect(tenth.find('[data-kind="deadline"]').exists()).toBe(false);
    expect(cell(wrapper, '2026-11-28').findAll('.month-item')).toHaveLength(0);
  });

  it('names every cell with its date and what it holds', async () => {
    const { wrapper } = await mountMonth();
    expect(cell(wrapper, '2026-11-14').attributes('aria-label')).toBe('11월 14일 토요일, 오늘, 블록 2개, 약속 2개, 마감 1개');
    expect(cell(wrapper, '2026-11-20').attributes('aria-label')).toBe('11월 20일 금요일, 블록 1개, 약속 1개, 마감 1개');
    expect(cell(wrapper, '2026-11-28').attributes('aria-label')).toBe('11월 28일 토요일, 일정 없음');
    expect(cell(wrapper, '2026-12-04').attributes('aria-label')).toBe('12월 4일 금요일, 마감 1개');
    // The words inside a cell are for the eye; the name says it once.
    expect(cell(wrapper, '2026-11-14').get('.month-items').attributes('aria-hidden')).toBe('true');
  });

  it('selects today at first and lists the whole day with where each item leads', async () => {
    const { wrapper } = await mountMonth();
    const today = cell(wrapper, '2026-11-14');
    expect(today.attributes('aria-selected')).toBe('true');
    expect(today.attributes('tabindex')).toBe('0');
    expect(wrapper.findAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);

    const detail = wrapper.get('[data-month-detail]');
    expect(detail.get('h2').text()).toContain('11월 14일 (토)');
    expect(detail.get('a.month-detail-open-today').attributes('href')).toBe('/today');
    const rows = detail.findAll('.month-agenda-item');
    expect(rows.map((row) => row.attributes('data-kind'))).toEqual(['commitment', 'block', 'block', 'commitment', 'deadline']);
    expect(rows[0]?.text()).toContain('오후 3:00~3:40');
    expect(rows[0]?.get('a').attributes('href')).toBe('/commitments');
    expect(rows[4]?.text()).toContain('오후 11:00까지');
    expect(rows[4]?.get('a').attributes('href')).toMatch(/^\/tasks\//);
  });

  it('shows another day when it is picked, without a way to "today" (negative)', async () => {
    const { wrapper } = await mountMonth();
    await cell(wrapper, '2026-11-20').trigger('click');
    expect(cell(wrapper, '2026-11-20').attributes('aria-selected')).toBe('true');
    expect(cell(wrapper, '2026-11-14').attributes('aria-selected')).toBe('false');
    const detail = wrapper.get('[data-month-detail]');
    expect(detail.get('h2').text()).toBe('11월 20일 (금)');
    expect(detail.find('a.month-detail-open-today').exists()).toBe(false);
    const links = detail.findAll('.month-agenda-title').map((link) => [link.text(), link.attributes('href')]);
    expect(links).toEqual([
      ['세미나 발표 자료', `/tasks/${MONTH_TASK_SLIDES_ID}`],
      ['세미나 발표', '/commitments'],
      ['졸업 논문 3장 초고', expect.stringMatching(/^\/tasks\//)],
    ]);
    expect(mockDb.commitments.has(MONTH_COMMITMENT_SEMINAR_ID)).toBe(true);

    await cell(wrapper, '2026-11-28').trigger('click');
    expect(wrapper.get('.month-detail-empty').text()).toBe('이날은 비어 있어요.');
  });

  it('moves the month in the URL and asks only for the visible grid', async () => {
    const spy = vi.spyOn(plannerClient, 'listScheduleBlocks');
    const { wrapper, router } = await mountMonth();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-10-25T15:00:00.000Z', to: '2026-12-06T15:00:00.000Z', limit: 100 }),
    );
    expect(wrapper.get('[data-month-current]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-month-next]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.query['m']).toBe('2026-12'));
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('2026년 12월'));
    await vi.waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-11-29T15:00:00.000Z', to: '2027-01-03T15:00:00.000Z' }),
      ),
    );
    expect(wrapper.findAll('[role="row"]')).toHaveLength(6);
    // Away from this month, the first of the month is picked.
    expect(cell(wrapper, '2026-12-01').attributes('aria-selected')).toBe('true');

    await wrapper.get('[data-month-current]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/month'));
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('2026년 11월'));

    await wrapper.get('[data-month-previous]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.query['m']).toBe('2026-10'));

    // Back in history is the month before.
    router.back();
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('2026년 11월'));
  });

  it('opens on the month in the URL and drops a month it cannot mean (negative)', async () => {
    const january = await mountMonth('/month?m=2027-01');
    expect(january.wrapper.get('h1').text()).toBe('2027년 1월');
    january.wrapper.unmount();
    mounted.splice(mounted.indexOf(january.wrapper), 1);

    const broken = await mountMonth('/month?m=2026-13');
    await vi.waitFor(() => expect(broken.router.currentRoute.value.fullPath).toBe('/month'));
    expect(broken.wrapper.get('h1').text()).toBe('2026년 11월');
  });

  it('moves focus by day and week, to the week ends and across months, and selects with Enter', async () => {
    const { wrapper, router } = await mountMonth();
    (cell(wrapper, '2026-11-14').element as HTMLElement).focus();
    expect(activeDate()).toBe('2026-11-14');

    await press(wrapper, 'ArrowRight');
    expect(activeDate()).toBe('2026-11-15');
    expect(cell(wrapper, '2026-11-15').attributes('tabindex')).toBe('0');
    expect(cell(wrapper, '2026-11-14').attributes('tabindex')).toBe('-1');
    await press(wrapper, 'ArrowDown');
    expect(activeDate()).toBe('2026-11-22');
    await press(wrapper, 'Home');
    expect(activeDate()).toBe('2026-11-16');
    await press(wrapper, 'End');
    expect(activeDate()).toBe('2026-11-22');
    await press(wrapper, 'ArrowLeft');
    expect(activeDate()).toBe('2026-11-21');
    // Moving does not select (negative); Enter and Space do.
    expect(cell(wrapper, '2026-11-21').attributes('aria-selected')).toBe('false');
    await press(wrapper, 'Enter');
    expect(cell(wrapper, '2026-11-21').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[data-month-detail] h2').text()).toBe('11월 21일 (토)');

    await press(wrapper, 'PageDown');
    await vi.waitFor(() => expect(router.currentRoute.value.query['m']).toBe('2026-12'));
    await vi.waitFor(() => expect(activeDate()).toBe('2026-12-21'));

    // Up from the first row leaves the grid: the month follows the focus.
    (cell(wrapper, '2026-12-01').element as HTMLElement).focus();
    await press(wrapper, 'ArrowUp');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/month'));
    await vi.waitFor(() => expect(activeDate()).toBe('2026-11-24'));

    await press(wrapper, 'PageUp');
    await vi.waitFor(() => expect(router.currentRoute.value.query['m']).toBe('2026-10'));
    await vi.waitFor(() => expect(activeDate()).toBe('2026-10-24'));
    await press(wrapper, ' ');
    expect(cell(wrapper, '2026-10-24').attributes('aria-selected')).toBe('true');
  });

  it('shows the grid as a skeleton while the month loads', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(/\/api\/v1\/schedule-blocks(\?.*)?$/, async () => {
        await held;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    const { wrapper } = await mountMonth('/month', { waitForData: false });
    await vi.waitFor(() => expect(wrapper.find('.month-grid').attributes('aria-busy')).toBe('true'));
    expect(wrapper.findAll('[role="gridcell"]')).toHaveLength(42);
    expect(wrapper.findAll('.month-cell-skeleton').length).toBeGreaterThan(20);
    expect(wrapper.get('[role="status"]').text()).toBe('한달 일정을 불러오는 중…');
    expect(wrapper.find('[data-month-empty]').exists()).toBe(false);
    release();
    await vi.waitFor(() => expect(wrapper.find('.month-grid').attributes('aria-busy')).toBeUndefined());
    expect(wrapper.find('.month-cell-skeleton').exists()).toBe(false);
  });

  it('says when the month cannot be read, and reads it again on retry', async () => {
    let failing = true;
    server.use(
      http.get(/\/api\/v1\/schedule-blocks(\?.*)?$/, ({ request }) => {
        if (failing) {
          return HttpResponse.json(
            { type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'no' },
            { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
          );
        }
        void request;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    const { wrapper } = await mountMonth('/month', { waitForData: false });
    await vi.waitFor(() => expect(wrapper.text()).toContain('이 달 일정을 불러오지 못했어요.'));
    expect(wrapper.find('[data-month-empty]').exists()).toBe(false);
    expect(wrapper.findAll('[role="gridcell"]')).toHaveLength(42);

    failing = false;
    await wrapper.get('[data-month-retry]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('이 달 일정을 불러오지 못했어요.'));
    await vi.waitFor(() => expect(cell(wrapper, '2026-11-14').text()).toContain('치과 예약'));
  });

  it('keeps what it has when a later re-read fails', async () => {
    const { wrapper, queryClient } = await mountMonth();
    expect(cell(wrapper, '2026-11-14').text()).toContain('치과 예약');
    server.use(
      http.get('*/api/v1/commitments', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'no' },
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    await queryClient.refetchQueries();
    await vi.waitFor(() => expect(wrapper.text()).toContain('최신 일정을 다시 불러오지 못했어요.'));
    expect(cell(wrapper, '2026-11-14').text()).toContain('치과 예약');
    expect(wrapper.text()).not.toContain('이 달 일정을 불러오지 못했어요.');
  });

  it('says a month with nothing planned in one line, and points to making a plan or a 약속', async () => {
    // The weekly 약속 would repeat into January.
    mockDb.commitments.clear();
    const { wrapper } = await mountMonth('/month?m=2027-01');
    const empty = wrapper.get('[data-month-empty]');
    expect(empty.text()).toContain('이 달에는 블록도, 약속도, 마감도 없어요.');
    expect(empty.findAll('a').map((link) => link.attributes('href'))).toEqual(['/plan/schedule', '/commitments']);
    expect(wrapper.findAll('[role="gridcell"]').length).toBeGreaterThanOrEqual(28);
    expect(wrapper.get('[data-month-detail] .month-detail-empty').text()).toBe('이날은 비어 있어요.');
  });

  it('does not call a planned month empty (negative)', async () => {
    const { wrapper } = await mountMonth();
    expect(wrapper.find('[data-month-empty]').exists()).toBe(false);
  });

  it('reads nothing offline without data, and says so instead of loading forever', async () => {
    onlineManager.setOnline(false);
    const pinia = createPinia();
    useOfflineStore(pinia).setOnline(false);
    const router = testRouter();
    await router.push('/month');
    const wrapper = mount(MonthView, {
      global: { plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], router] as never },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    expect(wrapper.text()).toContain('오프라인이라 이 달 일정을 불러올 수 없어요.');
    expect(wrapper.text()).toContain('오프라인 · 읽기 전용');
    expect(wrapper.find('.month-cell-skeleton').exists()).toBe(false);
  });
});
