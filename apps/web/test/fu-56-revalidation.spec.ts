import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent } from 'vue';
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
      { path: '/today', name: 'today', component: Stub },
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
  await router.push('/today');
  const wrapper = mount(AppShell, {
    global: { plugins: [pinia, router] },
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
    expect(IDENTITY_REVALIDATION_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
