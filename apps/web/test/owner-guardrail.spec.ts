import 'fake-indexeddb/auto';
import { QueryClient, useQueryClient } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, useRouter } from 'vue-router';
import { newActionId, plannerClient } from '../src/api';
import { AI_WAIT_STORAGE_PREFIX, LEGACY_AI_WAIT_STORAGE_KEY, aiWaitStorageKey } from '../src/composables/useAiWait';
import { acknowledgeRisk, isRiskAcknowledged } from '../src/layout/localSignals';
import { layoutPrefsKey, writeLayoutPrefs } from '../src/layout/prefs';
import { bindNavigationsToOwner, refuseNavigationWhenSealed, routes } from '../src/router';
import { IndexedDbSessionJournal } from '../src/session/journal';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { OwnerChangedError, collectPages, runOwnerBound, waitStep, type OwnerSteps } from '../src/session/ownerBound';
import {
  adoptActiveOwner,
  captureOwnerBinding,
  installPageSeal,
  invalidateOwnerEpoch,
  isPageSealed,
  ownerChanged,
  resetPageSealForTests,
} from '../src/session/ownerEpoch';
import { createOwnerQueryClient } from '../src/session/ownerQuery';
import { OWNER_STORAGE_MANIFEST, deviceSlot, ownerSlot } from '../src/session/ownerStorage';
import { clearQuarantine, listQuarantine, quarantineRecord } from '../src/session/quarantine';
import { useToastStore } from '../src/stores/toast';
import { OWNER_B, createOwnerSwitchStage, type OwnerSwitchStage } from './support/ownerSwitch';

/**
 * FU-77 — the owner-isolation guardrail itself (ADR-023 amendment):
 * owner-scoped storage, owner-bound continuations, the owner-scoped query
 * client and the page seal. The screens are covered by owner-switch-sweep.
 */
// Stage-based tests mount real screens; shared test machines can be slow.
vi.setConfig({ testTimeout: 60_000 });

const OWNER_A = '01900000-0000-7000-8000-0000000000a0';

function gate<T = void>() {
  let release: (value: T) => void = () => {};
  let fail: (cause: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetPageSealForTests();
  adoptActiveOwner(OWNER_A, 'bootstrap');
});

afterEach(() => {
  resetPageSealForTests();
});

