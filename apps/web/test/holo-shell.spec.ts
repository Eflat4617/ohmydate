import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../src/components/AppShell.vue';
import { BOTTOM_BAR_PLACES, MORE_LINKS, NAV_ITEMS, NAV_PLACES, NAV_SETTINGS, crumbFor, isNavItemCurrent, navItemFor } from '../src/layout/navigation';
import { readNavCollapsed, shellNavKey, writeNavCollapsed } from '../src/layout/shellNav';
import { newActionId, plannerClient } from '../src/api';
import { TODAY_TASK_ONE_ID, mockDb } from '../src/mocks/db';
import { routes } from '../src/router';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useSessionStore } from '../src/stores/session';
import { useUiStore } from '../src/stores/ui';
import { resetThemeForTests, themePrefKey } from '../src/theme/theme';

/**
 * The shell (HOLO-01; the places are HOLO-04's, FLOW.md §4): the sidebar is
 * the loop in its own order with 설정 below it, the top bar says where you are
 * and holds the notifications and the account (theme, 설정, sign-out), the
 * places have single-key shortcuts, and the phone's bar holds the first of
 * them. Every address an earlier version had still opens, at its new home.
 */
const Stub = defineComponent({ template: '<div />' });
const OTHER_OWNER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b77';

/** Every route of the app, by name, with a stub screen. */
function shellRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes
      .filter((route) => typeof route.name === 'string')
      .map((route) => ({ path: route.path, name: route.name as string, component: Stub })),
  });
}

