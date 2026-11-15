import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newActionId, plannerClient, type WorkSession } from '../src/api';
import FocusNextStep from '../src/components/focus/FocusNextStep.vue';
import PlanCommitmentStep from '../src/components/plan/PlanCommitmentStep.vue';
import { clearFlowReturn, readFlowReturn, rememberFlowReturn, safeReturnPath } from '../src/composables/flowReturn';
import { dayIsOver, dayRecap } from '../src/domain/recap';
import { setLayoutClock } from '../src/layout/clock';
import { TODAY_BLOCK_ONE_ID, TODAY_BLOCK_TWO_ID, TODAY_TASK_ONE_ID, TODAY_TASK_TWO_TITLE, mockDb, seedMonth } from '../src/mocks/db';
import { seedOverviewSessions } from '../src/mocks/overview-seed';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { OWNER_STORAGE_MANIFEST } from '../src/session/ownerStorage';
import { useAuthStore } from '../src/stores/auth';
import { useLlmConsentStore } from '../src/stores/llmConsent';
import { useSessionStore } from '../src/stores/session';
import FocusView from '../src/views/FocusView.vue';
import OverviewView from '../src/views/OverviewView.vue';
import SettingsView from '../src/views/SettingsView.vue';
import TaskDetailView from '../src/views/TaskDetailView.vue';
import TasksView from '../src/views/TasksView.vue';

