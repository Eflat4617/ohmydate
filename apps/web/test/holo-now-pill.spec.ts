import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin, onlineManager } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plannerClient } from '../src/api';
import NowPill from '../src/components/NowPill.vue';
import { clearFocusContexts, rememberFocusBlocks } from '../src/composables/focusContext';
import { setLayoutClock } from '../src/layout/clock';
import { TODAY_BLOCK_ONE_ID, TODAY_TASK_ONE_ID, mockDb, seedMonth } from '../src/mocks/db';
import { OVERVIEW_RUNNING_SESSION_ID, seedOverviewSessions } from '../src/mocks/overview-seed';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useOfflineStore } from '../src/stores/offline';

/**
 * HOLO-04 지금 알약 (FLOW.md §4): on every screen, the running focus session
 * with its time, or the next block of today with a start button. Never a
 * filled button, and not there when there is nothing to say.
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul; the next block is 19:00.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/notes', name: 'notes', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
    ],
  });
}

async function mountPill(path = '/notes'): Promise<{ wrapper: VueWrapper; router: Router; pinia: Pinia }> {
  const router = testRouter();
  await router.push(path);
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(NowPill, { global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, router, pinia };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  setLayoutClock({ now: () => NOW });
  clearFocusContexts();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setLayoutClock(null);
  onlineManager.setOnline(true);
  document.body.innerHTML = '';
});

describe('지금 알약 — the next block', () => {
  it('names the next block with when it starts, and starts it from wherever the owner is', async () => {
    seedMonth(mockDb);
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountPill('/notes');
    const pill = await vi.waitFor(() => wrapper.get('[data-now-pill]'));
    expect(pill.attributes('data-now')).toBe('next');
    expect(pill.get('[data-now-time]').text()).toBe('오후 7:00');
    expect(pill.get('.now-pill-title').text()).toBe('연구 노트 요약');
    // The name is read out once; the parts on show are decoration for a screen reader.
    expect(pill.get('[data-now-next]').attributes('aria-label')).toBe('다음 블록 오후 7:00 연구 노트 요약. 개요에서 보기');
    expect(pill.get('[data-now-next]').attributes('href')).toBe('/overview');
    const start = pill.get('[data-now-start]');
    expect(start.attributes('aria-label')).toBe('‘연구 노트 요약’ 집중 시작');
    // Never a filled button: the page keeps its one lime thing (negative).
    expect(wrapper.find('.btn--primary').exists()).toBe(false);

    await start.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: TODAY_TASK_ONE_ID, blockId: TODAY_BLOCK_ONE_ID });
  });

  it('says 지금 for a block whose time has come', async () => {
    seedMonth(mockDb);
    // 19:10 in Seoul: inside the 19:00 block.
    setLayoutClock({ now: () => Date.parse('2026-11-14T10:10:00.000Z') });
    const { wrapper } = await mountPill();
    const pill = await vi.waitFor(() => wrapper.get('[data-now-pill]'));
    expect(pill.get('[data-now-time]').text()).toBe('지금');
  });

  it('offline: the block is still named but cannot be started (negative: no request)', async () => {
    seedMonth(mockDb);
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, pinia } = await mountPill('/notes');
    await vi.waitFor(() => expect(wrapper.find('[data-now-start]').exists()).toBe(true));
    useOfflineStore(pinia).setOnline(false);
    await nextTick();
    const start = wrapper.get('[data-now-start]');
    expect(wrapper.get('.now-pill-title').text()).toBe('연구 노트 요약');
    expect(start.attributes('disabled')).toBeDefined();
    await start.trigger('click');
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
  });

  it('is not there with nothing planned and nothing running (negative)', async () => {
    mockDb.today = { ...mockDb.today, blocks: [] };
    const { wrapper } = await mountPill();
    await flushPromises();
    await nextTick();
    expect(wrapper.find('[data-now-pill]').exists()).toBe(false);
  });
});

describe('지금 알약 — a session is running', () => {
  it('shows the task and the time left of its block, and opens the timer', async () => {
    seedMonth(mockDb);
    seedOverviewSessions(mockDb, { running: true });
    const session = mockDb.sessions.get(OVERVIEW_RUNNING_SESSION_ID);
    if (session === undefined) throw new Error('the mock has no running session');
    // What a screen that started it remembered: a 90-minute block for this session's task.
    const started = Date.parse(session.startedAt);
    rememberFocusBlocks(
      mockDb.user.id,
      [
        {
          id: session.blockId ?? TODAY_BLOCK_ONE_ID,
          taskId: session.taskId,
          title: '연구 노트 요약',
          startAt: new Date(started).toISOString(),
          endAt: new Date(started + 90 * 60_000).toISOString(),
        },
      ],
      'Asia/Seoul',
    );
    const { wrapper, router } = await mountPill();
    const pill = await vi.waitFor(() => {
      const found = wrapper.get('[data-now-pill]');
      expect(found.attributes('data-now')).toBe('active');
      return found;
    });
    expect(pill.get('.now-pill-title').text()).toBe('연구 노트 요약');
    expect(pill.get('[data-now-time]').text()).toMatch(/남음$/);
    expect(pill.get('[data-now-open]').attributes('aria-label')).toMatch(/^집중 중: 연구 노트 요약, .*남음\. 집중 화면 열기$/);
    // No start button while one runs (negative): there is one session at a time.
    expect(pill.find('[data-now-start]').exists()).toBe(false);

    await pill.get('[data-now-open]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(`/focus/${session.id}`));
  });

  it('shows the time spent when the session has no block to count down from', async () => {
    seedMonth(mockDb);
    seedOverviewSessions(mockDb, { running: true });
    const { wrapper } = await mountPill();
    const pill = await vi.waitFor(() => {
      const found = wrapper.get('[data-now-pill]');
      expect(found.attributes('data-now')).toBe('active');
      return found;
    });
    expect(pill.get('[data-now-time]').text()).toMatch(/^\d{2}:\d{2}(:\d{2})?$/);
  });

  it('steps aside on the timer itself (negative)', async () => {
    seedMonth(mockDb);
    seedOverviewSessions(mockDb, { running: true });
    const { wrapper } = await mountPill(`/focus/${OVERVIEW_RUNNING_SESSION_ID}`);
    await flushPromises();
    await nextTick();
    expect(wrapper.find('[data-now-pill]').exists()).toBe(false);
  });
});
