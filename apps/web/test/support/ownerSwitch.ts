import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin, type QueryClient } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick, type Component, type Plugin } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import App from '../../src/App.vue';
import AdaptiveFrame from '../../src/components/layout/AdaptiveFrame.vue';
import { mockDb, resetMockDb } from '../../src/mocks/db';
import { server } from '../../src/mocks/server';
import { routes } from '../../src/router';
import { sessionJournal } from '../../src/session/journal';
import { OWNER_STORAGE_KEY } from '../../src/session/owner';
import {
  adoptActiveOwner,
  clearOwnerResetPending,
  ownerChanged,
  ownerState,
  resetPageSealForTests,
} from '../../src/session/ownerEpoch';
import { probeOwnerBound } from '../../src/session/ownerBound';
import { createOwnerQueryClient } from '../../src/session/ownerQuery';
import { OWNER_STORAGE_MANIFEST } from '../../src/session/ownerStorage';
import { useAuthStore } from '../../src/stores/auth';
import { useToastStore } from '../../src/stores/toast';

/**
 * Owner-switch harness (ADR-023 guardrail, FU-77).
 *
 * The scenario every owner-isolation defect so far has had in common:
 *
 *   1. owner A starts an action;
 *   2. its response is held in flight;
 *   3. the signed-in user changes to B;
 *   4. the response is released.
 *
 * `createOwnerSwitchStage()` sets that up for any view, component or
 * composable, on the real client code and the MSW mock API, and
 * `expectNoLeak()` checks what must hold afterwards whatever the screen is:
 * nothing written into B's storage namespace, no toast, no navigation, no
 * announcement, no new dialog, no data in the cache, and no mutating request
 * sent with B's credentials.
 *
 *   const stage = await createOwnerSwitchStage();
 *   const wrapper = await stage.mountView('/settings/availability');
 *   const held = stage.hold({ method: 'PUT', path: '/availability' });
 *   await wrapper.get('form').trigger('submit');
 *   await held.arrived();
 *   await stage.switchOwner();
 *   held.release();
 *   await stage.settle();
 *   stage.expectNoLeak();
 *
 * Run the same steps without `switchOwner()` and call `expectEffect()` to
 * prove the action is not a no-op to begin with.
 */

/** The next user. Owner A is the mock API's signed-in user (`mockDb.user.id`). */
export const OWNER_B = '01900000-0000-7000-8000-0000000000b0';

export interface RequestRecord {
  readonly method: string;
  readonly path: string;
  /** Sent before or after the owner switch. */
  readonly era: 'before' | 'after';
}

export type BoundEventKind = 'waiting' | 'settled' | 'finished';

/** How long the harness waits for something the screen is expected to do (a request, an armed switch). */
const WAIT_MS = 20_000;

/** `vi.waitFor` with the harness's patience: test machines are shared and can be slow. */
export function until<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: WAIT_MS });
}

export interface HoldMatch {
  readonly method?: string;
  /** Substring of the URL path, or a pattern for it. */
  readonly path: string | RegExp;
}

export interface HeldResponses {
  /** How many matching responses are being held. */
  readonly count: number;
  /** Resolves once `count` responses have arrived from the server and are held. */
  arrived(count?: number): Promise<void>;
  /**
   * Stop holding. By default every held response is delivered, even though the
   * owner change aborted its request (the worst case for code that expects
   * success). `{ as: 'aborted' }` does what a real fetch does instead: a
   * request whose signal was aborted meanwhile rejects with AbortError.
   */
  release(options?: { readonly as?: 'response' | 'aborted' }): void;
}

export interface LeakReport {
  /** Keys present in B's storage namespace, or outside every declared slot. */
  readonly storage: readonly string[];
  /** Focus journal records filed under B. */
  readonly journal: number;
  readonly toasts: readonly string[];
  /** Navigations started after the switch (`push` / `replace`) that went through. One started before it may still complete. */
  readonly navigation: readonly string[];
  /** Live-region texts (status, alert, aria-live) that appeared after the switch. */
  readonly announcements: readonly string[];
  /** Modal dialogs opened after the switch. */
  readonly dialogs: number;
  /** Cache entries holding data after the switch (the cache is dropped at the switch). */
  readonly cache: readonly string[];
  /** Non-GET requests sent after the switch: A's intent with B's credentials. */
  readonly mutations: readonly string[];
  /** Scenario markers (text of A's private data) found in the DOM, cache or storage. */
  readonly markers: readonly string[];
}

