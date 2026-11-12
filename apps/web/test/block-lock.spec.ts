import { focusManager } from '@tanstack/vue-query';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { http, HttpResponse } from 'msw';
import { createPinia } from 'pinia';
import { defineComponent } from 'vue';
import { createPlannerClient, newActionId, plannerClient, type Plan, type PlanBlock } from '../src/api';
import BlockLockToggle from '../src/components/BlockLockToggle.vue';
import WeekCalendar from '../src/components/WeekCalendar.vue';
import { useBlockLock } from '../src/composables/useBlockLock';
import { setLayoutClock } from '../src/layout/clock';
import {
  TODAY_BLOCK_ONE_ID,
  TODAY_BLOCK_TWO_ID,
  TODAY_TASK_ONE_TITLE,
  TODAY_TASK_TWO_TITLE,
  mockDb,
} from '../src/mocks/db';
import { REPLAN_PENDING_ID, seedReplanScenario } from '../src/mocks/replan';
import { server } from '../src/mocks/server';
import { useOfflineStore } from '../src/stores/offline';
import { useToastStore } from '../src/stores/toast';
import PlanComparisonView from '../src/views/PlanComparisonView.vue';
import ReplanProposalView from '../src/views/ReplanProposalView.vue';
import TodayView from '../src/views/TodayView.vue';
import { useTestClock } from './m6-layout-utils';
import { mountView, waitForText } from './m5-test-utils';
import { mountWithPlugins, settle, testRouter } from './planning-test-utils';

/**
 * FU-71 — the lock toggle on approved blocks: Today cards and the plan's
 * approved schedule toggle it (`POST /schedule-blocks/{id}:lock|:unlock`), the
 * replan proposal only shows it. Owner switches are covered by the sweep
 * (test/support/ownerSwitchCases.ts: "today: lock a block", "plans: lock an
 * approved block").
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_PATH = /\/api\/v1\/schedule-blocks\/[^/]+:(lock|unlock)$/;

interface SeenRequest {
  readonly url: string;
  readonly ifMatch: string | null;
  readonly key: string | null;
}

/**
 * Record every lock request and hold it until `release()`; then run
 * `beforeServer` (a change landing just before ours) and fall through to the
 * mock handler.
 */
function holdLockRequests(beforeServer: () => void = () => {}) {
  const seen: SeenRequest[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.post(LOCK_PATH, async ({ request }) => {
      seen.push({
        url: new URL(request.url).pathname,
        ifMatch: request.headers.get('If-Match'),
        key: request.headers.get('Idempotency-Key'),
      });
      await gate;
      beforeServer();
      return undefined;
    }),
  );
  return { seen, release: () => release() };
}

function toggleIn(root: Pick<DOMWrapper<Element>, 'find'>): DOMWrapper<Element> {
  return root.find('button[data-block-lock]');
}

/**
 * The accessible description of `element` (aria-describedby: the referenced
 * elements' text, space-joined); a dangling id shows up as `<missing id>`.
 */
function describedText(root: Pick<VueWrapper, 'find'>, element: Pick<DOMWrapper<Element>, 'attributes'>): string {
  const ids = (element.attributes('aria-describedby') ?? '').split(/\s+/).filter((id) => id.length > 0);
  return ids
    .map((id) => {
      const target = root.find(`[id="${id}"]`);
      return target.exists() ? target.text().replace(/\s+/g, ' ').trim() : `<missing ${id}>`;
    })
    .join(' ');
}

/** A pointer drag on a calendar block: press at `fromY`, move to `toY`, release (1 px = 1 min). */
function pointerDrag(block: DOMWrapper<Element> | undefined, fromY: number, toY: number): void {
  if (block === undefined) throw new Error('calendar block missing');
  block.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: fromY }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientY: toY }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientY: toY }));
}

const NETWORK_ERROR = '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.';
const NOT_LOCKABLE = '이미 시작했거나 끝난 블록은 고정을 바꿀 수 없어요. 최신 일정을 다시 불러왔어요.';
const SAVING_HINT = '블록 고정을 저장하는 동안에는 일정안을 편집할 수 없어요. 저장이 끝나면 다시 편집할 수 있어요.';

