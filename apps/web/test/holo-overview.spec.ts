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
  MONTH_TASK_THESIS_ID,
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_TWO_ID,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { OVERVIEW_RUNNING_SESSION_ID, seedOverviewSessions } from '../src/mocks/overview-seed';
import { REPLAN_PENDING_ID, seedColdEstimation, seedReplanScenario } from '../src/mocks/replan';
import { server } from '../src/mocks/server';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useOfflineStore } from '../src/stores/offline';
import OverviewView from '../src/views/OverviewView.vue';

/**
 * HOLO-01 개요: the dashboard. Every card is checked with data, empty, and
 * failing-then-retried; the screen keeps exactly one primary button.
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/tracker', name: 'tracker', component: Stub },
      { path: '/planner', name: 'planner', component: Stub },
      { path: '/month', name: 'month', component: Stub },
      { path: '/insights', name: 'insights', component: Stub },
      { path: '/replan', name: 'replan', component: Stub },
      { path: '/replan/:id', name: 'replan-proposal', component: Stub },
      { path: '/settings/ai', name: 'ai-settings', component: Stub },
      { path: '/plan', name: 'plan', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
    ],
  });
}

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

const mounted: VueWrapper[] = [];

async function mountOverview(options: { offline?: boolean } = {}): Promise<Mounted> {
  const router = testRouter();
  await router.push('/overview');
  const pinia = createPinia();
  // The owner is verified (GET /me) before any screen renders, as in AppShell.
  await useAuthStore(pinia).ensureOwnerConfirmed();
  if (options.offline === true) useOfflineStore(pinia).setOnline(false);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(OverviewView, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await settled(wrapper);
  return { wrapper, router, pinia };
}

/** No card is loading any more (each is ready, or shows its own error). */
async function settled(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(async () => {
    await flushPromises();
    expect(wrapper.findAll('[data-widget]')).toHaveLength(5);
    expect(wrapper.findAll('[data-widget][data-state="loading"]')).toHaveLength(0);
  });
  await nextTick();
}

function card(wrapper: VueWrapper, name: string) {
  return wrapper.get(`[data-widget="${name}"]`);
}

function compact(node: { text(): string }): string {
  return node.text().replace(/\s+/g, '');
}

