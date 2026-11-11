import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent } from 'vue';
import {
  ApiError,
  newActionId,
  plannerClient,
  type User,
  type WorkSession,
} from '../src/api';
import FocusView from '../src/views/FocusView.vue';
import AppShell from '../src/components/AppShell.vue';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import {
  adoptActiveOwner,
  injectOwnerReload,
  ownerState,
} from '../src/session/ownerEpoch';
import { sessionJournal } from '../src/session/journal';
import {
  flushFocusJournal,
  retryQuarantinedFocusEvents,
} from '../src/session/focusQueue';
import { listQuarantine, quarantineRecord } from '../src/session/quarantine';
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
      { path: '/login', name: 'login', component: Stub },
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
    clientId: 'hard-reset-test',
    version: 1,
    ...overrides,
  };
}

async function signIn(
  pinia: ReturnType<typeof createPinia>,
  user: User,
  login: { mockResolvedValue(value: void): unknown },
  getMe: { mockResolvedValue(value: User): unknown },
): Promise<void> {
  login.mockResolvedValue();
  getMe.mockResolvedValue(user);
  await useAuthStore(pinia).login(user.email, 'pw');
}

function seedSessionStorage(ownerId: string, session: WorkSession): void {
  localStorage.setItem(`ohmydate.focus.sessions:${ownerId}`, JSON.stringify({ [session.id]: session }));
}

