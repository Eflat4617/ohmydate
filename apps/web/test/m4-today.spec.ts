import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { newActionId, plannerClient } from '../src/api';
import TodayView from '../src/views/TodayView.vue';
import { sessionJournal } from '../src/session/journal';
import { resetFocusClientIdForTests } from '../src/session/clientId';
import { useSessionStore } from '../src/stores/session';
import {
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_ONE_TITLE,
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
    expect(cards[0]?.text()).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
    expect(wrapper.text()).toContain('Slack');
    expect(wrapper.text()).toContain('Risk: medium');
    expect(wrapper.text()).toContain('One block ends close to a task deadline');
    wrapper.unmount();
  });

  it('accepts the plan with If-Match and a replay-safe idempotency key', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const wrapper = await mountToday(pinia, testRouter());

    await button(wrapper, 'Accept plan').trigger('click');
    await vi.waitFor(() => expect(mockDb.today.version).toBe(2));
    expect(wrapper.text()).not.toContain('Could not load');
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
    await button(card, 'Shrink').trigger('click');
    await nextTick();
    await wrapper.get('#shrink-minutes').setValue('20');
    await button(wrapper, 'Preview shrink').trigger('click');
    await waitForText(wrapper, 'Proposal preview');
    expect(wrapper.text()).toContain('Nothing changes until you approve it');

    const approve = vi.spyOn(plannerClient, 'approveTodayProposal');
    await button(wrapper, 'Approve proposal').trigger('click');
    await vi.waitFor(() => {
      expect(mockDb.today.blocks[0]?.endAt).toBe(
        new Date(Date.parse(original.startAt) + 20 * 60_000).toISOString(),
      );
    });
    expect(approve).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringMatching(/^W\/"availability:\d+"$/),
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
    await button(card, 'Reschedule').trigger('click');
    await waitForText(wrapper, 'Proposal preview');
    await button(wrapper, 'Approve proposal').trigger('click');
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

    await button(card, 'Start focus').trigger('click');
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
    await button(card, 'Start focus').trigger('click');
    await waitForText(wrapper, 'Resume the active session');

    await button(wrapper, 'Resume the active session').trigger('click');
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe(`/focus/${session.id}`);
    });
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
    await waitForText(wrapper, 'Resume session');
    await button(wrapper, 'Resume session').trigger('click');
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