describe('ownerStorage — every key is declared and namespaced by owner', () => {
  it('writes into the binding’s own namespace and reads it back for that owner only', () => {
    const slot = ownerSlot('layoutPrefs');
    expect(slot.write(captureOwnerBinding(), 'A-value')).toBe('ok');
    expect(localStorage.getItem(`ohmydate.layout.prefs:${OWNER_A}`)).toBe('A-value');
    expect(slot.read(OWNER_A)).toBe('A-value');
    expect(slot.read(OWNER_B)).toBeNull();
    expect(slot.keyFor(null)).toBe('ohmydate.layout.prefs:anonymous');
  });

  it('a stale binding writes nothing — not for the old owner, not for the new one (negative)', () => {
    const slot = ownerSlot('layoutPrefs');
    const stale = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'storage');
    expect(slot.write(stale, 'late')).toBe('stale');
    expect(slot.remove(stale)).toBe('stale');
    expect(Object.keys(localStorage).filter((key) => key.startsWith('ohmydate.layout.'))).toEqual([]);
    // The same through the feature modules built on the slots.
    expect(writeLayoutPrefs(stale, { autoSwitch: false, locked: null })).toBe(false);
    expect(acknowledgeRisk(stale, '2026-11-14')).toBe(false);
    expect(localStorage.getItem(layoutPrefsKey(OWNER_B))).toBeNull();
    expect(isRiskAcknowledged(OWNER_B, '2026-11-14')).toBe(false);
  });

  it('a bumped epoch for the same owner is stale too (failed login, re-login)', () => {
    const slot = ownerSlot('layoutRiskAck');
    const binding = captureOwnerBinding();
    invalidateOwnerEpoch();
    expect(slot.write(binding, '2026-11-14')).toBe('stale');
    expect(slot.write(captureOwnerBinding(), '2026-11-14')).toBe('ok');
  });

  it('a durable slot keeps a late write, in the owner’s own namespace and never the current one', () => {
    const slot = ownerSlot('focusSessions');
    const stale = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'storage');
    expect(slot.write(stale, '{"late":true}')).toBe('ok');
    expect(localStorage.getItem(`ohmydate.focus.sessions:${OWNER_A}`)).toBe('{"late":true}');
    expect(localStorage.getItem(`ohmydate.focus.sessions:${OWNER_B}`)).toBeNull();
  });

  it('only declared keys exist: owner slots by prefix, device keys by the allowlist with a reason', () => {
    const { ownerSlots, deviceSlots, deviceDatabases } = OWNER_STORAGE_MANIFEST;
    expect(Object.values(deviceSlots).map((slot) => slot.key).sort()).toEqual([OWNER_STORAGE_KEY, LEGACY_AI_WAIT_STORAGE_KEY].sort());
    expect(Object.keys(deviceDatabases)).toEqual(['ohmydate-focus']);
    for (const spec of [...Object.values(ownerSlots), ...Object.values(deviceSlots), ...Object.values(deviceDatabases)]) {
      expect(spec.why.length).toBeGreaterThan(20);
    }
    // Prefixes are unique and none is a prefix of another (a key belongs to one slot).
    const prefixes = Object.values(ownerSlots).map((slot) => `${slot.prefix}:`);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.some((left) => prefixes.some((right) => left !== right && right.startsWith(left)))).toBe(false);
    // The modules that export a key agree with the table.
    expect(aiWaitStorageKey(OWNER_A)).toBe(`${ownerSlots.aiWait.prefix}:${OWNER_A}`);
    expect(AI_WAIT_STORAGE_PREFIX).toBe(ownerSlots.aiWait.prefix);
    expect(layoutPrefsKey(OWNER_A)).toBe(`${ownerSlots.layoutPrefs.prefix}:${OWNER_A}`);
    expect(deviceSlot('activeOwner').read()).toBe(OWNER_A);
  });

  it('clear-on-owner-change slots are emptied for every owner on any owner change; the rest is preserved', () => {
    sessionStorage.setItem(aiWaitStorageKey(OWNER_A), '{"private":"A"}');
    sessionStorage.setItem(aiWaitStorageKey(OWNER_B), '{"private":"B"}');
    sessionStorage.setItem(LEGACY_AI_WAIT_STORAGE_KEY, '{"private":"legacy"}');
    writeLayoutPrefs(captureOwnerBinding(), { autoSwitch: false, locked: null });
    adoptActiveOwner(OWNER_B, 'storage');
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(localStorage.getItem(layoutPrefsKey(OWNER_A))).not.toBeNull();
  });
});