describe('BlockLockToggle', () => {
  it('unlocked: a native button named "블록 고정", aria-pressed=false, a click asks to toggle', async () => {
    const wrapper = mount(BlockLockToggle, { props: { locked: false } });
    const button = wrapper.get('button');
    expect(button.attributes('type')).toBe('button');
    expect(button.text()).toBe('블록 고정');
    expect(button.attributes('aria-pressed')).toBe('false');
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
  });

  it('locked: still named "블록 고정" (FU-86), aria-pressed=true and the lock icon', () => {
    const wrapper = mount(BlockLockToggle, { props: { locked: true } });
    const button = wrapper.get('button');
    expect(button.text()).toBe('블록 고정');
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(button.attributes('data-block-lock')).toBe('locked');
    expect(button.find('svg').exists()).toBe(true);
  });

  it('pending or disabled never asks to toggle (negative)', async () => {
    const pending = mount(BlockLockToggle, { props: { locked: true, pending: true } });
    expect(pending.get('button').attributes('disabled')).toBeDefined();
    expect(pending.get('button').attributes('aria-busy')).toBe('true');
    await pending.get('button').trigger('click');
    expect(pending.emitted('toggle')).toBeUndefined();
    const disabled = mount(BlockLockToggle, { props: { locked: false, disabled: true } });
    await disabled.get('button').trigger('click');
    expect(disabled.emitted('toggle')).toBeUndefined();
  });

  it('FU-86: one name in both states (from its text, no aria-label); the description names the block', () => {
    for (const locked of [false, true]) {
      const wrapper = mount(BlockLockToggle, { props: { locked, describedBy: 'block-title block-time' } });
      const button = wrapper.get('button');
      expect(button.text()).toBe('블록 고정');
      expect(button.attributes('aria-label')).toBeUndefined();
      expect(button.attributes('aria-pressed')).toBe(locked ? 'true' : 'false');
      expect(button.attributes('aria-describedby')).toBe('block-title block-time');
    }
    // No description given: no dangling aria-describedby (negative).
    const bare = mount(BlockLockToggle, { props: { locked: false } });
    expect(bare.get('button').attributes('aria-describedby')).toBeUndefined();
  });

  it('read-only shows a locked badge and no button; nothing for an unlocked block', () => {
    const locked = mount(BlockLockToggle, { props: { locked: true, readOnly: true } });
    expect(locked.find('button').exists()).toBe(false);
    expect(locked.text()).toBe('고정됨');
    expect(locked.find('svg').exists()).toBe(true);
    const unlocked = mount(BlockLockToggle, { props: { locked: false, readOnly: true } });
    expect(unlocked.find('button').exists()).toBe(false);
    expect(unlocked.text()).toBe('');
  });
});