interface Shell {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

const mounted: VueWrapper[] = [];

async function mountShell(path = '/overview'): Promise<Shell> {
  const router = shellRouter();
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  const wrapper = mount(AppShell, {
    global: { plugins: [pinia, router, VueQueryPlugin] },
    slots: { default: () => h('h1', 'screen') },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await vi.waitFor(async () => {
    await flushPromises();
    expect(wrapper.find('.app-shell:not(.app-shell--loading)').exists()).toBe(true);
  });
  return { wrapper, router, pinia };
}

function press(key: string, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  resetThemeForTests();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  resetThemeForTests();
  document.body.innerHTML = '';
});

describe('sidebar', () => {
  it('lists the places of the loop in its order, then 설정 and 도움말 at the foot', async () => {
    const { wrapper } = await mountShell();
    const places = wrapper.findAll('.nav-rail [data-nav-places] .nav-link').map((link) => ({
      id: link.attributes('data-nav-place'),
      label: link.get('.nav-link-label').text(),
      href: link.attributes('href'),
    }));
    expect(places).toEqual([
      { id: 'overview', label: '개요', href: '/overview' },
      { id: 'tasks', label: '할 일', href: '/tasks' },
      { id: 'plan', label: '계획', href: '/plan' },
      { id: 'planner', label: '플래너', href: '/planner' },
      { id: 'focus', label: '집중', href: '/focus' },
      { id: 'insights', label: '분석', href: '/insights' },
      { id: 'notes', label: '노트', href: '/notes' },
    ]);
    // Sixteen entries in four groups became seven places: no group labels are left.
    expect(wrapper.find('.nav-rail [data-nav-group]').exists()).toBe(false);
    // 설정 and 도움말 at the foot; putting things down and searching are the capture bar's.
    expect(wrapper.findAll('.nav-rail .nav-secondary .nav-link-label').map((label) => label.text())).toEqual(['설정', '도움말']);
    expect(wrapper.get('.nav-rail .nav-secondary a.nav-link').attributes('href')).toBe('/settings');
    // Every place has its line icon, and the shortcuts are shown.
    expect(wrapper.findAll('.nav-rail [data-nav-places] .nav-link').every((link) => link.find('svg.nav-link-icon').exists())).toBe(true);
    expect(wrapper.findAll('.nav-rail [data-nav-places] kbd').map((key) => key.text())).toEqual(['o', 't', 'p', 'm', 'f']);
    // The key hints are for the eye: a link is named by its place alone, and says its key as a shortcut.
    expect(wrapper.findAll('.nav-rail kbd').every((key) => key.attributes('aria-hidden') === 'true')).toBe(true);
    expect(wrapper.findAll('.nav-rail [data-nav-places] a').map((link) => link.attributes('aria-keyshortcuts') ?? null)).toEqual(['o', 't', 'p', 'm', 'f', null, null]);
    // The brand opens 개요.
    expect(wrapper.get('.nav-brand').attributes('href')).toBe('/overview');
    // No "새 작업" button and no search entry in the sidebar (negative): both live in the top bar's capture bar.
    expect(wrapper.find('.nav-rail .nav-new-task').exists()).toBe(false);
    expect(wrapper.get('.nav-rail').text()).not.toContain('검색');
    // Sign-out is the account's, not a place (negative).
    expect(wrapper.get('.nav-rail').text()).not.toContain('로그아웃');
  });

  it('is glass that does not blur: only the ambient light is behind it', async () => {
    const { wrapper } = await mountShell();
    expect(wrapper.get('.nav-rail').classes()).toEqual(expect.arrayContaining(['glass', 'glass--still']));
    expect(wrapper.get('.app-topbar').classes()).toEqual(expect.arrayContaining(['glass', 'glass--host']));
    expect(wrapper.get('.bottom-nav').classes()).toContain('glass');
    expect(document.querySelector('[data-ambient]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks exactly the current place, also from a screen under it', async () => {
    const { wrapper, router } = await mountShell('/overview');
    const current = () =>
      wrapper.findAll('.nav-rail [aria-current="page"]').map((link) => link.get('.nav-link-label').text());
    expect(current()).toEqual(['개요']);
    expect(wrapper.findAll('.nav-rail .nav-link--current')).toHaveLength(1);

    for (const [path, place] of [
      ['/projects/01900000-0000-7000-8000-000000000003', '할 일'],
      ['/tasks/01900000-0000-7000-8000-000000000011', '할 일'],
      ['/tasks?view=list', '할 일'],
      ['/plan/schedule', '계획'],
      ['/replan', '계획'],
      ['/planner?view=list', '플래너'],
      ['/month', '플래너'],
      ['/focus', '집중'],
      ['/focus/01900000-0000-7000-8000-000000000599', '집중'],
      ['/insights', '분석'],
      ['/notes/new', '노트'],
      ['/settings/calendar', '설정'],
    ] as const) {
      await router.push(path);
      await nextTick();
      expect(current(), path).toEqual([place]);
    }
  });

  it('folds to icons from the top bar and remembers it for this owner only', async () => {
    const { wrapper, pinia } = await mountShell();
    const toggle = wrapper.get('[data-nav-toggle]');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(toggle.attributes('aria-controls')).toBe('app-sidebar');
    expect(wrapper.get('#app-sidebar').attributes('data-collapsed')).toBe('false');

    await toggle.trigger('click');
    expect(wrapper.get('.app-shell').classes()).toContain('app-shell--nav-collapsed');
    expect(wrapper.get('#app-sidebar').classes()).toContain('nav-rail--collapsed');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.attributes('aria-label')).toBe('사이드바 펼치기');
    // Folded, every link keeps its name (for assistive tech and as a tooltip).
    const overview = wrapper.get('.nav-rail a[href="/overview"].nav-link');
    expect(overview.text()).toContain('개요');
    expect(overview.attributes('title')).toBe('개요');

    expect(localStorage.getItem(shellNavKey(mockDb.user.id))).toBe('collapsed');
    expect(readNavCollapsed(mockDb.user.id)).toBe(true);
    expect(readNavCollapsed(OTHER_OWNER)).toBe(false);
    // A new page for the same owner opens folded; another owner's does not.
    expect(useUiStore(createPinia()).navCollapsed).toBe(true);
    adoptActiveOwner(OTHER_OWNER, 'bootstrap');
    expect(useUiStore(pinia).navCollapsed).toBe(false);
    expect(useUiStore(createPinia()).navCollapsed).toBe(false);
  });

  it('a fold written under a stale owner binding stores nothing (negative)', () => {
    const stale = captureOwnerBinding();
    adoptActiveOwner(OTHER_OWNER, 'bootstrap');
    expect(writeNavCollapsed(stale, true)).toBe(false);
    expect(localStorage.getItem(shellNavKey(mockDb.user.id))).toBeNull();
    expect(localStorage.getItem(shellNavKey(OTHER_OWNER))).toBeNull();
    expect(readNavCollapsed(null)).toBe(false);
  });
});

describe('navigation model', () => {
  it('gives every routed screen a place, and none to what it does not know (negative)', () => {
    expect(crumbFor('overview')).toEqual({ place: 'nav.overview', page: null });
    expect(crumbFor('tasks')).toEqual({ place: 'nav.tasks', page: null });
    // A screen under a place says both.
    expect(crumbFor('project')).toEqual({ place: 'nav.tasks', page: 'nav.crumbProject' });
    expect(crumbFor('task')).toEqual({ place: 'nav.tasks', page: 'nav.crumbTask' });
    expect(crumbFor('focus')).toEqual({ place: 'nav.focus', page: 'nav.crumbTimer' });
    expect(crumbFor('replan-proposal')).toEqual({ place: 'nav.plan', page: 'nav.crumbReplan' });
    // Every stage of the plan flow is the one place.
    for (const name of ['plan', 'plan-session', 'plan-scope', 'plan-schedule']) {
      expect(crumbFor(name)).toEqual({ place: 'nav.plan', page: null });
    }
    expect(crumbFor('settings')).toEqual({ place: 'nav.settings', page: null });
    const named = routes.flatMap((route) => (typeof route.name === 'string' && route.name !== 'login' ? [route.name] : []));
    expect(named.filter((name) => crumbFor(name) === null)).toEqual([]);
    // Names the app had before are no longer routes (negative).
    for (const gone of ['today', 'inbox', 'projects', 'tracker', 'commitments', 'availability', 'ai-settings', 'patterns']) {
      expect(crumbFor(gone), gone).toBeNull();
      expect(navItemFor(gone), gone).toBeNull();
    }
    expect(crumbFor('login')).toBeNull();
    expect(crumbFor(undefined)).toBeNull();
    expect(crumbFor(Symbol('x'))).toBeNull();
  });

  it('links only to routes that exist, each once, and no route has two places', () => {
    const router = shellRouter();
    expect(NAV_ITEMS).toEqual([...NAV_PLACES, NAV_SETTINGS]);
    expect(new Set(NAV_ITEMS.map((item) => item.to)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      expect(router.resolve(item.to).name, item.to).toBe(item.routes[0]);
      for (const name of item.routes) expect(router.hasRoute(name), name).toBe(true);
    }
    const owned = NAV_ITEMS.flatMap((item) => item.routes);
    expect(new Set(owned).size).toBe(owned.length);
    const first = NAV_PLACES[0];
    if (first === undefined) throw new Error('no places');
    expect(isNavItemCurrent(first, 'overview')).toBe(true);
    expect(isNavItemCurrent(first, 'tasks')).toBe(false);
    expect(isNavItemCurrent(first, undefined)).toBe(false);
  });

  it('opens the app on 개요: `/` and an unknown address go to the dashboard', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('overview');
    await router.push('/no/such/screen');
    expect(router.currentRoute.value.name).toBe('overview');
    // Not everything goes there (negative): a known address stays itself.
    await router.push('/tasks');
    expect(router.currentRoute.value.name).toBe('tasks');
  });

  it('sends every old address to its new home, with what it carried', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    for (const [old, home] of [
      ['/today', '/overview'],
      ['/inbox', '/tasks'],
      ['/projects', '/tasks'],
      ['/commitments', '/planner?view=list'],
      ['/tracker', '/focus'],
      ['/settings/layout', '/settings/display'],
      ['/patterns', '/insights'],
      ['/plans/new?taskIds=a,b', '/plan/schedule?taskIds=a,b'],
      ['/plan/new', '/plan'],
    ] as const) {
      await router.push(old);
      expect(router.currentRoute.value.fullPath, old).toBe(home);
    }
    // The addresses of the settings sections are the ones they always had.
    for (const [path, section] of [
      ['/settings', undefined],
      ['/settings/availability', 'availability'],
      ['/settings/calendar?google=connected', 'calendar'],
      ['/settings/ai', 'ai'],
    ] as const) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('settings');
      expect(router.currentRoute.value.params['section'] || undefined, path).toBe(section);
    }
    expect(router.currentRoute.value.fullPath).toBe('/settings/ai');
    await router.push('/settings/calendar?google=connected');
    expect(router.currentRoute.value.query['google']).toBe('connected');
    // A section that does not exist is not a settings address (negative).
    await router.push('/settings/nope');
    expect(router.currentRoute.value.name).toBe('overview');
  });
});

describe('top bar', () => {
  it('says where you are: the place, and the screen under it', async () => {
    const { wrapper, router } = await mountShell('/overview');
    const spoken = () => wrapper.get('[data-crumb] .visually-hidden').text();
    const seen = () => wrapper.findAll('[data-crumb] [aria-hidden="true"]').map((part) => part.text());
    expect(spoken()).toBe('현재 위치: 개요');
    expect(seen()).toEqual(['개요']);
    await router.push('/settings/ai');
    await nextTick();
    expect(spoken()).toBe('현재 위치: 설정');
    expect(seen()).toEqual(['설정']);
    await router.push('/tasks/01900000-0000-7000-8000-000000000011');
    await nextTick();
    expect(spoken()).toBe('현재 위치: 할 일 · 작업');
    expect(seen()).toEqual(['할 일', '/', '작업']);
    // The bar is a header, not a third navigation landmark, and holds no page heading.
    expect(wrapper.findAll('nav')).toHaveLength(2);
    expect(wrapper.get('.app-topbar').element.tagName).toBe('HEADER');
    expect(wrapper.find('.app-topbar h1').exists()).toBe(false);
  });

  it('opens the notifications panel and shows that something is unread', async () => {
    const { wrapper, pinia } = await mountShell();
    const bell = wrapper.get('.topbar-bell');
    // The mock has one delivered notification that is still listed.
    await vi.waitFor(() => expect(bell.attributes('data-unread')).toBe('1'));
    expect(bell.attributes('aria-label')).toBe('알림 · 읽지 않은 알림 1개');
    expect(bell.find('.topbar-dot').exists()).toBe(true);
    await bell.trigger('click');
    expect(useUiStore(pinia).notificationsOpen).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"][aria-labelledby="notifications-title"]')).not.toBeNull());
  });

  it('shows no dot when nothing is unread (negative)', async () => {
    for (const item of mockDb.notifications.values()) mockDb.notifications.set(item.id, { ...item, state: 'dismissed' });
    const { wrapper } = await mountShell();
    await flushPromises();
    const bell = wrapper.get('.topbar-bell');
    expect(bell.attributes('data-unread')).toBeUndefined();
    expect(bell.attributes('aria-label')).toBe('알림');
    expect(bell.find('.topbar-dot').exists()).toBe(false);
  });

  it('names the user; the account menu holds the theme, 설정 and sign-out, in glass', async () => {
    const { wrapper, pinia, router } = await mountShell();
    const auth = useAuthStore(pinia);
    const logout = vi.spyOn(auth, 'logout').mockResolvedValue();
    const button = wrapper.get('[data-user-menu]');
    expect(button.text()).toContain('planner');
    expect(button.attributes('aria-label')).toBe('planner 계정 메뉴');
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(false);
    // The theme is not on the bar itself any more (negative).
    expect(wrapper.find('.theme-switch').exists()).toBe(false);

    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    const menu = wrapper.get('#topbar-user-menu');
    expect(menu.classes()).toEqual(expect.arrayContaining(['menu', 'glass']));
    expect(menu.text()).toContain('planner@example.test');

    // The theme: three words, the one in use pressed.
    const pressed = () =>
      wrapper.findAll('.theme-switch [data-theme-choice]').map((item) => [item.attributes('data-theme-choice'), item.attributes('aria-pressed')]);
    expect(wrapper.get('.theme-switch').attributes('aria-label')).toBe('테마');
    expect(wrapper.findAll('.theme-switch [data-theme-choice]').map((item) => item.text())).toEqual(['라이트', '다크', '시스템']);
    expect(pressed()).toEqual([['light', 'false'], ['dark', 'true'], ['system', 'false']]);
    await wrapper.get('[data-theme-choice="light"]').trigger('click');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.dataset['scheme']).toBe('light');
    expect(pressed()).toEqual([['light', 'true'], ['dark', 'false'], ['system', 'false']]);
    expect(localStorage.getItem(themePrefKey(mockDb.user.id))).toBe('light');
    await wrapper.get('[data-theme-choice="system"]').trigger('click');
    expect(document.documentElement.dataset['theme']).toBe('system');
    expect(pressed()).toEqual([['light', 'false'], ['dark', 'false'], ['system', 'true']]);

    // Escape closes the menu and gives the focus back to its button.
    await wrapper.get('.topbar-user').trigger('keydown', { key: 'Escape' });
    await nextTick();
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(button.element);

    // 설정 opens the one settings screen and the menu steps away.
    await button.trigger('click');
    expect(wrapper.get('[data-user-settings]').attributes('href')).toBe('/settings');
    await wrapper.get('[data-user-settings]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('settings'));
    await nextTick();
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(false);

    await button.trigger('click');
    await wrapper.get('[data-user-sign-out]').trigger('click');
    expect(logout).toHaveBeenCalledTimes(1);
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(false);
  });
});

describe('shortcuts', () => {
  it('o, t, p, m and f open 개요, 할 일, 계획, 플래너 and 집중', async () => {
    const { router } = await mountShell('/notes');
    for (const [key, name] of [
      ['o', 'overview'],
      ['t', 'tasks'],
      ['p', 'plan'],
      ['m', 'planner'],
      ['f', 'focus-home'],
    ] as const) {
      press(key);
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe(name));
    }
  });

  it('f opens the session that is running, and is the timer’s own key on the timer', async () => {
    const { router, pinia } = await mountShell('/overview');
    const session = await plannerClient.createSession(
      { taskId: TODAY_TASK_ONE_ID, clientStartedAt: new Date().toISOString(), clientId: 'shell-test' },
      newActionId('session'),
    );
    useSessionStore(pinia).remember(session);
    press('f');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(`/focus/${session.id}`));
    // On the timer the shell leaves the key alone (negative).
    press('f');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(`/focus/${session.id}`);
  });

  it('n opens the capture bar on any screen, / opens it as the search, and neither leaves the page', async () => {
    const { wrapper, router, pinia } = await mountShell('/planner');
    const ui = useUiStore(pinia);
    // The bar is in the top bar on every screen.
    expect(wrapper.find('.app-topbar [data-capture]').exists()).toBe(true);
    press('n');
    expect(ui.captureRequest).toBe(1);
    expect(ui.captureMode).toBe('capture');
    expect(router.currentRoute.value.name).toBe('planner');
    // jsdom has no wide viewport: the request opens the same bar as a sheet.
    await vi.waitFor(() => expect(document.querySelector('[data-capture-sheet]')).not.toBeNull());
    const sheet = document.querySelector('[data-capture-sheet]');
    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(sheet?.classList.contains('glass')).toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(sheet?.querySelector('[data-capture-input]')));
    ui.setCaptureSheet(false);
    await vi.waitFor(() => expect(document.querySelector('[data-capture-sheet]')).toBeNull());

    press('/');
    expect(ui.captureRequest).toBe(2);
    expect(ui.captureMode).toBe('search');
    await vi.waitFor(() => expect(document.querySelector('[data-capture-sheet] [data-capture-search]')).not.toBeNull());
  });

