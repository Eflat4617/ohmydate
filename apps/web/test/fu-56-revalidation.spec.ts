import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { ApiError, plannerClient, type User } from '../src/api';
import AppShell from '../src/components/AppShell.vue';
import { adoptActiveOwner, clearOwnerResetPending } from '../src/session/ownerEpoch';
import { sessionJournal } from '../src/session/journal';
import { IDENTITY_REVALIDATION_TIMEOUT_MS, useAuthStore } from '../src/stores/auth';
import { createUuidV7, mockDb } from '../src/mocks/db';

const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: Stub },
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
    ],
  });
}

function owner(label: string): User {
  return {
    ...mockDb.user,
    id: createUuidV7(),
    email: `${label}-${Date.now().toString(36)}@example.test`,
    version: 1,
  };
}

async function signIn(pinia: ReturnType<typeof createPinia>, current: User) {
  const login = vi.spyOn(plannerClient, 'login').mockResolvedValue();
  const getMe = vi.spyOn(plannerClient, 'getMe').mockResolvedValue(current);
  await useAuthStore(pinia).login(current.email, 'pw');
  return { login, getMe };
}

async function mountShell(pinia: ReturnType<typeof createPinia>): Promise<VueWrapper> {
  const router = testRouter();
  await router.push('/overview');
  const wrapper = mount(AppShell, {
    global: { plugins: [pinia, router, VueQueryPlugin] },
    slots: { default: '<p class="protected-body">Journal</p>' },
    attachTo: document.body,
  });
  await vi.waitFor(() => expect(wrapper.find('.protected-body').exists()).toBe(true));
  return wrapper;
}

function retryButton(wrapper: VueWrapper) {
  const found = wrapper.findAll('.identity-revalidation-banner button');
  if (found.length !== 1) throw new Error('retry button not found');
  return found[0]!;
}

describe('identity revalidation on focus/visibility (FU-56)', () => {
  beforeEach(async () => {
    localStorage.clear();
    adoptActiveOwner(null, 'bootstrap');
    clearOwnerResetPending();
    sessionJournal.setOwner(null);
    await sessionJournal.clear(null);
  });

  it('keeps the confirmed owner on a network error and offers a manual retry', async () => {
    const pinia = createPinia();
    const current = owner('network');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);
    const wrapper = await mountShell(pinia);
    getMe.mockClear();

    getMe.mockRejectedValue(new TypeError('Failed to fetch'));
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => expect(auth.revalidationState).toBe('failed'));
    expect(auth.confirmed).toBe(true);
    expect(auth.user?.id).toBe(current.id);
    expect(auth.ownerId).toBe(current.id);
    const banner = wrapper.get('.identity-revalidation-banner');
    expect(banner.attributes('role')).toBe('status');
    expect(banner.attributes('aria-live')).toBe('polite');
    expect(banner.text()).toContain('로그인 상태를 다시 확인하지 못했어요');

    const callsAfterFailure = getMe.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMe.mock.calls.length).toBe(callsAfterFailure);

    getMe.mockResolvedValue(current);
    await retryButton(wrapper).trigger('click');
    await vi.waitFor(() => expect(auth.revalidationState).toBe('idle'));
    expect(wrapper.find('.identity-revalidation-banner').exists()).toBe(false);
    expect(auth.user?.id).toBe(current.id);
    expect(auth.confirmed).toBe(true);
    wrapper.unmount();
  });

  it('keeps the confirmed owner on a 503 and does not loop', async () => {
    const pinia = createPinia();
    const current = owner('unavailable');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);
    const wrapper = await mountShell(pinia);
    getMe.mockClear();

    getMe.mockRejectedValue(new ApiError(503, 'internal_error', 'temporarily unavailable'));
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(auth.revalidationState).toBe('failed'));
    expect(auth.confirmed).toBe(true);
    expect(auth.user?.id).toBe(current.id);
    expect(auth.ownerId).toBe(current.id);
    expect(wrapper.get('.identity-revalidation-banner').text()).toContain(
      '로그인 상태를 다시 확인하지 못했어요',
    );

    const callsAfterFailure = getMe.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMe.mock.calls.length).toBe(callsAfterFailure);

    wrapper.unmount();
  });

  it('bounds a hanging check with a timeout and keeps the owner', async () => {
    const pinia = createPinia();
    const current = owner('timeout');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);

    let requestSignal: AbortSignal | undefined;
    getMe.mockImplementation((signal?: AbortSignal) => {
      requestSignal = signal;
      return new Promise<User>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('identity revalidation timed out', 'TimeoutError'));
        });
      });
    });

    const result = await auth.loadCurrent({ timeoutMs: 25 });

    expect(result?.id).toBe(current.id);
    expect(requestSignal?.aborted).toBe(true);
    expect(auth.revalidationState).toBe('failed');
    expect(auth.confirmed).toBe(true);
    expect(auth.ownerId).toBe(current.id);
    expect(IDENTITY_REVALIDATION_TIMEOUT_MS).toBe(10_000);
  });
});

