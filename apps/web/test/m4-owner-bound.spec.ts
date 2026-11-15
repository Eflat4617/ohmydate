import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import {
  ApiError,
  newActionId,
  plannerClient,
  type User,
  type WorkSession,
} from '../src/api';
import AppShell from '../src/components/AppShell.vue';
import FocusView from '../src/views/FocusView.vue';
import TodayView from '../src/components/today/TodayBoard.vue';
import {
  flushFocusJournal,
  retryQuarantinedFocusEvents,
} from '../src/session/focusQueue';
import { sessionJournal } from '../src/session/journal';
import {
  clearQuarantine,
  listQuarantine,
  quarantineRecord,
} from '../src/session/quarantine';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import {
  captureOwnerBinding,
  invalidateOwnerEpoch,
} from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useSessionStore } from '../src/stores/session';
import {
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  createUuidV7,
  mockDb,
} from '../src/mocks/db';

const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
    ],
  });
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function owner(base: User, label: string): User {
  return {
    ...base,
    id: createUuidV7(),
    email: `${label}-${Date.now().toString(36)}@example.test`,
    version: 1,
  };
}

function workSession(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: createUuidV7(),
    taskId: TODAY_TASK_ONE_ID,
    blockId: TODAY_BLOCK_ONE_ID,
    state: 'active',
    startedAt: new Date().toISOString(),
    focusedSec: 0,
    pausedSec: 0,
    clientId: 'owner-bound-test',
    version: 1,
    ...overrides,
  };
}

function storedFor(ownerId: string): Record<string, WorkSession> {
  const raw = localStorage.getItem(`ohmydate.focus.sessions:${ownerId}`);
  return raw === null ? {} : (JSON.parse(raw) as Record<string, WorkSession>);
}

async function signIn(
  pinia: Pinia,
  user: User,
  login: { mockResolvedValue(value: void): unknown },
  getMe: { mockResolvedValue(value: User): unknown },
): Promise<void> {
  login.mockResolvedValue();
  getMe.mockResolvedValue(user);
  await useAuthStore(pinia).login(user.email, 'pw');
}