  it('on a wide window the bar in the top bar takes the focus instead of a sheet', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 1024px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { wrapper, pinia } = await mountShell('/planner');
    press('n');
    const field = wrapper.get('.app-topbar [data-capture-input]');
    await vi.waitFor(() => expect(document.activeElement).toBe(field.element));
    expect(useUiStore(pinia).captureSheetOpen).toBe(false);
    expect(document.querySelector('[data-capture-sheet]')).toBeNull();
    expect(wrapper.find('.app-topbar [data-capture-panel]').exists()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('Ctrl+K opens the capture bar even from a field; ? opens help', async () => {
    const { wrapper, pinia } = await mountShell('/overview');
    const ui = useUiStore(pinia);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(ui.captureRequest).toBe(1);
    // Other chords are not ours (negative).
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
    expect(ui.captureRequest).toBe(1);
    input.remove();
    await vi.waitFor(() => expect(ui.captureSheetOpen).toBe(true));
    // Under the open sheet the single keys are the sheet's (negative).
    press('?');
    expect(ui.helpOpen).toBe(false);
    ui.setCaptureSheet(false);
    await nextTick();

    press('?');
    expect(ui.helpOpen).toBe(true);
    await nextTick();
    // The help dialog lists the places' keys from the same list the sidebar reads.
    const help = document.querySelector('[role="dialog"][aria-labelledby="help-title"]');
    const rows = [...(help?.querySelectorAll('dt') ?? [])].map((term) => [
      term.textContent?.replace(/\s+/g, ' ').trim(),
      term.nextElementSibling?.textContent?.trim(),
    ]);
    expect(rows).toEqual([
      ['n', '담기 · 할 일이나 약속 적기'],
      ['Ctrl K', '담기 · 입력 중에도'],
      ['o', '개요'],
      ['t', '할 일'],
      ['p', '계획'],
      ['m', '플래너'],
      ['f', '집중'],
      ['/', '검색'],
      ['?', '이 도움말'],
      ['Esc', '대화상자 닫기'],
    ]);
    void wrapper;
  });

  it('does nothing while typing, with a modifier, or under an open dialog (negative)', async () => {
    const { router, pinia } = await mountShell('/notes');
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('o', input);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true }));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('notes');

    useUiStore(pinia).openHelp();
    press('m');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('notes');
    input.remove();
  });
});