describe('ADR-023 hard reset on owner change', () => {
  beforeEach(async () => {
    localStorage.clear();
    adoptActiveOwner(null, 'bootstrap');
    sessionJournal.setOwner(null);
    await sessionJournal.clear(null);
  });

  it('hard resets on a cross-tab owner change and rejects settings before the reload', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const auth = useAuthStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const reload = vi.fn();
    injectOwnerReload(reload);
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');
    const update = vi.spyOn(plannerClient, 'updateMySettings');

    await signIn(pinia, ownerA, login, getMe);
    reload.mockClear();
    const session = workSession();
    sessions.remember(session);
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

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: OWNER_STORAGE_KEY,
        oldValue: ownerA.id,
        newValue: ownerB.id,
      }),
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(auth.ownerId).toBe(ownerB.id);
    expect(auth.user).toBeNull();
    expect(auth.confirmed).toBe(false);
    expect(sessions.ownerId).toBe(ownerB.id);
    expect(sessions.active).toBeNull();

    await expect(auth.setLlmBudget(2, 10)).rejects.toThrow(/owner changed/i);
    expect(update).not.toHaveBeenCalled();
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(1);
    expect(localStorage.getItem(`ohmydate.focus.sessions:${ownerA.id}`)).not.toBeNull();
  });

  it('hard resets when another tab logs out and keeps the previous namespace', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const auth = useAuthStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const reload = vi.fn();
    injectOwnerReload(reload);
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    reload.mockClear();
    const session = workSession();
    sessions.remember(session);
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

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: OWNER_STORAGE_KEY,
        oldValue: ownerA.id,
        newValue: null,
      }),
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(auth.ownerId).toBeNull();
    expect(auth.user).toBeNull();
    expect(sessions.ownerId).toBeNull();
    expect(sessions.active).toBeNull();
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(1);
    expect(localStorage.getItem(`ohmydate.focus.sessions:${ownerA.id}`)).not.toBeNull();
  });

  it('hard resets when logging in as a different user', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const auth = useAuthStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const reload = vi.fn();
    injectOwnerReload(reload);
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const session = workSession();
    sessions.remember(session);
    seedSessionStorage(ownerA.id, session);
    reload.mockClear();

    getMe.mockResolvedValue(ownerB);
    const next = await auth.login(ownerB.email, 'pw');

    expect(reload).toHaveBeenCalledTimes(1);
    expect(next.id).toBe(ownerB.id);
    expect(auth.ownerId).toBe(ownerB.id);
    expect(auth.user?.id).toBe(ownerB.id);
    expect(sessions.ownerId).toBe(ownerB.id);
    expect(sessions.get(session.id)).toBeNull();
    expect(localStorage.getItem(`ohmydate.focus.sessions:${ownerA.id}`)).not.toBeNull();
  });

  it('hard resets when /me returns a different owner than the stored one at boot', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const auth = useAuthStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const session = workSession();
    adoptActiveOwner(ownerA.id, 'bootstrap');
    seedSessionStorage(ownerA.id, session);
    const reload = vi.fn();
    injectOwnerReload(reload);
    vi.spyOn(plannerClient, 'getMe').mockResolvedValue(ownerB);

    const current = await auth.loadCurrent();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(current?.id).toBe(ownerB.id);
    expect(auth.ownerId).toBe(ownerB.id);
    expect(auth.user?.id).toBe(ownerB.id);
    expect(auth.confirmed).toBe(true);
    expect(sessions.ownerId).toBe(ownerB.id);
    expect(localStorage.getItem(`ohmydate.focus.sessions:${ownerA.id}`)).not.toBeNull();
    expect(ownerA.id).not.toBe(ownerB.id);
    expect(ownerState.ownerId.value).toBe(ownerB.id);
  });

  it('renders no session or settings UI before /me confirms the owner', async () => {
    const pinia = createPinia();
    const ownerA = owner(mockDb.user, 'owner-a');
    const pending = deferred<User>();
    vi.spyOn(plannerClient, 'getMe').mockReturnValue(pending.promise);
    const router = testRouter();
    await router.push('/today');
    const wrapper = mount(AppShell, {
      global: { plugins: [pinia, router] },
      slots: { default: '<p class="protected-body">Journal</p>' },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Loading OhMyDate'));
    expect(wrapper.find('.protected-body').exists()).toBe(false);

    pending.resolve(ownerA);
    await vi.waitFor(() => expect(wrapper.find('.protected-body').exists()).toBe(true));
    wrapper.unmount();
  });

  it('revalidates identity on focus and returns to login after an external logout', async () => {
    const pinia = createPinia();
    const auth = useAuthStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    expect(auth.confirmed).toBe(true);
    const router = testRouter();
    await router.push('/today');
    const wrapper = mount(AppShell, {
      global: { plugins: [pinia, router] },
      slots: { default: '<p class="protected-body">Journal</p>' },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.find('.protected-body').exists()).toBe(true));

    getMe.mockRejectedValue(new ApiError(401, 'unauthenticated', 'no session'));
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
    expect(auth.confirmed).toBe(false);
    wrapper.unmount();
  });

  it('serializes retry with replay and keeps a concurrently quarantined event', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    adoptActiveOwner(ownerA.id, 'bootstrap');
    sessions.setOwner(ownerA.id);
    vi.spyOn(plannerClient, 'getMe').mockResolvedValue(ownerA);
    const session = workSession();
    const oldRecord = {
      id: createUuidV7(),
      sessionId: session.id,
      kind: 'resume' as const,
      clientAt: new Date().toISOString(),
      idempotencyKey: newActionId('resume'),
      expectedVersion: 1,
    };
    const newRecord = {
      id: createUuidV7(),
      sessionId: session.id,
      kind: 'pause' as const,
      clientAt: new Date().toISOString(),
      idempotencyKey: newActionId('pause'),
      expectedVersion: 2,
    };
    quarantineRecord(
      ownerA.id,
      { ...oldRecord, seq: 1, ownerId: ownerA.id },
      'session gone',
    );
    await sessionJournal.append(newRecord, ownerA.id);

    const originalAppend = sessionJournal.append.bind(sessionJournal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedAppend = vi
      .spyOn(sessionJournal, 'append')
      .mockImplementationOnce(async (event, ownerId) => {
        await gate;
        return originalAppend(event, ownerId);
      });
    const pause = vi.spyOn(plannerClient, 'pauseSession').mockRejectedValue(
      new ApiError(404, 'not_found', 'session gone'),
    );
    vi.spyOn(plannerClient, 'resumeSession').mockResolvedValue({
      ...session,
      state: 'active',
      version: 3,
    });

    const retry = retryQuarantinedFocusEvents({ store: sessions, online: true });
    await vi.waitFor(() => expect(delayedAppend).toHaveBeenCalledTimes(1));
    const flush = flushFocusJournal({ store: sessions, online: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pause).not.toHaveBeenCalled();

    release();
    expect(await retry).toBe(1);
    const result = await flush;

    expect(result.quarantined).toBe(1);
    expect(await sessionJournal.list(undefined, ownerA.id)).toHaveLength(0);
    const quarantinedKeys = listQuarantine(ownerA.id).map(
      (entry) => entry.record.idempotencyKey,
    );
    expect(quarantinedKeys).toContain(newRecord.idempotencyKey);
    expect(quarantinedKeys).not.toContain(oldRecord.idempotencyKey);
  });

  it('aborts a never-settling owner A focus operation and leaves B unaffected', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    const auth = useAuthStore(pinia);
    const ownerA = owner(mockDb.user, 'owner-a');
    const ownerB = owner(mockDb.user, 'owner-b');
    const login = vi.spyOn(plannerClient, 'login');
    const getMe = vi.spyOn(plannerClient, 'getMe');

    await signIn(pinia, ownerA, login, getMe);
    const created = await plannerClient.createSession(
      {
        taskId: TODAY_TASK_ONE_ID,
        blockId: TODAY_BLOCK_ONE_ID,
        clientStartedAt: new Date().toISOString(),
        clientId: 'owner-a-client',
      },
      newActionId('session'),
    );
    sessions.remember(created);

    const pending = deferred<WorkSession>();
    let pauseSignal: AbortSignal | undefined;
    const pause = vi
      .spyOn(plannerClient, 'pauseSession')
      .mockImplementationOnce(
        (_sessionId, _clientAt, _key, _version, signal?: AbortSignal) => {
          pauseSignal = signal;
          return pending.promise;
        },
      );
    const router = testRouter();
    await router.push(`/focus/${created.id}`);
    const wrapper = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
    await vi.waitFor(() => expect(button(wrapper, 'Pause').attributes('disabled')).toBeUndefined());
    await button(wrapper, 'Pause').trigger('click');
    await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(1));

    const getSession = vi
      .spyOn(plannerClient, 'getSession')
      .mockRejectedValue(new ApiError(404, 'not_found', 'session gone'));
    const reload = vi.fn();
    injectOwnerReload(reload);
    getMe.mockResolvedValue(ownerB);
    await auth.login(ownerB.email, 'pw');

    expect(reload).toHaveBeenCalledTimes(1);
    expect(pauseSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(sessions.get(created.id)).toBeNull();
    expect(await sessionJournal.list(undefined, ownerB.id)).toHaveLength(0);
    wrapper.unmount();

    const sessionB = workSession({ clientId: 'owner-b-client' });
    sessions.remember(sessionB);
    getSession.mockImplementation((sessionId) =>
      sessionId === sessionB.id
        ? Promise.resolve(sessionB)
        : Promise.reject(new ApiError(404, 'not_found', 'session gone')),
    );
    await router.push(`/focus/${sessionB.id}`);
    const wrapperB = mount(FocusView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapperB.find('.focus-timer').exists()).toBe(true));
    pause.mockImplementationOnce(() =>
      Promise.resolve({ ...sessionB, state: 'paused', version: sessionB.version + 1 }),
    );
    await vi.waitFor(() =>
      expect(button(wrapperB, 'Pause').attributes('disabled')).toBeUndefined(),
    );
    await button(wrapperB, 'Pause').trigger('click');
    await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sessions.get(sessionB.id)?.state).toBe('paused'));
    wrapperB.unmount();
  });
});