/** A `/me` that never answers on its own; it fails only when its signal aborts, as fetch does. */
function neverSettlingMe(signals: AbortSignal[]) {
  return (signal?: AbortSignal): Promise<User> => {
    if (signal === undefined) throw new Error('identity check sent without an abort signal');
    signals.push(signal);
    return new Promise<User>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

/** A `/me` the test answers by hand. */
function heldMe() {
  const held: { resolve: (user: User) => void; reject: (cause: unknown) => void }[] = [];
  const impl = (): Promise<User> =>
    new Promise<User>((resolve, reject) => {
      held.push({ resolve, reject });
    });
  return { held, impl };
}

function noticeExists(wrapper: VueWrapper): boolean {
  return wrapper.find('.identity-revalidation-banner').exists();
}

describe('identity revalidation hardening (FU-85)', () => {
  beforeEach(async () => {
    localStorage.clear();
    adoptActiveOwner(null, 'bootstrap');
    clearOwnerResetPending();
    sessionJournal.setOwner(null);
    await sessionJournal.clear(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.dispatchEvent(new Event('online'));
  });

  it('aborts a never-settling focus check at exactly 10 s, keeps the owner, and the next focus checks again', async () => {
    const pinia = createPinia();
    const current = owner('focus-timeout');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);
    const wrapper = await mountShell(pinia);
    getMe.mockClear();
    const signals: AbortSignal[] = [];
    getMe.mockImplementationOnce(neverSettlingMe(signals));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(getMe).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    const first = signals[0]!;
    expect(first.aborted).toBe(false);
    expect(auth.revalidationState).toBe('pending');

    await vi.advanceTimersByTimeAsync(9_999);
    await flushPromises();
    expect(first.aborted).toBe(false);
    expect(auth.revalidationState).toBe('pending');
    // A focus while the check is in flight joins it instead of starting another.
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(getMe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(first.aborted).toBe(true);
    expect((first.reason as DOMException).name).toBe('TimeoutError');
    expect(auth.revalidationState).toBe('failed');
    expect(auth.confirmed).toBe(true);
    expect(auth.user?.id).toBe(current.id);
    expect(auth.ownerId).toBe(current.id);
    expect(wrapper.find('.protected-body').exists()).toBe(true);
    expect(noticeExists(wrapper)).toBe(true);

    getMe.mockResolvedValue(current);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(getMe).toHaveBeenCalledTimes(2);
    const second = getMe.mock.calls[1]![0];
    expect(second).toBeInstanceOf(AbortSignal);
    expect(second).not.toBe(first);
    expect(second?.aborted).toBe(false);
    expect(auth.revalidationState).toBe('idle');
    expect(auth.user?.id).toBe(current.id);
    expect(noticeExists(wrapper)).toBe(false);
    expect(IDENTITY_REVALIDATION_TIMEOUT_MS).toBe(10_000);
    wrapper.unmount();
  });

  it('keeps the failed notice out of the offline banner and checks once when the network returns', async () => {
    const pinia = createPinia();
    const current = owner('offline');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);
    const wrapper = await mountShell(pinia);
    getMe.mockClear();
    getMe.mockRejectedValue(new TypeError('Failed to fetch'));

    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(auth.revalidationState).toBe('failed'));
    await flushPromises();
    expect(auth.confirmed).toBe(true);
    expect(auth.ownerId).toBe(current.id);
    expect(wrapper.find('.offline-banner').exists()).toBe(true);
    expect(noticeExists(wrapper)).toBe(false);
    expect(wrapper.findAll('.app-main > [role="status"][aria-live="polite"]')).toHaveLength(1);
    expect(getMe).toHaveBeenCalledTimes(1);

    const { held, impl } = heldMe();
    getMe.mockImplementation(impl);
    window.dispatchEvent(new Event('online'));
    expect(getMe).toHaveBeenCalledTimes(2);
    expect(auth.revalidationState).toBe('pending');
    // Repeated `online` (and a focus) while the check is in flight start nothing new.
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    await flushPromises();
    expect(getMe).toHaveBeenCalledTimes(2);
    expect(held).toHaveLength(1);
    expect(wrapper.find('.offline-banner').exists()).toBe(false);

    held[0]!.resolve(current);
    await vi.waitFor(() => expect(auth.revalidationState).toBe('idle'));
    await flushPromises();
    expect(noticeExists(wrapper)).toBe(false);
    expect(auth.user?.id).toBe(current.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMe).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('shows the notice once the network is back if the check still fails', async () => {
    const pinia = createPinia();
    const current = owner('offline-still-failing');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);
    const wrapper = await mountShell(pinia);
    getMe.mockClear();
    getMe.mockRejectedValue(new TypeError('Failed to fetch'));

    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(auth.revalidationState).toBe('failed'));
    await flushPromises();
    expect(noticeExists(wrapper)).toBe(false);

    getMe.mockRejectedValue(new ApiError(503, 'internal_error', 'temporarily unavailable'));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(noticeExists(wrapper)).toBe(true));
    expect(auth.revalidationState).toBe('failed');
    expect(auth.ownerId).toBe(current.id);
    expect(wrapper.find('.offline-banner').exists()).toBe(false);
    expect(wrapper.findAll('.app-main > [role="status"][aria-live="polite"]')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMe).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('does not check identity on `online` while nobody is confirmed', async () => {
    const pinia = createPinia();
    const getMe = vi
      .spyOn(plannerClient, 'getMe')
      .mockRejectedValue(new ApiError(401, 'unauthenticated', 'no session'));
    const auth = useAuthStore(pinia);
    const router = testRouter();
    await router.push('/overview');
    const wrapper = mount(AppShell, {
      global: { plugins: [pinia, router, VueQueryPlugin] },
      slots: { default: '<p class="protected-body">Journal</p>' },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(auth.bootstrapState).toBe('anonymous'));
    const callsWhileAnonymous = getMe.mock.calls.length;

    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    await flushPromises();
    expect(getMe.mock.calls.length).toBe(callsWhileAnonymous);
    expect(wrapper.find('.protected-body').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps keyboard focus on the retry button while retrying and hands it to the main region on success', async () => {
    const pinia = createPinia();
    const current = owner('retry-focus');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);
    const wrapper = await mountShell(pinia);
    getMe.mockClear();
    getMe.mockRejectedValue(new TypeError('Failed to fetch'));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(noticeExists(wrapper)).toBe(true));

    const button = retryButton(wrapper).element as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);

    // A retry that fails again: the control never leaves and keeps focus.
    const { held, impl } = heldMe();
    getMe.mockImplementation(impl);
    await retryButton(wrapper).trigger('click');
    expect(auth.revalidationState).toBe('pending');
    await nextTick();
    expect(retryButton(wrapper).element).toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    held[0]!.reject(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(auth.revalidationState).toBe('failed'));
    await flushPromises();
    expect(retryButton(wrapper).element).toBe(button);
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(document.activeElement).toBe(button);

    // A retry that succeeds: the notice closes and focus goes to <main>, not <body>.
    await retryButton(wrapper).trigger('click');
    await nextTick();
    expect(document.activeElement).toBe(button);
    held[1]!.resolve(current);
    await vi.waitFor(() => expect(noticeExists(wrapper)).toBe(false));
    await flushPromises();
    expect(auth.revalidationState).toBe('idle');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(wrapper.get('#main-content').element);
    expect(getMe).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it('does not move focus when the notice closes while focus is elsewhere', async () => {
    const pinia = createPinia();
    const current = owner('focus-elsewhere');
    const { getMe } = await signIn(pinia, current);
    const auth = useAuthStore(pinia);
    const wrapper = await mountShell(pinia);
    getMe.mockClear();
    getMe.mockRejectedValue(new TypeError('Failed to fetch'));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(noticeExists(wrapper)).toBe(true));

    const skipLink = wrapper.get('.skip-link').element as HTMLAnchorElement;
    skipLink.focus();
    expect(document.activeElement).toBe(skipLink);
    getMe.mockResolvedValue(current);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(noticeExists(wrapper)).toBe(false));
    await flushPromises();
    expect(auth.revalidationState).toBe('idle');
    expect(document.activeElement).toBe(skipLink);
    wrapper.unmount();
  });
});