function forbidden(): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'no' },
    { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** The mock's believable fortnight: the seeded month and its focus sessions. */
function seedWeek(options: { running?: boolean } = {}): void {
  seedMonth(mockDb);
  seedOverviewSessions(mockDb, options);
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

describe('개요 — greeting and the one primary button', () => {
  it('greets by name and time of day, names the next block and offers to start it', async () => {
    seedWeek();
    const { wrapper } = await mountOverview();
    expect(wrapper.get('h1').text()).toBe('planner님, 좋은 저녁이에요');
    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(wrapper.get('[data-next]').text()).toBe('다음은 오후 7:00에 시작하는 ‘연구 노트 요약’ 블록이에요.');

    // HOLO-04: 오늘 lives here. The page's one filled button is on the next
    // block's card, not in the head.
    await vi.waitFor(() => expect(wrapper.find('[data-primary="start"]').exists()).toBe(true));
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.attributes('data-primary')).toBe('start');
    expect(primaries[0]?.text()).toBe('집중 시작');
    expect(primaries[0]?.element.closest('.today-card--next')).not.toBeNull();
    expect(wrapper.find('.overview-head .btn--primary').exists()).toBe(false);
    // The day, then the week: two sections under the greeting.
    expect(wrapper.get('[data-today-board] h2').text()).toBe('오늘');
    expect(wrapper.get('.overview-week h2').text()).toBe('이번 주');
    expect(wrapper.find('.overview-week [data-week]').exists()).toBe(true);
    // Every card has a title; all but the log have an "open" corner to the screen that owns the detail.
    expect(wrapper.findAll('[data-widget] h2').map((title) => title.text())).toEqual([
      '진행',
      '타임 트래커',
      '오늘 요약',
      'AI 도우미',
      '작업 기록',
    ]);
    expect(
      wrapper.findAll('[data-widget] [data-open]').map((link) => [link.attributes('aria-label'), link.attributes('href')]),
    ).toEqual([
      ['AI 분석 열기', '/insights'],
      // HOLO-04: the 타임 트래커 card opens 집중, where the timer and its record live.
      ['타임 트래커 열기', '/focus'],
      // HOLO-02: 오늘 요약 opens today in 플래너 (한달 is that screen's month view now).
      ['플래너에서 오늘 열기', '/planner?view=day'],
      ['재계획 제안 열기', '/replan'],
    ]);
  });

  it('says good morning in the morning, in the owner’s zone', async () => {
    // 00:30 UTC is 09:30 in Seoul.
    setLayoutClock({ now: () => Date.parse('2026-11-14T00:30:00.000Z') });
    const { wrapper } = await mountOverview();
    expect(wrapper.get('h1').text()).toBe('planner님, 좋은 아침이에요');
  });

  it('starts the next block: one POST for that block, then the Focus screen', async () => {
    seedWeek();
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountOverview();
    await wrapper.get('[data-primary="start"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: TODAY_TASK_ONE_ID, blockId: TODAY_BLOCK_ONE_ID });
  });

  it('offers to make a plan when today has none, still as the only primary (negative: no start button)', async () => {
    mockDb.today = { ...mockDb.today, blocks: [] };
    const { wrapper } = await mountOverview();
    expect(wrapper.get('[data-next]').text()).toBe('오늘 계획이 없어요. 계획을 세우면 다음 할 일이 여기에 보여요.');
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.attributes('data-primary')).toBe('plan');
    expect(primaries[0]?.attributes('href')).toBe('/plan');
    expect(primaries[0]?.text()).toBe('계획 세우기');
    expect(wrapper.find('[data-primary="start"]').exists()).toBe(false);
    expect(wrapper.find('[data-tracker-start]').exists()).toBe(false);
  });

  it('says so when the server refuses because a session is already running (negative)', async () => {
    seedWeek();
    server.use(
      http.post(/\/api\/v1\/sessions$/, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Conflict', status: 409, code: 'active_session_exists', detail: 'busy' },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const { wrapper, router } = await mountOverview();
    // The cards' own start (타임 트래커) reports to the page; the filled button of 오늘 has its own notice (m4-today).
    await wrapper.get('.overview-grid [data-tracker-start]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('.overview-start-error').exists()).toBe(true));
    expect(wrapper.get('.overview-start-error').text()).toContain('이미 돌아가는 세션이 있어요');
    expect(wrapper.get('.overview-start-error').attributes('role')).toBe('alert');
    expect(router.currentRoute.value.name).toBe('overview');
  });
});

describe('개요 — 진행', () => {
  it('adds up the week, highlights today and compares it with the plan', async () => {
    seedWeek();
    const { wrapper } = await mountOverview();
    const progress = card(wrapper, 'progress');
    expect(progress.attributes('data-state')).toBe('ready');
    // 52 + 78 + 22 + 85 + 58 + (62 + 41) minutes.
    expect(compact(progress.get('[data-week-total]'))).toBe('6시간38분');
    expect(progress.text()).toContain('이번 주 집중 시간');
    expect(progress.get('[data-bar="5"]').classes()).toContain('bar-set-col--highlight');
    expect(progress.get('[data-callout]').text()).toContain('1시간 43분');
    // Today 103 minutes focused against 130 planned.
    expect(progress.get('[data-chip]').text()).toBe('계획보다 −27분');
    const rows = progress.findAll('[data-chart-table] tbody tr').map((row) => [row.get('th').text(), row.get('td').text()]);
    expect(rows).toEqual([
      ['11월 9일 (월)', '52분'],
      ['11월 10일 (화)', '1시간 18분'],
      ['11월 11일 (수)', '22분'],
      ['11월 12일 (목)', '1시간 25분'],
      ['11월 13일 (금)', '58분'],
      ['11월 14일 (토)', '1시간 43분 (계획보다 −27분)'],
      ['11월 15일 (일)', '아직 오지 않은 날'],
    ]);
  });

  it('follows the week switcher back and forth; the next week cannot be opened (negative)', async () => {
    seedWeek();
    const { wrapper } = await mountOverview();
    const next = wrapper.get('[data-week-next]');
    expect(next.attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-week]').text()).toContain('11월 9일');

    await wrapper.get('[data-week-previous]').trigger('click');
    await settled(wrapper);
    expect(wrapper.get('[data-week]').text()).toContain('11월 2일');
    const progress = card(wrapper, 'progress');
    // 80 + 75 + 50 + 110 minutes the week before.
    await vi.waitFor(() => expect(compact(progress.get('[data-week-total]'))).toBe('5시간15분'));
    expect(progress.text()).toContain('이 주의 집중 시간');
    // No bar is "today" in another week, so there is no callout and no chip.
    expect(progress.find('[data-callout]').exists()).toBe(false);
    expect(progress.findAll('.bar-set-col--highlight')).toHaveLength(0);
    expect(next.attributes('disabled')).toBeUndefined();

    await next.trigger('click');
    await settled(wrapper);
    await vi.waitFor(() => expect(compact(card(wrapper, 'progress').get('[data-week-total]'))).toBe('6시간38분'));
    expect(wrapper.get('[data-week-next]').attributes('disabled')).toBeDefined();
  });

  it('shows a real empty state without sessions, never a made-up chart (negative)', async () => {
    const { wrapper } = await mountOverview();
    const progress = card(wrapper, 'progress');
    expect(compact(progress.get('[data-week-total]'))).toBe('0분');
    expect(progress.get('[data-empty]').text()).toContain('이 주에는 집중 기록이 없어요.');
    expect(progress.find('[data-chart="bars"]').exists()).toBe(false);
  });

  it('shows its own error with a retry and leaves the rest of the page alone', async () => {
    seedWeek();
    let failing = true;
    server.use(http.get(/\/api\/v1\/sessions(\?.*)?$/, () => (failing ? forbidden() : undefined)));
    const { wrapper } = await mountOverview();
    const progress = card(wrapper, 'progress');
    expect(progress.attributes('data-state')).toBe('error');
    expect(progress.get('[role="alert"]').text()).toContain('이 카드를 불러오지 못했어요.');
    // The greeting, the plan and the AI card (which needs no sessions) are still there.
    expect(wrapper.get('h1').text()).toBe('planner님, 좋은 저녁이에요');
    expect(wrapper.get('[data-primary="start"]').text()).toBe('집중 시작');
    expect(card(wrapper, 'ai').attributes('data-state')).toBe('ready');
    expect(card(wrapper, 'ai').get('[data-ratio]').text()).toContain('1.3');

    failing = false;
    await progress.get('[data-retry]').trigger('click');
    await vi.waitFor(() => expect(card(wrapper, 'progress').attributes('data-state')).toBe('ready'));
    expect(compact(card(wrapper, 'progress').get('[data-week-total]'))).toBe('6시간38분');
  });
});

describe('개요 — 타임 트래커', () => {
  it('waits at zero, names what is next and lists the last tasks worked on', async () => {
    seedWeek();
    const { wrapper } = await mountOverview();
    const tracker = card(wrapper, 'tracker');
    expect(tracker.get('.tracker-well').attributes('data-status')).toBe('idle');
    expect(tracker.get('.tracker-status').text()).toBe('대기 중');
    expect(tracker.get('[data-timer] .visually-hidden').text()).toBe('00:00:00');
    expect(tracker.get('.tracker-task').text()).toBe('다음: 연구 노트 요약');
    // The card's own start is a quiet button; the lime one is the page's.
    expect(tracker.get('[data-tracker-start]').classes()).not.toContain('btn--primary');

    const recent = tracker.findAll('[data-recent] .tracker-recent-item');
    expect(recent.map((item) => item.get('.tracker-recent-title').text())).toEqual([
      '발표 개요 초안',
      '졸업 논문 3장 초고',
      '세미나 발표 자료',
    ]);
    expect(recent[0]?.get('.tracker-recent-meta').text()).toContain('41분');
    expect(recent[0]?.get('.tracker-recent-meta').text()).toContain('오늘 오후 4:20 시작');
    expect(recent[2]?.get('.tracker-recent-meta').text()).toContain('어제 오후 7:00 시작');
  });

  it('starts an earlier task again through the same flow', async () => {
    seedWeek();
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountOverview();
    const second = card(wrapper, 'tracker').findAll('[data-restart]')[1];
    expect(second?.attributes('aria-label')).toBe('‘졸업 논문 3장 초고’ 다시 시작');
    await second?.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: MONTH_TASK_THESIS_ID });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('blockId');
  });

  it('shows the running session as a live timer and makes "이어서 보기" the one primary', async () => {
    seedWeek({ running: true });
    const { wrapper, router } = await mountOverview();
    const tracker = card(wrapper, 'tracker');
    await vi.waitFor(() => expect(tracker.get('.tracker-well').attributes('data-status')).toBe('active'));
    expect(tracker.get('.tracker-status').text()).toBe('집중하는 중');
    // Started 18:15, it is 18:40.
    expect(tracker.get('[data-timer] .visually-hidden').text()).toBe('00:25:00');
    expect(tracker.get('.tracker-task').text()).toBe('연구 노트 요약');
    expect(wrapper.get('[data-next]').text()).toBe('지금 ‘연구 노트 요약’에 집중하고 있어요.');
    // Nothing offers to start a second session (negative).
    expect(tracker.find('[data-tracker-start]').exists()).toBe(false);
    expect(wrapper.find('[data-primary="start"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-restart]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-restart]').every((button) => button.attributes('disabled') !== undefined)).toBe(true);
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.attributes('data-primary')).toBe('resume');

    await tracker.get('[data-tracker-resume]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.params['sessionId']).toBe(OVERVIEW_RUNNING_SESSION_ID));
  });

  it('has an empty state, and offers no restart for a task that is gone (negative)', async () => {
    const empty = await mountOverview();
    expect(card(empty.wrapper, 'tracker').get('[data-empty]').text()).toContain('아직 집중한 작업이 없어요.');
    expect(card(empty.wrapper, 'tracker').find('[data-recent]').exists()).toBe(false);
    mounted.pop()?.unmount();

    mockDb.sessions.set('01900000-0000-7000-8000-0000000005f0', {
      id: '01900000-0000-7000-8000-0000000005f0',
      taskId: '01900000-0000-7000-8000-00000000dead',
      startedAt: '2026-11-14T02:00:00.000Z',
      endedAt: '2026-11-14T02:30:00.000Z',
      focusedSec: 1500,
      pausedSec: 300,
      state: 'completed',
      clientId: 'test',
      version: 2,
    });
    const { wrapper } = await mountOverview();
    const item = card(wrapper, 'tracker').get('.tracker-recent-item');
    expect(item.get('.tracker-recent-title').text()).toBe('지워진 작업');
    expect(item.find('[data-restart]').exists()).toBe(false);
  });
});

describe('개요 — 오늘 요약', () => {
  it('splits today by kind in a ring and counts what is due today', async () => {
    seedWeek();
    const { wrapper } = await mountOverview();
    const summary = card(wrapper, 'summary');
    expect(summary.findAll('.ring-arc')).toHaveLength(3);
    expect(
      summary.findAll('.legend-row').map((row) => [row.get('.legend-label').text(), row.get('.legend-value').text()]),
    ).toEqual([
      ['집중 블록', '2시간 10분 · 43%'],
      ['약속', '1시간 10분 · 23%'],
      ['끝낸 집중', '1시간 43분 · 34%'],
    ]);
    expect(summary.get('.ring-total').text()).toContain('5시간 3분');
    expect(summary.get('.summary-due').text()).toBe('오늘 마감 1건');
    expect(summary.get('.summary-due').attributes('data-due')).toBe('1');
  });

  it('has an empty state on a day with nothing in it (negative: no ring)', async () => {
    mockDb.today = { ...mockDb.today, blocks: [] };
    const { wrapper } = await mountOverview();
    const summary = card(wrapper, 'summary');
    expect(summary.get('[data-empty]').text()).toContain('오늘은 아직 잡힌 시간이 없어요.');
    expect(summary.find('[data-chart="ring"]').exists()).toBe(false);
    expect(summary.get('.summary-due').text()).toBe('오늘 마감은 없어요');
  });

  it('shows its own error with a retry and leaves the other cards alone', async () => {
    seedWeek();
    let failing = true;
    server.use(http.get('*/api/v1/commitments', () => (failing ? forbidden() : undefined)));
    const { wrapper } = await mountOverview();
    expect(card(wrapper, 'summary').attributes('data-state')).toBe('error');
    expect(card(wrapper, 'progress').attributes('data-state')).toBe('ready');
    expect(card(wrapper, 'log').attributes('data-state')).toBe('ready');

    failing = false;
    await card(wrapper, 'summary').get('[data-retry]').trigger('click');
    await vi.waitFor(() => expect(card(wrapper, 'summary').attributes('data-state')).toBe('ready'));
    expect(card(wrapper, 'summary').findAll('.legend-row')).toHaveLength(3);
  });
});

describe('개요 — AI 도우미', () => {
  it('gives the personal estimate, the risk of today and waiting proposals, each in words', async () => {
    seedWeek();
    const proposal = seedReplanScenario(mockDb);
    const { wrapper } = await mountOverview();
    const ai = card(wrapper, 'ai');
    // 255 minutes actually focused over 195 estimated, in four counted records.
    expect(compact(ai.get('[data-ratio]'))).toBe('1.3배');
    expect(ai.text()).toContain('실제 시간이 예상의 1.3배예요');
    expect(ai.text()).toContain('회고 기록 4건으로 계산했어요');
    expect(ai.get('[data-chart="trend"]').attributes('data-points')).toBe('4');
    expect(ai.get('.ai-link').attributes('href')).toBe('/insights');

    await vi.waitFor(() => expect(ai.get('[data-ai-replan]').text()).toContain('재계획 제안 1건이 기다려요'));
    expect(proposal.id).toBe(REPLAN_PENDING_ID);
    expect(ai.get('[data-ai-replan] a').attributes('href')).toBe(`/replan/${REPLAN_PENDING_ID}`);
    expect(ai.get('[data-ai-replan] .ai-fact-note').text().length).toBeGreaterThan(0);

    const risk = ai.get('[data-ai-risk]');
    expect(risk.attributes('data-ai-risk')).toBe('medium');
    expect(risk.text()).toContain('오늘 계획 위험도 보통');
    // The glass object is there (jsdom has no WebGL: its still stands in), and decorative.
    expect(ai.get('.glass-orb').attributes('aria-hidden')).toBe('true');
    expect(ai.get('.glass-orb').attributes('data-glass')).toBe('still');
  });

  it('says there is not enough yet instead of a ratio of too few records (negative)', async () => {
    seedColdEstimation(mockDb);
    const { wrapper } = await mountOverview();
    const ai = card(wrapper, 'ai');
    expect(ai.get('.ai-estimate').attributes('data-estimate')).toBe('cold');
    expect(ai.text()).toContain('아직 기록이 부족해요');
    expect(ai.text()).toContain('회고를 3번 남기면');
    expect(ai.find('[data-ratio]').exists()).toBe(false);
    expect(ai.find('[data-chart="trend"]').exists()).toBe(false);
    expect(ai.get('[data-ai-replan]').text()).toContain('기다리는 재계획 제안이 없어요');
    expect(ai.find('[data-ai-replan] a').exists()).toBe(false);
  });

  it('without AI consent says so and points to AI 설정, with no figures (negative)', async () => {
    seedWeek();
    mockDb.user = { ...mockDb.user, llmProvider: 'deepseek' };
    const { wrapper } = await mountOverview();
    const ai = card(wrapper, 'ai');
    const consent = ai.get('[data-ai-consent]');
    expect(consent.text()).toContain('AI 계획 도움이 꺼져 있어요');
    expect(consent.get('a').attributes('href')).toBe('/settings/ai');
    expect(consent.get('a').text()).toBe('AI 설정 열기');
    expect(ai.find('[data-ratio]').exists()).toBe(false);
    expect(ai.find('.ai-facts').exists()).toBe(false);
    expect(ai.find('[data-open]').exists()).toBe(false);
    // The other cards do not depend on consent.
    expect(compact(card(wrapper, 'progress').get('[data-week-total]'))).toBe('6시간38분');
  });

  it('shows its own error with a retry and leaves the rest of the page alone', async () => {
    seedWeek();
    let failing = true;
    server.use(http.get('*/api/v1/estimation/profile', () => (failing ? forbidden() : undefined)));
    const { wrapper } = await mountOverview();
    expect(card(wrapper, 'ai').attributes('data-state')).toBe('error');
    expect(card(wrapper, 'tracker').attributes('data-state')).toBe('ready');
    expect(compact(card(wrapper, 'progress').get('[data-week-total]'))).toBe('6시간38분');

    failing = false;
    await card(wrapper, 'ai').get('[data-retry]').trigger('click');
    await vi.waitFor(() => expect(card(wrapper, 'ai').attributes('data-state')).toBe('ready'));
    expect(compact(card(wrapper, 'ai').get('[data-ratio]'))).toBe('1.3배');
  });
});

describe('개요 — 작업 기록', () => {
  it('lists the newest sessions of the week with task, project, time, focus and state', async () => {
    seedWeek();
    const { wrapper } = await mountOverview();
    const log = card(wrapper, 'log');
    expect(log.get('caption').text()).toBe('이번 주 집중 세션');
    const rows = log.findAll('[data-log] tbody tr');
    expect(rows).toHaveLength(6);
    const first = rows[0]!;
    expect(first.get('th').text()).toBe('발표 개요 초안');
    expect(first.findAll('td')[0]?.text()).toBe('인박스');
    expect(first.get('.log-time').text()).toContain('11월 14일 (토)');
    expect(first.get('.log-time').text()).toContain('오후 4:20');
    expect(first.findAll('td')[2]?.text()).toBe('41분');
    expect(first.findAll('td')[3]?.text()).toBe('완료');
    expect(first.get('[data-open-task]').attributes('href')).toBe(`/tasks/${TODAY_TASK_TWO_ID}`);
    expect(first.get('[data-open-task]').attributes('aria-label')).toBe('‘발표 개요 초안’ 작업 열기');
    // A project of the user's own is named; the session given up says so.
    expect(rows[1]?.findAll('td')[0]?.text()).toBe('졸업 논문');
    expect(rows.map((row) => row.attributes('data-session'))).toContain('abandoned');
    expect(rows.find((row) => row.attributes('data-session') === 'abandoned')?.findAll('td')[3]?.text()).toBe('중단');
    // Seven sessions this week, six shown.
    expect(log.get('.overview-note').text()).toBe('이번 주 세션 7개 가운데 최근 것만 보여요');
  });

  it('starts a logged task again', async () => {
    seedWeek();
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountOverview();
    await card(wrapper, 'log').get('[data-restart]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: TODAY_TASK_TWO_ID });
  });

  it('has an empty state and no table without sessions (negative)', async () => {
    const { wrapper } = await mountOverview();
    const log = card(wrapper, 'log');
    expect(log.get('[data-empty]').text()).toContain('이번 주 집중 기록이 없어요.');
    expect(log.find('[data-log]').exists()).toBe(false);
    expect(log.find('.overview-note').exists()).toBe(false);
  });
});

describe('개요 — offline', () => {
  it('stays readable but starts nothing (negative: no request)', async () => {
    seedWeek();
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountOverview({ offline: true });
    expect(wrapper.get('.chip--offline').text()).toBe('오프라인 · 읽기 전용');
    expect(compact(card(wrapper, 'progress').get('[data-week-total]'))).toBe('6시간38분');

    const primary = wrapper.get('[data-primary="start"]');
    expect(primary.attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('[data-restart]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-restart]').every((button) => button.attributes('disabled') !== undefined)).toBe(true);
    expect(wrapper.get('[data-tracker-start]').attributes('disabled')).toBeDefined();

    await primary.trigger('click');
    await wrapper.findAll('[data-restart]')[0]?.trigger('click');
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe('overview');
  });
});
