import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { DEFAULT_PREFERENCES } from '@ohmydate/ui-policy';
import { newActionId, plannerClient, type EstimationFeedback } from '../src/api';
import { layoutPrefsKey } from '../src/layout/prefs';
import { TODAY_BLOCK_ONE_ID, TODAY_TASK_ONE_ID, mockDb, seedTodayRisk } from '../src/mocks/db';
import { sessionJournal } from '../src/session/journal';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, ownerChanged, ownerState } from '../src/session/ownerEpoch';
import { useLayoutStore } from '../src/stores/layout';
import { useSessionStore } from '../src/stores/session';
import { useToastStore } from '../src/stores/toast';
import FocusView from '../src/views/FocusView.vue';
import { BEFORE_REVIEW, IN_REVIEW_WINDOW, modeOf, mountApp, regionsOf, settle, startedSession, useTestClock } from './m6-layout-utils';
import { setLayoutClock } from '../src/layout/clock';

/**
 * M6-02R-1 findings, each reproduced as a failing test first:
 * H1 — a late async continuation (review response) or any layout writer must
 *      never write into another owner's namespace; the mounted layout store
 *      resets on an owner hard reset.
 * L1 — Next up expires on a shared reactive clock; day rollover refreshes the
 *      current-day query.
 */
const OWNER_A = '01900000-0000-7000-8000-00000000aa01';
const OWNER_B = '01900000-0000-7000-8000-00000000bb02';
const Stub = defineComponent({ template: '<div />' });

function layoutKeysFor(owner: string): Record<string, string | null> {
  const keys = ['prefs', 'riskAck', 'reviewed', 'reviewSkip'];
  return Object.fromEntries(keys.map((key) => [key, localStorage.getItem(`ohmydate.layout.${key}:${owner}`)]));
}

const NOTHING = { prefs: null, riskAck: null, reviewed: null, reviewSkip: null };

beforeEach(async () => {
  localStorage.clear();
  await sessionJournal.clear();
});

afterEach(() => {
  vi.useRealTimers();
  setLayoutClock(null);
  document.body.innerHTML = '';
});

describe('H1 — a late review response never writes into another owner', () => {
  it('drops the continuation when the owner changes before reviewSession resolves', async () => {
    adoptActiveOwner(OWNER_A, 'bootstrap');
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    expect(sessions.ownerId).toBe(OWNER_A);
    const created = await plannerClient.createSession(
      { taskId: TODAY_TASK_ONE_ID, blockId: TODAY_BLOCK_ONE_ID, clientStartedAt: new Date().toISOString(), clientId: 'h1' },
      newActionId('session'),
    );
    const completed = await plannerClient.completeSession(
      created.id,
      new Date().toISOString(),
      newActionId('complete'),
      created.version,
    );
    sessions.remember(completed);

    let resolve: (value: EstimationFeedback) => void = () => {};
    const review = vi.spyOn(plannerClient, 'reviewSession').mockImplementation(
      () => new Promise<EstimationFeedback>((done) => {
        resolve = done;
      }),
    );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/overview', name: 'overview', component: Stub },
        { path: '/focus/:sessionId', name: 'focus', component: Stub },
      ],
    });
    await router.push(`/focus/${completed.id}`);
    const wrapper = mount(FocusView, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await vi.waitFor(() => expect(wrapper.text()).toContain('이번 세션은 어땠나요?'));
    await wrapper.findAll('input[type="radio"]')[1]?.setValue(true);
    const submit = wrapper.findAll('button').find((item) => item.text().includes('회고 저장'));
    await submit?.trigger('click');
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));

    // Another tab signs in as owner B while the response is still in flight.
    ownerChanged(OWNER_A, OWNER_B, 'login');
    expect(ownerState.ownerId.value).toBe(OWNER_B);
    resolve({ taskId: TODAY_TASK_ONE_ID, estimatedP50: 60, actualFocusMin: 1, quality: 'ok' });
    await settle();

    expect(layoutKeysFor(OWNER_B)).toEqual(NOTHING);
    const writtenForA = localStorage.getItem(`ohmydate.layout.reviewed:${OWNER_A}`);
    expect(writtenForA === null || JSON.parse(writtenForA).every((id: string) => id === completed.id)).toBe(true);
    // The stale continuation does not update the (owner A) screen either.
    expect(wrapper.find('[data-focus-next]').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/예상 .+ · 실제/);
    expect(useToastStore(pinia).toasts.some((item) => item.message.includes('회고를 저장했어요'))).toBe(false);
    wrapper.unmount();
  });
});

