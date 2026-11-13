import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newActionId, plannerClient, type WorkSession } from '../src/api';
import { clearFocusContexts, focusTaskTitle, rememberFocusTask } from '../src/composables/focusContext';
import { setCalmMode } from '../src/composables/useCalmMode';
import { setLayoutClock } from '../src/layout/clock';
import {
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_ONE_TITLE,
  TODAY_TASK_TWO_ID,
  TODAY_TASK_TWO_TITLE,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { seedOverviewSessions } from '../src/mocks/overview-seed';
import { resetFocusClientIdForTests } from '../src/session/clientId';
import { sessionJournal } from '../src/session/journal';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useSessionStore } from '../src/stores/session';
import FocusView from '../src/views/FocusView.vue';
import TodayView from '../src/views/TodayView.vue';

/**
 * HOLO-02 오늘 and 집중 in the dashboard system: what changed on purpose.
 * (What these screens do — accept, shrink, reschedule, lock, pause, review,
 * sync — is in the M4/M6 suites, which pass unchanged.)
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const OTHER_OWNER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b77';
const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/today', name: 'today', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/commitments', name: 'commitments', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/replan/:id', name: 'replan-proposal', component: Stub },
    ],
  });
}

const mounted: VueWrapper[] = [];

async function mountToday(pinia: Pinia = createPinia()): Promise<VueWrapper> {
  const router = testRouter();
  await router.push('/today');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(TodayView, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await vi.waitFor(() => expect(wrapper.findAll('.today-card').length).toBeGreaterThan(0));
  await flushPromises();
  return wrapper;
}

function startButtons(wrapper: VueWrapper) {
  return wrapper.findAll('.today-card').map((card) => {
    const start = card.findAll('button').find((button) => button.text().includes('집중 시작'));
    if (start === undefined) throw new Error('a block card has no 집중 시작');
    return start;
  });
}

async function createSession(taskId: string, blockId?: string): Promise<WorkSession> {
  return plannerClient.createSession(
    {
      taskId,
      ...(blockId === undefined ? {} : { blockId }),
      clientStartedAt: new Date(NOW).toISOString(),
      clientId: 'holo-daily-test',
    },
    newActionId('session'),
  );
}

async function mountFocus(pinia: Pinia, session: WorkSession, options: { remember?: boolean } = {}): Promise<VueWrapper> {
  if (options.remember !== false) useSessionStore(pinia).remember(session);
  const router = testRouter();
  await router.push(`/focus/${session.id}`);
  const wrapper = mount(FocusView, { global: { plugins: [pinia, router] }, attachTo: document.body });
  mounted.push(wrapper);
  await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
  return wrapper;
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  resetFocusClientIdForTests();
  await sessionJournal.clear();
  clearFocusContexts();
  setLayoutClock({ now: () => NOW });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setCalmMode(false);
  setLayoutClock(null);
  document.body.innerHTML = '';
});

describe('오늘 — the day as cards', () => {
  it('shows the figures as three small stat cards and the risk as a card of its own', async () => {
    const wrapper = await mountToday();
    const stats = wrapper.findAll('.today-stats .today-stat');
    expect(stats.map((stat) => stat.get('dt').text())).toEqual(['여유', '계획', '블록']);
    expect(stats.map((stat) => stat.get('.stat-value').text())).toEqual(['3시간 20분', '2시간 10분', '2']);
    expect(stats.every((stat) => stat.classes().includes('card'))).toBe(true);
    const risk = wrapper.get('.today-risk-card');
    expect(risk.classes()).toContain('card');
    expect(risk.get('.today-risk').attributes('aria-label')).toBe('위험도와 여유');
    expect(risk.text()).toContain('위험도: 보통');
    expect(risk.text()).toContain('남은 계획이 하루 집중 한도를 넘어요 (5시간 10분)');
  });

  it('makes each block a card and gives the next one the mark and the screen’s one filled button', async () => {
    const wrapper = await mountToday();
    const cards = wrapper.findAll('.today-card');
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.classes().includes('card'))).toBe(true);
    expect(cards.map((card) => card.classes().includes('today-card--next'))).toEqual([true, false]);
    expect(cards[0]?.get('.today-next-label').text()).toBe('다음 차례');
    expect(cards[1]?.find('.today-next-label').exists()).toBe(false);
    // The paper system's numbered squares are gone.
    expect(wrapper.find('.today-index').exists()).toBe(false);

    const starts = startButtons(wrapper);
    expect(starts.map((button) => button.classes().includes('btn--primary'))).toEqual([true, false]);
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1);
    // The other blocks can still be started (secondary, not disabled).
    expect(starts[1]?.attributes('disabled')).toBeUndefined();
  });

  it('gives the filled button to 세션 이어가기 while a session waits: no card is filled then', async () => {
    seedOverviewSessions(mockDb, { running: true });
    const wrapper = await mountToday();
    await vi.waitFor(() => expect(wrapper.text()).toContain('세션 이어가기'));
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries.map((button) => button.text())).toEqual(['세션 이어가기']);
    expect(startButtons(wrapper).some((button) => button.classes().includes('btn--primary'))).toBe(false);
  });

  it('has no filled button when every block of the day is over (negative)', async () => {
    // TodayView reads "what is next" from the real clock at mount (as before HOLO-02).
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-14T15:30:00.000Z'));
    const wrapper = await mountToday();
    expect(wrapper.findAll('.today-card--next')).toHaveLength(0);
    expect(wrapper.findAll('.btn--primary')).toHaveLength(0);
    expect(wrapper.find('.today-next-label').exists()).toBe(false);
  });

  it('shows 오늘 약속 and 오늘 마감 as two compact cards, and the timetable as a card', async () => {
    seedMonth(mockDb);
    const wrapper = await mountToday();
    const commitments = await vi.waitFor(() => wrapper.get('[data-today-commitments]'));
    expect(commitments.classes()).toEqual(expect.arrayContaining(['card', 'card--compact']));
    expect(wrapper.get('[data-today-due]').classes()).toEqual(expect.arrayContaining(['card', 'card--compact']));
    // The way to the 약속 screen is the card's open corner, named.
    const open = commitments.get('a.icon-link');
    expect(open.attributes('href')).toBe('/commitments');
    expect(open.attributes('aria-label')).toBe('약속 보기');
    expect(wrapper.get('.day-timetable').classes()).toContain('card');
    // Without 약속 or deadlines neither card is there (negative).
    mockDb.commitments.clear();
    for (const task of [...mockDb.tasks.values()]) {
      if (task.dueAt !== undefined) mockDb.tasks.delete(task.id);
    }
    const bare = await mountToday();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bare.find('[data-today-commitments]').exists()).toBe(false);
    expect(bare.find('[data-today-due]').exists()).toBe(false);
  });
});

describe('집중 — the name of the task, never its id', () => {
  it('shows the block’s title for a session started from a block', async () => {
    const pinia = createPinia();
    await mountToday(pinia);
    const session = await createSession(TODAY_TASK_ONE_ID, TODAY_BLOCK_ONE_ID);
    const wrapper = await mountFocus(pinia, session);
    expect(wrapper.get('.focus-task-title').text()).toBe(TODAY_TASK_ONE_TITLE);
    expect(wrapper.get('.focus-task-meta').text()).toContain('계획 오후 7:00~8:30');
  });

  it('shows the name it was given for a session started on a bare task (타임 트래커)', async () => {
    const pinia = createPinia();
    const session = await createSession(TODAY_TASK_TWO_ID);
    rememberFocusTask(mockDb.user.id, TODAY_TASK_TWO_ID, TODAY_TASK_TWO_TITLE);
    const wrapper = await mountFocus(pinia, session);
    expect(wrapper.get('.focus-task-title').text()).toBe(TODAY_TASK_TWO_TITLE);
    // No planned time to compare with: it says when it started instead.
    expect(wrapper.get('.focus-task-meta').text()).toMatch(/에 시작했어요$/);
    expect(wrapper.find('.focus-progress').exists()).toBe(false);
  });

  it('reads the task’s name after a reload, and shows no id while it waits or when it cannot (negative)', async () => {
    const pinia = createPinia();
    await useAuthStore(pinia).ensureOwnerConfirmed();
    const session = await createSession(TODAY_TASK_TWO_ID);
    const wrapper = await mountFocus(pinia, session);
    // Before the answer: the plain fallback, not an id.
    expect(wrapper.text()).not.toContain(session.taskId);
    await vi.waitFor(() => expect(wrapper.get('.focus-task-title').text()).toBe(TODAY_TASK_TWO_TITLE));
    expect(wrapper.text()).not.toContain(session.taskId);
    expect(wrapper.text()).not.toContain(session.id);

    // A task that is gone: the fallback stays, still without an id.
    mockDb.sessions.set(session.id, { ...session, state: 'completed', endedAt: new Date(NOW).toISOString() });
    mockDb.activeSessionId = null;
    const gone = await createSession(TODAY_TASK_ONE_ID, TODAY_BLOCK_ONE_ID);
    mockDb.sessions.set(gone.id, { ...gone, state: 'completed', endedAt: new Date(NOW).toISOString() });
    mockDb.activeSessionId = null;
    mockDb.tasks.delete(TODAY_TASK_ONE_ID);
    const other = await mountFocus(createPinia(), { ...gone, state: 'completed' });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(other.get('.focus-task-title').text()).toBe('집중 세션');
    expect(other.text()).not.toContain(TODAY_TASK_ONE_ID);
    expect(other.text()).not.toContain(TODAY_BLOCK_ONE_ID);
  });

  it('keeps a remembered name to its owner (negative)', () => {
    rememberFocusTask(mockDb.user.id, 't1', '내 작업');
    expect(focusTaskTitle(mockDb.user.id, 't1')).toBe('내 작업');
    expect(focusTaskTitle(OTHER_OWNER, 't1')).toBeNull();
    expect(focusTaskTitle(null, 't1')).toBeNull();
    expect(focusTaskTitle(mockDb.user.id, 't2')).toBeNull();
    clearFocusContexts();
    expect(focusTaskTitle(mockDb.user.id, 't1')).toBeNull();
  });
});

describe('집중 — the timer card and calm mode', () => {
  it('sets the timer in a card with the system’s meter under it', async () => {
    const pinia = createPinia();
    await mountToday(pinia);
    const session = await createSession(TODAY_TASK_ONE_ID, TODAY_BLOCK_ONE_ID);
    const wrapper = await mountFocus(pinia, session);
    expect(wrapper.get('.focus-stage').classes()).toContain('card');
    expect(wrapper.get('.focus-timer').attributes('role')).toBe('timer');
    const meter = wrapper.get('.focus-progress-track');
    expect(meter.classes()).toContain('meter');
    expect(meter.get('.meter-fill').exists()).toBe(true);
    // A 90-minute block is ticked into nine ten-minute cells.
    expect(meter.attributes('style')).toContain('--cells: 9');
    // The filled button is the timer's own; 완료 is not filled (negative).
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.text()).toContain('일시정지');
  });

  it('turns calm mode dark whatever the theme, and back when it is left', async () => {
    const pinia = createPinia();
    const session = await createSession(TODAY_TASK_TWO_ID);
    const wrapper = await mountFocus(pinia, session);
    const page = wrapper.get('.focus-page');
    expect(page.classes()).not.toContain('scheme-dark');
    const calm = wrapper.findAll('button').find((button) => button.text().includes('몰입 모드'));
    if (calm === undefined) throw new Error('missing 몰입 모드');
    await calm.trigger('click');
    expect(page.classes()).toEqual(expect.arrayContaining(['focus-page--calm', 'scheme-dark']));
    expect(calm.attributes('aria-pressed')).toBe('true');
    await calm.trigger('click');
    await nextTick();
    expect(page.classes()).not.toContain('scheme-dark');
    expect(page.classes()).not.toContain('focus-page--calm');
  });
});