describe('Today: lock a block', () => {
  beforeEach(() => {
    localStorage.clear();
    // 18:40 in Seoul on the mock day: both blocks are still ahead.
    useTestClock();
  });

  afterEach(() => {
    vi.useRealTimers();
    setLayoutClock(null);
  });

  async function mountToday(): Promise<VueWrapper> {
    const { wrapper } = await mountView(TodayView, { path: '/today' });
    await waitForText(wrapper, TODAY_TASK_ONE_TITLE);
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).exists()).toBe(true));
    return wrapper;
  }

  function card(wrapper: VueWrapper, blockId: string) {
    return wrapper.get(`.today-card[data-block-id="${blockId}"]`);
  }

  it('shows the locked state at once, sends If-Match + Idempotency-Key, then re-reads Today', async () => {
    const wrapper = await mountToday();
    const versionBefore = mockDb.today.version;
    const held = holdLockRequests();
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');

    // Optimistic: pressed and busy while the request is out.
    await vi.waitFor(() => expect(held.seen).toHaveLength(1));
    const pending = toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID));
    expect(pending.attributes('aria-pressed')).toBe('true');
    expect(pending.attributes('disabled')).toBeDefined();
    expect(held.seen[0]).toMatchObject({ url: `/api/v1/schedule-blocks/${TODAY_BLOCK_ONE_ID}:lock`, ifMatch: 'W/"1"' });
    expect(held.seen[0]?.key).toMatch(UUID_V7);
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toBeUndefined();

    held.release();
    // Settled once the refresh is in and the optimistic state is dropped.
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    const done = toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID));
    expect(done.text()).toBe('블록 고정');
    expect(done.attributes('aria-pressed')).toBe('true');
    expect(done.attributes('data-block-lock')).toBe('locked');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: true, version: 2 });
    expect(mockDb.today.version).toBe(versionBefore + 1);
    expect(useToastStore().toasts.map((toast) => toast.message)).toContain(
      '블록을 고정했어요. 재계획해도 이 블록은 옮기지 않아요.',
    );
    // A locked block can be neither shrunk nor moved; the other card still can.
    const lockedActions = card(wrapper, TODAY_BLOCK_ONE_ID).findAll('button');
    for (const label of ['축소', '재배치']) {
      expect(lockedActions.find((item) => item.text() === label)?.attributes('disabled')).toBeDefined();
      expect(
        card(wrapper, TODAY_BLOCK_TWO_ID).findAll('button').find((item) => item.text() === label)?.attributes('disabled'),
      ).toBeUndefined();
    }

    // Unlocking sends the new version and frees the block again.
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(held.seen).toHaveLength(2));
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).text()).toBe('블록 고정');
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('aria-pressed')).toBe('false');
    expect(held.seen[1]).toMatchObject({ url: `/api/v1/schedule-blocks/${TODAY_BLOCK_ONE_ID}:unlock`, ifMatch: 'W/"2"' });
    expect(held.seen[1]?.key).not.toBe(held.seen[0]?.key);
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: false, version: 3 });
    wrapper.unmount();
  });

  it('a 412 drops the optimistic state, explains it and shows the block as the server has it (negative)', async () => {
    const wrapper = await mountToday();
    // Locked in another tab just before our request lands: we still send version 1.
    const held = holdLockRequests(() => {
      if (mockDb.todayBlockLocks.has(TODAY_BLOCK_ONE_ID)) return;
      mockDb.todayBlockLocks.set(TODAY_BLOCK_ONE_ID, { locked: true, version: 2 });
    });
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(held.seen).toHaveLength(1));
    expect(held.seen[0]?.ifMatch).toBe('W/"1"');
    held.release();

    await waitForText(wrapper, '이 블록이 다른 곳에서 바뀌었어요. 최신 일정을 다시 불러왔어요.');
    expect(wrapper.get('.block-lock-error').attributes('role')).toBe('alert');
    // Refreshed: the server's state, not the optimistic one and not the stale one.
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('data-block-lock')).toBe('locked'));
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).text()).toBe('블록 고정');
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('aria-pressed')).toBe('true');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: true, version: 2 });
    expect(useToastStore().toasts).toHaveLength(0);

    // The next press carries the fresh version and succeeds.
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(held.seen).toHaveLength(2));
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).text()).toBe('블록 고정');
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('aria-pressed')).toBe('false');
    expect(held.seen[1]?.ifMatch).toBe('W/"2"');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: false, version: 3 });
    wrapper.unmount();
  });

  it('a block that has started shows only the locked badge, no toggle (negative)', async () => {
    mockDb.todayBlockLocks.set(TODAY_BLOCK_ONE_ID, { locked: true, version: 2 });
    // 19:10 in Seoul: block one (19:00–20:30) has started, block two has not.
    useTestClock(Date.parse('2026-11-14T10:10:00.000Z'));
    const { wrapper } = await mountView(TodayView, { path: '/today' });
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_TWO_ID)).exists()).toBe(true));
    const started = card(wrapper, TODAY_BLOCK_ONE_ID);
    expect(started.find('button[data-block-lock]').exists()).toBe(false);
    expect(started.get('[data-block-lock="locked"]').text()).toBe('고정됨');
    wrapper.unmount();
  });

  it('FU-86: every toggle has the same name; each is described by its own card title and time', async () => {
    const wrapper = await mountToday();
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_TWO_ID)).exists()).toBe(true));
    const rows = [
      { id: TODAY_BLOCK_ONE_ID, title: TODAY_TASK_ONE_TITLE },
      { id: TODAY_BLOCK_TWO_ID, title: TODAY_TASK_TWO_TITLE },
    ];
    const descriptions = rows.map(({ id, title }) => {
      const toggle = toggleIn(card(wrapper, id));
      expect(toggle.text()).toBe('블록 고정');
      expect(toggle.attributes('aria-label')).toBeUndefined();
      const time = card(wrapper, id).get('.today-time .tabular').text();
      expect(time).toMatch(/\d{1,2}:\d{2}/);
      const description = describedText(wrapper, toggle);
      expect(description).toBe(`${title} ${time}`);
      return description;
    });
    // Two rows, two different descriptions: a screen reader can tell them apart.
    expect(descriptions[0]).not.toBe(descriptions[1]);
    // Locking changes the state, not the name or the description.
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    const locked = toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID));
    expect(locked.attributes('aria-pressed')).toBe('true');
    expect(locked.text()).toBe('블록 고정');
    expect(describedText(wrapper, locked)).toBe(descriptions[0]);
    wrapper.unmount();
  });

  it('FU-86: a 409 (the block just started) explains, re-reads and drops the toggle at once, before the layout tick', async () => {
    // The 30 s layout tick is frozen: only the 409 branch can move the shared clock.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // 18:59:50 in Seoul: block one (19:00–20:30) is still ahead.
    const clock = useTestClock(Date.parse('2026-11-14T09:59:50.000Z'));
    const wrapper = await mountToday();
    // The block starts; without a tick the page still offers its toggle.
    clock.set(Date.parse('2026-11-14T10:00:10.000Z'));
    await settle();
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).exists()).toBe(true);
    const todayReads = vi.spyOn(plannerClient, 'getToday');
    const blockReads = vi.spyOn(plannerClient, 'listScheduleBlocks');
    const held = holdLockRequests();
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(held.seen).toHaveLength(1));
    expect(todayReads).not.toHaveBeenCalled();
    held.release();

    await waitForText(wrapper, NOT_LOCKABLE);
    expect(wrapper.get('.block-lock-error').attributes('role')).toBe('alert');
    // Gone without advancing any timer; an unlocked started block shows nothing.
    await vi.waitFor(() => expect(card(wrapper, TODAY_BLOCK_ONE_ID).find('[data-block-lock]').exists()).toBe(false));
    // Re-read: the Today revision and the block list.
    await vi.waitFor(() => {
      expect(todayReads).toHaveBeenCalled();
      expect(blockReads).toHaveBeenCalled();
    });
    // Nothing changed on the server and no success toast; the later block keeps its toggle (negative).
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toBeUndefined();
    expect(useToastStore().toasts).toHaveLength(0);
    expect(toggleIn(card(wrapper, TODAY_BLOCK_TWO_ID)).exists()).toBe(true);
    expect(toggleIn(card(wrapper, TODAY_BLOCK_TWO_ID)).attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('FU-86: a network failure keeps the action; the retry reuses its Idempotency-Key and If-Match', async () => {
    const wrapper = await mountToday();
    const seen: SeenRequest[] = [];
    let failNext = true;
    server.use(
      http.post(LOCK_PATH, ({ request }) => {
        seen.push({
          url: new URL(request.url).pathname,
          ifMatch: request.headers.get('If-Match'),
          key: request.headers.get('Idempotency-Key'),
        });
        if (failNext) {
          failNext = false;
          return HttpResponse.error();
        }
        return undefined;
      }),
    );
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await waitForText(wrapper, NETWORK_ERROR);
    expect(wrapper.get('.block-lock-error').attributes('role')).toBe('alert');
    // The optimistic state is dropped and the toggle is free for the retry.
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('aria-pressed')).toBe('false');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toBeUndefined();

    // The retry is the same logical request: same key, same If-Match.
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]?.key).toMatch(UUID_V7);
    expect(seen[1]).toEqual(seen[0]);
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('aria-pressed')).toBe('true');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: true, version: 2 });
    expect(wrapper.find('.block-lock-error').exists()).toBe(false);

    // Settled: the next press (unlock) is a new action with a new key (negative).
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2]?.key).not.toBe(seen[0]?.key);
    expect(seen[2]).toMatchObject({ url: `/api/v1/schedule-blocks/${TODAY_BLOCK_ONE_ID}:unlock`, ifMatch: 'W/"2"' });
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    wrapper.unmount();
  });

  it('FU-86: offline, every toggle is disabled and a press sends nothing (negative)', async () => {
    const wrapper = await mountToday();
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_TWO_ID)).exists()).toBe(true));
    const offline = useOfflineStore();
    offline.setOnline(false);
    await settle();
    const held = holdLockRequests();
    for (const id of [TODAY_BLOCK_ONE_ID, TODAY_BLOCK_TWO_ID]) {
      expect(toggleIn(card(wrapper, id)).attributes('disabled')).toBeDefined();
      await toggleIn(card(wrapper, id)).trigger('click');
    }
    await settle();
    expect(held.seen).toHaveLength(0);
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('aria-pressed')).toBe('false');
    // Back online, the toggles work again.
    offline.setOnline(true);
    await settle();
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('useBlockLock guards', () => {
  it('offline, toggle() itself sends nothing, whatever a button shows (negative)', async () => {
    const pinia = createPinia();
    const refresh = vi.fn(async () => undefined);
    let lock: ReturnType<typeof useBlockLock> | undefined;
    const Harness = defineComponent({
      setup() {
        lock = useBlockLock({ refresh });
        return () => null;
      },
    });
    const wrapper = mount(Harness, { global: { plugins: [pinia] } });
    useOfflineStore(pinia).setOnline(false);
    const held = holdLockRequests();
    await lock?.toggle({
      id: TODAY_BLOCK_ONE_ID,
      locked: false,
      version: 1,
      status: 'planned',
      startAt: '2026-11-14T10:00:00.000Z',
    });
    await settle();
    expect(held.seen).toHaveLength(0);
    expect(lock?.isPending(TODAY_BLOCK_ONE_ID)).toBe(false);
    expect(lock?.anyPending.value).toBe(false);
    expect(lock?.error.value).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('FU-86F: a lost answer re-reads the screen, and stays pending until that re-read is in', async () => {
    const pinia = createPinia();
    let finishRefresh: () => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    let lock: ReturnType<typeof useBlockLock> | undefined;
    const Harness = defineComponent({
      setup() {
        lock = useBlockLock({ refresh });
        return () => null;
      },
    });
    const wrapper = mount(Harness, { global: { plugins: [pinia] } });
    server.use(http.post(LOCK_PATH, () => HttpResponse.error()));
    const done = lock?.toggle({
      id: TODAY_BLOCK_ONE_ID,
      locked: false,
      version: 1,
      status: 'planned',
      startAt: '2026-11-14T10:00:00.000Z',
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(lock?.error.value).toBe(NETWORK_ERROR);
    // Still held: the plan page keeps its calendar locked until the revision is known.
    expect(lock?.isPending(TODAY_BLOCK_ONE_ID)).toBe(true);
    expect(lock?.anyPending.value).toBe(true);
    finishRefresh();
    await done;
    expect(lock?.anyPending.value).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});

describe('Plan comparison: lock an approved block', () => {
  /** The plan the page shows (set by mountPlan). */
  let shown: Plan | undefined;

  beforeEach(() => {
    localStorage.clear();
    useTestClock();
  });

  afterEach(() => {
    setLayoutClock(null);
  });

  async function mountPlan(): Promise<VueWrapper> {
    const task = [...mockDb.tasks.values()][0];
    if (task === undefined) throw new Error('seed task missing');
    const plan: Plan = await createPlannerClient().createPlan(
      {
        scope: { taskIds: [task.id] },
        horizon: { start: '2026-11-11T00:00:00.000Z', end: '2026-11-25T00:00:00.000Z' },
        policies: ['front_loaded'],
      },
      newActionId('plan-create'),
    );
    shown = plan;
    const router = testRouter();
    await router.push(`/plans/${plan.id}`);
    await router.isReady();
    const wrapper = mountWithPlugins(PlanComparisonView, { router, pinia: createPinia() });
    await settle();
    await vi.waitFor(() => expect(wrapper.find(`[data-approved-block-id="${TODAY_BLOCK_ONE_ID}"] button[data-block-lock]`).exists()).toBe(true));
    return wrapper;
  }

  function rowToggle(wrapper: VueWrapper) {
    return wrapper.get(`[data-approved-block-id="${TODAY_BLOCK_ONE_ID}"] button[data-block-lock]`);
  }

  it('locks from the approved schedule and pauses locks while the candidate draft is edited', async () => {
    const wrapper = await mountPlan();
    expect(rowToggle(wrapper).text()).toBe('블록 고정');
    expect(rowToggle(wrapper).attributes('aria-pressed')).toBe('false');
    await rowToggle(wrapper).trigger('click');
    await vi.waitFor(() => expect(rowToggle(wrapper).attributes('aria-pressed')).toBe('true'));
    await vi.waitFor(() => expect(rowToggle(wrapper).attributes('disabled')).toBeUndefined());
    expect(rowToggle(wrapper).text()).toBe('블록 고정');
    expect(rowToggle(wrapper).attributes('data-block-lock')).toBe('locked');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: true, version: 2 });

    // Editing a candidate: a plan re-read would reset the draft, so locks wait.
    await vi.waitFor(() => expect(wrapper.findAll('.calendar-block').length).toBeGreaterThan(0));
    await wrapper.findAll('.calendar-block')[0]?.trigger('keydown', { key: 'ArrowDown' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('일정안을 편집하는 동안에는 고정을 바꿀 수 없어요.'));
    expect(rowToggle(wrapper).attributes('disabled')).toBeDefined();
    const held = holdLockRequests();
    await rowToggle(wrapper).trigger('click');
    await settle();
    expect(held.seen).toHaveLength(0);
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: true, version: 2 });
    wrapper.unmount();
  });

  /** As the server does (08 §2.5.1): a lock of this plan's block moves plan.version. */
  function lockMovesPlanRevision(): void {
    const plan = shown === undefined ? undefined : mockDb.plans.get(shown.id);
    if (plan === undefined) throw new Error('shown plan missing');
    mockDb.plans.set(plan.id, { ...plan, version: plan.version + 1 });
  }

  function calendarLabels(wrapper: VueWrapper): Array<string | undefined> {
    return wrapper.findAll('.calendar-block').map((block) => block.attributes('aria-label'));
  }

  it('FU-86: an edit tried while a lock is out is held with the reason shown, never dropped by the plan re-read', async () => {
    const wrapper = await mountPlan();
    const planId = shown?.id ?? '';
    const versionBefore = mockDb.plans.get(planId)?.version ?? -1;
    await vi.waitFor(() => expect(wrapper.findAll('.calendar-block').length).toBeGreaterThan(0));
    const note = wrapper.get('#plan-lock-saving-note');
    expect(note.attributes('role')).toBe('status');
    expect(note.text()).toBe('');
    const before = calendarLabels(wrapper);
    const previews: Array<string | null> = [];
    server.use(
      http.post(/\/candidates\/[^/]+:preview-edit$/, ({ request }) => {
        previews.push(request.headers.get('If-Match'));
        return undefined;
      }),
    );

    // A clean draft; the lock is out.
    const held = holdLockRequests(lockMovesPlanRevision);
    await rowToggle(wrapper).trigger('click');
    await vi.waitFor(() => expect(held.seen).toHaveLength(1));
    expect(wrapper.text()).toContain('생성된 블록');

    // The keyboard move is held: the draft stays clean and the reason is shown and announced.
    await wrapper.findAll('.calendar-block')[0]?.trigger('keydown', { key: 'ArrowDown' });
    await settle();
    expect(note.text()).toBe(SAVING_HINT);
    expect(wrapper.text()).not.toContain('편집한 블록');
    expect(calendarLabels(wrapper)).toEqual(before);
    for (const block of wrapper.findAll('.calendar-block')) {
      expect(block.attributes('aria-describedby')).toBe('plan-lock-saving-note');
    }
    // A drag that reaches the page is held too (the page's guard, not only the calendar's).
    const moved: PlanBlock[] = (shown?.candidates[0]?.blocks ?? []).map((block) => ({
      ...block,
      startAt: new Date(Date.parse(block.startAt) + 15 * 60_000).toISOString(),
      endAt: new Date(Date.parse(block.endAt) + 15 * 60_000).toISOString(),
    }));
    expect(moved.length).toBeGreaterThan(0);
    wrapper.findComponent(WeekCalendar).vm.$emit('update:blocks', moved);
    await settle();
    expect(wrapper.text()).not.toContain('편집한 블록');
    expect(calendarLabels(wrapper)).toEqual(before);

    // The lock lands and the plan is re-read at its new revision.
    held.release();
    await vi.waitFor(() => expect(rowToggle(wrapper).attributes('disabled')).toBeUndefined());
    expect(rowToggle(wrapper).attributes('aria-pressed')).toBe('true');
    expect(mockDb.plans.get(planId)?.version).toBe(versionBefore + 1);
    expect(note.text()).toBe('');
    expect(wrapper.findAll('.calendar-block')[0]?.attributes('aria-describedby')).toBeUndefined();
    expect(previews).toEqual([]);

    // Editing works again; the edit stays, previews against the new revision, and locks now wait for it.
    await wrapper.findAll('.calendar-block')[0]?.trigger('keydown', { key: 'ArrowDown' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('편집한 블록'));
    expect(calendarLabels(wrapper)).not.toEqual(before);
    await vi.waitFor(() => expect(previews).toEqual([`W/"${versionBefore + 1}"`]));
    await settle();
    expect(wrapper.text()).toContain('편집한 블록');
    expect(rowToggle(wrapper).attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('FU-86F: while a lock is out the calendar itself refuses edits (no resize handle, a pointer drag emits nothing); only a held edit shows the reason', async () => {
    const wrapper = await mountPlan();
    await vi.waitFor(() => expect(wrapper.findAll('.calendar-block').length).toBeGreaterThan(0));
    const calendar = wrapper.findComponent(WeekCalendar);
    const note = wrapper.get('#plan-lock-saving-note');
    // Editable before the lock: every block has its resize handle (positive control).
    expect(wrapper.findAll('.calendar-resize')).toHaveLength(wrapper.findAll('.calendar-block').length);
    const before = calendarLabels(wrapper);

    const held = holdLockRequests(lockMovesPlanRevision);
    await rowToggle(wrapper).trigger('click');
    await vi.waitFor(() => expect(held.seen).toHaveLength(1));
    // The calendar's own state, independent of the page's guard.
    expect(calendar.props('editable')).toBe(false);
    expect(wrapper.findAll('.calendar-resize')).toHaveLength(0);
    // Pressing a toggle alone says nothing about the calendar: nobody is editing it (negative).
    expect(note.text()).toBe('');
    expect(note.classes()).not.toContain('block-lock-saving--shown');
    for (const block of wrapper.findAll('.calendar-block')) {
      expect(block.attributes('aria-describedby')).toBeUndefined();
    }

    // pointerdown + pointermove on a block: the calendar emits no change at all.
    pointerDrag(wrapper.findAll('.calendar-block')[0], 0, 30);
    await settle();
    expect(calendar.emitted('update:blocks')).toBeUndefined();
    expect(calendarLabels(wrapper)).toEqual(before);
    expect(wrapper.text()).not.toContain('편집한 블록');
    // That held press is what shows (and announces) the reason, over the calendar.
    expect(calendar.emitted('edit-blocked')).toEqual([[0]]);
    expect(note.text()).toBe(SAVING_HINT);
    expect(note.attributes('role')).toBe('status');
    expect(note.classes()).toContain('block-lock-saving--shown');
    expect(note.element.parentElement?.classList.contains('calendar-frame')).toBe(true);
    for (const block of wrapper.findAll('.calendar-block')) {
      expect(block.attributes('aria-describedby')).toBe('plan-lock-saving-note');
    }

    held.release();
    await vi.waitFor(() => expect(rowToggle(wrapper).attributes('disabled')).toBeUndefined());
    expect(note.text()).toBe('');
    expect(note.classes()).not.toContain('block-lock-saving--shown');
    // Editable again: the handles are back and the same drag edits the draft.
    expect(calendar.props('editable')).toBe(true);
    expect(wrapper.findAll('.calendar-resize').length).toBeGreaterThan(0);
    pointerDrag(wrapper.findAll('.calendar-block')[0], 0, 30);
    await vi.waitFor(() => expect(wrapper.text()).toContain('편집한 블록'));
    expect(calendar.emitted('update:blocks')).toHaveLength(1);
    expect(calendarLabels(wrapper)).not.toEqual(before);
    wrapper.unmount();
  });

  it('FU-86F: a lock whose answer is lost re-reads the plan before the calendar is released; an edit then goes with the new revision', async () => {
    const wrapper = await mountPlan();
    const planId = shown?.id ?? '';
    const versionBefore = mockDb.plans.get(planId)?.version ?? -1;
    await vi.waitFor(() => expect(wrapper.findAll('.calendar-block').length).toBeGreaterThan(0));
    const before = calendarLabels(wrapper);
    const previews: Array<string | null> = [];
    server.use(
      http.post(/\/candidates\/[^/]+:preview-edit$/, ({ request }) => {
        previews.push(request.headers.get('If-Match'));
        return undefined;
      }),
      // The server applies the lock (the block and the plan revision move), then the answer is lost.
      http.post(LOCK_PATH, () => {
        mockDb.todayBlockLocks.set(TODAY_BLOCK_ONE_ID, { locked: true, version: 2 });
        lockMovesPlanRevision();
        return HttpResponse.error();
      }),
    );
    const planReads = vi.spyOn(plannerClient, 'getPlan');

    await rowToggle(wrapper).trigger('click');
    await waitForText(wrapper, NETWORK_ERROR);
    expect(wrapper.get('.block-lock-error').attributes('role')).toBe('alert');
    // Released only after the re-read: the server's lock, the plan at its new revision, a clean draft.
    await vi.waitFor(() => expect(rowToggle(wrapper).attributes('disabled')).toBeUndefined());
    expect(planReads).toHaveBeenCalled();
    expect(mockDb.plans.get(planId)?.version).toBe(versionBefore + 1);
    expect(rowToggle(wrapper).attributes('aria-pressed')).toBe('true');
    expect(rowToggle(wrapper).attributes('data-block-lock')).toBe('locked');
    expect(wrapper.text()).toContain('생성된 블록');
    expect(calendarLabels(wrapper)).toEqual(before);

    // An edit now previews against the new revision — no 412 (negative) — and is kept.
    await wrapper.findAll('.calendar-block')[0]?.trigger('keydown', { key: 'ArrowDown' });
    await vi.waitFor(() => expect(previews).toEqual([`W/"${versionBefore + 1}"`]));
    await settle();
    expect(wrapper.text()).toContain('편집한 블록');
    expect(wrapper.text()).not.toContain('다른 곳에서 먼저 바뀌었어요.');
    // A later re-read (window focus) finds the same revision: the edit stays.
    const readsBefore = planReads.mock.calls.length;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.waitFor(() => expect(planReads.mock.calls.length).toBeGreaterThan(readsBefore));
    await settle();
    expect(wrapper.text()).toContain('편집한 블록');
    expect(calendarLabels(wrapper)).not.toEqual(before);
    wrapper.unmount();
    focusManager.setFocused(undefined);
    planReads.mockRestore();
  });

  it('FU-86: the approved-schedule toggles keep one name and are described by their row title and time', async () => {
    const wrapper = await mountPlan();
    const row = wrapper.get(`[data-approved-block-id="${TODAY_BLOCK_ONE_ID}"]`);
    const toggle = rowToggle(wrapper);
    expect(toggle.text()).toBe('블록 고정');
    expect(toggle.attributes('aria-label')).toBeUndefined();
    const title = row.get('.approved-schedule-title').text();
    const time = row.get('.approved-schedule-time').text();
    expect(title).toBe(TODAY_TASK_ONE_TITLE);
    expect(time).toMatch(/\d{1,2}:\d{2}/);
    expect(describedText(wrapper, toggle)).toBe(`${title} ${time}`);
    const other = wrapper.find(`[data-approved-block-id="${TODAY_BLOCK_TWO_ID}"] button[data-block-lock]`);
    expect(other.exists()).toBe(true);
    expect(describedText(wrapper, other)).not.toBe(describedText(wrapper, toggle));
    wrapper.unmount();
  });

  it('FU-86: offline, the approved-schedule toggle is disabled and a press sends nothing (negative)', async () => {
    const wrapper = await mountPlan();
    expect(rowToggle(wrapper).attributes('disabled')).toBeUndefined();
    useOfflineStore().setOnline(false);
    await settle();
    expect(rowToggle(wrapper).attributes('disabled')).toBeDefined();
    const held = holdLockRequests();
    await rowToggle(wrapper).trigger('click');
    await settle();
    expect(held.seen).toHaveLength(0);
    expect(rowToggle(wrapper).attributes('aria-pressed')).toBe('false');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toBeUndefined();
    wrapper.unmount();
  });
});

describe('Replan proposal: locks are read-only', () => {
  it('lists the locked block with its badge and offers no lock toggle', async () => {
    seedReplanScenario(mockDb);
    const { wrapper } = await mountView(ReplanProposalView, {
      path: `/replan/${REPLAN_PENDING_ID}`,
      props: { id: REPLAN_PENDING_ID },
    });
    await waitForText(wrapper, '바뀌는 블록');
    await vi.waitFor(() => expect(wrapper.findAll('[data-locked]')).toHaveLength(1));
    const locked = wrapper.get('[data-locked]');
    expect(locked.get('[data-block-lock="locked"]').text()).toBe('고정됨');
    expect(wrapper.find('button[data-block-lock]').exists()).toBe(false);
    expect(wrapper.findAll('button').some((item) => ['블록 고정', '고정 해제'].includes(item.text()))).toBe(false);
    expect(wrapper.text()).toContain('고정은 오늘 화면이나 일정안 비교 화면의 확정된 일정에서 바꿀 수 있어요.');
    wrapper.unmount();
  });
});