describe('H1 — the mounted layout store resets on an owner hard reset', () => {
  it('drops the old owner’s prefs at once and writes nothing into the new owner’s namespace', async () => {
    useTestClock();
    const app = await mountApp('/overview');
    await vi.waitFor(() => expect(app.wrapper.findAll('.today-card').length).toBeGreaterThan(0));
    const ownerA = mockDb.user.id;
    const layout = useLayoutStore(app.pinia);
    layout.lockCurrent();
    layout.setAutoSwitch(false);
    expect(layout.prefs).toEqual({ autoSwitch: false, locked: 'overview' });
    const storedA = localStorage.getItem(layoutPrefsKey(ownerA));
    expect(storedA).not.toBeNull();

    ownerChanged(ownerA, OWNER_B, 'login');
    // Synchronously, before any watcher runs: none of owner A's state is left.
    expect(layout.prefs).toEqual(DEFAULT_PREFERENCES);
    expect(layout.current).toBeNull();
    expect(layout.undoAvailable).toBe(false);
    expect(layout.announcement).toBe('');
    // Writers in the reset window (before the reload) must not open owner B's namespace.
    layout.setAutoSwitch(false);
    expect(layout.lockCurrent()).toBe(false);
    layout.intent();
    layout.step();
    await settle();
    expect(layoutKeysFor(OWNER_B)).toEqual(NOTHING);
    // Owner A's namespace is preserved for when A signs in again (ADR-023).
    expect(localStorage.getItem(layoutPrefsKey(ownerA))).toBe(storedA);
    expect(useToastStore(app.pinia).toasts.some((item) => item.message === '레이아웃이 바뀌었어요')).toBe(false);
    app.wrapper.unmount();
  });

  it('a risk acknowledgement clicked after the owner changed is not stored for the new owner', async () => {
    useTestClock();
    seedTodayRisk(mockDb);
    const app = await mountApp('/overview');
    await vi.waitFor(() => expect(modeOf(app.wrapper)).toBe('deadline_risk'));
    const ack = [...document.querySelectorAll<HTMLButtonElement>('[data-panel="deadline-risk"] button')].find((item) =>
      item.textContent?.includes('확인했어요'),
    );
    expect(ack).toBeDefined();
    ownerChanged(mockDb.user.id, OWNER_B, 'login');
    ack?.click();
    await settle();
    expect(layoutKeysFor(OWNER_B)).toEqual(NOTHING);
    expect(localStorage.getItem(`ohmydate.layout.riskAck:${mockDb.user.id}`)).toBeNull();
    app.wrapper.unmount();
  });

  it('skipping the review prompt after the owner changed is not stored for the new owner', async () => {
    useTestClock(IN_REVIEW_WINDOW);
    const app = await mountApp('/overview', async (pinia) => {
      const session = await startedSession(pinia);
      const done = await plannerClient.completeSession(
        session.id,
        new Date(IN_REVIEW_WINDOW - 60_000).toISOString(),
        newActionId('complete'),
        session.version,
      );
      useSessionStore(pinia).remember({ ...done, endedAt: new Date(IN_REVIEW_WINDOW - 60_000).toISOString() });
    });
    await vi.waitFor(() => expect(modeOf(app.wrapper)).toBe('review'));
    const skip = [...document.querySelectorAll<HTMLButtonElement>('[data-panel="review-prompt"] button')].find((item) =>
      item.textContent?.includes('오늘은 건너뛰기'),
    );
    expect(skip).toBeDefined();
    ownerChanged(mockDb.user.id, OWNER_B, 'login');
    skip?.click();
    await settle();
    expect(layoutKeysFor(OWNER_B)).toEqual(NOTHING);
    app.wrapper.unmount();
  });

  it('a confirmed owner (bootstrap after /me) does get its own prefs (negative for the guard)', async () => {
    localStorage.setItem(OWNER_STORAGE_KEY, OWNER_A);
    adoptActiveOwner(OWNER_A, 'bootstrap');
    localStorage.setItem(layoutPrefsKey(OWNER_B), JSON.stringify({ autoSwitch: false, locked: null }));
    const pinia = createPinia();
    const layout = useLayoutStore(pinia);
    expect(layout.prefs).toEqual(DEFAULT_PREFERENCES);
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect(layout.prefs).toEqual({ autoSwitch: false, locked: null });
    layout.setAutoSwitch(true);
    expect(JSON.parse(localStorage.getItem(layoutPrefsKey(OWNER_B)) ?? '{}')).toEqual({ autoSwitch: true, locked: null });
    expect(localStorage.getItem(layoutPrefsKey(OWNER_A))).toBeNull();
  });
});

describe('L1 — Next up follows a shared reactive clock', () => {
  it('drops a block once the clock passes its end, without any other state change', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = useTestClock(BEFORE_REVIEW);
    const app = await mountApp('/overview');
    await vi.waitFor(() => expect(app.wrapper.findAll('.today-card').length).toBeGreaterThan(0));
    const items = () => app.wrapper.findAll('[data-panel="next-up"] .layout-next-item').map((item) => item.text());
    await vi.waitFor(() => expect(items().length).toBe(2));
    expect(items()[0]).toContain('연구 노트 요약');

    const today = vi.spyOn(plannerClient, 'getToday');
    const before = regionsOf(app.wrapper);
    // The first block ends at 11:30Z; move the injected clock past it, then let the shared tick fire.
    clock.set(Date.parse('2026-11-14T11:31:00.000Z'));
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(items().length).toBe(1);
    expect(items()[0]).toContain('발표 개요 초안');
    expect(today).not.toHaveBeenCalled();
    expect(regionsOf(app.wrapper)).toEqual(before);
    app.wrapper.unmount();
  });

  it('a day rollover refetches today for the new date', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // 23:59 local (browser zone) on 11-14; jsdom's zone is the runner's, so derive the dates from it.
    const start = new Date(2026, 10, 14, 23, 59, 0).getTime();
    const clock = useTestClock(start);
    const today = vi.spyOn(plannerClient, 'getToday');
    const app = await mountApp('/overview');
    await vi.waitFor(() => expect(app.wrapper.findAll('.today-card').length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(today).toHaveBeenCalledWith('2026-11-14', expect.anything()));
    expect(today.mock.calls.some(([date]) => date === '2026-11-15')).toBe(false);

    clock.set(new Date(2026, 10, 15, 0, 0, 30).getTime());
    vi.advanceTimersByTime(30_000);
    await settle();
    await vi.waitFor(() => expect(today.mock.calls.some(([date]) => date === '2026-11-15')).toBe(true));
    app.wrapper.unmount();
  });
});