/** Live-region texts and dialogs an owner switch produces on a screen by itself. */
export interface SwitchReference {
  readonly live: readonly string[];
  readonly dialogs: number;
}

export interface OwnerSwitchStage {
  readonly ownerA: string;
  readonly ownerB: string;
  readonly pinia: Pinia;
  readonly router: Router;
  readonly queryClient: QueryClient;
  /** Every request the client sent, in order. */
  readonly requests: readonly RequestRecord[];
  /** The whole app (AppShell and all) at `path`. AppShell unmounts its content on an owner change. */
  mountApp(path: string): Promise<VueWrapper>;
  /**
   * Only the routed view at `path` (inside the adaptive frame when `frame` is
   * set), without AppShell: it stays mounted through the owner change, so a
   * stale continuation has every chance to touch the screen.
   */
  mountView(path: string, options?: { frame?: boolean }): Promise<VueWrapper>;
  /** Any component, with the stage's pinia, router and query client. */
  mount(component: Component, options?: { props?: Record<string, unknown> }): VueWrapper;
  /** Hold matching responses in flight (the server has already acted) until released. */
  hold(match: HoldMatch): HeldResponses;
  /**
   * Start counting requests (call right before the action) and hold the
   * `index`-th one sent from now on, whatever it is. Used to switch the owner
   * at each network await of a continuation in turn.
   */
  holdNth(index: number): HeldResponses;
  /**
   * Switch the owner at the `index`-th suspension point of an owner-bound
   * task from now on (session/ownerBound.ts), counted per kind:
   * - `waiting`: right after a task began to wait — the owner changes while
   *   that wait (a request, a helper's own await, a browser prompt) is pending;
   * - `settled`: what it waited for has just settled for the current owner —
   *   the owner changes before the task resumes;
   * - `finished`: a bound task has just finished — the owner changes before
   *   whoever awaits it resumes.
   * `fired` tells whether that point was reached.
   */
  switchAtBoundEvent(kind: BoundEventKind, index: number): { readonly fired: boolean };
  /** Suspension points of owner-bound tasks seen since the stage was created. */
  boundEvents(): Readonly<Record<BoundEventKind, number>>;
  /** True once the owner was switched (by `switchOwner` or an armed bound event). */
  readonly switched: boolean;
  /** Resolves when the owner is switched. */
  whenSwitched(): Promise<void>;
  /** Start counting requests without holding any (a discovery run). */
  markActionStart(): void;
  /** Requests sent since `markActionStart()` / `holdNth()`. */
  requestsSinceMark(): readonly RequestRecord[];
  /**
   * The signed-in user changes to B. `reset` (default) is the production path:
   * another tab signed in, this page decides on a hard reset. `adopt` changes
   * the owner without one. Requests sent afterwards are recorded and never
   * answered, so whatever appears later came from A's held response.
   */
  switchOwner(options?: { via?: 'reset' | 'adopt' }): Promise<void>;
  /** The same, synchronously and without waiting for the screen to settle (to place the change in a precise turn). */
  switchOwnerNow(options?: { via?: 'reset' | 'adopt' }): void;
  settle(): Promise<void>;
  /**
   * What this screen shows on an owner switch when nothing is in flight (its
   * own "loading" notice, say): not counted as a leak. See `switchReference`.
   */
  expectOnSwitch(reference: SwitchReference): void;
  /** After `switchOwner()`: what appeared on the screen because of the switch alone. */
  switchReference(): SwitchReference;
  /** What leaked since the switch. `markers`: strings that identify A's private data. */
  leaks(markers?: readonly string[]): LeakReport;
  expectNoLeak(markers?: readonly string[], context?: string): void;
  /** Start observing for a control run (no owner switch): call before releasing. */
  watchEffects(): void;
  /** Control run: the action must have had an observable effect for its own owner. */
  expectEffect(): Promise<void>;
  dispose(): Promise<void>;
}

interface Hold {
  readonly match: HoldMatch;
  count: number;
  released: boolean;
  release: () => void;
  readonly gate: Promise<void>;
  /** Held by position (`holdNth`), not by pattern. */
  byPosition: boolean;
  deliverAs: 'response' | 'aborted';
}

