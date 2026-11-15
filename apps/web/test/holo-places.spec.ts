/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DisplaySettings from '../src/components/settings/DisplaySettings.vue';
import { plannerLocation, plannerQueryFix, plannerViewOf, PLANNER_VIEWS } from '../src/domain/plannerRoute';
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, settingsSectionOf } from '../src/domain/settings';
import { focusRouteSessionId, routeKindOf, workspacePathFor } from '../src/layout/routes';
import { mockDb } from '../src/mocks/db';
import { routes } from '../src/router';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { OWNER_STORAGE_MANIFEST } from '../src/session/ownerStorage';
import { useAuthStore } from '../src/stores/auth';
import { resetThemeForTests, themePrefKey } from '../src/theme/theme';
import {
  bootTransparency,
  readTransparencyReduced,
  resetTransparencyForTests,
  transparencyPrefKey,
  useTransparency,
  writeTransparencyReduced,
} from '../src/theme/transparency';
import SettingsView from '../src/views/SettingsView.vue';
import TasksView from '../src/views/TasksView.vue';

/**
 * HOLO-04 places (FLOW.md §4): 할 일 as one place (HOLO-05: its canvas and its list), 설정 as one
 * screen with four sections (with the glass switch of 화면), the planner's
 * fourth view in the address, and 개요 as the daily workspace's own page.
 */
const OWNER_A = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
const OWNER_B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';
const root = document.documentElement;
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

/** The app's own addresses with stub screens, except the one under test. */
function placeRouter(real: Record<string, unknown>): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes.map((route) =>
      typeof route.name === 'string' && route.name in real
        ? { ...route, component: real[route.name] as never }
        : 'redirect' in route
          ? route
          : { ...route, component: Stub },
    ) as never,
  });
}

