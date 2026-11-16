import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { HttpResponse, http } from 'msw';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, plannerClient } from '../src/api';
import AppShell from '../src/components/AppShell.vue';
import CaptureBar from '../src/components/capture/CaptureBar.vue';
import OverviewCard from '../src/components/overview/OverviewCard.vue';
import { retryFenced } from '../src/composables/notes';
import { retryTransient } from '../src/composables/usePlannerRange';
import { apiErrorMessage, errorMessage, problemMessage } from '../src/i18n/problem';
import { setLayoutClock } from '../src/layout/clock';
import { mockDb, seedMonth } from '../src/mocks/db';
import { seedNewOwner } from '../src/mocks/first-run-seed';
import { seedGoogle } from '../src/mocks/google';
import { server } from '../src/mocks/server';
import { useNotifications } from '../src/notifications/useNotifications';
import { DESKTOP_BUILD_MODE } from '../src/platform/mode';
import { NOT_READY_STATUS, anyNotReady, isNotReady } from '../src/platform/notReady';
import { routes } from '../src/router';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { OwnerChangedError } from '../src/session/ownerBound';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { createOwnerQueryClient } from '../src/session/ownerQuery';
import { useAuthStore } from '../src/stores/auth';
import InboxView from '../src/views/InboxView.vue';
import OverviewView from '../src/views/OverviewView.vue';
import TasksView from '../src/views/TasksView.vue';

/**
 * RC-10B: "this place is not ready" (src/platform/notReady.ts; blueprint 15
 * §1.4, §7.3). The Rust core serves nineteen operations today (RC-20 added
 * available hours, appointments and a day's events to the first twelve) and
 * answers 501 for the rest. In the desktop bundle a 501 is not retried, the place that
 * asked says so calmly, the start guide stays away, 개요 keeps its frame and
 * 할 일 works in full. In a server bundle a 501 is what it always was — every
 * rule has that negative beside it.
 *
 * `likeTheCore()` makes the mock answer the way the core does today.
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

function desktopBundle(): void {
  vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
}

function problem(status: number, code: string, title = 'x'): Response {
  return HttpResponse.json(
    { type: 'about:blank', title, status, code },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/**
 * What the core serves today (`handlers::table()` in core/crates/server, and
 * `CORE_SERVES` in e2e/helpers/driver.ts): method + path, without `/api/v1`.
 * Nineteen operations — the owner, projects and tasks (RC-00, RC-10A: twelve),
 * then available hours, appointments and a day's calendar events (RC-20: seven).
 */
const SERVED: readonly RegExp[] = [
  // getMe, updateMySettings
  /^GET \/me$/,
  /^PATCH \/me\/settings$/,
  // listProjects, createProject, updateProject
  /^(GET|POST) \/projects$/,
  /^PATCH \/projects\/[^/:]+$/,
  // listTasks, createTask, getTask, updateTask, deleteTask, completeTask, createTaskDependency
  /^(GET|POST) \/tasks$/,
  /^(GET|PATCH|DELETE) \/tasks\/[^/:]+$/,
  /^POST \/tasks\/[^/:]+:complete$/,
  /^POST \/tasks\/[^/:]+\/dependencies$/,
  // getAvailability, putAvailability
  /^(GET|PUT) \/availability$/,
  // listCommitments, createCommitment, updateCommitment, deleteCommitment
  /^(GET|POST) \/commitments$/,
  /^(PATCH|DELETE) \/commitments\/[^/:]+$/,
  // listCalendarDayEvents
  /^GET \/calendar-day-events$/,
];
/** One call of each served operation: the model above holds exactly these, and nothing of what is still to come. */
const SERVED_OPERATIONS: readonly string[] = [
  'GET /me',
  'PATCH /me/settings',
  'GET /projects',
  'POST /projects',
  'PATCH /projects/p1',
  'GET /tasks',
  'POST /tasks',
  'GET /tasks/t1',
  'PATCH /tasks/t1',
  'DELETE /tasks/t1',
  'POST /tasks/t1:complete',
  'POST /tasks/t1/dependencies',
  'GET /availability',
  'PUT /availability',
  'GET /commitments',
  'POST /commitments',
  'PATCH /commitments/c1',
  'DELETE /commitments/c1',
  'GET /calendar-day-events',
];
/** Operations the desktop core will never serve: unknown routes (404). */
const DROPPED: readonly RegExp[] = [/^POST \/auth\/(login|logout)$/, /^(POST|DELETE) \/push-subscriptions/];

