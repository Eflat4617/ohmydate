import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { newActionId, plannerClient, type WorkSession } from '../src/api';
import FocusView from '../src/views/FocusView.vue';
import { flushFocusJournal } from '../src/session/focusQueue';
import { sessionJournal, type SessionEventRecord } from '../src/session/journal';
import { useOfflineStore } from '../src/stores/offline';
import { useSessionStore } from '../src/stores/session';
import { TODAY_BLOCK_ONE_ID, TODAY_TASK_ONE_ID, createUuidV7, mockDb } from '../src/mocks/db';

const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/today', name: 'today', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
    ],
  });
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

async function createSession(): Promise<WorkSession> {
  return plannerClient.createSession(
    {
      taskId: TODAY_TASK_ONE_ID,
      blockId: TODAY_BLOCK_ONE_ID,
      clientStartedAt: new Date().toISOString(),
      clientId: 'focus-test',
    },
    newActionId('session'),
  );
}

async function mountFocus(pinia: Pinia, router: Router, session: WorkSession): Promise<VueWrapper> {
  useSessionStore(pinia).remember(session);
  await router.push(`/focus/${session.id}`);
  const wrapper = mount(FocusView, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
  if (session.state === 'active' || session.state === 'paused') {
    const label = session.state === 'active' ? '일시정지' : '다시 시작';
    await vi.waitFor(() => expect(button(wrapper, label).attributes('disabled')).toBeUndefined());
  }
  return wrapper;
}

describe('Focus mode', () => {
  beforeEach(async () => {
    localStorage.clear();
    await sessionJournal.clear();
  });

  it('starts a session from Today and pauses, resumes and completes it', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const session = await createSession();
    const router = testRouter();
    const wrapper = await mountFocus(pinia, router, session);

    expect(wrapper.get('.focus-timer').attributes('role')).toBe('timer');
    expect(wrapper.text()).toContain('집중하는 중');

    await button(wrapper, '일시정지').trigger('click');
    await vi.waitFor(() => expect(store.get(session.id)?.state).toBe('paused'));
    expect(mockDb.sessions.get(session.id)?.state).toBe('paused');
    expect(wrapper.text()).toContain('일시정지됨');

    await button(wrapper, '다시 시작').trigger('click');
    await vi.waitFor(() => expect(store.get(session.id)?.state).toBe('active'));
    expect(mockDb.sessions.get(session.id)?.state).toBe('active');

    await button(wrapper, '완료').trigger('click');
    await vi.waitFor(() => expect(store.get(session.id)?.state).toBe('completed'));
    expect(mockDb.sessions.get(session.id)?.state).toBe('completed');
    expect(wrapper.text()).toContain('이번 세션은 어땠나요?');
    wrapper.unmount();
  });

  it('submits an end-of-session review and shows estimation feedback', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const created = await createSession();
    const paused = await plannerClient.pauseSession(
      created.id,
      new Date().toISOString(),
      newActionId('pause'),
      created.version,
    );
    const completed = await plannerClient.completeSession(
      created.id,
      new Date().toISOString(),
      newActionId('complete'),
      paused.version,
    );
    const router = testRouter();
    const wrapper = await mountFocus(pinia, router, completed);

    const review = vi.spyOn(plannerClient, 'reviewSession');
    const radios = wrapper.findAll('input[type="radio"]');
    await radios[1]?.setValue(true);
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    await checkboxes[2]?.setValue(true);
    await wrapper.get('#review-note').setValue('Interrupted by a delivery.');
    await button(wrapper, '회고 저장').trigger('click');

    await vi.waitFor(() => expect(wrapper.text()).toContain('추정 피드백'));
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(
      completed.id,
      {
        outcome: 'partial',
        reasonChips: ['task_larger'],
        note: 'Interrupted by a delivery.',
      },
      expect.any(String),
      completed.version,
    );
    expect(wrapper.text()).toContain('실제');
    wrapper.unmount();
  });

  it('records focus events offline and uploads them exactly once on reconnect', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const session = await createSession();
    const router = testRouter();
    const offline = useOfflineStore(pinia);
    offline.setOnline(false);

    const wrapper = await mountFocus(pinia, router, session);
    await button(wrapper, '일시정지').trigger('click');
    await vi.waitFor(() => expect(store.pendingCount).toBe(1));
    expect(store.get(session.id)?.state).toBe('paused');
    expect(mockDb.sessions.get(session.id)?.version).toBe(1);
    expect(wrapper.text()).toContain('이 기기에 저장했어요');

    await vi.waitFor(() => expect(button(wrapper, '완료').attributes('disabled')).toBeUndefined());
    await button(wrapper, '완료').trigger('click');
    await vi.waitFor(() => expect(store.pendingCount).toBe(2));
    expect(store.get(session.id)?.state).toBe('completed');
    expect(mockDb.sessions.get(session.id)?.version).toBe(1);

    const queued = await sessionJournal.list(session.id);
    expect(queued.map((item) => item.kind)).toEqual(['pause', 'complete']);
    const completeRecord = queued[1];
    if (completeRecord === undefined) throw new Error('missing queued complete event');
    expect(completeRecord.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    offline.setOnline(true);
    await vi.waitFor(() => {
      expect(mockDb.sessions.get(session.id)?.version).toBe(3);
      expect(mockDb.sessions.get(session.id)?.state).toBe('completed');
      expect(store.pendingCount).toBe(0);
    });
    expect(await sessionJournal.list()).toHaveLength(0);

    const duplicate: Omit<SessionEventRecord, 'seq' | 'ownerId'> = {
      id: completeRecord.id,
      sessionId: completeRecord.sessionId,
      kind: completeRecord.kind,
      clientAt: completeRecord.clientAt,
      idempotencyKey: completeRecord.idempotencyKey,
      expectedVersion: completeRecord.expectedVersion,
    };
    await sessionJournal.append(duplicate);
    await flushFocusJournal({ store, online: true });
    expect(mockDb.sessions.get(session.id)?.version).toBe(3);
    expect(await sessionJournal.list()).toHaveLength(0);
    wrapper.unmount();
  });

  it('serializes transient offline actions while the journal write is pending', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const offline = useOfflineStore(pinia);
    const session = await createSession();
    const router = testRouter();
    const wrapper = await mountFocus(pinia, router, session);
    offline.setOnline(false);

    const originalAppend = sessionJournal.append.bind(sessionJournal);
    vi.spyOn(sessionJournal, 'append').mockImplementation(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return originalAppend(event);
    });

    const pause = button(wrapper, '일시정지');
    await Promise.all([pause.trigger('click'), pause.trigger('click')]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));

    await vi.waitFor(() => expect(store.pendingCount).toBe(1));
    const pausedEvents = await sessionJournal.list(session.id);
    expect(pausedEvents.map((event) => event.kind)).toEqual(['pause']);
    expect(pausedEvents[0]?.expectedVersion).toBe(1);
    expect(store.get(session.id)?.version).toBe(2);

    await vi.waitFor(() => expect(button(wrapper, '완료').attributes('disabled')).toBeUndefined());
    await button(wrapper, '완료').trigger('click');
    await vi.waitFor(() => expect(store.pendingCount).toBe(2));
    const queued = await sessionJournal.list(session.id);
    expect(queued.map((event) => event.kind)).toEqual(['pause', 'complete']);
    expect(queued[1]?.expectedVersion).toBe(2);

    offline.setOnline(true);
    await vi.waitFor(() => {
      expect(mockDb.sessions.get(session.id)?.state).toBe('completed');
      expect(mockDb.sessions.get(session.id)?.version).toBe(3);
      expect(store.pendingCount).toBe(0);
    });
    expect(await sessionJournal.list()).toHaveLength(0);
    wrapper.unmount();
  });

  it('treats an authoritative 404 as unavailable instead of showing cached data', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const session = await createSession();
    store.remember(session);
    mockDb.sessions.delete(session.id);

    const router = testRouter();
    await router.push(`/focus/${session.id}`);
    const wrapper = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('이 집중 세션을 열 수 없어요'));
    expect(wrapper.find('.focus-timer').exists()).toBe(false);
    expect(store.get(session.id)).toBeNull();
    wrapper.unmount();
  });

  it('loads a deep-linked session from the server when it is not in device storage', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const session = await createSession();
    store.forget(session.id);
    expect(store.get(session.id)).toBeNull();

    const router = testRouter();
    await router.push(`/focus/${session.id}`);
    const wrapper = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
    expect(wrapper.text()).toContain('집중하는 중');
    expect(store.get(session.id)?.id).toBe(session.id);
    wrapper.unmount();
  });

  it('derives elapsed time from the server clock when restoring reloads, paused and resumed sessions', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    const now = Date.now();
    const cases = [
      {
        label: 'active',
        session: {
          id: createUuidV7(),
          taskId: TODAY_TASK_ONE_ID,
          state: 'active' as const,
          startedAt: new Date(now - 600_000).toISOString(),
          focusedSec: 0,
          pausedSec: 0,
          clientId: 'timer-test',
          version: 1,
        },
        expected: 600,
      },
      {
        label: 'paused',
        session: {
          id: createUuidV7(),
          taskId: TODAY_TASK_ONE_ID,
          state: 'paused' as const,
          startedAt: new Date(now - 700_000).toISOString(),
          focusedSec: 600,
          pausedSec: 100,
          clientId: 'timer-test',
          version: 2,
        },
        expected: 600,
      },
      {
        label: 'resumed',
        session: {
          id: createUuidV7(),
          taskId: TODAY_TASK_ONE_ID,
          state: 'active' as const,
          startedAt: new Date(now - 720_000).toISOString(),
          focusedSec: 600,
          pausedSec: 60,
          clientId: 'timer-test',
          version: 3,
        },
        expected: 660,
      },
    ];

    for (const entry of cases) {
      store.reset();
      mockDb.sessions.set(entry.session.id, entry.session);
      const router = testRouter();
      await router.push(`/focus/${entry.session.id}`);
      const wrapper = mount(FocusView, {
        global: { plugins: [pinia, router] },
        attachTo: document.body,
      });
      await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
      const text = wrapper.get('.focus-timer').text();
      const match = /^(?:(\d+):)?(\d{2}):(\d{2})$/.exec(text);
      if (match === null) throw new Error(`unexpected timer ${text}`);
      const seconds = Number(match[1] ?? '0') * 3600 + Number(match[2]) * 60 + Number(match[3]);
      expect(seconds, entry.label).toBeGreaterThanOrEqual(entry.expected);
      expect(seconds, entry.label).toBeLessThan(entry.expected + 5);
      wrapper.unmount();
    }
  });

  it('supports a keyboard-only pause, resume, focus and complete flow', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const session = await createSession();
    const router = testRouter();
    const wrapper = await mountFocus(pinia, router, session);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    await vi.waitFor(() => expect(store.get(session.id)?.state).toBe('paused'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    await vi.waitFor(() => expect(store.get(session.id)?.state).toBe('active'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('.focus-timer').element);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => expect(store.get(session.id)?.state).toBe('completed'));
    expect(wrapper.find('fieldset').exists()).toBe(true);
    expect(wrapper.text()).toContain('이번 세션은 어땠나요?');
    wrapper.unmount();
  });

  it('announces elapsed minutes at most once per minute', async () => {
    vi.useFakeTimers();
    try {
      const pinia = createPinia();
      const store = useSessionStore(pinia);
      store.reset();
      const session = await createSession();
      const router = testRouter();
      await router.push(`/focus/${session.id}`);
      store.remember(session);
      const wrapper = mount(FocusView, {
        global: { plugins: [pinia, router] },
        attachTo: document.body,
      });
      await nextTick();
      expect(wrapper.get('.focus-timer').text()).toMatch(/\d{2}:\d{2}/);

      await vi.advanceTimersByTimeAsync(61_000);
      await nextTick();
      expect(wrapper.get('.sr-only').text()).toContain('1분 집중했어요');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('provides axe-lite roles for timer and review feedback', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const created = await createSession();
    const paused = await plannerClient.pauseSession(
      created.id,
      new Date().toISOString(),
      newActionId('pause'),
      created.version,
    );
    const completed = await plannerClient.completeSession(
      created.id,
      new Date().toISOString(),
      newActionId('complete'),
      paused.version,
    );
    const wrapper = await mountFocus(pinia, testRouter(), completed);

    expect(wrapper.get('.focus-timer').attributes('role')).toBe('timer');
    expect(wrapper.get('.focus-timer').attributes('aria-label')).toBe('집중 타이머');
    expect(wrapper.findAll('.sr-only[aria-live="polite"]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('fieldset legend').map((legend) => legend.text())).toEqual([
      '결과',
      '무엇이 영향을 줬나요?',
    ]);
    for (const element of wrapper.findAll('button')) {
      const accessible = element.attributes('aria-label') ?? element.text().trim();
      expect(accessible.length).toBeGreaterThan(0);
    }
    wrapper.unmount();
  });
});