describe('phone navigation', () => {
  it('keeps five slots: the first places of the loop, 담기 and 더 보기', async () => {
    const { wrapper, router, pinia } = await mountShell('/overview');
    const bar = wrapper.get('.bottom-nav');
    expect(bar.attributes('aria-label')).toBe('주 메뉴');
    const slots = bar.findAll('a, button').map((item) => item.attributes('aria-label') ?? item.text());
    expect(slots).toEqual(['개요', '할 일', '담기', '계획', '더 보기']);
    // 담기 opens the capture bar as a sheet, from any screen.
    await bar.get('[data-nav-capture]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('[data-capture-sheet]')).not.toBeNull());
    useUiStore(pinia).setCaptureSheet(false);
    await nextTick();
    expect(BOTTOM_BAR_PLACES.map((item) => item.id)).toEqual(['overview', 'tasks', 'plan']);
    const current = () => bar.findAll('.bottom-nav-item--current').map((item) => item.text());
    expect(current()).toEqual(['개요']);
    expect(bar.get('[aria-current="page"]').text()).toBe('개요');
    // A screen under a place marks the place.
    await router.push('/replan');
    await nextTick();
    expect(current()).toEqual(['계획']);
  });

  it('lists the rest of the places in the 더 보기 sheet and marks 더 보기 while on one', async () => {
    const { wrapper, router } = await mountShell('/planner');
    const more = wrapper.get('.bottom-nav [data-nav-more]');
    expect(more.classes()).toContain('bottom-nav-item--current');
    await more.trigger('click');
    await nextTick();
    const sheet = wrapper.get('[role="dialog"][aria-labelledby="more-sheet-title"]');
    const links = sheet.findAll('a.nav-link').map((link) => link.text());
    expect(links).toEqual(['플래너', '집중', '분석', '노트', '설정']);
    expect(links).toHaveLength(MORE_LINKS.length);
    expect(sheet.get('a.nav-link[aria-current="page"]').text()).toBe('플래너');
    // What the bar holds itself is not repeated in the sheet (negative).
    for (const held of ['개요', '할 일', '계획']) expect(links).not.toContain(held);
    expect(MORE_LINKS.some((link) => BOTTOM_BAR_PLACES.includes(link))).toBe(false);
    expect(sheet.findAll('button').map((button) => button.text())).toEqual(
      expect.arrayContaining(['알림', '검색', '도움말', '로그아웃']),
    );

    await sheet.get('a.nav-link[href="/focus"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus-home'));
  });

  it('on a phone the top bar’s mark opens 개요', async () => {
    const { wrapper } = await mountShell('/tasks');
    const brand = wrapper.get('.topbar-brand');
    expect(brand.attributes('href')).toBe('/overview');
    expect(brand.attributes('aria-label')).toBe('OhMyDate 홈');
  });
});