interface Seen {
  readonly method: string;
  readonly path: string;
  /** The query string, so two different lookups of one list are told apart. */
  readonly query: string;
  readonly status: number;
}

/** The hours lookup, for a test of a place whose operation is not served yet (as hours were before RC-20). */
const HOURS_LOOKUP = /^GET \/availability$/;

/**
 * The mock answers as the Rust core does today: the served operations as
 * always, everything else 501 `internal_error` "Not implemented", and `/me`
 * without `llmProvider`. Returns every request it saw, with its answer.
 *
 * `notYet` takes operations back out, to stand a served one in for "not
 * ready": the rules for a 501 hold for whichever operation answers it, and
 * the hours lookup — the one the start guide waits for — is served now.
 */
function likeTheCore(options: { readonly notYet?: readonly RegExp[] } = {}): Seen[] {
  const notYet = options.notYet ?? [];
  const seen: Seen[] = [];
  const { llmProvider: _none, ...owner } = mockDb.user;
  void _none;
  mockDb.user = owner;
  server.use(
    http.all(/\/api\/v1\//, ({ request }) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^.*\/api\/v1/, '');
      const call = `${request.method} ${path}`;
      if (SERVED.some((pattern) => pattern.test(call)) && !notYet.some((pattern) => pattern.test(call))) {
        seen.push({ method: request.method, path, query: url.search, status: 200 });
        return undefined;
      }
      const status = DROPPED.some((pattern) => pattern.test(call)) ? 404 : 501;
      seen.push({ method: request.method, path, query: url.search, status });
      return status === 404 ? problem(404, 'not_found', 'Not found') : problem(501, 'internal_error', 'Not implemented');
    }),
  );
  return seen;
}

const notServed = (seen: readonly Seen[]) => seen.filter((entry) => entry.status === 501);
/** How often the very same request (method, path, query) was sent. */
const sameRequest = (seen: readonly Seen[], entry: Seen) =>
  seen.filter((other) => other.method === entry.method && other.path === entry.path && other.query === entry.query).length;
const countOf = (seen: readonly Seen[], method: string, path: string) =>
  seen.filter((entry) => entry.method === method && entry.path === path).length;

function stubRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes.map((route) => ('redirect' in route ? route : { ...route, component: Stub })) as never,
  });
}

function fastClient(): QueryClient {
  return createOwnerQueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
}

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

async function mountView(view: Parameters<typeof mount>[0], path: string): Promise<Mounted> {
  const router = stubRouter();
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  const wrapper = mount(view as never, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient: fastClient() }], router] as never },
    attachTo: document.body,
  }) as VueWrapper;
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, router, pinia };
}

/** No 개요 card is loading any more. */
async function overviewSettled(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(async () => {
    await flushPromises();
    expect(wrapper.findAll('[data-widget]')).toHaveLength(5);
    expect(wrapper.findAll('[data-widget][data-state="loading"]')).toHaveLength(0);
    expect(wrapper.find('.today-skeleton').exists()).toBe(false);
  });
  await nextTick();
}

const cardStates = (wrapper: VueWrapper) =>
  Object.fromEntries(wrapper.findAll('[data-widget]').map((card) => [card.attributes('data-widget'), card.attributes('data-state')]));

const notImplemented = () => new ApiError(501, 'internal_error', 'Not implemented');

let consoleError: ReturnType<typeof vi.spyOn>;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  setLayoutClock({ now: () => NOW });
  consoleError = vi.spyOn(console, 'error');
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setLayoutClock(null);
  adoptActiveOwner(null, 'bootstrap');
  document.body.innerHTML = '';
});

