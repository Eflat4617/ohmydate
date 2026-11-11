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
import FocusView from '../src/views/FocusView.vue';
import TodayView from '../src/views/TodayView.vue';
import { flushFocusJournal } from '../src/session/focusQueue';
import { sessionJournal } from '../src/session/journal';
import { clearQuarantine, listQuarantine } from '../src/session/quarantine';
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
    vi.spyOn(plannerClient, 'pauseSession').mockImplementation(() => pending.promise);
    const router = testRouter();
    await router.push(`/focus/${session.id}`);
    const wrapper = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
    await vi.waitFor(() => expect(button(wrapper, 'Pause').attributes('disabled')).toBeUndefined());
    await button(wrapper, 'Pause').trigger('click');
    await vi.waitFor(() => expect(plannerClient.pauseSession).toHaveBeenCalledTimes(1));
    wrapper.unmount();

    await signIn(pinia, ownerB, login, getMe);
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
    await router.push('/today');
    const wrapper = mount(TodayView, {
      global: { plugins: [pinia, VueQueryPlugin, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.findAll('.today-card').length).toBeGreaterThan(0));
    const card = wrapper.findAll('.today-card')[0];
    if (card === undefined) throw new Error('missing today card');
    await button(card as unknown as VueWrapper, 'Start focus').trigger('click');
    await vi.waitFor(() => expect(plannerClient.createSession).toHaveBeenCalledTimes(1));

    await signIn(pinia, ownerB, login, getMe);
    const created = workSession({ clientId: 'owner-a-client' });
    pending.resolve(created);

    await vi.waitFor(() => expect(storedFor(ownerA.id)[created.id]?.id).toBe(created.id));
    expect(router.currentRoute.value.name).toBe('today');
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

  it('quarantines a terminal 403/404 replay per owner and keeps later events moving', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    sessions.setOwner(ownerA.id);

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
    expect(sessions.syncMessage).toMatch(/set aside/);

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