describe('page seal — a page being hard-reset cannot act for anyone', () => {
  it('is opt-in: without it an owner change seals nothing (the unit tests switch owners on one page)', () => {
    ownerChanged(OWNER_A, OWNER_B, 'storage');
    expect(isPageSealed()).toBe(false);
    expect(ownerSlot('layoutPrefs').write(captureOwnerBinding(), 'B-value')).toBe('ok');
  });

  it('once sealed, nothing is written into the new owner’s namespace, with any binding or explicit owner (negative)', async () => {
    installPageSeal();
    const before = captureOwnerBinding();
    ownerChanged(OWNER_A, OWNER_B, 'storage');
    expect(isPageSealed()).toBe(true);
    // A continuation that captured its binding AFTER the switch (the M6-02R-1 H1 mistake).
    const late = captureOwnerBinding();
    expect(late.ownerId).toBe(OWNER_B);
    expect(ownerSlot('layoutPrefs').write(late, 'A-data')).toBe('sealed');
    expect(ownerSlot('focusSessions').write(late, 'A-data')).toBe('sealed');
    expect(ownerSlot('focusSessions').writeFor(OWNER_B, 'A-data')).toBe('sealed');
    expect(ownerSlot('focusQuarantine').discard(OWNER_B)).toBe('sealed');
    expect(writeLayoutPrefs(late, { autoSwitch: false, locked: null })).toBe(false);
    expect(acknowledgeRisk(late, '2026-11-14')).toBe(false);
    expect(Object.keys(localStorage).filter((key) => key.endsWith(`:${OWNER_B}`))).toEqual([]);
    // The previous owner's durable data may still be completed (ADR-023 §1) …
    expect(ownerSlot('focusSessions').write(before, '{"mine":true}')).toBe('ok');
    expect(localStorage.getItem(`ohmydate.focus.sessions:${OWNER_A}`)).toBe('{"mine":true}');
    // … and the device pointer still follows the owner.
    expect(deviceSlot('activeOwner').write(OWNER_B)).toBe('ok');
    // The journal refuses the new owner's namespace as well.
    const journal = new IndexedDbSessionJournal();
    const event = { id: 'e1', sessionId: 's1', kind: 'pause' as const, clientAt: '2026-11-14T00:00:00.000Z', idempotencyKey: 'k1', expectedVersion: 1 };
    await expect(journal.append(event, OWNER_B)).rejects.toThrow(/closed for this owner/);
    await expect(journal.append(event, OWNER_A)).resolves.toMatchObject({ ownerId: OWNER_A });
    await journal.clear(OWNER_A);
  });

  it('quarantine helpers obey the seal for the new owner and still work for the old one', () => {
    installPageSeal();
    ownerChanged(OWNER_A, OWNER_B, 'storage');
    const record = { seq: 1, ownerId: OWNER_B, id: 'e', sessionId: 's', kind: 'pause' as const, clientAt: 'now', idempotencyKey: 'k', expectedVersion: 1 };
    expect(quarantineRecord(OWNER_B, record, 'x')).toBe(false);
    expect(listQuarantine(OWNER_B)).toEqual([]);
    expect(quarantineRecord(OWNER_A, { ...record, ownerId: OWNER_A }, 'x')).toBe(true);
    expect(listQuarantine(OWNER_A)).toHaveLength(1);
    clearQuarantine(OWNER_A);
    expect(listQuarantine(OWNER_A)).toEqual([]);
  });

  it('toasts: cleared on an owner change, refused while sealed, shown again for a fresh page (negative + control)', () => {
    const toast = useToastStore(createPinia());
    toast.show('A-toast', { duration: 0 });
    expect(toast.toasts).toHaveLength(1);
    adoptActiveOwner(OWNER_B, 'storage');
    expect(toast.toasts).toEqual([]);
    toast.show('B-toast', { duration: 0 });
    expect(toast.toasts.map((item) => item.message)).toEqual(['B-toast']);

    installPageSeal();
    ownerChanged(OWNER_B, OWNER_A, 'storage');
    toast.show('late toast from the previous owner', { duration: 0 });
    expect(toast.toasts).toEqual([]);
  });

  it('router: no navigation while sealed (negative), normal navigation otherwise', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    refuseNavigationWhenSealed(router);
    await router.push('/inbox');
    await router.push('/overview');
    expect(router.currentRoute.value.path).toBe('/overview');
    installPageSeal();
    ownerChanged(OWNER_A, OWNER_B, 'storage');
    await router.push('/notes');
    expect(router.currentRoute.value.path).toBe('/overview');
  });
});