function newHold(match: HoldMatch): Hold {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { match, count: 0, released: false, release, gate, byPosition: false, deliverAs: 'response' };
}

function handleOf(hold: Hold, label: string): HeldResponses {
  return {
    get count() {
      return hold.count;
    },
    async arrived(count = 1) {
      await vi.waitFor(() => expect(hold.count, `held ${label}`).toBeGreaterThanOrEqual(count), { timeout: WAIT_MS });
    },
    release(options = {}) {
      hold.deliverAs = options.as ?? 'response';
      hold.released = true;
      hold.release();
    },
  };
}

function matches(match: HoldMatch, method: string, path: string): boolean {
  if (match.method !== undefined && match.method.toUpperCase() !== method) return false;
  return typeof match.path === 'string' ? path.includes(match.path) : match.path.test(path);
}

function storageKeys(): string[] {
  const keys: string[] = [];
  for (const area of [localStorage, sessionStorage]) {
    for (let index = 0; index < area.length; index += 1) {
      const key = area.key(index);
      if (key !== null) keys.push(key);
    }
  }
  return keys.sort();
}

/** A key is declared when it is a device slot or `<owner slot prefix>:<owner>`. */
function isDeclaredKey(key: string): boolean {
  const { deviceSlots, ownerSlots } = OWNER_STORAGE_MANIFEST;
  if (Object.values(deviceSlots).some((slot) => slot.key === key)) return true;
  return Object.values(ownerSlots).some((slot) => key.startsWith(`${slot.prefix}:`));
}

/**
 * A screen that stays mounted may tell the next user that it is loading, or
 * could not load, their data (its queries restart for them). That is its own
 * reaction to the switch and says nothing about the previous user; anything
 * else that appears is counted as a leak.
 */
const LOAD_STATE = /불러오(는 중|지 못했)/;

function liveTexts(): string[] {
  const nodes = document.body.querySelectorAll('[role="status"], [role="alert"], [aria-live]');
  return [...nodes].map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((text) => text.length > 0);
}

function dialogCount(): number {
  return document.body.querySelectorAll('[aria-modal="true"], [role="alertdialog"]').length;
}