// ── The rule ────────────────────────────────────────────────────────────────

describe('what "not ready" is', () => {
  it('desktop: a 501 from the API — and nothing else', () => {
    desktopBundle();
    expect(NOT_READY_STATUS).toBe(501);
    expect(isNotReady(notImplemented())).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 412, 500, 502, 503]) {
      expect(isNotReady(new ApiError(status, 'internal_error', 'x')), String(status)).toBe(false);
    }
    expect(isNotReady(new TypeError('Failed to fetch'))).toBe(false);
    expect(isNotReady(new OwnerChangedError())).toBe(false);
    expect(isNotReady({ status: 501 })).toBe(false);
    expect(isNotReady(null)).toBe(false);
    expect(anyNotReady(null, new TypeError('x'), notImplemented())).toBe(true);
    expect(anyNotReady(null, new ApiError(500, 'internal_error', 'x'))).toBe(false);
    expect(anyNotReady()).toBe(false);
  });

  it('server: a 501 is a server fault like any 5xx (negative)', () => {
    expect(isNotReady(notImplemented())).toBe(false);
    expect(anyNotReady(notImplemented())).toBe(false);
  });

  it('says so calmly on the desktop; the server keeps its words', () => {
    const generic = problemMessage('internal_error');
    expect(generic).toContain('서버에 문제가 생겼어요');
    expect(apiErrorMessage(notImplemented())).toBe(generic);
    desktopBundle();
    expect(apiErrorMessage(notImplemented())).toBe('이 부분은 아직 준비 중이에요.');
    expect(errorMessage(notImplemented(), 'fallback')).toBe('이 부분은 아직 준비 중이에요.');
    // Another 5xx is still a fault there too.
    expect(apiErrorMessage(new ApiError(500, 'internal_error', 'boom'))).toBe(generic);
    // The server's English never reaches the screen.
    expect(apiErrorMessage(notImplemented())).not.toContain('Not implemented');
  });
});