describe('navigation belongs to the user who started it', () => {
  const Page = defineComponent({ render: () => h('div') });

  /** A router whose `/slow` screen loads only when the test lets it (a lazily loaded view). */
  function slowRouter() {
    const loading = gate<typeof Page>();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Page },
        { path: '/slow', component: () => loading.promise },
        { path: '/old', redirect: '/slow' },
        { path: '/other', component: Page },
      ],
    });
    bindNavigationsToOwner(router);
    return { router, loaded: () => loading.release(Page) };
  }

  it('a navigation A started does not complete after B signed in (negative); without a switch it does', async () => {
    const first = slowRouter();
    await first.router.push('/');
    const leaving = first.router.push('/slow');
    adoptActiveOwner(OWNER_B, 'storage');
    first.loaded();
    await leaving;
    expect(first.router.currentRoute.value.path).toBe('/');

    adoptActiveOwner(OWNER_A, 'storage');
    const second = slowRouter();
    await second.router.push('/');
    const arriving = second.router.push('/slow');
    second.loaded();
    await arriving;
    expect(second.router.currentRoute.value.path).toBe('/slow');
  });

  it('the owner is noted when push is called, not when the first guard runs a microtask later', async () => {
    const { router, loaded } = slowRouter();
    await router.push('/');
    const leaving = router.push('/slow');
    // Before any guard of this navigation has run.
    queueMicrotask(() => adoptActiveOwner(OWNER_B, 'storage'));
    loaded();
    await leaving;
    expect(router.currentRoute.value.path).toBe('/');
    // What B starts afterwards goes through.
    await router.push('/other');
    expect(router.currentRoute.value.path).toBe('/other');
  });

  it('a redirect keeps the owner of the navigation it came from', async () => {
    const { router, loaded } = slowRouter();
    await router.push('/');
    const leaving = router.push('/old');
    adoptActiveOwner(OWNER_B, 'storage');
    loaded();
    await leaving;
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('single owner: a navigation that began before the owner was known, or before a re-login of the same user, completes', async () => {
    adoptActiveOwner(null, 'storage');
    const boot = slowRouter();
    await boot.router.push('/');
    const first = boot.router.push('/slow');
    // /me answers while the first screen is still loading.
    adoptActiveOwner(OWNER_A, 'bootstrap');
    boot.loaded();
    await first;
    expect(boot.router.currentRoute.value.path).toBe('/slow');

    const again = slowRouter();
    await again.router.push('/');
    const second = again.router.push('/slow');
    invalidateOwnerEpoch();
    again.loaded();
    await second;
    expect(again.router.currentRoute.value.path).toBe('/slow');
  });

  it('a duplicate navigation leaves nothing behind that could bind a later one to the wrong owner', async () => {
    const { router } = slowRouter();
    await router.push('/');
    await router.push('/');
    adoptActiveOwner(OWNER_B, 'storage');
    await router.push('/other');
    expect(router.currentRoute.value.path).toBe('/other');
  });
});

describe('owner-scoped query client', () => {
  it('drops the whole cache and cancels requests on an owner change; a late answer is not cached', async () => {
    const client = createOwnerQueryClient();
    client.mount();
    const held = gate<string>();
    client.setQueryData(['availability'], 'A-availability');
    const pending = client.fetchQuery({ queryKey: ['tasks'], queryFn: () => held.promise }).catch((cause: unknown) => cause);
    adoptActiveOwner(OWNER_B, 'storage');
    expect(client.getQueryCache().getAll()).toEqual([]);
    held.release('A-tasks');
    await pending;
    await Promise.resolve();
    expect(client.getQueryData(['tasks'])).toBeUndefined();
    expect(client.getQueryData(['availability'])).toBeUndefined();
    client.unmount();
  });

  it('takes no more data once the page is sealed (negative); a plain client would', () => {
    const client = createOwnerQueryClient();
    client.mount();
    const plain = new QueryClient();
    installPageSeal();
    ownerChanged(OWNER_A, OWNER_B, 'storage');
    expect(client.setQueryData(['availability'], 'A-availability')).toBeUndefined();
    expect(client.setQueriesData({ queryKey: ['availability'] }, 'A-availability')).toEqual([]);
    expect(client.getQueryData(['availability'])).toBeUndefined();
    plain.setQueryData(['availability'], 'A-availability');
    expect(plain.getQueryData(['availability'])).toBe('A-availability');
    client.unmount();
  });

  it('never retries a lookup that failed because its owner changed; other failures keep the default retries', () => {
    const client = createOwnerQueryClient();
    const retry = client.getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('retry policy missing');
    expect(retry(0, new OwnerChangedError())).toBe(false);
    expect(retry(0, new Error('network'))).toBe(true);
    expect(retry(3, new Error('network'))).toBe(false);
  });

  it('stops watching the owner when unmounted', () => {
    const client = createOwnerQueryClient();
    client.mount();
    client.unmount();
    client.setQueryData(['kept'], 1);
    adoptActiveOwner(OWNER_B, 'storage');
    expect(client.getQueryData(['kept'])).toBe(1);
  });
});