describe('owner-bound Focus and Today client operations', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionJournal.setOwner(null);
    await sessionJournal.clear(null);
    await clearQuarantine(null);
  });

  it('P1: keeps an in-flight pause in owner A when the request fails after switching to B', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const session = await plannerClient.createSession(
      {
        taskId: TODAY_TASK_ONE_ID,
        blockId: TODAY_BLOCK_ONE_ID,
        clientStartedAt: new Date().toISOString(),
        clientId: 'owner-a-client',
      },
      newActionId('session'),
    );
    sessions.remember(session);

    const pending = deferred<WorkSession>();
    let pauseSignal: AbortSignal | undefined;
    vi.spyOn(plannerClient, 'pauseSession').mockImplementation(
      (
        _sessionId: string,
        _clientAt: string,
        _key: string,
        _version: number,
        signal?: AbortSignal,
      ) => {
        pauseSignal = signal;
        return pending.promise;
      },
    );
    const router = testRouter();
    await router.push(`/focus/${session.id}`);
    const wrapper = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
    await vi.waitFor(() => expect(button(wrapper, '일시정지').attributes('disabled')).toBeUndefined());
    await button(wrapper, '일시정지').trigger('click');
    await vi.waitFor(() => expect(plannerClient.pauseSession).toHaveBeenCalledTimes(1));
    wrapper.unmount();

    await signIn(pinia, ownerB, login, getMe);
    expect(pauseSignal?.aborted).toBe(true);
    pending.reject(new TypeError('Failed to fetch'));

    await vi.waitFor(async () => {
      expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(1);
    });
    const ownerAQueue = await sessionJournal.list(undefined, ownerA.id);
    expect(ownerAQueue[0]).toMatchObject({
      ownerId: ownerA.id,
      sessionId: session.id,
      kind: 'pause',
    });
    expect(await sessionJournal.list(undefined, ownerB.id)).toHaveLength(0);
    expect(sessions.active).toBeNull();
    expect(sessions.pendingCount).toBe(0);
    expect(storedFor(ownerB.id)[session.id]).toBeUndefined();
    expect(storedFor(ownerA.id)[session.id]?.state).toBe('paused');
  });

  it('applies a different owner discovered by a me-refresh bootstrap', async () => {
    const pinia = createPinia();
    const auth = useAuthStore(pinia);
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const epochBefore = auth.epoch;
    getMe.mockResolvedValue(ownerB);
    const current = await auth.loadCurrent();

    expect(current?.id).toBe(ownerB.id);
    expect(auth.ownerId).toBe(ownerB.id);
    expect(auth.epoch).toBeGreaterThan(epochBefore);
    expect(sessions.ownerId).toBe(ownerB.id);
    expect(sessions.active).toBeNull();
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(0);
  });

  it('P2: never writes owner A replay results into owner B after a switch', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const session = await plannerClient.createSession(
      {
        taskId: TODAY_TASK_ONE_ID,
        blockId: TODAY_BLOCK_ONE_ID,
        clientStartedAt: new Date().toISOString(),
        clientId: 'owner-a-client',
      },
      newActionId('session'),
    );
    sessions.remember(session);
    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: session.version,
      },
      ownerA.id,
    );

    const pending = deferred<WorkSession>();
    vi.spyOn(plannerClient, 'pauseSession').mockImplementation(() => pending.promise);
    const flush = flushFocusJournal({ store: sessions, online: true });
    await vi.waitFor(() => expect(plannerClient.pauseSession).toHaveBeenCalledTimes(1));

    await signIn(pinia, ownerB, login, getMe);
    pending.resolve({ ...session, state: 'paused', version: session.version + 1 });
    const result = await flush;

    expect(result.uploaded).toBe(1);
    expect(result.remaining).toBe(0);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(0);
    expect(await sessionJournal.list(undefined, ownerB.id)).toHaveLength(0);
    expect(sessions.active).toBeNull();
    expect(sessions.pendingCount).toBe(0);
    expect(storedFor(ownerB.id)[session.id]).toBeUndefined();
    expect(storedFor(ownerA.id)[session.id]?.state).toBe('paused');
  });

  it('binds a createSession response that arrives after a switch to the starting owner', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const auth = useAuthStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const pending = deferred<WorkSession>();
    vi.spyOn(plannerClient, 'createSession').mockImplementation(() => pending.promise);
    const router = testRouter();
    await router.push('/overview');
    const wrapper = mount(TodayView, {
      global: { plugins: [pinia, VueQueryPlugin, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.findAll('.today-card').length).toBeGreaterThan(0));
    const card = wrapper.findAll('.today-card')[0];
    if (card === undefined) throw new Error('missing today card');
    await button(card as unknown as VueWrapper, '집중 시작').trigger('click');
    await vi.waitFor(() => expect(plannerClient.createSession).toHaveBeenCalledTimes(1));

    await signIn(pinia, ownerB, login, getMe);
    const created = workSession({ clientId: 'owner-a-client' });
    pending.resolve(created);

    await vi.waitFor(() => expect(storedFor(ownerA.id)[created.id]?.id).toBe(created.id));
    expect(router.currentRoute.value.name).toBe('overview');
    expect(sessions.get(created.id)).toBeNull();
    expect(sessions.active).toBeNull();
    expect(storedFor(ownerB.id)[created.id]).toBeUndefined();
    expect(auth.ownerId).toBe(ownerB.id);
    wrapper.unmount();
  });

  it('binds a restoreSession response that arrives after a switch to the starting owner', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const remote = workSession({ clientId: 'owner-a-client' });
    const first = deferred<WorkSession>();
    let calls = 0;
    vi.spyOn(plannerClient, 'getSession').mockImplementation(() => {
      calls += 1;
      if (calls === 1) return first.promise;
      return Promise.reject(new ApiError(404, 'not_found', 'missing session'));
    });
    const router = testRouter();
    await router.push(`/focus/${remote.id}`);
    const wrapper = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));

    await signIn(pinia, ownerB, login, getMe);
    first.resolve(remote);

    await vi.waitFor(() => expect(storedFor(ownerA.id)[remote.id]?.id).toBe(remote.id));
    expect(sessions.get(remote.id)).toBeNull();
    expect(sessions.active).toBeNull();
    expect(storedFor(ownerB.id)[remote.id]).toBeUndefined();
    wrapper.unmount();
  });

  it('discards a stale loadCurrent response after switching to owner B', async () => {
    const pinia = createPinia();
    const auth = useAuthStore(pinia);
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const pendingMe = deferred<User>();
    getMe.mockImplementationOnce(() => pendingMe.promise);
    const loading = auth.loadCurrent();
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledTimes(2));
    await signIn(pinia, ownerB, login, getMe);

    pendingMe.resolve(ownerA);
    const result = await loading;

    expect(result).toBeNull();
    expect(auth.user?.id).toBe(ownerB.id);
    expect(auth.ownerId).toBe(ownerB.id);
    expect(sessions.ownerId).toBe(ownerB.id);
    expect(sessions.active).toBeNull();
  });

  it('discards stale consent and budget responses after switching to owner B', async () => {
    const pinia = createPinia();
    const auth = useAuthStore(pinia);
    const ownerA: User = { ...owner(mockDb.user, 'owner-a'), llmProvider: 'deepseek' };
    const ownerB: User = { ...owner(mockDb.user, 'owner-b'), llmProvider: 'deepseek' };
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');
    const updatedAt = new Date().toISOString();

    await signIn(pinia, ownerA, login, getMe);
    const consent = deferred<User>();
    const budget = deferred<User>();
    const update = vi.spyOn(plannerClient, 'updateMySettings');
    update
      .mockImplementationOnce(() => consent.promise)
      .mockImplementationOnce(() => budget.promise);
    const consentRequest = auth.setLlmConsent(true);
    const budgetRequest = auth.setLlmBudget(2, 10);
    await signIn(pinia, ownerB, login, getMe);

    consent.resolve({
      ...ownerA,
      version: 2,
      llm: { consent: { granted: true, at: updatedAt, provider: 'deepseek' } },
    });
    budget.resolve({
      ...ownerA,
      version: 3,
      llm: { budget: { dailyUsd: 2, monthlyUsd: 10 } },
    });
    await Promise.all([consentRequest, budgetRequest]);

    expect(auth.user?.id).toBe(ownerB.id);
    expect(auth.user?.llm?.consent?.granted).not.toBe(true);
    expect(auth.user?.llm?.budget).toBeUndefined();
    expect(auth.ownerId).toBe(ownerB.id);

    const router = testRouter();
    await router.push('/overview');
    const wrapper = mount(AppShell, {
      global: { plugins: [pinia, router, VueQueryPlugin] },
      attachTo: document.body,
    });
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('AI 계획 도움을 쓸까요?'),
    );
    wrapper.unmount();
  });

  it('bumps the owner epoch when another tab changes the owner key', async () => {
    const pinia = createPinia();
    const auth = useAuthStore(pinia);
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const epochBefore = auth.epoch;
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: OWNER_STORAGE_KEY,
        oldValue: ownerA.id,
        newValue: ownerB.id,
      }),
    );

    expect(auth.ownerId).toBe(ownerB.id);
    expect(auth.epoch).toBeGreaterThan(epochBefore);
    expect(sessions.ownerId).toBe(ownerB.id);
  });

  it('keeps a persistent quarantine notice and retries the records from Focus', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    sessions.setOwner(ownerA.id);
    const session = workSession();
    sessions.remember(session);
    const record = await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: 1,
      },
      ownerA.id,
    );
    quarantineRecord(ownerA.id, record, 'session gone');
    await sessionJournal.remove(record.seq);
    vi.spyOn(plannerClient, 'pauseSession').mockResolvedValue({
      ...session,
      state: 'paused',
      version: 2,
    });

    const router = testRouter();
    await router.push(`/focus/${session.id}`);
    const wrapper = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('따로 보관했어요'));
    await button(wrapper, '다시 업로드').trigger('click');
    await vi.waitFor(() => expect(listQuarantine(ownerA.id)).toHaveLength(0));
    await vi.waitFor(async () =>
      expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(0),
    );
    wrapper.unmount();
  });

  it('shows the quarantine notice in Today', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    sessions.setOwner(ownerA.id);
    quarantineRecord(
      ownerA.id,
      {
        seq: 1,
        ownerId: ownerA.id,
        id: createUuidV7(),
        sessionId: createUuidV7(),
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: 1,
      },
      'session gone',
    );
    const router = testRouter();
    await router.push('/overview');
    const wrapper = mount(TodayView, {
      global: { plugins: [pinia, VueQueryPlugin, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.findAll('.today-card').length).toBeGreaterThan(0));
    expect(wrapper.text()).toContain('따로 보관했어요');
    await button(wrapper, '닫기').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('따로 보관했어요'));
    wrapper.unmount();
  });

  it('keeps the quarantined count when a later replay fails transiently', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    sessions.setOwner(ownerA.id);
    const session = workSession();
    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: 1,
      },
      ownerA.id,
    );
    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'resume',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('resume'),
        expectedVersion: 2,
      },
      ownerA.id,
    );
    vi.spyOn(plannerClient, 'getMe').mockResolvedValue(ownerA);
    vi.spyOn(plannerClient, 'pauseSession').mockRejectedValue(
      new ApiError(404, 'not_found', 'session gone'),
    );
    vi.spyOn(plannerClient, 'resumeSession').mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    const result = await flushFocusJournal({ store: sessions, online: true });

    expect(result.quarantined).toBe(1);
    expect(result.remaining).toBe(1);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(1);
    expect(listQuarantine(ownerA.id)).toHaveLength(1);
    expect(sessions.syncMessage).toMatch(/집중 기록 1개를 이 기기에 따로 보관했어요/);
    expect(sessions.syncMessage).toMatch(/집중 기록 1개가 아직 업로드를 기다리고 있어요/);
  });

  it('keeps the quarantined count when a later replay conflicts', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    sessions.setOwner(ownerA.id);
    const session = workSession();
    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: 1,
      },
      ownerA.id,
    );
    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'resume',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('resume'),
        expectedVersion: 2,
      },
      ownerA.id,
    );
    vi.spyOn(plannerClient, 'getMe').mockResolvedValue(ownerA);
    vi.spyOn(plannerClient, 'pauseSession').mockRejectedValue(
      new ApiError(404, 'not_found', 'session gone'),
    );
    vi.spyOn(plannerClient, 'resumeSession').mockRejectedValue(
      new ApiError(409, 'illegal_transition', 'stale version'),
    );

    const result = await flushFocusJournal({ store: sessions, online: true });

    expect(result.quarantined).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.conflict).toMatch(/집중 기록 1개를 이 기기에 따로 보관했어요/);
    expect(listQuarantine(ownerA.id)).toHaveLength(1);
  });

  it('does not remove a journal record when the quarantine write fails', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    sessions.setOwner(ownerA.id);
    const session = workSession();
    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: 1,
      },
      ownerA.id,
    );
    vi.spyOn(plannerClient, 'getMe').mockResolvedValue(ownerA);
    vi.spyOn(plannerClient, 'pauseSession').mockRejectedValue(
      new ApiError(404, 'not_found', 'session gone'),
    );
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.startsWith('ohmydate.focus.quarantine')) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    });

    const result = await flushFocusJournal({ store: sessions, online: true });

    expect(result.quarantined).toBe(0);
    expect(listQuarantine(ownerA.id)).toHaveLength(0);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(1);
    expect(sessions.syncMessage).toMatch(/따로 보관할 공간을 만들지 못해서 집중 기록 1개를 대기열에 그대로 남겨 뒀어요/);
  });

  it('re-queues quarantined records when retried', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    sessions.setOwner(ownerA.id);
    const session = workSession();
    quarantineRecord(
      ownerA.id,
      {
        seq: 1,
        ownerId: ownerA.id,
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: 1,
      },
      'session gone',
    );

    const requeued = await retryQuarantinedFocusEvents({ store: sessions, online: true });

    expect(requeued).toBe(1);
    expect(listQuarantine(ownerA.id)).toHaveLength(0);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(1);
  });

  it('stops without quarantining when the cookie owner no longer matches the binding', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    sessions.setOwner(ownerA.id);
    const session = workSession();
    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'pause',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('pause'),
        expectedVersion: 1,
      },
      ownerA.id,
    );
    vi.spyOn(plannerClient, 'getMe').mockResolvedValue(ownerB);
    vi.spyOn(plannerClient, 'pauseSession').mockRejectedValue(
      new ApiError(404, 'not_found', 'session gone'),
    );

    const result = await flushFocusJournal({ store: sessions, online: true });

    expect(result.quarantined).toBe(0);
    expect(result.remaining).toBe(1);
    expect(listQuarantine(ownerA.id)).toHaveLength(0);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(1);
    expect(sessions.syncMessage).toMatch(/로그인한 사용자가 바뀌어서 집중 기록 1개가/);
  });

  it('merges a stale same-owner write into the in-memory sessions', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    sessions.setOwner(ownerA.id);
    const binding = captureOwnerBinding();
    const session = workSession();
    invalidateOwnerEpoch();

    sessions.remember(session, binding);

    expect(sessions.get(session.id)?.id).toBe(session.id);
    expect(storedFor(ownerA.id)[session.id]?.id).toBe(session.id);
  });

  it('quarantines a terminal 403/404 replay per owner and keeps later events moving', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    sessions.setOwner(ownerA.id);
    vi.spyOn(plannerClient, 'getMe').mockResolvedValue(ownerA);

    const session = workSession();
    const terminal = {
      id: createUuidV7(),
      sessionId: session.id,
      kind: 'pause' as const,
      clientAt: new Date().toISOString(),
      idempotencyKey: newActionId('pause'),
      expectedVersion: 1,
    };
    const later = {
      id: createUuidV7(),
      sessionId: session.id,
      kind: 'resume' as const,
      clientAt: new Date().toISOString(),
      idempotencyKey: newActionId('resume'),
      expectedVersion: 2,
    };
    await sessionJournal.append(terminal, ownerA.id);
    await sessionJournal.append(later, ownerA.id);
    vi.spyOn(plannerClient, 'pauseSession').mockRejectedValue(
      new ApiError(404, 'not_found', 'session gone'),
    );
    vi.spyOn(plannerClient, 'resumeSession').mockResolvedValue({
      ...session,
      state: 'active',
      version: 3,
    });

    const result = await flushFocusJournal({ store: sessions, online: true });

    expect(result.uploaded).toBe(1);
    expect(result.remaining).toBe(0);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(0);
    const quarantined = listQuarantine(ownerA.id);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.record.kind).toBe('pause');
    expect(listQuarantine(ownerB.id)).toHaveLength(0);
    expect(sessions.syncState).toBe('conflict');
    expect(sessions.syncMessage).toMatch(/따로 보관했어요/);

    await sessionJournal.append(
      {
        id: createUuidV7(),
        sessionId: session.id,
        kind: 'complete',
        clientAt: new Date().toISOString(),
        idempotencyKey: newActionId('complete'),
        expectedVersion: 3,
      },
      ownerA.id,
    );
    vi.spyOn(plannerClient, 'completeSession').mockResolvedValue({
      ...session,
      state: 'completed',
      version: 4,
    });
    const after = await flushFocusJournal({ store: sessions, online: true });
    expect(after.uploaded).toBe(1);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(0);
    expect(listQuarantine(ownerA.id)).toHaveLength(1);
  });
});
