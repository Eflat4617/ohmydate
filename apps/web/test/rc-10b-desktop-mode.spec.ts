import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { HttpResponse, http } from 'msw';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../src/api';
import AppShell from '../src/components/AppShell.vue';
import BottomNav from '../src/components/BottomNav.vue';
import NotificationsPanel from '../src/components/NotificationsPanel.vue';
import { timeZoneChoices } from '../src/domain/settings';
import { createUuidV7, mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { DESKTOP_BUILD_MODE, aiAvailable, appMode, isDesktop, mockApiWanted, ownerEmail } from '../src/platform/mode';
import { routes, routesFor } from '../src/router';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, injectOwnerReload, ownerState } from '../src/session/ownerEpoch';
import { ownerSlot } from '../src/session/ownerStorage';
import { useAuthStore } from '../src/stores/auth';
import { useSessionStore } from '../src/stores/session';
import LoginView from '../src/views/LoginView.vue';

/**
 * RC-10B, the desktop bundle (src/platform/mode.ts; blueprint 15 §4.2, §7.3).
 *
 * The web is built twice: for the server (accounts, a login form) and for the
 * desktop app's window (the Rust core serves it; the launch cookie is the
 * whole sign-in). Every rule of the desktop bundle is checked here beside its
 * negative — the same thing in a server bundle, where nothing may differ from
 * before. The guard the task asks for is the first shell test: a server
 * bundle that does not send a signed-out visitor to the login form fails it.
 */
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

function desktopBundle(): void {
  vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
}

/** The bundle's own route table, with every screen replaced by a stub. */
function bundleRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: routesFor(appMode()).map((route) => ('redirect' in route ? route : { ...route, component: Stub })) as never,
  });
}

function problem(status: number, code: string): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: 'x', status, code, detail: 'synthetic' },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