export async function createOwnerSwitchStage(): Promise<OwnerSwitchStage> {
  probeOwnerBound(null);
  // A fresh mock server for every stage: one test may build several in a row.
  server.resetHandlers();
  resetMockDb();
  const ownerA = mockDb.user.id;
  localStorage.clear();
  sessionStorage.clear();
  await sessionJournal.clear(ownerA);
  await sessionJournal.clear(OWNER_B);
  resetPageSealForTests();
  clearOwnerResetPending();
  // The signed-in mock owner, so stores created before mount already use it.
  localStorage.setItem(OWNER_STORAGE_KEY, ownerA);
  adoptActiveOwner(ownerA, 'bootstrap');

  const pinia = createPinia();
  const router = createRouter({ history: createMemoryHistory(), routes });
  const queryClient = createOwnerQueryClient();
  const toasts = useToastStore(pinia);
  // A navigation belongs to whoever started it: record the calls, not the moment the route changes.
  const lateNavigations: string[] = [];
  for (const method of ['push', 'replace'] as const) {
    const navigate = router[method].bind(router);
    router[method] = (to) => {
      const late = switched;
      const result = navigate(to);
      // A navigation a guard refused (the page seal) did not happen.
      if (late) {
        void result.then((failure) => {
          if (failure === undefined) lateNavigations.push(`${method} ${typeof to === 'string' ? to : JSON.stringify(to)}`);
        });
      }
      return result;
    };
  }
  const wrappers: VueWrapper[] = [];
  const requests: RequestRecord[] = [];
  const holds: Hold[] = [];
  let mark: number | null = null;
  let nth: { index: number; hold: Hold } | null = null;
  let switched = false;
  let journalForB = 0;
  let expected: SwitchReference = { live: [], dialogs: 0 };
  let baseline: {
    route: string;
    live: string[];
    dialogs: number;
    keys: string[];
    dom: string;
    toasts: number;
    cache: string;
  } | null = null;

  // One stage at a time: a previous stage's interception must not be wrapped again.
  if (vi.isMockFunction(globalThis.fetch)) vi.mocked(globalThis.fetch).mockRestore();
  const transport = globalThis.fetch;
  const interception = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const method = request.method.toUpperCase();
    const path = new URL(request.url).pathname;
    // As a real fetch: a request whose signal is already aborted is never sent.
    if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    requests.push({ method, path, era: switched ? 'after' : 'before' });
    // B's server never answers within the test: anything that shows up after
    // the switch can only have come from A's held response.
    if (switched) return new Promise<Response>(() => {});
    const ordinal = mark === null ? -1 : requests.length - 1 - mark;
    const hold =
      nth !== null && !nth.hold.released && ordinal === nth.index
        ? nth.hold
        : holds.find((item) => !item.released && !item.byPosition && matches(item.match, method, path));
    const response = await transport(request);
    if (hold === undefined) return response;
    // Worst case on purpose: the response is delivered on release even though
    // the owner change aborted the request meanwhile. A real fetch would
    // reject instead, but a continuation must not depend on that (not every
    // request carries the signal, and a mocked client ignores it). So the body
    // is read now and handed over detached from the request's signal.
    const body = response.status === 204 || response.status === 304 ? null : await response.arrayBuffer();
    const detached = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    hold.count += 1;
    await hold.gate;
    if (hold.deliverAs === 'aborted' && request.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    return detached;
  });

  // The owner is verified (GET /me) before any screen renders, as in AppShell.
  await useAuthStore(pinia).ensureOwnerConfirmed();

  const plugins = (): (Plugin | [Plugin, ...unknown[]])[] => [pinia, router, [VueQueryPlugin, { queryClient }]];

  function track(wrapper: VueWrapper): VueWrapper {
    wrappers.push(wrapper);
    return wrapper;
  }

  async function settle(): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      await flushPromises();
      await nextTick();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await nextTick();
  }

  const boundSeen: Record<BoundEventKind, number> = { waiting: 0, settled: 0, finished: 0 };
  // Until a test arms a switch, the stage only counts the suspension points.
  probeOwnerBound({
    waiting: () => void (boundSeen.waiting += 1),
    settled: () => void (boundSeen.settled += 1),
    finished: () => void (boundSeen.finished += 1),
  });
  let announceSwitch: () => void = () => {};
  const switchedSignal = new Promise<void>((resolve) => {
    announceSwitch = resolve;
  });

  function switchNow(via: 'reset' | 'adopt'): void {
    if (switched) throw new Error('the owner was already switched');
    // Taken before the switch: cancelling A's requests resumes A's
    // continuations at once, and what they do then counts as well.
    baseline = snapshot();
    switched = true;
    if (via === 'adopt') {
      adoptActiveOwner(OWNER_B, 'storage');
    } else {
      // Another tab signed in as B: it wrote the pointer, this page hears of it.
      localStorage.setItem(OWNER_STORAGE_KEY, OWNER_B);
      ownerChanged(ownerA, OWNER_B, 'storage');
    }
    expect(ownerState.ownerId.value).toBe(OWNER_B);
    announceSwitch();
  }

  function snapshot(): NonNullable<typeof baseline> {
    return {
      route: router.currentRoute.value.fullPath,
      live: liveTexts(),
      dialogs: dialogCount(),
      keys: storageKeys(),
      dom: document.body.textContent ?? '',
      toasts: toasts.toasts.length,
      cache: queryClient
        .getQueryCache()
        .getAll()
        .map((query) => `${query.queryHash}@${query.state.dataUpdatedAt}`)
        .sort()
        .join('|'),
    };
  }

  function cacheWithData(): string[] {
    return queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.data !== undefined)
      .map((query) => JSON.stringify(query.queryKey));
  }

  function leaks(markers: readonly string[] = []): LeakReport {
    if (baseline === null) throw new Error('switchOwner() was not called');
    const before = baseline;
    const keys = storageKeys();
    // What A's own screen already showed before the switch is not a leak; a
    // marker counts when it turns up afterwards, anywhere B could see it.
    const screen = document.body.textContent ?? '';
    const elsewhere = [
      JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data ?? null)),
      // A's own namespace may keep A's data (ADR-023 §1); everything else may not.
      storageValuesOutside(ownerA),
      toasts.toasts.map((toast) => toast.message).join('\n'),
    ].join('\n');
    return {
      storage: keys.filter((key) => key.endsWith(`:${OWNER_B}`) || !isDeclaredKey(key)),
      journal: journalForB,
      toasts: toasts.toasts.map((toast) => toast.message),
      navigation: [...lateNavigations],
      announcements: liveTexts().filter(
        (text) => !before.live.includes(text) && !expected.live.includes(text) && !LOAD_STATE.test(text),
      ),
      dialogs: Math.max(0, dialogCount() - before.dialogs - expected.dialogs),
      cache: cacheWithData(),
      mutations: requests
        .filter((request) => request.era === 'after' && request.method !== 'GET' && request.method !== 'HEAD')
        .map((request) => `${request.method} ${request.path}`),
      markers: markers.filter(
        (marker) => elsewhere.includes(marker) || (screen.includes(marker) && !before.dom.includes(marker)),
      ),
    };
  }

  function storageValuesOutside(owner: string): string {
    const values: string[] = [];
    for (const area of [localStorage, sessionStorage]) {
      for (const key of Object.keys(area)) {
        if (!key.endsWith(`:${owner}`)) values.push(area.getItem(key) ?? '');
      }
    }
    return values.join('\n');
  }

  const stage: OwnerSwitchStage = {
    ownerA,
    ownerB: OWNER_B,
    pinia,
    router,
    queryClient,
    requests,

    async mountApp(path) {
      await router.push(path);
      const wrapper = track(mount(App, { global: { plugins: plugins() }, attachTo: document.body }));
      await router.isReady();
      await until(() => expect(wrapper.find('.adaptive-frame, .page').exists()).toBe(true));
      await settle();
      return wrapper;
    },

    async mountView(path, options = {}) {
      await router.push(path);
      const Host = defineComponent({
        setup: () => () => (options.frame === true ? h(AdaptiveFrame, null, { default: () => h(RouterView) }) : h(RouterView)),
      });
      const wrapper = track(mount(Host, { global: { plugins: plugins() }, attachTo: document.body }));
      await router.isReady();
      await settle();
      return wrapper;
    },

    mount(component, options = {}) {
      return track(
        mount(component, {
          ...(options.props === undefined ? {} : { props: options.props }),
          global: { plugins: plugins() },
          attachTo: document.body,
        }),
      );
    },

    hold(match) {
      const hold = newHold(match);
      holds.push(hold);
      return handleOf(hold, JSON.stringify(match));
    },

    holdNth(index) {
      mark = requests.length;
      const hold = newHold({ path: '' });
      nth = { index, hold };
      holds.push(hold);
      // `holds` is only searched by pattern for unreleased holds; this one is
      // matched by position, so keep the pattern from matching anything.
      hold.byPosition = true;
      return handleOf(hold, `request #${index} after the action`);
    },

    markActionStart() {
      mark = requests.length;
    },

    requestsSinceMark() {
      return mark === null ? [] : requests.slice(mark);
    },

    async switchOwner(options = {}) {
      switchNow(options.via ?? 'reset');
      await settle();
    },

    switchOwnerNow(options = {}) {
      switchNow(options.via ?? 'reset');
    },

    switchAtBoundEvent(kind, index) {
      const armed = { fired: false };
      const seen: Record<BoundEventKind, number> = { waiting: 0, settled: 0, finished: 0 };
      const at = (event: BoundEventKind, change: () => void): void => {
        const ordinal = seen[event];
        seen[event] += 1;
        if (switched || event !== kind || ordinal !== index) return;
        armed.fired = true;
        change();
      };
      probeOwnerBound({
        // The task is still in the synchronous run that started the wait; the
        // owner changes as soon as it has suspended.
        waiting: () => at('waiting', () => queueMicrotask(() => switchNow('reset'))),
        // Called inside the promise reaction that settled the wait, so the
        // change lands before the task's continuation (the next microtask).
        settled: () => at('settled', () => switchNow('reset')),
        // The task's last turn is still running. Its caller resumes in the
        // microtask after next; the change is queued in between, after the
        // screen has rendered what the task did for its own owner.
        finished: () => at('finished', () => queueMicrotask(() => switchNow('reset'))),
      });
      return armed;
    },

    boundEvents() {
      return { ...boundSeen };
    },

    get switched() {
      return switched;
    },

    whenSwitched() {
      return switchedSignal;
    },

    async settle() {
      await settle();
      if (switched) journalForB = (await sessionJournal.list(undefined, OWNER_B)).length;
    },

    expectOnSwitch(reference) {
      expected = reference;
    },

    switchReference() {
      if (baseline === null) throw new Error('switchOwner() was not called');
      const before = baseline;
      return {
        live: liveTexts().filter((text) => !before.live.includes(text)),
        dialogs: Math.max(0, dialogCount() - before.dialogs),
      };
    },

    leaks,

    expectNoLeak(markers = [], context) {
      expect(leaks(markers), context).toEqual({
        storage: [],
        journal: 0,
        toasts: [],
        navigation: [],
        announcements: [],
        dialogs: 0,
        cache: [],
        mutations: [],
        markers: [],
      } satisfies LeakReport);
    },

    watchEffects() {
      baseline = snapshot();
    },

    async expectEffect() {
      if (baseline === null) throw new Error('watchEffects() was not called');
      const before = baseline;
      await vi.waitFor(() => {
        const now = snapshot();
        const changed =
          now.toasts > before.toasts ||
          now.route !== before.route ||
          now.dialogs !== before.dialogs ||
          now.dom !== before.dom ||
          now.cache !== before.cache ||
          now.keys.join('|') !== before.keys.join('|') ||
          now.live.join('|') !== before.live.join('|');
        expect(changed, 'the action had no observable effect for its own owner').toBe(true);
      }, { timeout: WAIT_MS });
    },

    async dispose() {
      for (const hold of holds) {
        hold.released = true;
        hold.release();
      }
      for (const wrapper of wrappers.splice(0)) wrapper.unmount();
      probeOwnerBound(null);
      interception.mockRestore();
      queryClient.clear();
      document.body.innerHTML = '';
      localStorage.clear();
      sessionStorage.clear();
      await sessionJournal.clear(ownerA);
      await sessionJournal.clear(OWNER_B);
      resetPageSealForTests();
      clearOwnerResetPending();
      adoptActiveOwner(ownerA, 'bootstrap');
    },
  };
  return stage;
}

