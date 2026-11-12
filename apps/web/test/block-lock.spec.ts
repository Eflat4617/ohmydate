import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { http } from 'msw';
import { createPinia } from 'pinia';
import { createPlannerClient, newActionId, type Plan } from '../src/api';
import BlockLockToggle from '../src/components/BlockLockToggle.vue';
import { setLayoutClock } from '../src/layout/clock';
import { TODAY_BLOCK_ONE_ID, TODAY_BLOCK_TWO_ID, TODAY_TASK_ONE_TITLE, mockDb } from '../src/mocks/db';
import { REPLAN_PENDING_ID, seedReplanScenario } from '../src/mocks/replan';
import { server } from '../src/mocks/server';
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

  it('locked: named "고정 해제" with aria-pressed=true and the lock icon', () => {
    const wrapper = mount(BlockLockToggle, { props: { locked: true } });
    const button = wrapper.get('button');
    expect(button.text()).toBe('고정 해제');
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
    expect(done.text()).toBe('고정 해제');
    expect(done.attributes('aria-pressed')).toBe('true');
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
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).text()).toBe('고정 해제'));
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('aria-pressed')).toBe('true');
    expect(mockDb.todayBlockLocks.get(TODAY_BLOCK_ONE_ID)).toEqual({ locked: true, version: 2 });
    expect(useToastStore().toasts).toHaveLength(0);

    // The next press carries the fresh version and succeeds.
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    await toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).trigger('click');
    await vi.waitFor(() => expect(held.seen).toHaveLength(2));
    await vi.waitFor(() => expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).attributes('disabled')).toBeUndefined());
    expect(toggleIn(card(wrapper, TODAY_BLOCK_ONE_ID)).text()).toBe('블록 고정');
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
});

describe('Plan comparison: lock an approved block', () => {
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
    await rowToggle(wrapper).trigger('click');
    await vi.waitFor(() => expect(rowToggle(wrapper).attributes('aria-pressed')).toBe('true'));
    await vi.waitFor(() => expect(rowToggle(wrapper).attributes('disabled')).toBeUndefined());
    expect(rowToggle(wrapper).text()).toBe('고정 해제');
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
