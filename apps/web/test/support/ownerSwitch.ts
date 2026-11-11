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
  /** Deliver every held response (and stop holding new ones). */
  release(): void;
}

export interface LeakReport {
  /** Keys present in B's storage namespace, or outside every declared slot. */
  readonly storage: readonly string[];
  /** Focus journal records filed under B. */
  readonly journal: number;
  readonly toasts: readonly string[];
  /** `from -> to` when the route moved after the switch. */
  readonly navigation: string | null;
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
}

function newHold(match: HoldMatch): Hold {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { match, count: 0, released: false, release, gate, byPosition: false };
}

function handleOf(hold: Hold, label: string): HeldResponses {
  return {
    get count() {
      return hold.count;
    },
    async arrived(count = 1) {
      await vi.waitFor(() => expect(hold.count, `held ${label}`).toBeGreaterThanOrEqual(count), { timeout: 3_000 });
    },
    release() {
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
    const route = router.currentRoute.value.fullPath;
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
      navigation: route === before.route ? null : `${before.route} -> ${route}`,
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
      await vi.waitFor(() => expect(wrapper.find('.adaptive-frame, .page').exists()).toBe(true));
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
      if (switched) throw new Error('the owner was already switched');
      // Taken before the switch: cancelling A's requests resumes A's
      // continuations at once, and what they do then counts as well.
      baseline = snapshot();
      switched = true;
      if (options.via === 'adopt') {
        adoptActiveOwner(OWNER_B, 'storage');
      } else {
        // Another tab signed in as B: it wrote the pointer, this page hears of it.
        localStorage.setItem(OWNER_STORAGE_KEY, OWNER_B);
        ownerChanged(ownerA, OWNER_B, 'storage');
      }
      expect(ownerState.ownerId.value).toBe(OWNER_B);
      await settle();
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
        navigation: null,
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
      });
    },

    async dispose() {
      for (const hold of holds) {
        hold.released = true;
        hold.release();
      }
      for (const wrapper of wrappers.splice(0)) wrapper.unmount();
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
}

async function arrange(testCase: OwnerSwitchCase): Promise<{ stage: OwnerSwitchStage; wrapper: VueWrapper }> {
  const stage = await createOwnerSwitchStage();
  await testCase.seed?.(stage);
  let wrapper: VueWrapper;
  if (testCase.mount !== undefined) {
    wrapper = await testCase.mount(stage);
  } else {
    if (testCase.path === undefined) throw new Error(`${testCase.name}: give the case a path or a mount`);
    const path = typeof testCase.path === 'function' ? await testCase.path(stage) : testCase.path;
    wrapper = await stage.mountView(path, { frame: testCase.frame === true });
  }
  await testCase.ready(wrapper, stage);
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

    it('control: the action takes effect for the owner who started it', async () => {
      const arranged = await arrange(testCase);
      stage = arranged.stage;
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
    });

    it('switch: released after another user signed in, it reaches nothing of theirs', async () => {
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
    it('switch at every network await of the action: nothing reaches the next user', async () => {
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
        { timeout: 3_000 },
      );
      await stage.settle();
      await testCase.afterwards?.(stage);
      await stage.settle();
      const total = Math.min(stage.requestsSinceMark().length, MAX_EXPLORED_AWAITS);
      await stage.dispose();
      stage = null;
      expect(total, 'the action sent no request').toBeGreaterThan(0);

      for (let index = 0; index < total; index += 1) {
        const arranged = await arrange(testCase);
        stage = arranged.stage;
        stage.expectOnSwitch(onSwitch);
        const held = stage.holdNth(index);
        await testCase.act(arranged.wrapper, stage);
        await held.arrived();
        const pending = stage.requestsSinceMark()[index];
        await stage.switchOwner();
        held.release();
        await stage.settle();
        await testCase.afterwards?.(stage);
        await stage.settle();
        stage.expectNoLeak(
          testCase.markers,
          `owner switched while request #${index} (${pending?.method} ${pending?.path}) was pending`,
        );
        await stage.dispose();
        stage = null;
      }
    });
  });
}

/** Upper bound on the requests explored per case (a polling screen never stops sending). */
const MAX_EXPLORED_AWAITS = 8;