/**
 * HOLO-04 hand-offs (FLOW.md §2, §5): every stage's ending is the next step
 * as the one filled button — a finished session hands on to the next block
 * or the day's recap, the recap to tomorrow — selections travel, and what a
 * flow needs is asked for where it is needed.
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul; blocks at 19:00 and 21:00.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const ZONE = 'Asia/Seoul';
const OTHER_OWNER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b77';
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/tasks', name: 'tasks', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/projects/:id', name: 'project', component: Stub },
      { path: '/plan', name: 'plan', component: Stub },
      { path: '/plan/schedule', name: 'plan-scope', component: Stub },
      { path: '/planner', name: 'planner', component: Stub },
      { path: '/focus', name: 'focus-home', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/insights', name: 'insights', component: Stub },
      { path: '/replan', name: 'replan', component: Stub },
      { path: '/notes', name: 'notes', component: Stub },
      { path: '/settings/:section?', name: 'settings', component: Stub },
    ],
  });
}

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

async function mountAt(view: unknown, path: string, options: { pinia?: Pinia; props?: Record<string, unknown> } = {}): Promise<Mounted> {
  const router = testRouter();
  await router.push(path);
  const pinia = options.pinia ?? createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(view as never, {
    props: options.props ?? {},
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  } as never);
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, router, pinia };
}

async function finishedSession(blockId = TODAY_BLOCK_ONE_ID): Promise<WorkSession> {
  const created = await plannerClient.createSession(
    { taskId: TODAY_TASK_ONE_ID, blockId, clientStartedAt: new Date().toISOString(), clientId: 'flow-test' },
    newActionId('session'),
  );
  return plannerClient.completeSession(created.id, new Date().toISOString(), newActionId('complete'), created.version);
}

function finishToday(): void {
  mockDb.today = { ...mockDb.today, blocks: mockDb.today.blocks.map((block) => ({ ...block, status: 'done' as const })) };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  setLayoutClock({ now: () => NOW });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setLayoutClock(null);
  adoptActiveOwner(null, 'bootstrap');
  document.body.innerHTML = '';
});

// ── ④ 집중 → 다음 걸음 ───────────────────────────────────────────────────────

describe('집중이 끝나면 다음 걸음 — the review hands on', () => {
  async function reviewed(): Promise<Mounted & { session: WorkSession }> {
    const session = await finishedSession();
    const pinia = createPinia();
    useSessionStore(pinia).remember(session);
    const app = await mountAt(FocusView, `/focus/${session.id}`, { pinia });
    await vi.waitFor(() => expect(app.wrapper.find('.review-sheet').exists()).toBe(true));
    return { ...app, session };
  }

  it('before the review there is no next step: the review holds the filled button (negative)', async () => {
    const { wrapper } = await reviewed();
    expect(wrapper.find('[data-focus-next]').exists()).toBe(false);
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['회고 저장']);
  });

  it('once the review is in, 다음 블록 시작 is the one filled button, with the block it means', async () => {
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await reviewed();
    await wrapper.get('.review-submit').trigger('click');
    const next = await vi.waitFor(() => wrapper.get('[data-focus-next]'));
    expect(next.get('h2').text()).toBe('회고를 저장했어요');
    // The estimate feedback is said in the hand-off, in words.
    expect(next.get('[data-focus-next-feedback]').text()).toMatch(/^예상 .+ · 실제 .+ · .+$/);
    // The block that just ended is not "next": the other one of today is.
    expect(next.get('[data-focus-next-line]').text()).toContain(`다음은 ‘${TODAY_TASK_TWO_TITLE}’`);
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.attributes('data-focus-next-primary')).toBe('start');
    expect(primaries[0]?.text()).toBe('다음 블록 시작');
    // The review can still be corrected, quietly.
    expect(wrapper.get('.review-submit').classes()).not.toContain('btn--primary');
    expect(wrapper.get('.review-submit').text()).toBe('회고 고쳐 저장');
    // The two other ways on are quiet links.
    expect(next.get('[data-focus-next-rest]').text()).toBe('쉬었다 하기');
    expect(next.get('[data-focus-next-rest]').attributes('href')).toBe('/overview');
    expect(next.get('[data-focus-next-done]').text()).toBe('오늘은 여기까지');
    expect(next.get('[data-focus-next-done]').attributes('href')).toBe('/overview?recap=1');

    await primaries[0]?.trigger('click');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[0]).toMatchObject({ blockId: TODAY_BLOCK_TWO_ID });
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    await vi.waitFor(() => expect(String(router.currentRoute.value.params['sessionId'])).not.toBe(''));
  });

  it('after the last block the filled button is 오늘 돌아보기 (negative: no start, no "오늘은 여기까지")', async () => {
    mockDb.today = { ...mockDb.today, blocks: mockDb.today.blocks.filter((block) => block.id === TODAY_BLOCK_ONE_ID) };
    const { wrapper } = await reviewed();
    await wrapper.get('.review-submit').trigger('click');
    const next = await vi.waitFor(() => wrapper.get('[data-focus-next]'));
    expect(next.get('[data-focus-next-line]').text()).toBe('오늘 계획한 블록을 모두 지났어요.');
    const primary = next.get('[data-focus-next-primary]');
    expect(primary.attributes('data-focus-next-primary')).toBe('recap');
    expect(primary.text()).toBe('오늘 돌아보기');
    expect(primary.attributes('href')).toBe('/overview?recap=1');
    expect(next.find('[data-focus-next-done]').exists()).toBe(false);
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1);
  });

  it('the card itself: a block is not next when it is the one that just ended', async () => {
    const { wrapper } = await mountAt(FocusNextStep, '/focus/x', {
      props: { finishedBlockId: TODAY_BLOCK_TWO_ID, feedback: { estimatedP50: 30, actualFocusMin: 25, quality: 'ok' } },
    });
    await vi.waitFor(() => expect(wrapper.get('[data-focus-next-line]').text()).toContain('연구 노트 요약'));
    expect(wrapper.get('[data-focus-next-feedback]').text()).toBe('예상 30분 · 실제 25분 · 예상과 비슷했어요');
  });
});

// ── ⑤ 돌아보기 ───────────────────────────────────────────────────────────────

describe('오늘 정리 — the day against its plan (domain/recap.ts)', () => {
  const block = (id: string, status: 'planned' | 'done' | 'skipped' | 'moved', start: string, end: string) => ({
    id,
    taskId: `t-${id}`,
    title: id,
    startAt: start,
    endAt: end,
    status,
  });
  const session = (startedAt: string, focusedSec: number) => ({ startedAt, focusedSec, pausedSec: 0, state: 'completed' as const });

  it('counts the blocks of the plan and what was focused on the day, in the owner’s zone', () => {
    const recap = dayRecap({
      blocks: [
        block('a', 'done', '2026-11-14T10:00:00.000Z', '2026-11-14T11:30:00.000Z'),
        block('b', 'planned', '2026-11-14T12:00:00.000Z', '2026-11-14T12:40:00.000Z'),
        // Moved away: not part of the day's plan any more.
        block('c', 'moved', '2026-11-14T13:00:00.000Z', '2026-11-14T14:00:00.000Z'),
      ],
      sessions: [
        session('2026-11-14T10:00:00.000Z', 80 * 60),
        // 2026-11-13 23:30 in Seoul: yesterday's.
        session('2026-11-13T14:30:00.000Z', 60 * 60),
      ] as never,
      date: '2026-11-14',
      timeZone: ZONE,
      nowMs: NOW,
    });
    expect(recap).toEqual({ blockCount: 2, doneCount: 1, plannedMin: 130, focusedMin: 80, sessionCount: 1, deltaMin: -50 });
  });

  it('makes no comparison of nothing: no plan, or no focus (negative)', () => {
    const none = dayRecap({ blocks: [], sessions: [], date: '2026-11-14', timeZone: ZONE, nowMs: NOW });
    expect(none).toEqual({ blockCount: 0, doneCount: 0, plannedMin: 0, focusedMin: 0, sessionCount: 0, deltaMin: null });
    const unfocused = dayRecap({
      blocks: [block('a', 'planned', '2026-11-14T10:00:00.000Z', '2026-11-14T11:00:00.000Z')],
      sessions: [],
      date: '2026-11-14',
      timeZone: ZONE,
      nowMs: NOW,
    });
    expect(unfocused.deltaMin).toBeNull();
  });

  it('a day is over when it had blocks and none is left; a day without a plan has not begun (negative)', () => {
    const past = block('a', 'planned', '2026-11-14T06:00:00.000Z', '2026-11-14T07:00:00.000Z');
    const ahead = block('b', 'planned', '2026-11-14T10:00:00.000Z', '2026-11-14T11:00:00.000Z');
    expect(dayIsOver([past], NOW)).toBe(true);
    expect(dayIsOver([{ ...ahead, status: 'done' }], NOW)).toBe(true);
    expect(dayIsOver([past, ahead], NOW)).toBe(false);
    expect(dayIsOver([], NOW)).toBe(false);
    expect(dayIsOver([block('c', 'moved', '2026-11-14T10:00:00.000Z', '2026-11-14T11:00:00.000Z')], NOW)).toBe(false);
  });
});

describe('개요 — the recap takes the filled button when the day is over', () => {
  async function mountOverview(path = '/overview'): Promise<Mounted> {
    const app = await mountAt(OverviewView, path);
    await vi.waitFor(async () => {
      await flushPromises();
      expect(app.wrapper.findAll('[data-widget][data-state="loading"]')).toHaveLength(0);
      expect(app.wrapper.find('.today-skeleton').exists()).toBe(false);
    });
    return app;
  }

  it('is not there while blocks are left: the next block holds the filled button (negative)', async () => {
    seedMonth(mockDb);
    const { wrapper } = await mountOverview();
    expect(wrapper.find('[data-day-recap]').exists()).toBe(false);
    await vi.waitFor(() => expect(wrapper.findAll('.btn--primary').map((button) => button.attributes('data-primary'))).toEqual(['start']));
  });

  it('sums up the day once every block is done, and the one filled button is 내일 미리 보기', async () => {
    seedMonth(mockDb);
    seedOverviewSessions(mockDb);
    finishToday();
    const { wrapper } = await mountOverview();
    const recap = await vi.waitFor(() => wrapper.get('[data-day-recap]'));
    expect(recap.get('h2').text()).toBe('오늘 정리');
    expect(recap.get('[data-recap-blocks]').text()).toBe('블록 2개 중 2개를 끝냈어요');
    await vi.waitFor(() => expect(recap.find('[data-recap-focus]').exists()).toBe(true));
    expect(recap.get('[data-recap-focus]').text()).toMatch(/^집중 .+ · 계획 2시간 10분 · 세션 \d+번$/);
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.text()).toBe('내일 미리 보기');
    expect(primaries[0]?.attributes('href')).toBe('/planner?view=day&d=2026-11-15');
    expect(recap.get('[data-recap-insights]').attributes('href')).toBe('/insights');
  });

  it('“오늘은 여기까지” (?recap) shows it with blocks left, and nothing in 오늘 is filled then', async () => {
    seedMonth(mockDb);
    const { wrapper } = await mountOverview('/overview?recap=1');
    const recap = await vi.waitFor(() => wrapper.get('[data-day-recap]'));
    expect(recap.get('[data-recap-blocks]').text()).toBe('블록 2개 중 0개를 끝냈어요');
    await vi.waitFor(() => expect(wrapper.findAll('.today-card')).toHaveLength(2));
    expect(wrapper.findAll('.btn--primary').map((button) => button.attributes('data-primary'))).toEqual(['tomorrow']);
    expect(wrapper.find('[data-primary="start"]').exists()).toBe(false);
    // The blocks can still be started, as ordinary buttons.
    expect(wrapper.findAll('.today-card')[0]?.text()).toContain('집중 시작');
  });

  it('says so when there is no record of focus today, and draws no number from nothing (negative)', async () => {
    seedMonth(mockDb);
    finishToday();
    mockDb.sessions.clear();
    const { wrapper } = await mountOverview();
    const recap = await vi.waitFor(() => wrapper.get('[data-day-recap]'));
    await vi.waitFor(() => expect(recap.find('[data-recap-empty]').exists()).toBe(true));
    expect(recap.get('[data-recap-empty]').text()).toContain('오늘은 집중 기록이 없어요');
    expect(recap.find('[data-recap-focus]').exists()).toBe(false);
    expect(recap.find('[data-recap-lesson]').exists()).toBe(false);
  });

  it('steps back while a session runs: the session is the next thing, not the recap (negative)', async () => {
    seedMonth(mockDb);
    seedOverviewSessions(mockDb, { running: true });
    const { wrapper } = await mountOverview('/overview?recap=1');
    await vi.waitFor(() => expect(wrapper.find('[data-primary="resume"]').exists()).toBe(true));
    expect(wrapper.find('[data-day-recap]').exists()).toBe(false);
  });
});

// ── 선택은 따라간다 ──────────────────────────────────────────────────────────

describe('선택은 따라간다 — what was picked arrives picked', () => {
  it('할 일 hands on to the plan from its head', async () => {
    const { wrapper } = await mountAt(TasksView, '/tasks');
    const link = await vi.waitFor(() => wrapper.get('[data-tasks-to-plan]'));
    expect(link.text()).toBe('계획에 넣기');
    expect(link.attributes('href')).toBe('/plan/schedule');
    // HOLO-05: on the canvas it is the place's one filled button — the next step of the loop.
    expect(link.classes()).toContain('btn--primary');
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1);
  });

  it('in the list the quick add keeps the filled button, and the hand-off is a plain one (negative)', async () => {
    const { wrapper } = await mountAt(TasksView, '/tasks?view=list');
    const link = await vi.waitFor(() => wrapper.get('[data-tasks-to-plan]'));
    expect(link.attributes('href')).toBe('/plan/schedule');
    expect(link.classes()).not.toContain('btn--primary');
  });

  it('a task hands itself on to the plan; a finished one does not (negative)', async () => {
    const open = [...mockDb.tasks.values()].find((task) => task.status !== 'done' && task.deletedAt === undefined);
    if (open === undefined) throw new Error('the mock has no open task');
    const first = await mountAt(TaskDetailView, `/tasks/${open.id}`, { props: { id: open.id } });
    const link = await vi.waitFor(() => first.wrapper.get('[data-task-to-plan]'));
    expect(link.attributes('href')).toBe(`/plan/schedule?taskIds=${open.id}`);
    expect(link.classes()).not.toContain('btn--primary');
    first.wrapper.unmount();

    mockDb.tasks.set(open.id, { ...open, status: 'done' });
    const second = await mountAt(TaskDetailView, `/tasks/${open.id}`, { props: { id: open.id } });
    await vi.waitFor(() => expect(second.wrapper.find('.task-page').exists()).toBe(true));
    await flushPromises();
    expect(second.wrapper.find('[data-task-to-plan]').exists()).toBe(false);
  });
});

// ── 그 자리에서 묻는다 ───────────────────────────────────────────────────────

describe('그 자리에서 묻는다 — AI consent is asked for where it is needed', () => {
  async function signedIn(consent?: { granted: boolean }): Promise<Pinia> {
    mockDb.user = {
      ...mockDb.user,
      llmProvider: 'deepseek',
      ...(consent === undefined ? { llm: {} } : { llm: { consent: { ...consent, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } } }),
    };
    const pinia = createPinia();
    await useAuthStore(pinia).loadCurrent();
    return pinia;
  }

  it('ask() opens the dialog even after it was turned down, and resolves when it closes', async () => {
    const consent = useLlmConsentStore(await signedIn({ granted: false }));
    const detach = consent.attachHost();
    // Shown once this session and closed. Turned down by answer, it does not come back before an AI action…
    consent.closed();
    expect(consent.open).toBe(false);
    await consent.askBeforeAi();
    expect(consent.open).toBe(false);
    // …but a press that asks for it brings it, in place.
    let settled = false;
    const asked = consent.ask().then(() => {
      settled = true;
    });
    expect(consent.open).toBe(true);
    await nextTick();
    expect(settled).toBe(false);
    consent.closed();
    await asked;
    expect(settled).toBe(true);
    expect(consent.open).toBe(false);
    detach();
  });

  it('ask() is nothing where there is nothing to grant, or no dialog to show it (negative)', async () => {
    const granted = useLlmConsentStore(await signedIn({ granted: true }));
    const detachGranted = granted.attachHost();
    await granted.ask();
    expect(granted.open).toBe(false);
    expect(granted.requested).toBe(false);
    detachGranted();

    const hostless = useLlmConsentStore(await signedIn({ granted: false }));
    await hostless.ask();
    expect(hostless.requested).toBe(false);
  });
});

describe('되돌아오기 — a flow that sends the owner out leaves the way back', () => {
  it('keeps only a path of this app, and never 설정 itself (negative)', () => {
    expect(safeReturnPath('/plan/schedule?taskIds=a,b')).toBe('/plan/schedule?taskIds=a,b');
    expect(safeReturnPath('/overview')).toBe('/overview');
    for (const bad of ['https://example.test/x', '//example.test/x', 'plan', '', '/settings', '/settings/calendar', '/login', '/\\\\example.test', 3, null]) {
      expect(safeReturnPath(bad), String(bad)).toBeNull();
    }
    expect(safeReturnPath(`/${'a'.repeat(2_100)}`)).toBeNull();
  });

  it('is remembered per owner for the session, and dropped on any owner change', () => {
    const owner = mockDb.user.id;
    expect(rememberFlowReturn(captureOwnerBinding(), '/plan/schedule?goalId=g1')).toBe(true);
    expect(readFlowReturn(owner)).toBe('/plan/schedule?goalId=g1');
    expect(readFlowReturn(OTHER_OWNER)).toBeNull();
    expect(localStorage.length).toBe(1); // only the active-owner pointer: this lives in the session area
    expect(OWNER_STORAGE_MANIFEST.ownerSlots.flowReturn).toMatchObject({ area: 'session', staleWrites: 'drop', onOwnerChange: 'clear' });

    // A stale binding writes nothing (negative).
    const stale = captureOwnerBinding();
    adoptActiveOwner(OTHER_OWNER, 'bootstrap');
    expect(rememberFlowReturn(stale, '/overview')).toBe(false);
    expect(readFlowReturn(OTHER_OWNER)).toBeNull();
    // The owner change cleared the first owner's too.
    expect(readFlowReturn(owner)).toBeNull();
    // Nothing unsafe is stored.
    expect(rememberFlowReturn(captureOwnerBinding(), '/settings/calendar')).toBe(false);
    clearFlowReturn(captureOwnerBinding());
  });

  it('the plan’s 구글 캘린더 연결 remembers where the plan was', async () => {
    const { wrapper, router } = await mountAt(PlanCommitmentStep, '/plan/schedule?taskIds=t1', {
      props: { timeZone: ZONE, date: '2026-11-14', offerGoogle: true },
    });
    const link = wrapper.get('[data-plan-google]');
    expect(link.attributes('href')).toBe('/settings/calendar');
    await link.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/settings/calendar'));
    expect(readFlowReturn(mockDb.user.id)).toBe('/plan/schedule?taskIds=t1');
  });

  it('설정 offers the way back first, takes it once, and forgets it', async () => {
    rememberFlowReturn(captureOwnerBinding(), '/plan/schedule?taskIds=t1');
    const { wrapper, router } = await mountAt(SettingsView, '/settings/display');
    const back = wrapper.get('[data-settings-return]');
    expect(back.attributes('role')).toBe('status');
    expect(back.text()).toContain('하던 일에서 잠깐 나왔어요');
    await back.get('[data-settings-return-go]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/plan/schedule?taskIds=t1'));
    expect(readFlowReturn(mockDb.user.id)).toBeNull();
  });

  it('without one 설정 shows no such thing (negative)', async () => {
    const { wrapper } = await mountAt(SettingsView, '/settings/display');
    expect(wrapper.find('[data-settings-return]').exists()).toBe(false);
  });
});