// ── A sweep case: one action on one screen, checked both ways ───────────────

export interface OwnerSwitchCase {
  readonly name: string;
  /** Source files whose asynchronous writes this case exercises (see the sweep's manifest). */
  readonly covers: readonly string[];
  /** Route to mount (the routed view, without AppShell). */
  readonly path?: string | ((stage: OwnerSwitchStage) => string | Promise<string>);
  /** Instead of a route: mount something else with the stage's plugins. */
  readonly mount?: (stage: OwnerSwitchStage) => VueWrapper | Promise<VueWrapper>;
  /** Mount inside the adaptive frame (layout panels). */
  readonly frame?: boolean;
  /** Prepare mock data before the view mounts. */
  readonly seed?: (stage: OwnerSwitchStage) => void | Promise<void>;
  /** Wait until the screen is ready for the action. */
  readonly ready: (wrapper: VueWrapper, stage: OwnerSwitchStage) => Promise<void>;
  /**
   * The response to hold while the owner changes. Without it the action
   * itself is performed after the switch (a control the old screen still shows).
   */
  readonly hold?: HoldMatch;
  /** Start the action as owner A. */
  readonly act: (wrapper: VueWrapper, stage: OwnerSwitchStage) => Promise<void>;
  /** After the response was released (or the late action performed): e.g. let a timer fire. */
  readonly afterwards?: (stage: OwnerSwitchStage) => Promise<void>;
  /** Text that only A's held response carries; it must reach nothing B can see. */
  readonly markers?: readonly string[];
  /** The action is meant to end in an error notice (a conflict, a refusal). Otherwise the control run forbids one. */
  readonly expectsAlert?: boolean;
}

