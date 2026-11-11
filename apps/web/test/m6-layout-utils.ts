import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import App from '../src/App.vue';
import { newActionId, plannerClient, type WorkSession } from '../src/api';
import { setLayoutClock } from '../src/layout/clock';
import { TODAY_BLOCK_ONE_ID, TODAY_TASK_ONE_ID, mockDb } from '../src/mocks/db';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { routes } from '../src/router';
import { useSessionStore } from '../src/stores/session';

/** Mock "today" is 2026-11-14 in Asia/Seoul; 18:40 there, before the review window. */
export const BEFORE_REVIEW = Date.parse('2026-11-14T09:40:00.000Z');
/** 20:30 in Asia/Seoul: inside the review window. */
export const IN_REVIEW_WINDOW = Date.parse('2026-11-14T11:30:00.000Z');

export interface TestClock {
  now(): number;
  set(value: number): void;
  advance(ms: number): void;
}

export function useTestClock(start = BEFORE_REVIEW): TestClock {
  let value = start;
  const clock: TestClock = {
    now: () => value,
    set: (next) => {
      value = next;
    },
    advance: (ms) => {
      value += ms;
    },
  };
  setLayoutClock(clock);
  return clock;
}

export interface MountedApp {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
  readonly queryClient: QueryClient;
}

export async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

/** The real App (AppShell + adaptive frame + views) on a memory router and the MSW mock API. */
export async function mountApp(path: string, prepare?: (pinia: Pinia) => void | Promise<void>): Promise<MountedApp> {
  // The signed-in mock owner, so stores created before mount already use it.
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  const pinia = createPinia();
  await prepare?.(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  const queryClient = new QueryClient();
  const wrapper = mount(App, {
    global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] },
    attachTo: document.body,
  });
  await router.isReady();
  await vi.waitFor(() => expect(wrapper.find('.adaptive-frame, .page').exists()).toBe(true));
  await settle();
  return { wrapper, router, pinia, queryClient };
}

export function modeOf(wrapper: VueWrapper): string | undefined {
  return wrapper.find('.adaptive-frame').attributes('data-layout-mode');
}

/** Components per region, in order, as rendered. */
export function regionsOf(wrapper: VueWrapper): Record<string, string[]> {
  const result: Record<string, string[]> = { primary: [], secondary: [], tertiary: [] };
  for (const region of wrapper.findAll('[data-layout-region]')) {
    const name = region.attributes('data-layout-region') ?? '';
    result[name] = region.findAll('[data-layout-item]').map((item) => item.attributes('data-layout-item') ?? '');
  }
  return result;
}

export function button(
  root: { findAll(selector: string): Pick<DOMWrapper<Element>, 'text' | 'trigger'>[] },
  label: string,
): Pick<DOMWrapper<Element>, 'text' | 'trigger'> {
  const found = root.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

export function bodyButton(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

export function announcement(wrapper: VueWrapper): string {
  return wrapper.find('[data-layout-announcer]').text();
}

export async function startedSession(pinia: Pinia): Promise<WorkSession> {
  const session = await plannerClient.createSession(
    {
      taskId: TODAY_TASK_ONE_ID,
      blockId: TODAY_BLOCK_ONE_ID,
      clientStartedAt: new Date(BEFORE_REVIEW).toISOString(),
      clientId: 'layout-test',
    },
    newActionId('session'),
  );
  useSessionStore(pinia).remember(session);
  return session;
}