interface Shell {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

async function mountShell(path = '/overview'): Promise<Shell> {
  const router = bundleRouter();
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  const wrapper = mount(AppShell, {
    global: { plugins: [pinia, router, VueQueryPlugin] },
    slots: { default: '<p class="protected-body">Journal</p>' },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await vi.waitFor(async () => {
    await flushPromises();
    expect(useAuthStore(pinia).bootstrapState).not.toBe('pending');
  });
  await flushPromises();
  return { wrapper, router, pinia };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  adoptActiveOwner(null, 'bootstrap');
  document.body.innerHTML = '';
});

// ── The switch ──────────────────────────────────────────────────────────────

describe('which bundle this is', () => {
  it('is the server unless it was built in the desktop mode — exactly that word', () => {
    // vitest's own mode: not the desktop's.
    expect(import.meta.env.MODE).not.toBe(DESKTOP_BUILD_MODE);
    expect(appMode()).toBe('server');
    expect(isDesktop()).toBe(false);
    for (const mode of ['production', 'development', 'test', 'Desktop', 'DESKTOP', ' desktop', 'desktop ', 'desktop-dev', '1', 'true', '']) {
      vi.stubEnv('MODE', mode);
      expect(appMode(), `mode "${mode}"`).toBe('server');
    }
    vi.stubEnv('MODE', 'desktop');
    expect(appMode()).toBe('desktop');
    expect(isDesktop()).toBe(true);
  });

  it('nothing a page can do at run time turns the desktop on (negative)', () => {
    localStorage.setItem('ohmydate.mode', 'desktop');
    localStorage.setItem('desktop', '1');
    sessionStorage.setItem('ohmydate.mode', 'desktop');
    window.history.replaceState(null, '', '/overview?desktop=1&mode=desktop#desktop');
    vi.stubGlobal('__OHMYDATE_DESKTOP__', true);
    vi.stubGlobal('__TAURI__', {});
    document.cookie = 'omd_launch=anything; path=/';
    vi.stubEnv('VITE_APP_MODE', 'desktop');
    vi.stubEnv('VITE_DESKTOP', '1');
    expect(appMode()).toBe('server');
    expect(routesFor(appMode()).some((route) => route.name === 'login')).toBe(true);
    window.history.replaceState(null, '', '/');
  });

  it('the desktop bundle starts no mock service worker; the server bundle still can (negative)', () => {
    vi.stubEnv('VITE_MOCK', '1');
    expect(mockApiWanted()).toBe(true);
    desktopBundle();
    expect(mockApiWanted()).toBe(false);
    vi.stubEnv('VITE_MOCK', '0');
    vi.stubEnv('MODE', 'production');
    expect(mockApiWanted()).toBe(false);
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

describe('the route table', () => {
  it('server: /login is the login form, as it always was', async () => {
    const login = routes.find((route) => route.name === 'login');
    expect(login).toMatchObject({ path: '/login', component: LoginView, meta: { layout: 'blank' } });
    expect(routesFor('server')).toBe(routesFor('server'));
    expect(routesFor('server').map((route) => route.path)).toEqual(routes.map((route) => route.path));
    const router = bundleRouter();
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('desktop: there is no login route, and its address opens 개요 like any unknown one', async () => {
    const desktop = routesFor('desktop');
    expect(desktop.some((route) => route.name === 'login' || route.path === '/login')).toBe(false);
    expect(desktop.some((route) => route.component === LoginView)).toBe(false);
    // Everything else is the same table.
    expect(desktop).toEqual(routesFor('server').filter((route) => route.name !== 'login'));
    desktopBundle();
    const router = bundleRouter();
    expect(router.hasRoute('login')).toBe(false);
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('overview');
  });
});

// ── Signed out ──────────────────────────────────────────────────────────────

describe('a page nobody is signed in to (401 from /me)', () => {
  it('server (the guard): goes to the login form — never the desktop page', async () => {
    server.use(http.get('*/api/v1/me', () => problem(401, 'unauthenticated')));
    const { wrapper, router, pinia } = await mountShell('/tasks');
    expect(useAuthStore(pinia).bootstrapState).toBe('anonymous');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
    expect(wrapper.find('[data-desktop-locked]').exists()).toBe(false);
    expect(document.body.textContent).not.toContain('앱에서 다시 열어 주세요');
    // The shell itself never rendered for an unknown visitor.
    expect(wrapper.find('.protected-body').exists()).toBe(false);
  });

  it('desktop: a plain page says to open it from the app; nothing navigates and there is nothing to fill in', async () => {
    desktopBundle();
    server.use(http.get('*/api/v1/me', () => problem(401, 'unauthenticated')));
    const { wrapper, router, pinia } = await mountShell('/tasks');
    expect(useAuthStore(pinia).bootstrapState).toBe('anonymous');
    const page = wrapper.get('[data-desktop-locked]');
    expect(page.get('h1').text()).toBe('앱에서 다시 열어 주세요');
    expect(page.text()).toContain('로그인하는 곳이 없어요');
    expect(page.findAll('input, form, button, a')).toHaveLength(0);
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/tasks');
    expect(wrapper.find('.protected-body').exists()).toBe(false);
    expect(wrapper.find('.nav-rail').exists()).toBe(false);
  });

  it('desktop: a 403 (the core refused the host or the origin) is the same page', async () => {
    desktopBundle();
    server.use(http.get('*/api/v1/me', () => problem(403, 'forbidden')));
    const { wrapper } = await mountShell();
    expect(wrapper.find('[data-desktop-locked]').exists()).toBe(true);
  });

  it('desktop: with the launch cookie (/me answers) the shell opens, not that page (negative)', async () => {
    desktopBundle();
    const { wrapper, pinia } = await mountShell();
    expect(useAuthStore(pinia).confirmed).toBe(true);
    expect(wrapper.find('[data-desktop-locked]').exists()).toBe(false);
    expect(wrapper.find('.protected-body').exists()).toBe(true);
  });

  it('desktop: the cookie is gone later (the app was restarted) — the open page turns into that page', async () => {
    desktopBundle();
    const { wrapper, pinia } = await mountShell();
    expect(wrapper.find('.protected-body').exists()).toBe(true);
    server.use(http.get('*/api/v1/me', () => problem(401, 'unauthenticated')));
    await useAuthStore(pinia).loadCurrent();
    await flushPromises();
    expect(wrapper.find('[data-desktop-locked]').exists()).toBe(true);
    expect(wrapper.find('.protected-body').exists()).toBe(false);
  });
});

// ── What is left out ────────────────────────────────────────────────────────

describe('sign-out, the address and Web Push', () => {
  async function openAccountMenu(wrapper: VueWrapper): Promise<void> {
    await wrapper.get('[data-user-menu]').trigger('click');
    await flushPromises();
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(true);
  }

  it('server: the account menu shows the address and signs out', async () => {
    const { wrapper } = await mountShell();
    expect(wrapper.get('[data-user-menu]').attributes('aria-label')).toContain('planner');
    await openAccountMenu(wrapper);
    expect(wrapper.get('#topbar-user-menu .menu-note').text()).toBe(mockDb.user.email);
    expect(wrapper.find('[data-user-sign-out]').exists()).toBe(true);
    expect(wrapper.find('[data-user-settings]').exists()).toBe(true);
  });

  it('desktop: no sign-out and no address — the menu keeps the theme and 설정', async () => {
    desktopBundle();
    const { wrapper } = await mountShell();
    expect(wrapper.get('[data-user-menu]').attributes('aria-label')).toBe('계정 메뉴');
    expect(wrapper.find('.topbar-user-name').exists()).toBe(false);
    await openAccountMenu(wrapper);
    expect(wrapper.find('[data-user-sign-out]').exists()).toBe(false);
    expect(wrapper.find('#topbar-user-menu .menu-note').exists()).toBe(false);
    expect(wrapper.get('#topbar-user-menu').text()).not.toContain('@');
    expect(wrapper.get('#topbar-user-menu').text()).not.toContain('로그아웃');
    expect(wrapper.find('[data-user-settings]').exists()).toBe(true);
    expect(wrapper.find('.topbar-theme').exists()).toBe(true);
  });

  async function mountBottomNav(): Promise<VueWrapper> {
    const router = bundleRouter();
    await router.push('/overview');
    const wrapper = mount(BottomNav, { global: { plugins: [createPinia(), router] }, attachTo: document.body });
    mounted.push(wrapper);
    await wrapper.get('[data-nav-more]').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('the phone’s 더 보기: sign-out on the server, none on the desktop', async () => {
    const serverNav = await mountBottomNav();
    expect(document.body.querySelector('[data-more-sign-out]')).not.toBeNull();
    serverNav.unmount();
    document.body.innerHTML = '';
    desktopBundle();
    await mountBottomNav();
    expect(document.body.querySelector('[data-more-sign-out]')).toBeNull();
    expect(document.body.textContent).not.toContain('로그아웃');
    // The rest of the sheet is there.
    expect(document.body.textContent).toContain('도움말');
  });

  async function mountNotifications(): Promise<VueWrapper> {
    const pinia = createPinia();
    await useAuthStore(pinia).ensureOwnerConfirmed();
    const wrapper = mount(NotificationsPanel, {
      props: { open: true },
      global: { plugins: [pinia, bundleRouter(), VueQueryPlugin] },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    return wrapper;
  }

  it('the notifications panel: the push opt-in on the server, none on the desktop', async () => {
    // A browser that could subscribe: the desktop bundle still does not offer it.
    vi.stubGlobal('Notification', { requestPermission: vi.fn() });
    vi.stubGlobal('PushManager', class {});
    const register = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register, ready: new Promise(() => undefined) } });
    try {
      await mountNotifications();
      expect(document.body.querySelector('.push-opt-in')).not.toBeNull();
      expect(document.body.textContent).toContain('푸시 알림 켜기');
      mounted.pop()?.unmount();
      document.body.innerHTML = '';

      desktopBundle();
      await mountNotifications();
      expect(document.body.querySelector('#notifications-title')).not.toBeNull();
      expect(document.body.querySelector('.push-opt-in')).toBeNull();
      expect(document.body.textContent).not.toContain('푸시');
      // No service worker was registered by either bundle's panel.
      expect(register).not.toHaveBeenCalled();
    } finally {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    }
  });

  it('the address the core made up is not a name; the server’s address still is (negative)', () => {
    const coreOwner = { email: 'owner@ohmydate.local' };
    expect(ownerEmail(coreOwner)).toBe('owner@ohmydate.local');
    expect(ownerEmail(null)).toBeNull();
    desktopBundle();
    expect(ownerEmail(coreOwner)).toBeNull();
  });
});

// ── The single owner is still an owner ──────────────────────────────────────

describe('the desktop owner', () => {
  it('is the id /me returns: device state is kept under it, as for any owner', async () => {
    desktopBundle();
    const { pinia } = await mountShell();
    const id = mockDb.user.id;
    expect(ownerState.ownerId.value).toBe(id);
    expect(localStorage.getItem(OWNER_STORAGE_KEY)).toBe(id);
    expect(useSessionStore(pinia).ownerId).toBe(id);
    // An owner-scoped slot is namespaced by that id, never by a fixed "desktop" name.
    const key = ownerSlot('focusSessions').keyFor(id);
    expect(key).toContain(id);
    expect(key).not.toBe(ownerSlot('focusSessions').keyFor(null));
  });

  it('a different id from /me is still an owner change: the page is hard-reset, as on the server', async () => {
    desktopBundle();
    const reload = vi.fn();
    const { pinia } = await mountShell();
    injectOwnerReload(reload);
    const other: User = { ...mockDb.user, id: createUuidV7() };
    server.use(http.get('*/api/v1/me', () => HttpResponse.json(other, { headers: { ETag: 'W/"1"' } })));
    await useAuthStore(pinia).loadCurrent();
    expect(reload).toHaveBeenCalledWith('me-mismatch');
    expect(ownerState.ownerId.value).toBe(other.id);
  });
});

// ── Small rules ─────────────────────────────────────────────────────────────

describe('no AI yet, and a zone the engine does not list', () => {
  it('desktop without `llmProvider` has no AI; with one it has; the server always has', () => {
    expect(aiAvailable({})).toBe(true);
    expect(aiAvailable(null)).toBe(true);
    desktopBundle();
    expect(aiAvailable({})).toBe(false);
    expect(aiAvailable(null)).toBe(false);
    expect(aiAvailable({ llmProvider: 'deepseek' })).toBe(true);
    expect(aiAvailable({ llmProvider: 'fake' })).toBe(true);
  });

  it('the zone that is set stays in the field even when the engine does not list it', () => {
    const listed = ['Asia/Seoul', 'Europe/Berlin'];
    expect(timeZoneChoices(listed, 'America/Coyhaique')).toEqual(['America/Coyhaique', 'Asia/Seoul', 'Europe/Berlin']);
    // A listed zone, or none, changes nothing (negative).
    expect(timeZoneChoices(listed, 'Asia/Seoul')).toEqual(listed);
    expect(timeZoneChoices(listed, undefined)).toEqual(listed);
    expect(timeZoneChoices(listed, '')).toEqual(listed);
    expect(timeZoneChoices(listed, null)).not.toBe(listed);
  });
});