describe('runOwnerBound — one owner for a continuation’s whole life', () => {
  it('done: returns the value and runs onSettled; the first stretch runs in the caller’s turn', async () => {
    const settled = vi.fn();
    const order: string[] = [];
    const running = runOwnerBound(
      function* (owner) {
        order.push('task started');
        yield* owner.wait(Promise.resolve());
        return `for ${String(owner.ownerId)}`;
      },
      { onSettled: settled },
    );
    order.push('caller went on');
    expect(order).toEqual(['task started', 'caller went on']);
    expect(await running).toEqual({ status: 'done', value: `for ${OWNER_A}` });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('failed: onError gets a real failure; without onError it is rethrown; onSettled runs either way', async () => {
    const boom = new Error('boom');
    const onError = vi.fn();
    const settled = vi.fn();
    const failing = function* (): OwnerSteps<void> {
      yield* waitStep(Promise.resolve());
      throw boom;
    };
    expect(await runOwnerBound(failing, { onError, onSettled: settled })).toEqual({ status: 'failed', cause: boom });
    expect(onError).toHaveBeenCalledWith(boom);
    await expect(runOwnerBound(failing, { onSettled: settled })).rejects.toBe(boom);
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('a failure of the awaited work is thrown into the task, where a catch handles it', async () => {
    const real = new Error('412');
    const seen: unknown[] = [];
    const outcome = await runOwnerBound(function* (owner) {
      try {
        yield* owner.wait(Promise.reject(real));
      } catch (cause) {
        seen.push(cause);
        return 'handled';
      }
      return 'not reached';
    });
    expect(outcome).toEqual({ status: 'done', value: 'handled' });
    expect(seen).toEqual([real]);
  });

  it('stale: the owner changed while it waited — the task never resumes: no later line, no catch, no finally, no handler (negative)', async () => {
    const held = gate<string>();
    const ran: string[] = [];
    const onError = vi.fn();
    const settled = vi.fn();
    const running = runOwnerBound(
      function* (owner) {
        try {
          const value = yield* owner.wait(held.promise);
          ran.push(`after the wait: ${value}`);
          return value;
        } catch {
          ran.push('catch');
          return 'caught';
        } finally {
          ran.push('finally');
        }
      },
      { onError, onSettled: settled },
    );
    adoptActiveOwner(OWNER_B, 'storage');
    held.release('A-private');
    expect(await running).toEqual({ status: 'stale' });
    await Promise.resolve();
    expect(ran).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('stale: stops waiting at once even if the awaited work never settles or fails later', async () => {
    const never = new Promise<string>(() => {});
    const late = gate<string>();
    const first = runOwnerBound((owner) => owner.wait(never));
    const second = runOwnerBound((owner) => owner.wait(late.promise), { onError: vi.fn() });
    adoptActiveOwner(OWNER_B, 'storage');
    expect(await first).toEqual({ status: 'stale' });
    expect(await second).toEqual({ status: 'stale' });
    // A failure of the abandoned work is nobody's error any more (no unhandled rejection).
    late.fail(new Error('aborted'));
    await Promise.resolve();
  });

  it('a stale failure is not an error: the aborted request’s rejection reaches neither the task nor onError', async () => {
    const held = gate<string>();
    const onError = vi.fn();
    const caught = vi.fn();
    const running = runOwnerBound(
      function* (owner) {
        try {
          return yield* owner.wait(held.promise);
        } catch (cause) {
          caught(cause);
          throw cause;
        }
      },
      { onError },
    );
    adoptActiveOwner(OWNER_B, 'storage');
    held.fail(new TypeError('Failed to fetch'));
    expect(await running).toEqual({ status: 'stale' });
    expect(caught).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('runs nothing under a binding that is already stale (a timer that fires for the previous owner)', async () => {
    const binding = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'storage');
    const task = vi.fn(function* (): OwnerSteps<string> {
      yield* waitStep(Promise.resolve());
      return 'ran';
    });
    expect(await runOwnerBound(task, { binding })).toEqual({ status: 'stale' });
    expect(task).not.toHaveBeenCalled();
    // Control: the same call under the current owner runs.
    expect(await runOwnerBound(task)).toEqual({ status: 'done', value: 'ran' });
  });

  it('a raw `yield` is fenced like owner.wait, and yielding a generator instead of delegating is an error', async () => {
    const held = gate<string>();
    const after = vi.fn();
    const running = runOwnerBound(function* () {
      const value = yield held.promise;
      after(value);
    });
    adoptActiveOwner(OWNER_B, 'storage');
    held.release('A-private');
    expect(await running).toEqual({ status: 'stale' });
    expect(after).not.toHaveBeenCalled();

    function* helper(): OwnerSteps<void> {
      yield Promise.resolve();
    }
    await expect(
      runOwnerBound(function* () {
        yield helper();
      }),
    ).rejects.toThrow(/delegate to a helper with `yield\*`/);
  });

  it('pages: follows cursors under one binding and stops before the next page once the owner changed', async () => {
    const calls: (string | undefined)[] = [];
    const all = await runOwnerBound((owner) =>
      owner.pages<string>(async (cursor, signal) => {
        expect(signal).toBe(owner.signal);
        calls.push(cursor);
        return { items: [`page-${calls.length}`], nextCursor: calls.length < 3 ? `c${calls.length}` : null };
      }),
    );
    expect(all).toEqual({ status: 'done', value: { items: ['page-1', 'page-2', 'page-3'], found: null } });
    expect(calls).toEqual([undefined, 'c1', 'c2']);

    let scoped = 0;
    const stopped = await runOwnerBound((owner) =>
      owner.pages<string>(async () => {
        scoped += 1;
        adoptActiveOwner(OWNER_B, 'storage');
        return { items: ['A-page'], nextCursor: 'more' };
      }),
    );
    expect(stopped).toEqual({ status: 'stale' });
    expect(scoped).toBe(1);

    adoptActiveOwner(OWNER_A, 'storage');
    let fetched = 0;
    const binding = captureOwnerBinding();
    const lookup = collectPages<string>(binding, async () => {
      fetched += 1;
      adoptActiveOwner(OWNER_B, 'storage');
      return { items: ['A-page'], nextCursor: 'more' };
    });
    await expect(lookup).rejects.toBeInstanceOf(OwnerChangedError);
    expect(fetched).toBe(1);
  });
});

describe('the seal makes even unfenced code inert (and the harness sees unfenced code)', () => {
  let stage: OwnerSwitchStage | null = null;

  afterEach(async () => {
    await stage?.dispose();
    stage = null;
  });

  /** Every mistake at once: nothing is bound, and the owner is read after the await. */
  const Unfenced = defineComponent({
    setup() {
      const toast = useToastStore();
      const router = useRouter();
      const queryClient = useQueryClient();
      async function act(): Promise<void> {
        const availability = await plannerClient.getAvailability({ fresh: true });
        const late = captureOwnerBinding();
        writeLayoutPrefs(late, { autoSwitch: false, locked: null });
        queryClient.setQueryData(['availability'], availability);
        toast.show('saved for whoever is signed in now', { duration: 0 });
        await router.push('/overview');
      }
      return () => h('button', { onClick: () => void act() }, 'go');
    },
  });

  async function switchWhileHeld(seal: boolean): Promise<OwnerSwitchStage> {
    const created = await createOwnerSwitchStage();
    if (seal) {
      installPageSeal();
      refuseNavigationWhenSealed(created.router);
    }
    await created.router.push('/inbox');
    const wrapper = created.mount(Unfenced);
    const held = created.hold({ method: 'GET', path: '/availability' });
    await wrapper.get('button').trigger('click');
    await held.arrived();
    await created.switchOwner();
    held.release();
    await created.settle();
    return created;
  }

  it('without the seal the harness reports the leaks: storage, cache, toast and navigation (negative)', async () => {
    stage = await switchWhileHeld(false);
    const leaks = stage.leaks();
    expect(leaks.storage).toEqual([layoutPrefsKey(OWNER_B)]);
    expect(leaks.cache).toEqual(['["availability"]']);
    expect(leaks.toasts).toEqual(['saved for whoever is signed in now']);
    expect(leaks.navigation).toBe('/tasks -> /overview');
    expect(() => stage?.expectNoLeak()).toThrow();
  });

  it('with the seal (as in production) the same code reaches nothing', async () => {
    stage = await switchWhileHeld(true);
    stage.expectNoLeak();
  });
});

describe('the harness sees each way a request and an owner change can meet (unfenced code)', () => {
  let stage: OwnerSwitchStage | null = null;

  afterEach(async () => {
    await stage?.dispose();
    stage = null;
  });

  /** A plain async handler: no binding, a toast on success and on failure. */
  const Plain = defineComponent({
    setup() {
      const toast = useToastStore();
      async function act(): Promise<void> {
        try {
          await plannerClient.getAvailability({ fresh: true });
          toast.show('saved', { duration: 0 });
        } catch {
          toast.show('could not save', { duration: 0 });
        }
      }
      return () => h('button', { onClick: () => void act() }, 'go');
    },
  });

  /** The same as an owner-bound task. */
  const Bound = defineComponent({
    setup() {
      const toast = useToastStore();
      function act(): Promise<unknown> {
        return runOwnerBound(function* (owner) {
          try {
            yield* owner.wait(plannerClient.getAvailability({ fresh: true }));
            toast.show('saved', { duration: 0 });
          } catch {
            toast.show('could not save', { duration: 0 });
          }
        });
      }
      return () => h('button', { onClick: () => void act() }, 'go');
    },
  });

  async function meet(component: typeof Plain, order: 'late' | 'aborted' | 'gap'): Promise<readonly string[]> {
    const created = await createOwnerSwitchStage();
    stage = created;
    const wrapper = created.mount(component);
    const held = created.hold({ method: 'GET', path: '/availability' });
    await wrapper.get('button').trigger('click');
    await held.arrived();
    if (order === 'gap') {
      held.release();
      queueMicrotask(() => created.switchOwnerNow());
    } else {
      await created.switchOwner();
      held.release({ as: order === 'aborted' ? 'aborted' : 'response' });
    }
    await created.settle();
    const toasts = created.leaks().toasts;
    await created.dispose();
    stage = null;
    return toasts;
  }

  it('unfenced: a late answer, an aborted request and an answer followed by the switch each leak a toast (negative)', async () => {
    expect(await meet(Plain, 'late')).toEqual(['saved']);
    expect(await meet(Plain, 'aborted')).toEqual(['could not save']);
    expect(await meet(Plain, 'gap')).toEqual(['saved']);
  });

  it('owner-bound: none of the three orders reaches the next user', async () => {
    expect(await meet(Bound, 'late')).toEqual([]);
    expect(await meet(Bound, 'aborted')).toEqual([]);
    expect(await meet(Bound, 'gap')).toEqual([]);
  });

  it('the transport does not send a request whose owner changed before it left (no signal parameter needed)', async () => {
    const created = await createOwnerSwitchStage();
    stage = created;
    // The client method is called for A; the owner changes in the next
    // microtask, before openapi-fetch has reached fetch().
    const pending = plannerClient.createCommitment(
      { title: 'A-private', startAt: '2026-11-20T01:00:00.000Z', endAt: '2026-11-20T02:00:00.000Z', timeZone: 'UTC' },
      newActionId('commitment'),
    );
    queueMicrotask(() => created.switchOwnerNow());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(created.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });
});