function alertTexts(): string[] {
  return [...document.body.querySelectorAll('[role="alert"]')]
    .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0);
}

async function arrange(
  testCase: OwnerSwitchCase,
  /** Runs before anything mounts (an armed owner switch must see every wait from the start). */
  prepare?: (stage: OwnerSwitchStage) => void,
): Promise<{ stage: OwnerSwitchStage; wrapper: VueWrapper }> {
  const stage = await createOwnerSwitchStage();
  prepare?.(stage);
  await testCase.seed?.(stage);
  let wrapper: VueWrapper;
  if (testCase.mount !== undefined) {
    wrapper = await testCase.mount(stage);
  } else {
    if (testCase.path === undefined) throw new Error(`${testCase.name}: give the case a path or a mount`);
    const path = typeof testCase.path === 'function' ? await testCase.path(stage) : testCase.path;
    wrapper = await stage.mountView(path, { frame: testCase.frame === true });
  }
  // An armed switch may fire while the screen is still getting ready.
  await Promise.race([testCase.ready(wrapper, stage), stage.whenSwitched()]);
  await stage.settle();
  return { stage, wrapper };
}

/**
 * Registers two tests for the case:
 * - control: for its own owner the action has an observable effect (so the
 *   second test cannot pass by doing nothing);
 * - switch: owner A starts it, B signs in while the response is held, the
 *   response is released — and nothing of it reaches B (`expectNoLeak`).
 */