describe('a place that is not ready is not asked again', () => {
  const defaultRetry = (count: number, cause: unknown): boolean => {
    const retry = fastClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('the owner query client has a retry function');
    return retry(count, cause as Error);
  };

  it('desktop: none of the three retry rules retries a 501', () => {
    desktopBundle();
    expect(retryTransient(0, notImplemented())).toBe(false);
    expect(retryFenced()(0, notImplemented())).toBe(false);
    expect(retryFenced(5)(0, notImplemented())).toBe(false);
    expect(defaultRetry(0, notImplemented())).toBe(false);
    // What may pass on its own is still retried there.
    expect(retryTransient(0, new ApiError(503, 'provider_unavailable', 'x'))).toBe(true);
    expect(retryFenced()(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(defaultRetry(0, new ApiError(500, 'internal_error', 'x'))).toBe(true);
  });

  it('server: a 501 is retried like any 5xx (negative)', () => {
    expect(retryTransient(0, notImplemented())).toBe(true);
    expect(retryTransient(2, notImplemented())).toBe(false);
    expect(retryFenced()(0, notImplemented())).toBe(true);
    expect(defaultRetry(0, notImplemented())).toBe(true);
    expect(defaultRetry(3, notImplemented())).toBe(false);
  });
});

// ── Notifications ───────────────────────────────────────────────────────────

describe('the notification list', () => {
  function mountPoller() {
    let api!: ReturnType<typeof useNotifications>;
    const Harness = defineComponent({
      setup() {
        api = useNotifications({ pollDelayMs: 5, maxDelayMs: 10 });
        api.start();
        return () => h('div');
      },
    });
    const wrapper = mount(Harness, { global: { plugins: [createPinia()] } });
    mounted.push(wrapper);
    return api;
  }

  it('desktop: asked once, then left alone — not ready, and not an error', async () => {
    desktopBundle();
    const seen = likeTheCore();
    const api = mountPoller();
    await vi.waitFor(() => expect(api.notReady.value).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(countOf(seen, 'GET', '/notifications')).toBe(1);
    expect(api.error.value).toBeNull();
    expect(api.loading.value).toBe(false);
    expect(api.items.value).toEqual([]);
  });

  it('server: a failing list is an error and is polled again (negative)', async () => {
    const seen = likeTheCore();
    const api = mountPoller();
    await vi.waitFor(() => expect(countOf(seen, 'GET', '/notifications')).toBeGreaterThanOrEqual(3));
    expect(api.notReady.value).toBe(false);
    // (Each poll clears the message while it asks; it is back as soon as the answer is.)
    await vi.waitFor(() => expect(api.error.value).toBe(problemMessage('internal_error')));
  });

  it('desktop: any other failure is still an error that is polled again (negative)', async () => {
    desktopBundle();
    let calls = 0;
    server.use(
      http.get('*/api/v1/notifications', () => {
        calls += 1;
        return problem(503, 'provider_unavailable');
      }),
    );
    const api = mountPoller();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    expect(api.notReady.value).toBe(false);
    await vi.waitFor(() => expect(api.error.value).not.toBeNull());
  });
});

// ── The shell and the start guide ───────────────────────────────────────────

describe('the model of the core: what it serves today', () => {
  const answer = (call: string): number =>
    SERVED.some((pattern) => pattern.test(call)) ? 200 : DROPPED.some((pattern) => pattern.test(call)) ? 404 : 501;

  it('serves nineteen operations: the owner, projects and tasks, and since RC-20 hours, appointments and a day’s events', () => {
    expect(SERVED_OPERATIONS).toHaveLength(19);
    expect(new Set(SERVED_OPERATIONS).size).toBe(19);
    for (const call of SERVED_OPERATIONS) expect(answer(call), call).toBe(200);
    // The seven RC-20 brought.
    expect(SERVED_OPERATIONS.filter((call) => /\/(availability|commitments|calendar-day-events)/.test(call))).toHaveLength(7);
  });

  it('answers 501 for what is still to come, and 404 for what it will never serve (negative)', () => {
    for (const call of [
      'GET /today',
      'GET /notifications',
      'GET /plans',
      'POST /plans',
      'GET /focus-sessions',
      'POST /focus-sessions',
      'GET /insights',
      'GET /notes',
      'GET /replan-proposals',
      'GET /integrations/google',
      // Close to a served one, and not it.
      'DELETE /availability',
      'PUT /commitments',
      'GET /commitments/c1',
      'POST /calendar-day-events',
      'DELETE /projects/p1',
    ]) {
      expect(answer(call), call).toBe(501);
    }
    for (const call of ['POST /auth/login', 'POST /auth/logout', 'POST /push-subscriptions', 'DELETE /push-subscriptions/s1']) {
      expect(answer(call), call).toBe(404);
    }
  });

  it('the mock answers that way: a served lookup is read, one taken back out is a 501', async () => {
    desktopBundle();
    const seen = likeTheCore({ notYet: [HOURS_LOOKUP] });
    await plannerClient.listCommitments({ from: '2026-11-09T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' });
    await expect(plannerClient.getAvailability()).rejects.toMatchObject({ status: 501 });
    expect(seen.map((entry) => [entry.method, entry.path, entry.status])).toEqual([
      ['GET', '/commitments', 200],
      ['GET', '/availability', 501],
    ]);
  });
});

describe('the shell on the core as it is today', () => {
  async function mountShell(): Promise<VueWrapper> {
    const router = stubRouter();
    await router.push('/overview');
    await router.isReady();
    const wrapper = mount(AppShell, {
      global: { plugins: [createPinia(), router, [VueQueryPlugin, { queryClient: fastClient() }]] as never },
      slots: { default: '<p class="protected-body">Journal</p>' },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.find('.app-shell:not(.app-shell--loading)').exists()).toBe(true);
    });
    return wrapper;
  }

  const guideState = (wrapper: VueWrapper) => wrapper.get('.app-shell').attributes('data-first-run-state');

  it('desktop: on today’s core the hours are read, once, and an owner who has some is not met by the guide', async () => {
    desktopBundle();
    const seen = likeTheCore();
    const wrapper = await mountShell();
    await vi.waitFor(() => expect(guideState(wrapper)).toBe('idle'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await flushPromises();
    expect(guideState(wrapper)).toBe('idle');
    expect(document.querySelector('[data-first-run]')).toBeNull();
    // Served since RC-20: the lookup is answered, not refused.
    expect(seen.filter((entry) => entry.method === 'GET' && entry.path === '/availability').map((entry) => entry.status)).toEqual([200]);
    // What is still to come is asked once.
    expect(countOf(seen, 'GET', '/notifications')).toBe(1);
    expect(notServed(seen).length).toBeGreaterThan(0);
    for (const entry of notServed(seen)) {
      expect(sameRequest(seen, entry), `${entry.method} ${entry.path}${entry.query}`).toBe(1);
    }
    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('desktop: the start guide does not wait for hours nobody can read, and stays away', async () => {
    desktopBundle();
    // A place that is not ready, standing in for any that will be: the hours lookup answers 501.
    const seen = likeTheCore({ notYet: [HOURS_LOOKUP] });
    const wrapper = await mountShell();
    await vi.waitFor(() => expect(guideState(wrapper)).toBe('idle'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await flushPromises();
    expect(guideState(wrapper)).toBe('idle');
    expect(document.querySelector('[data-first-run]')).toBeNull();
    // The AI question is not asked either: there is no provider to consent to.
    expect(document.querySelector('.llm-consent-dialog, [data-llm-consent]')).toBeNull();
    // Each place was asked once.
    expect(countOf(seen, 'GET', '/availability')).toBe(1);
    expect(countOf(seen, 'GET', '/notifications')).toBe(1);
    for (const entry of notServed(seen)) {
      expect(sameRequest(seen, entry), `${entry.method} ${entry.path}${entry.query}`).toBe(1);
    }
    // The shell is whole: its places, the capture bar, the page.
    expect(wrapper.find('.nav-rail').exists()).toBe(true);
    expect(wrapper.find('.app-topbar [data-capture-input]').exists()).toBe(true);
    expect(wrapper.find('.protected-body').exists()).toBe(true);
    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('desktop: once hours can be read and there are none, the guide opens as on the server (negative)', async () => {
    desktopBundle();
    seedGoogle(mockDb, 'disconnected');
    seedNewOwner(mockDb);
    const wrapper = await mountShell();
    await vi.waitFor(() => expect(guideState(wrapper)).toBe('open'));
    expect(document.querySelector('[data-first-run]')).not.toBeNull();
  });

  it('server: hours that fail are asked again before the guide gives up (negative)', async () => {
    const seen = likeTheCore({ notYet: [HOURS_LOOKUP] });
    const wrapper = await mountShell();
    await vi.waitFor(() => expect(guideState(wrapper)).toBe('idle'));
    expect(countOf(seen, 'GET', '/availability')).toBeGreaterThan(1);
  });
});

// ── 개요 ────────────────────────────────────────────────────────────────────

describe('개요 on the core as it is today', () => {
  it('desktop: the frame renders and every card says calmly that it is not ready', async () => {
    desktopBundle();
    seedMonth(mockDb);
    const seen = likeTheCore();
    const { wrapper } = await mountView(OverviewView, '/overview');
    await overviewSettled(wrapper);

    // The frame: the greeting (naming nobody), one sentence, the week and its five cards.
    expect(wrapper.get('[data-greeting]').text()).toMatch(/^좋은 (아침|오후|저녁)이에요$/);
    expect(wrapper.get('[data-next]').text()).toBe('할 일부터 적어 두세요. 오늘 계획은 아직 준비 중이에요.');
    expect(wrapper.get('#overview-week-title').text()).toBe('이번 주');
    expect(cardStates(wrapper)).toEqual({
      progress: 'not-ready',
      tracker: 'not-ready',
      summary: 'not-ready',
      ai: 'not-ready',
      log: 'not-ready',
    });
    for (const card of wrapper.findAll('[data-widget]')) {
      expect(card.get('[data-not-ready]').text()).toBe('아직 준비 중이에요.');
      expect(card.find('[data-retry]').exists()).toBe(false);
      expect(card.find('h3').exists()).toBe(true);
    }

    // 오늘: calm, with the way to what works.
    const today = wrapper.get('[data-today-board] [data-not-ready], [data-not-ready][role="status"]');
    expect(today.text()).toContain('오늘 계획은 아직 준비 중이에요.');
    expect(today.get('a').attributes('href')).toBe('/tasks');

    // Nothing is an alarm, nothing offers a retry, nothing was asked twice.
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('불러오지 못했어요');
    expect(wrapper.text()).not.toContain('다시 시도');
    expect(wrapper.find('.btn--primary').exists()).toBe(false);
    expect(notServed(seen).length).toBeGreaterThan(0);
    for (const entry of notServed(seen)) {
      expect(sameRequest(seen, entry), `${entry.method} ${entry.path}${entry.query}`).toBe(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const settledCount = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen.length, 'nothing keeps asking').toBe(settledCount);
    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('server: the same answers are failures — alerts with a retry (negative)', async () => {
    seedMonth(mockDb);
    likeTheCore();
    const { wrapper } = await mountView(OverviewView, '/overview');
    await overviewSettled(wrapper);
    expect(Object.values(cardStates(wrapper))).not.toContain('not-ready');
    expect(wrapper.findAll('[data-widget][data-state="error"]').length).toBeGreaterThanOrEqual(4);
    expect(wrapper.findAll('[data-not-ready]')).toHaveLength(0);
    expect(wrapper.findAll('[role="alert"]').length).toBeGreaterThan(0);
    expect(wrapper.text()).toContain('오늘 계획을 불러오지 못했어요.');
    expect(wrapper.get('[data-next]').text()).not.toContain('준비 중');
  });

  it('the card’s fourth body is one calm line: no alert, no retry; an error still has both (negative)', () => {
    const notReady = mount(OverviewCard, {
      props: { widget: 'log', title: '작업 기록', icon: 'list', state: 'not-ready' },
      slots: { default: '<p class="body">rows</p>' },
      global: { plugins: [stubRouter()] },
    });
    mounted.push(notReady);
    expect(notReady.get('[data-not-ready]').text()).toBe('아직 준비 중이에요.');
    expect(notReady.find('[role="alert"]').exists()).toBe(false);
    expect(notReady.find('button').exists()).toBe(false);
    expect(notReady.find('.body').exists()).toBe(false);
    expect(notReady.get('h3').text()).toContain('작업 기록');

    const failed = mount(OverviewCard, {
      props: { widget: 'log', title: '작업 기록', icon: 'list', state: 'error' },
      global: { plugins: [stubRouter()] },
    });
    mounted.push(failed);
    expect(failed.find('[role="alert"]').exists()).toBe(true);
    expect(failed.find('[data-retry]').exists()).toBe(true);
    expect(failed.find('[data-not-ready]').exists()).toBe(false);
  });
});

// ── 할 일 ───────────────────────────────────────────────────────────────────

describe('할 일 on the core as it is today', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('desktop: the canvas works in full; only the "has a planned block" bar is not drawn', async () => {
    desktopBundle();
    seedMonth(mockDb);
    const seen = likeTheCore();
    const { wrapper } = await mountView(TasksView, '/tasks');
    await vi.waitFor(() => expect(wrapper.find('[data-todo-canvas]').exists()).toBe(true));
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.findAll('[data-todo]').length).toBeGreaterThan(0);
    });
    const open = [...mockDb.tasks.values()].filter((task) => task.status !== 'done' && task.deletedAt === undefined);
    expect(wrapper.findAll('[data-todo]')).toHaveLength(open.length);
    expect(wrapper.findAll('[data-folder-dish]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-todo-planned]')).toHaveLength(0);
    // The blocks were asked for once, and their absence is nobody's alarm.
    expect(countOf(seen, 'GET', '/schedule-blocks')).toBe(1);
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('준비 중');
    expect(wrapper.text()).not.toContain('불러오지 못했어요');
    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('with blocks served, the bar is drawn (negative: it is the 501 that hides it)', async () => {
    desktopBundle();
    seedMonth(mockDb);
    const { wrapper } = await mountView(TasksView, '/tasks');
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.findAll('[data-todo-planned]').length).toBeGreaterThan(0);
    });
  });

  it('the list: 말로 적기 is not offered without an AI; the title field is', async () => {
    desktopBundle();
    likeTheCore();
    const { wrapper } = await mountView(InboxView, '/tasks?view=list');
    await vi.waitFor(() => expect(wrapper.find('form.quick-add').exists()).toBe(true));
    expect(wrapper.find('[data-task-parse-fold]').exists()).toBe(false);
  });

  it('the list on the server, and on a desktop that has an AI, offers 말로 적기 (negative)', async () => {
    const onServer = await mountView(InboxView, '/tasks?view=list');
    await vi.waitFor(() => expect(onServer.wrapper.find('form.quick-add').exists()).toBe(true));
    expect(onServer.wrapper.find('[data-task-parse-fold]').exists()).toBe(true);
    mounted.pop()?.unmount();

    desktopBundle();
    // The mock's owner has `llmProvider: 'fake'`: a core whose AI slice has landed.
    const withAi = await mountView(InboxView, '/tasks?view=list');
    await vi.waitFor(() => expect(withAi.wrapper.find('form.quick-add').exists()).toBe(true));
    expect(withAi.wrapper.find('[data-task-parse-fold]').exists()).toBe(true);
  });
});

// ── 담기 ────────────────────────────────────────────────────────────────────

describe('담기 without an AI', () => {
  const LINE = '내일 3시까지 보고서';

  async function capture(text: string): Promise<VueWrapper> {
    const { wrapper } = await mountView(CaptureBar, '/planner');
    const input = wrapper.get<HTMLInputElement>('[data-capture-input]');
    await input.trigger('focus');
    await input.setValue(text);
    await wrapper.get('[data-capture-form]').trigger('submit');
    await flushPromises();
    return wrapper;
  }

  const titled = (title: string) => [...mockDb.tasks.values()].filter((task) => task.title === title && task.deletedAt === undefined);
  const parses = (seen: readonly Seen[]) => seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith(':parse'));

  it('desktop: a line with a day and a time is not sent to be read — it is put down as the title it is', async () => {
    desktopBundle();
    const seen = likeTheCore();
    const wrapper = await capture(LINE);
    await vi.waitFor(() => expect(titled(LINE)).toHaveLength(1));
    expect(parses(seen)).toEqual([]);
    expect(notServed(seen)).toEqual([]);
    expect(wrapper.get('[data-capture-done]').text()).toContain(LINE);
    expect(wrapper.text()).toContain('AI 없이 제목 그대로 담았어요.');
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(0);
    expect(unhandled).toEqual([]);
  });

  it('server: the same line is read first, provider named or not (negative)', async () => {
    const seen = likeTheCore();
    await capture(LINE);
    await vi.waitFor(() => expect(parses(seen)).toHaveLength(1));
  });

  it('desktop with an AI (`llmProvider` present): the line is read (negative)', async () => {
    desktopBundle();
    const seen: Seen[] = [];
    server.events.on('request:start', ({ request }) => {
      seen.push({ method: request.method, path: new URL(request.url).pathname, query: '', status: 0 });
    });
    try {
      await capture(LINE);
      await vi.waitFor(() => expect(parses(seen)).toHaveLength(1));
    } finally {
      server.events.removeAllListeners();
    }
  });
});
