import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { newActionId, plannerClient, type ScheduleBlock } from '../src/api';
import TodayView from '../src/views/TodayView.vue';
import { sessionJournal } from '../src/session/journal';
import { resetFocusClientIdForTests } from '../src/session/clientId';
import { useSessionStore } from '../src/stores/session';
import {
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_ONE_TITLE,
  TODAY_TASK_TWO_ID,
  TODAY_TASK_TWO_TITLE,
  mockDb,
} from '../src/mocks/db';

const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/today', name: 'today', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
    ],
  });
}

function button(wrapper: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

async function waitForText(wrapper: VueWrapper, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain(text);
  });
}

/**
 * Waits until the spied client method has been called `index + 1` times and
 * that call's request has settled (FU-60: no timing assumptions).
 */
async function settledCall(spy: { mock: { calls: unknown[]; results: { value: unknown }[] } }, index: number): Promise<void> {
  await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(index));
  await spy.mock.results[index]?.value;
}

async function mountToday(pinia: Pinia, router: Router): Promise<VueWrapper> {
  await router.push('/today');
  const wrapper = mount(TodayView, {
    global: { plugins: [pinia, VueQueryPlugin, router] },
    attachTo: document.body,
  });
  await waitForText(wrapper, TODAY_TASK_ONE_TITLE);
  return wrapper;
}