async function mountAt(view: unknown, name: string, path: string): Promise<{ wrapper: VueWrapper; router: Router; pinia: Pinia }> {
  const router = placeRouter({ [name]: view });
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  const wrapper = mount(view as never, { global: { plugins: [pinia, VueQueryPlugin, router] as never }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, router, pinia };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  resetThemeForTests();
  resetTransparencyForTests();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  resetThemeForTests();
  resetTransparencyForTests();
  adoptActiveOwner(null, 'bootstrap');
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('할 일 — one place, the canvas and the list', () => {
  it('opens on the canvas, and the address picks the list', async () => {
    const { wrapper, router } = await mountAt(TasksView, 'tasks', '/tasks');
    const place = wrapper.get('[data-tasks-place]');
    expect(place.attributes('data-tasks-view')).toBe('canvas');
    await vi.waitFor(() => expect(wrapper.find('[data-todo-canvas]').exists()).toBe(true));
    expect(wrapper.find('[data-tasks-list]').exists()).toBe(false);
    // The switch names the two views; the one on show is the current page.
    const links = wrapper.findAll('[data-tasks-view-link]');
    expect(wrapper.get('.tasks-views').attributes('aria-label')).toBe('할 일 보기');
    expect(links.map((link) => [link.text(), link.attributes('href'), link.attributes('aria-current')])).toEqual([
      ['캔버스', '/tasks', 'page'],
      ['목록', '/tasks?view=list', undefined],
    ]);
    // One page heading: the place's own, whichever view is on show.
    expect(wrapper.findAll('h1').map((heading) => heading.text())).toEqual(['할 일']);

    await router.push('/tasks?view=list');
    await vi.waitFor(() => expect(wrapper.find('[data-tasks-list]').exists()).toBe(true));
    expect(place.attributes('data-tasks-view')).toBe('list');
    expect(wrapper.find('[data-todo-canvas]').exists()).toBe(false);
    expect(wrapper.get('[data-tasks-view-link="list"]').attributes('aria-current')).toBe('page');
    expect(wrapper.findAll('h1').map((heading) => heading.text())).toEqual(['할 일']);
    await vi.waitFor(() => expect(wrapper.find('[data-inbox]').exists()).toBe(true));
  });

  it('a view it does not know is the canvas (negative)', async () => {
    const { wrapper } = await mountAt(TasksView, 'tasks', '/tasks?view=board');
    expect(wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('canvas');
  });

  it('the old addresses of both screens land in it', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/inbox');
    expect(router.currentRoute.value.fullPath).toBe('/tasks');
    // The project list is gone: folders are on the canvas, which is where its address leads.
    await router.push('/projects');
    expect(router.currentRoute.value.fullPath).toBe('/tasks');
    // A project and a task keep their own addresses, under the place.
    expect(router.resolve('/projects/01900000-0000-7000-8000-000000000003').name).toBe('project');
    expect(router.resolve('/tasks/01900000-0000-7000-8000-000000000011').name).toBe('task');
  });
});

describe('설정 — one screen, four sections', () => {
  it('names the four sections and opens the first without one in the address', async () => {
    const { wrapper } = await mountAt(SettingsView, 'settings', '/settings');
    expect(wrapper.findAll('h1').map((heading) => heading.text())).toEqual(['설정']);
    expect(wrapper.get('.settings-sections').attributes('aria-label')).toBe('설정 구역');
    expect(wrapper.findAll('[data-settings-link]').map((link) => [link.text(), link.attributes('href')])).toEqual([
      ['가용 시간', '/settings/availability'],
      ['캘린더 연동', '/settings/calendar'],
      ['AI', '/settings/ai'],
      ['화면', '/settings/display'],
    ]);
    expect(SETTINGS_SECTIONS).toEqual(['availability', 'calendar', 'ai', 'display']);
    expect(wrapper.get('[data-settings]').attributes('data-settings-section')).toBe(DEFAULT_SETTINGS_SECTION);
    expect(wrapper.get('[data-settings-link="availability"]').attributes('aria-current')).toBe('page');
    expect(wrapper.find('[data-settings-availability]').exists()).toBe(true);
  });

  it('shows one section at a time, each under its own h2', async () => {
    const { wrapper, router } = await mountAt(SettingsView, 'settings', '/settings/ai');
    expect(wrapper.find('[data-settings-ai]').exists()).toBe(true);
    expect(wrapper.find('[data-settings-availability]').exists()).toBe(false);
    expect(wrapper.get('[data-settings-ai] h2').text()).toBe('AI 설정');
    expect(wrapper.findAll('[data-settings-link][aria-current="page"]').map((link) => link.text())).toEqual(['AI']);

    for (const [section, hook, title] of [
      ['calendar', '[data-settings-calendar]', '캘린더 연동'],
      ['display', '[data-settings-display]', '화면'],
      ['availability', '[data-settings-availability]', '가용 시간'],
    ] as const) {
      await router.push(`/settings/${section}`);
      await flushPromises();
      expect(wrapper.get('[data-settings]').attributes('data-settings-section')).toBe(section);
      expect(wrapper.get(`${hook} h2`).text()).toBe(title);
      expect(wrapper.findAll('.settings-section')).toHaveLength(1);
      expect(wrapper.findAll('h1')).toHaveLength(1);
    }
  });

  it('reads a section only from the names it has (negative)', () => {
    expect(settingsSectionOf('calendar')).toBe('calendar');
    expect(settingsSectionOf(['ai'])).toBe('ai');
    for (const other of [undefined, '', 'layout', 'nope', 3, null]) expect(settingsSectionOf(other)).toBe('availability');
  });

  it('keeps what the Google sign-in brings back when it lands on its section', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/settings/calendar?google=connected');
    expect(router.currentRoute.value.name).toBe('settings');
    expect(router.currentRoute.value.params['section']).toBe('calendar');
    expect(router.currentRoute.value.query).toEqual({ google: 'connected' });
  });
});

describe('설정 › 화면 — the theme, the glass and the layout', () => {
  async function mountDisplay(): Promise<VueWrapper> {
    const wrapper = mount(DisplaySettings, { global: { plugins: [createPinia()] }, attachTo: document.body });
    mounted.push(wrapper);
    await nextTick();
    return wrapper;
  }

  it('holds the theme switch: three choices, the one in use pressed', async () => {
    const wrapper = await mountDisplay();
    const choices = () => wrapper.findAll('[data-display-theme] [data-theme-choice]').map((item) => [item.text(), item.attributes('aria-pressed')]);
    expect(choices()).toEqual([['라이트', 'false'], ['다크', 'true'], ['시스템', 'false']]);
    await wrapper.get('[data-theme-choice="light"]').trigger('click');
    expect(root.dataset['scheme']).toBe('light');
    expect(choices()).toEqual([['라이트', 'true'], ['다크', 'false'], ['시스템', 'false']]);
    expect(localStorage.getItem(themePrefKey(mockDb.user.id))).toBe('light');
  });

  it('투명 효과 줄이기 puts the request on the root, says so, and remembers it for this owner', async () => {
    const wrapper = await mountDisplay();
    const toggle = wrapper.get<HTMLInputElement>('[data-display-transparency]');
    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.element.checked).toBe(false);
    expect(root.dataset['transparency']).toBeUndefined();

    await toggle.setValue(true);
    expect(root.dataset['transparency']).toBe('reduce');
    expect(localStorage.getItem(transparencyPrefKey(mockDb.user.id))).toBe('reduce');
    expect(wrapper.get('[role="status"]').text()).toBe('투명 효과를 줄였어요.');

    await toggle.setValue(false);
    expect(root.dataset['transparency']).toBeUndefined();
    expect(localStorage.getItem(transparencyPrefKey(mockDb.user.id))).toBeNull();
    expect(wrapper.get('[role="status"]').text()).toBe('유리 효과를 켰어요.');
  });

  it('keeps the layout switch and its lock (the hooks the layout tests use)', async () => {
    const wrapper = await mountDisplay();
    expect(wrapper.get<HTMLInputElement>('[data-layout-auto]').element.checked).toBe(true);
    expect(wrapper.get('[data-layout-lock-status]').text()).toContain('고정');
    expect(wrapper.find('details.settings-fold ol.layout-order').exists()).toBe(true);
  });
});