export function sweepOwnerSwitch(testCase: OwnerSwitchCase): void {
  describe(testCase.name, () => {
    let stage: OwnerSwitchStage | null = null;
    let reference: SwitchReference | null = null;

    /** The screen's own reaction to an owner switch with nothing in flight. */
    async function idleReference(): Promise<SwitchReference> {
      if (reference !== null) return reference;
      const idle = await arrange(testCase);
      await idle.stage.switchOwner();
      await idle.stage.settle();
      reference = idle.stage.switchReference();
      await idle.stage.dispose();
      return reference;
    }

    afterEach(async () => {
      await stage?.dispose();
      stage = null;
      vi.useRealTimers();
    });

    it('control: the action takes effect for the owner who started it', { timeout: SINGLE_RUN_MS }, async () => {
      const arranged = await arrange(testCase);
      stage = arranged.stage;
      const alertsBefore = alertTexts();
      const held = testCase.hold === undefined ? null : stage.hold(testCase.hold);
      if (held === null) stage.watchEffects();
      await testCase.act(arranged.wrapper, stage);
      if (held !== null) {
        await held.arrived();
        stage.watchEffects();
        held.release();
      }
      await testCase.afterwards?.(stage);
      await stage.expectEffect();
      await stage.settle();
      // The effect must be the action succeeding, not an error notice about it.
      if (testCase.expectsAlert !== true) {
        expect(alertTexts().filter((text) => !alertsBefore.includes(text))).toEqual([]);
      }
    });

    it('switch: released after another user signed in, it reaches nothing of theirs', { timeout: SINGLE_RUN_MS }, async () => {
      const onSwitch = await idleReference();
      const arranged = await arrange(testCase);
      stage = arranged.stage;
      stage.expectOnSwitch(onSwitch);
      if (testCase.hold === undefined) {
        await stage.switchOwner();
        await testCase.act(arranged.wrapper, stage);
      } else {
        const held = stage.hold(testCase.hold);
        await testCase.act(arranged.wrapper, stage);
        await held.arrived();
        await stage.switchOwner();
        held.release();
      }
      await stage.settle();
      await testCase.afterwards?.(stage);
      await stage.settle();
      stage.expectNoLeak(testCase.markers);
    });

    // A continuation usually awaits more than once (the mutation, then a
    // re-read, then a refresh). The switch above lands on the first await; this
    // one finds every request the action leads to and switches the owner
    // while each of them is pending, in turn.
    it('switch at every network await of the action, in every order: nothing reaches the next user', { timeout: EXPLORATION_MS }, async () => {
      if (testCase.hold === undefined) return;
      const onSwitch = await idleReference();
      const discovery = await arrange(testCase);
      stage = discovery.stage;
      stage.markActionStart();
      await testCase.act(discovery.wrapper, stage);
      const declared = testCase.hold;
      const sent = stage;
      // A debounced action sends its first request a little later.
      await vi.waitFor(
        () => expect(sent.requestsSinceMark().some((request) => matches(declared, request.method, request.path))).toBe(true),
        { timeout: WAIT_MS },
      );
      await stage.settle();
      await testCase.afterwards?.(stage);
      await stage.settle();
      const total = Math.min(stage.requestsSinceMark().length, MAX_EXPLORED_AWAITS);
      await stage.dispose();
      stage = null;
      expect(total, 'the action sent no request').toBeGreaterThan(0);

      for (let index = 0; index < total; index += 1) {
        for (const order of REQUEST_ORDERS) {
          const arranged = await arrange(testCase);
          stage = arranged.stage;
          stage.expectOnSwitch(onSwitch);
          const held = stage.holdNth(index);
          await testCase.act(arranged.wrapper, stage);
          await held.arrived();
          const pending = stage.requestsSinceMark()[index];
          if (order === 'answered, then switched') {
            // The answer is handed over first; the owner changes in the very
            // next microtask, before the code that awaits it has resumed.
            const switching = stage;
            held.release();
            queueMicrotask(() => switching.switchOwnerNow());
          } else {
            await stage.switchOwner();
            held.release({ as: order === 'switched, then aborted' ? 'aborted' : 'response' });
          }
          await stage.settle();
          await testCase.afterwards?.(stage);
          await stage.settle();
          stage.expectNoLeak(
            testCase.markers,
            `request #${index} (${pending?.method} ${pending?.path}): ${order}`,
          );
          await stage.dispose();
          stage = null;
        }
      }
    });

    // The same for every suspension point of the owner-bound tasks the action
    // runs (session/ownerBound.ts) — network or not: a helper's nextTick, a
    // cache refresh, a browser permission prompt. Each point is tried in both
    // orders: the owner changes while the wait is pending, and the owner
    // changes right after the wait settled but before the task resumes (the
    // microtask gap of FU-77R-1 H1); and once more right after each task
    // finished, before whoever awaits it resumes.
    it('switch at every owner-bound suspension point, in both orders: nothing reaches the next user', { timeout: EXPLORATION_MS }, async () => {
      const onSwitch = await idleReference();
      const discovery = await arrange(testCase);
      stage = discovery.stage;
      const declared = testCase.hold;
      stage.markActionStart();
      // Points reached while the screen was only getting ready are not part
      // of the action (a switch there is the request-level test's business).
      const before = stage.boundEvents();
      await testCase.act(discovery.wrapper, stage);
      if (declared !== undefined) {
        const sent = stage;
        await vi.waitFor(
          () => expect(sent.requestsSinceMark().some((request) => matches(declared, request.method, request.path))).toBe(true),
          { timeout: WAIT_MS },
        );
      }
      await stage.settle();
      await testCase.afterwards?.(stage);
      await stage.settle();
      const seen = stage.boundEvents();
      await stage.dispose();
      stage = null;

      for (const kind of BOUND_EVENT_KINDS) {
        const last = Math.min(seen[kind], before[kind] + MAX_EXPLORED_AWAITS);
        for (let index = before[kind]; index < last; index += 1) {
          let armed = { fired: false };
          const arranged = await arrange(testCase, (created) => {
            armed = created.switchAtBoundEvent(kind, index);
          });
          stage = arranged.stage;
          stage.expectOnSwitch(onSwitch);
          const reached = armed;
          const context = `owner switched ${BOUND_EVENT_LABEL[kind]} (#${index} of ${seen[kind]})`;
          try {
            await testCase.act(arranged.wrapper, stage);
          } catch (cause) {
            // The switch can fire while the screen gets ready; its controls may be gone by now.
            if (!stage.switched) throw cause;
          }
          await vi.waitFor(() => expect(reached.fired, context).toBe(true), { timeout: WAIT_MS });
          await stage.settle();
          await testCase.afterwards?.(stage);
          await stage.settle();
          stage.expectNoLeak(testCase.markers, context);
          await stage.dispose();
          stage = null;
        }
      }
    });
  });
}

/** Upper bound on the requests explored per case (a polling screen never stops sending). */
const MAX_EXPLORED_AWAITS = 8;

/** One arrangement, and a test that walks through many of them. Generous: CI machines are shared. */
const SINGLE_RUN_MS = 60_000;
const EXPLORATION_MS = 300_000;

/**
 * The orders in which a pending request and an owner change can meet:
 * - the owner changes, then the answer arrives anyway (a transport that does
 *   not honour the abort — the worst case for code that expects success);
 * - the owner changes, and the request fails as aborted (what a real fetch
 *   does — the worst case for code that reports failures);
 * - the answer arrives, and the owner changes before the code that awaits it
 *   has resumed.
 */
const REQUEST_ORDERS = ['switched, then answered late', 'switched, then aborted', 'answered, then switched'] as const;

const BOUND_EVENT_KINDS: readonly BoundEventKind[] = ['waiting', 'settled', 'finished'];
const BOUND_EVENT_LABEL: Record<BoundEventKind, string> = {
  waiting: 'while an owner-bound wait was pending',
  settled: 'right after an owner-bound wait settled, before the task resumed',
  finished: 'right after an owner-bound task finished, before its caller resumed',
};