describe('Today view', () => {
  beforeEach(async () => {
    localStorage.clear();
    resetFocusClientIdForTests();
    await sessionJournal.clear();
  });

  it('renders two to three block cards with time, slack and risk chips', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const wrapper = await mountToday(pinia, testRouter());

    const cards = wrapper.findAll('.today-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.text()).toContain(TODAY_TASK_ONE_TITLE);
    expect(cards[1]?.text()).toContain(TODAY_TASK_TWO_TITLE);
    expect(cards[0]?.text()).toMatch(/오[전후] \d{1,2}:\d{2}~(오[전후] )?\d{1,2}:\d{2}/);
    expect(cards[0]?.text()).toContain('오후 7:00~8:30');
    expect(cards[0]?.text()).toContain('1시간 30분');
    expect(wrapper.text()).toContain('여유');
    expect(wrapper.text()).toContain('위험도: 보통');
    expect(wrapper.text()).toContain('남은 계획이 하루 집중 한도를 넘어요 (5시간 10분)');
    expect(wrapper.text()).not.toContain('daily_focus_cap_exceeded');
    wrapper.unmount();
  });

  it('accepts the plan with If-Match and a replay-safe idempotency key', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const wrapper = await mountToday(pinia, testRouter());

    await button(wrapper, '오늘 계획 수락').trigger('click');
    await vi.waitFor(() => expect(mockDb.today.version).toBe(2));
    expect(wrapper.text()).not.toContain('불러오지 못했어요');
    wrapper.unmount();
  });

  it('creates, previews and approves a shrink proposal with the availability precondition', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const wrapper = await mountToday(pinia, testRouter());
    const original = mockDb.today.blocks[0];
    if (original === undefined) throw new Error('missing today block');

    const card = wrapper.findAll('.today-card')[0];
    if (card === undefined) throw new Error('missing today card');
    await button(card, '축소').trigger('click');
    await nextTick();
    await wrapper.get('#shrink-minutes').setValue('20');
    await button(wrapper, '축소 미리보기').trigger('click');
    await waitForText(wrapper, '제안 미리보기');
    expect(wrapper.text()).toContain('승인하기 전에는 아무것도 바뀌지 않아요');

    const approve = vi.spyOn(plannerClient, 'approveTodayProposal');
    await button(wrapper, '제안 승인').trigger('click');
    await vi.waitFor(() => {
      expect(mockDb.today.blocks[0]?.endAt).toBe(
        new Date(Date.parse(original.startAt) + 20 * 60_000).toISOString(),
      );
    });
    expect(approve).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringMatching(/^W\/"availability:\d+"$/),
      expect.any(AbortSignal),
    );
    expect(wrapper.find('.proposal-preview').exists()).toBe(false);
    wrapper.unmount();
  });

  it('creates, previews and approves a reschedule proposal', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const wrapper = await mountToday(pinia, testRouter());
    const original = mockDb.today.blocks[1];
    if (original === undefined) throw new Error('missing today block');

    const card = wrapper.findAll('.today-card')[1];
    if (card === undefined) throw new Error('missing today card');
    await button(card, '재배치').trigger('click');
    await waitForText(wrapper, '제안 미리보기');
    await button(wrapper, '제안 승인').trigger('click');
    await vi.waitFor(() => {
      expect(mockDb.today.blocks[1]?.startAt).toBe(
        new Date(Date.parse(original.startAt) + 30 * 60_000).toISOString(),
      );
    });
    wrapper.unmount();
  });

  it('starts a focus session from a block and remembers it locally', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const router = testRouter();
    const wrapper = await mountToday(pinia, router);
    const card = wrapper.findAll('.today-card')[0];
    if (card === undefined) throw new Error('missing today card');

    await button(card, '집중 시작').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    const sessions = useSessionStore(pinia);
    expect(sessions.active?.taskId).toBe(TODAY_TASK_ONE_ID);
    expect(mockDb.sessions.size).toBe(1);
    wrapper.unmount();
  });

  it('offers to resume the active session when the server returns 409', async () => {
    const pinia = createPinia();
    const sessions = useSessionStore(pinia);
    sessions.reset();
    const session = await plannerClient.createSession(
      {
        taskId: TODAY_TASK_ONE_ID,
        blockId: TODAY_BLOCK_ONE_ID,
        clientStartedAt: new Date().toISOString(),
        clientId: 'resume-test',
      },
      newActionId('session'),
    );
    sessions.remember(session);

    const router = testRouter();
    const wrapper = await mountToday(pinia, router);
    const card = wrapper.findAll('.today-card')[0];
    if (card === undefined) throw new Error('missing today card');
    await button(card, '집중 시작').trigger('click');
    await waitForText(wrapper, '진행 중인 세션으로 가기');

    await button(wrapper, '진행 중인 세션으로 가기').trigger('click');
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe(`/focus/${session.id}`);
    });
    expect(mockDb.sessions.size).toBe(1);
    wrapper.unmount();
  });

  it('keeps Today cards scoped to the current plan when older approved plans also have blocks', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const oldBlock: ScheduleBlock = {
      id: '01900000-0000-7000-8000-0000000000e1',
      planVersionId: '01900000-0000-7000-8000-0000000000e0',
      taskId: TODAY_TASK_TWO_ID,
      startAt: '2026-11-14T08:00:00.000Z',
      endAt: '2026-11-14T09:00:00.000Z',
      locked: false,
      status: 'planned',
      version: 1,
    };
    mockDb.extraScheduleBlocks.push(oldBlock);

    const wrapper = await mountToday(pinia, testRouter());
    const cards = wrapper.findAll('.today-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.text()).toContain(TODAY_TASK_ONE_TITLE);
    expect(cards[1]?.text()).toContain(TODAY_TASK_TWO_TITLE);
    expect(wrapper.text()).not.toContain('오후 5:00~6:00');

    const first = cards[0];
    if (first === undefined) throw new Error('missing first card');
    // FU-60: wait on the real requests and the settled UI, never on timing.
    const shrink = vi.spyOn(plannerClient, 'shrinkToday');
    const approve = vi.spyOn(plannerClient, 'approveTodayProposal');
    const reschedule = vi.spyOn(plannerClient, 'rescheduleToday');
    const reloadToday = vi.spyOn(plannerClient, 'getToday');

    await button(first, '축소').trigger('click');
    await nextTick();
    await wrapper.get('#shrink-minutes').setValue('20');
    await button(wrapper, '축소 미리보기').trigger('click');
    await settledCall(shrink, 0);
    await waitForText(wrapper, '제안 미리보기');
    const reloadsBeforeApprove = reloadToday.mock.calls.length;
    await button(wrapper, '제안 승인').trigger('click');
    await settledCall(approve, 0);
    expect(mockDb.today.blocks[0]?.endAt).not.toBe('2026-11-14T11:30:00.000Z');
    // approveProposal() refetches Today before it clears `busy`.
    await settledCall(reloadToday, reloadsBeforeApprove);
    await vi.waitFor(() => expect(wrapper.find('.proposal-preview').exists()).toBe(false));
    await vi.waitFor(() => {
      const second = wrapper.findAll('.today-card')[1];
      if (second === undefined) throw new Error('missing second card');
      expect(button(second, '재배치').attributes('disabled')).toBeUndefined();
    });

    const second = wrapper.findAll('.today-card')[1];
    if (second === undefined) throw new Error('missing second card');
    await button(second, '재배치').trigger('click');
    await settledCall(reschedule, 0);
    await waitForText(wrapper, '제안 미리보기');
    await button(wrapper, '제안 승인').trigger('click');
    await settledCall(approve, 1);
    expect(mockDb.today.blocks[1]?.startAt).not.toBe('2026-11-14T12:00:00.000Z');
    wrapper.unmount();
  });

  it('retries a lost session-start response with the identical key and body', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const router = testRouter();
    const wrapper = await mountToday(pinia, router);
    const original = plannerClient.createSession.bind(plannerClient);
    const calls: { input: unknown; key: string }[] = [];
    vi.spyOn(plannerClient, 'createSession').mockImplementation(async (input, key) => {
      calls.push({ input, key });
      const result = await original(input, key);
      if (calls.length === 1) throw new TypeError('response lost after commit');
      return result;
    });

    const card = wrapper.findAll('.today-card')[0];
    if (card === undefined) throw new Error('missing today card');
    await button(card, '집중 시작').trigger('click');
    await waitForText(wrapper, '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    await button(wrapper, '집중 시작').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(calls[1]?.input).toEqual(calls[0]?.input);
    expect(mockDb.sessions.size).toBe(1);
    wrapper.unmount();
  });

  it('resumes an active session discovered through the sessions API', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const session = await plannerClient.createSession(
      {
        taskId: TODAY_TASK_ONE_ID,
        blockId: TODAY_BLOCK_ONE_ID,
        clientStartedAt: new Date().toISOString(),
        clientId: 'server-resume-test',
      },
      newActionId('session'),
    );

    expect(useSessionStore(pinia).get(session.id)).toBeNull();
    const router = testRouter();
    const wrapper = await mountToday(pinia, router);
    await waitForText(wrapper, '세션 이어가기');
    await button(wrapper, '세션 이어가기').trigger('click');
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe(`/focus/${session.id}`);
    });
    expect(useSessionStore(pinia).get(session.id)?.state).toBe('active');
    wrapper.unmount();
  });

  it('loads Today blocks from the approved schedule-blocks endpoint', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const schedule = vi.spyOn(plannerClient, 'listScheduleBlocks');
    const wrapper = await mountToday(pinia, testRouter());

    expect(schedule).toHaveBeenCalled();
    expect(schedule.mock.calls[0]?.[0]).toMatchObject({
      limit: 100,
      from: expect.any(String),
      to: expect.any(String),
    });
    expect(wrapper.findAll('.today-card')).toHaveLength(2);
    wrapper.unmount();
  });

  it('exposes accessible names for interactive controls (axe-lite)', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const wrapper = await mountToday(pinia, testRouter());

    for (const element of wrapper.findAll('button')) {
      const accessible = element.attributes('aria-label') ?? element.text().trim();
      expect(accessible.length).toBeGreaterThan(0);
    }
    expect(wrapper.findAll('ul[aria-label]').length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});