describe('투명 효과 줄이기 is remembered per owner', () => {
  beforeEach(() => {
    adoptActiveOwner(OWNER_A, 'bootstrap');
  });

  it('brings the choice back on a fresh page for the same owner', () => {
    bootTransparency();
    expect(useTransparency().setReduced(true)).toBe(true);
    expect(transparencyPrefKey(OWNER_A)).toBe(`ohmydate.transparency:${OWNER_A}`);
    resetTransparencyForTests();
    expect(root.dataset['transparency']).toBeUndefined();
    bootTransparency();
    expect(root.dataset['transparency']).toBe('reduce');
    expect(useTransparency().reduced.value).toBe(true);
  });

  it('never shows one owner the other one’s choice (negative)', () => {
    bootTransparency();
    useTransparency().setReduced(true);
    expect(readTransparencyReduced(OWNER_B)).toBe(false);
    // Another user signs in on this page: glass again, their own default…
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect(root.dataset['transparency']).toBeUndefined();
    // …and the first owner's choice is still theirs.
    adoptActiveOwner(OWNER_A, 'bootstrap');
    expect(root.dataset['transparency']).toBe('reduce');
  });

  it('a write under a stale owner binding stores nothing (negative)', () => {
    const stale = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect(writeTransparencyReduced(stale, true)).toBe(false);
    expect(localStorage.getItem(transparencyPrefKey(OWNER_A))).toBeNull();
    expect(localStorage.getItem(transparencyPrefKey(OWNER_B))).toBeNull();
  });

  it('goes through the owner-scoped storage module only: a declared slot, no storage API of its own', () => {
    expect(OWNER_STORAGE_MANIFEST.ownerSlots.transparencyPref).toMatchObject({
      area: 'local',
      prefix: 'ohmydate.transparency',
      staleWrites: 'drop',
      onOwnerChange: 'preserve',
    });
    const file = [resolve(process.cwd(), 'src/theme/transparency.ts'), resolve(process.cwd(), 'apps/web/src/theme/transparency.ts')].find((path) => existsSync(path));
    const source = readFileSync(file ?? '', 'utf8');
    expect(source).toContain("ownerSlot('transparencyPref')");
    expect(/\b(localStorage|sessionStorage|indexedDB)\b/.test(source)).toBe(false);
  });
});

describe('플래너 — the 약속 view in the address', () => {
  const TODAY = '2026-11-14';

  it('is the fourth view and keeps its week like the week view', () => {
    expect(PLANNER_VIEWS).toEqual(['day', 'week', 'month', 'list']);
    expect(plannerViewOf('planner', { view: 'list' })).toBe('list');
    expect(plannerLocation('list', TODAY, TODAY)).toEqual({ name: 'planner', query: { view: 'list' } });
    expect(plannerLocation('list', '2026-11-18', TODAY)).toEqual({ name: 'planner', query: { view: 'list', w: '2026-11-16' } });
    // From the list back to the week of the same days.
    expect(plannerLocation('week', '2026-11-16', TODAY)).toEqual({ name: 'planner', query: { w: '2026-11-16' } });
  });

  it('corrects a week it cannot mean, and is never the month page’s view (negative)', () => {
    expect(plannerQueryFix('planner', { view: 'list', w: '2026-11-18' })).toEqual({ drop: [], set: { w: '2026-11-16' } });
    expect(plannerQueryFix('planner', { view: 'list', w: 'soon' })).toEqual({ drop: ['w'], set: {} });
    expect(plannerQueryFix('planner', { view: 'list' })).toBeNull();
    expect(plannerViewOf('month', { view: 'list' })).toBe('month');
  });
});

describe('개요 is the daily workspace’s page', () => {
  const SESSION = '01900000-0000-7000-8000-000000000599';

  it('takes the place 오늘 had in the adaptive layout', () => {
    expect(routeKindOf({ name: 'overview', params: {} })).toBe('today');
    expect(routeKindOf({ name: 'focus', params: { sessionId: SESSION } })).toBe('focus');
    // 집중's own place (the timer and its record) is not a layout surface, and 오늘 is no route any more (negative).
    expect(routeKindOf({ name: 'focus-home', params: {} })).toBe('other');
    expect(routeKindOf({ name: 'today', params: {} })).toBe('other');
    expect(focusRouteSessionId({ name: 'focus-home', params: {} })).toBeNull();
  });

  it('the workspace goes back to /overview when the page is not the timer', () => {
    const spec = (component: 'TodayPlan' | 'FocusTimer') =>
      ({
        mode: component === 'FocusTimer' ? 'focus' : 'overview',
        regions: { primary: [component === 'FocusTimer' ? { component, props: { sessionId: SESSION } } : { component }], secondary: [], tertiary: [] },
        pinned: ['NavRail', 'BottomNav'],
        reason: 'default',
        policyVersion: 'test',
      }) as never;
    expect(workspacePathFor(spec('TodayPlan'), 'today')).toBe('/overview');
    expect(workspacePathFor(spec('FocusTimer'), 'today')).toBe(`/focus/${SESSION}`);
    expect(workspacePathFor(spec('TodayPlan'), 'planning')).toBeNull();
  });
});
