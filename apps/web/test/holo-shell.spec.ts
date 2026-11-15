import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../src/components/AppShell.vue';
import { BOTTOM_BAR_ROUTES, MORE_LINKS, NAV_GROUPS, crumbFor, isNavItemCurrent } from '../src/layout/navigation';
import { readNavCollapsed, shellNavKey, writeNavCollapsed } from '../src/layout/shellNav';
import { mockDb } from '../src/mocks/db';
import { routes } from '../src/router';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useUiStore } from '../src/stores/ui';
import { resetThemeForTests, themePrefKey } from '../src/theme/theme';

/**
 * HOLO-01 shell: the sidebar (groups, current item, fold remembered per
 * owner), the top bar (breadcrumb, theme, notifications, account), the single
 * key shortcuts and the phone's bottom nav.
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

async function mountShell(path = '/today'): Promise<Shell> {
  const router = shellRouter();
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  const wrapper = mount(AppShell, {
    global: { plugins: [pinia, router] },
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
  it('lists the groups and their screens in order, 개요 first', async () => {
    const { wrapper } = await mountShell();
    const groups = wrapper.findAll('.nav-rail [data-nav-group]').map((group) => ({
      id: group.attributes('data-nav-group'),
      label: group.get('.nav-group-label').text(),
      items: group.findAll('.nav-link-label').map((label) => label.text()),
    }));
    expect(groups).toEqual([
      { id: 'main', label: '메인', items: ['개요', '오늘', '타임 트래커', '플래너', '인박스', '프로젝트', '노트'] },
      // HOLO-03A: the plan flow is one entry (it was 계획 세우기 + 일정안 만들기); 내 패턴 is AI 분석.
      { id: 'planning', label: '계획', items: ['계획 세우기', '재계획', '약속', '가용 시간'] },
      { id: 'ai', label: '분석', items: ['AI 분석'] },
      { id: 'settings', label: '설정', items: ['캘린더 연동', 'AI 설정', '레이아웃'] },
    ]);
    expect(wrapper.findAll('.nav-rail .nav-secondary .nav-link-label').map((label) => label.text())).toEqual([
      '검색',
      '도움말',
      '로그아웃',
    ]);
    // Every item has its line icon again, and the shortcuts are shown.
    expect(wrapper.findAll('.nav-rail .nav-groups .nav-link').every((link) => link.find('svg.nav-link-icon').exists())).toBe(true);
    expect(wrapper.findAll('.nav-rail .nav-groups kbd').map((key) => key.text())).toEqual(['o', 't', 'm', 'p']);
    // The brand opens 개요; 새 작업 stays reachable with its key.
    expect(wrapper.get('.nav-brand').attributes('href')).toBe('/overview');
    expect(wrapper.get('.nav-new-task').text()).toContain('새 작업');
    expect(wrapper.get('.nav-new-task kbd').text()).toBe('n');
  });

  it('marks exactly the current screen, also from a screen under it', async () => {
    const { wrapper, router } = await mountShell('/today');
    const current = () =>
      wrapper.findAll('.nav-rail [aria-current="page"]').map((link) => link.get('.nav-link-label').text());
    expect(current()).toEqual(['오늘']);
    expect(wrapper.findAll('.nav-rail .nav-link--current')).toHaveLength(1);

    await router.push('/projects/01900000-0000-7000-8000-000000000003');
    await nextTick();
    expect(current()).toEqual(['프로젝트']);

    await router.push('/overview');
    await nextTick();
    expect(current()).toEqual(['개요']);

    // A screen that is not in the sidebar marks nothing (negative).
    await router.push('/focus/01900000-0000-7000-8000-000000000599');
    await nextTick();
    expect(current()).toEqual([]);
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
  it('gives every routed screen a breadcrumb, and none to what it does not know (negative)', () => {
    expect(crumbFor('overview')).toEqual({ group: 'nav.groupMain', page: 'nav.overview' });
    expect(crumbFor('project')).toEqual({ group: 'nav.groupMain', page: 'nav.projects' });
    expect(crumbFor('plan-session')).toEqual({ group: 'nav.groupPlanning', page: 'nav.plan' });
    // HOLO-03A: every stage of the plan flow is under its one entry; 내 패턴 is AI 분석.
    expect(crumbFor('plan-schedule')).toEqual({ group: 'nav.groupPlanning', page: 'nav.plan' });
    expect(crumbFor('plan-scope')).toEqual({ group: 'nav.groupPlanning', page: 'nav.plan' });
    expect(crumbFor('insights')).toEqual({ group: 'nav.groupAi', page: 'nav.insights' });
    expect(crumbFor('patterns')).toBeNull();
    expect(crumbFor('focus')).toEqual({ group: 'nav.groupMain', page: 'nav.crumbFocus' });
    const named = routes.flatMap((route) => (typeof route.name === 'string' && route.name !== 'login' ? [route.name] : []));
    expect(named.filter((name) => crumbFor(name) === null)).toEqual([]);
    expect(crumbFor('login')).toBeNull();
    expect(crumbFor('nope')).toBeNull();
    expect(crumbFor(undefined)).toBeNull();
    expect(crumbFor(Symbol('x'))).toBeNull();
  });

  it('links only to routes that exist, each once', () => {
    const router = shellRouter();
    const items = NAV_GROUPS.flatMap((group) => group.items);
    expect(new Set(items.map((item) => item.to)).size).toBe(items.length);
    for (const item of items) {
      expect(router.resolve(item.to).name, item.to).toBe(item.routes[0]);
      for (const name of item.routes) expect(router.hasRoute(name), name).toBe(true);
    }
    const first = items[0];
    if (first === undefined) throw new Error('no nav items');
    expect(isNavItemCurrent(first, 'overview')).toBe(true);
    expect(isNavItemCurrent(first, 'today')).toBe(false);
    expect(isNavItemCurrent(first, undefined)).toBe(false);
  });

  // HOLO-02 (coordinator's addendum): the app opens on 개요. This replaces the
  // HOLO-01 test that kept `/` on the inbox.
  it('opens the app on 개요: `/` and an unknown address go to the dashboard, the inbox keeps its own route', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('overview');
    await router.push('/no/such/screen');
    expect(router.currentRoute.value.name).toBe('overview');
    // Not everything goes there (negative): a known address stays itself.
    await router.push('/inbox');
    expect(router.currentRoute.value.name).toBe('inbox');
    expect(router.resolve('/overview').name).toBe('overview');
  });
});

describe('top bar', () => {
  it('says where you are: group / screen', async () => {
    const { wrapper, router } = await mountShell('/today');
    const spoken = () => wrapper.get('[data-crumb] .visually-hidden').text();
    const seen = () => wrapper.findAll('[data-crumb] [aria-hidden="true"]').map((part) => part.text());
    expect(spoken()).toBe('현재 위치: 메인 · 오늘');
    expect(seen()).toEqual(['메인', '/', '오늘']);
    await router.push('/settings/ai');
    await nextTick();
    expect(spoken()).toBe('현재 위치: 설정 · AI 설정');
    expect(seen()).toEqual(['설정', '/', 'AI 설정']);
    // The bar is a header, not a third navigation landmark, and holds no page heading.
    expect(wrapper.findAll('nav')).toHaveLength(2);
    expect(wrapper.get('.app-topbar').element.tagName).toBe('HEADER');
    expect(wrapper.find('.app-topbar h1').exists()).toBe(false);
  });

  it('switches the theme and shows which one is on', async () => {
    const { wrapper } = await mountShell();
    const pressed = () =>
      wrapper.findAll('.theme-switch [data-theme-choice]').map((button) => [button.attributes('data-theme-choice'), button.attributes('aria-pressed')]);
    expect(wrapper.get('.theme-switch').attributes('aria-label')).toBe('테마');
    expect(wrapper.findAll('.theme-switch [data-theme-choice]').map((button) => button.text())).toEqual(['라이트', '다크', '시스템']);
    expect(pressed()).toEqual([['light', 'false'], ['dark', 'true'], ['system', 'false']]);

    await wrapper.get('[data-theme-choice="light"]').trigger('click');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.dataset['scheme']).toBe('light');
    expect(pressed()).toEqual([['light', 'true'], ['dark', 'false'], ['system', 'false']]);
    expect(localStorage.getItem(themePrefKey(mockDb.user.id))).toBe('light');

    await wrapper.get('[data-theme-choice="system"]').trigger('click');
    expect(document.documentElement.dataset['theme']).toBe('system');
    expect(pressed()).toEqual([['light', 'false'], ['dark', 'false'], ['system', 'true']]);
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

  it('names the user and signs out from the account menu', async () => {
    const { wrapper, pinia } = await mountShell();
    const auth = useAuthStore(pinia);
    const logout = vi.spyOn(auth, 'logout').mockResolvedValue();
    const button = wrapper.get('[data-user-menu]');
    expect(button.text()).toContain('planner');
    expect(button.attributes('aria-label')).toBe('planner 계정 메뉴');
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(false);

    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('#topbar-user-menu').text()).toContain('planner@example.test');

    // Escape closes the menu and gives the focus back to its button.
    await wrapper.get('.topbar-user').trigger('keydown', { key: 'Escape' });
    await nextTick();
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(button.element);

    await button.trigger('click');
    await wrapper.get('[data-user-sign-out]').trigger('click');
    expect(logout).toHaveBeenCalledTimes(1);
    expect(wrapper.find('#topbar-user-menu').exists()).toBe(false);
  });
});

describe('shortcuts', () => {
  // HOLO-02: the sidebar entry beside `m` is 플래너 now (the calendar screen, 일 · 주 · 월).
  // HOLO-03A: `p` opens 계획 세우기, the one way into the plan flow.
  it('o, t, m and p open 개요, 오늘, 플래너 and 계획 세우기', async () => {
    const { router } = await mountShell('/inbox');
    for (const [key, name] of [
      ['o', 'overview'],
      ['t', 'today'],
      ['m', 'planner'],
      ['p', 'plan'],
    ] as const) {
      press(key);
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe(name));
    }
  });

  it('n asks the inbox for a new task, / opens search and ? opens help', async () => {
    const { wrapper, router, pinia } = await mountShell('/today');
    const ui = useUiStore(pinia);
    press('n');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('inbox'));
    await vi.waitFor(() => expect(ui.newTaskRequest).toBe(1));

    press('/');
    expect(ui.searchOpen).toBe(true);
    ui.closeDialogs();
    press('?');
    expect(ui.helpOpen).toBe(true);
    await nextTick();
    // The help dialog lists the new key.
    const help = document.querySelector('[role="dialog"][aria-labelledby="help-title"]');
    expect(help?.textContent).toContain('개요');
    expect([...(help?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent)).toContain('o');
    void wrapper;
  });

  it('does nothing while typing, with a modifier, or under an open dialog (negative)', async () => {
    const { router, pinia } = await mountShell('/inbox');
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('o', input);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true }));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('inbox');

    useUiStore(pinia).openHelp();
    press('m');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('inbox');
    input.remove();
  });
});

describe('phone navigation', () => {
  it('keeps the five slots and their names', async () => {
    const { wrapper } = await mountShell('/today');
    const bar = wrapper.get('.bottom-nav');
    expect(bar.attributes('aria-label')).toBe('주 메뉴');
    const slots = bar.findAll('a, button').map((item) => item.attributes('aria-label') ?? item.text());
    expect(slots).toEqual(['오늘', '인박스', '새 작업', '계획', '더 보기']);
    expect(bar.findAll('.router-link-active').map((item) => item.text())).toEqual(['오늘']);
  });

  it('puts 개요 first in the 더 보기 sheet and marks 더 보기 while on it', async () => {
    const { wrapper, router } = await mountShell('/overview');
    const more = wrapper.findAll('.bottom-nav button').find((item) => item.text() === '더 보기');
    if (more === undefined) throw new Error('missing 더 보기');
    expect(more.classes()).toContain('router-link-active');
    await more.trigger('click');
    await nextTick();
    const sheet = wrapper.get('[role="dialog"][aria-labelledby="more-sheet-title"]');
    const links = sheet.findAll('a.nav-link').map((link) => link.text());
    expect(links[0]).toBe('개요');
    expect(links).toEqual([
      '개요',
      '타임 트래커',
      '플래너',
      '프로젝트',
      '노트',
      '재계획',
      '약속',
      '가용 시간',
      'AI 분석',
      '캘린더 연동',
      'AI 설정',
      '레이아웃',
    ]);
    expect(links).toHaveLength(MORE_LINKS.length);
    // What the bar holds itself is not repeated in the sheet (negative).
    expect(links).not.toContain('오늘');
    expect(links).not.toContain('인박스');
    expect(MORE_LINKS.some((link) => link.routes.some((name) => BOTTOM_BAR_ROUTES.has(name)))).toBe(false);
    expect(sheet.findAll('button').map((button) => button.text())).toEqual(
      expect.arrayContaining(['알림', '검색', '도움말', '로그아웃']),
    );

    await sheet.get('a.nav-link[href="/planner"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('planner'));
  });

  it('on a phone the top bar’s mark opens 개요', async () => {
    const { wrapper } = await mountShell('/today');
    const brand = wrapper.get('.topbar-brand');
    expect(brand.attributes('href')).toBe('/overview');
    expect(brand.attributes('aria-label')).toBe('OhMyDate 홈');
  });
});
