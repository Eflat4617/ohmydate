import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { ApiError, createPlannerClient, plannerClient } from '../src/api';
import NotificationsPanel from '../src/components/NotificationsPanel.vue';
import ReplanBanner from '../src/components/ReplanBanner.vue';
import { TODAY_TASK_ONE_TITLE, mockDb } from '../src/mocks/db';
import {
  MOCK_PLAN_ID,
  REPLAN_APPROVED_ID,
  REPLAN_EXPIRED_ID,
  REPLAN_PENDING_ID,
  REPLAN_REJECTED_ID,
  seedReplanScenario,
} from '../src/mocks/replan';
import { sessionJournal } from '../src/session/journal';
import { resetFocusClientIdForTests } from '../src/session/clientId';
import ReplanListView from '../src/views/ReplanListView.vue';
import TodayView from '../src/views/TodayView.vue';
import { mountView, waitForText } from './m5-test-utils';

describe('Pending replan entry points (M5-03)', () => {
  beforeEach(async () => {
    localStorage.clear();
    resetFocusClientIdForTests();
    await sessionJournal.clear();
  });

  it('shows a calm Today banner that links to the single pending proposal', async () => {
    seedReplanScenario(mockDb);
    const { wrapper } = await mountView(TodayView, { path: '/today' });
    await waitForText(wrapper, TODAY_TASK_ONE_TITLE);
    await vi.waitFor(() => expect(wrapper.find('[data-replan-banner]').exists()).toBe(true));
    const banner = wrapper.get('[data-replan-banner]');
    expect(banner.text()).toContain('재계획 제안 1개가 기다리고 있어요');
    expect(banner.text()).toContain('약속과 겹치는 블록이 있어요. 승인하기 전에는 아무것도 바뀌지 않아요.');
    const link = banner.get('a');
    expect(link.text()).toBe('제안 확인하기');
    expect(link.attributes('href')).toBe(`/replan/${REPLAN_PENDING_ID}`);
    // The banner only links: approving needs the full diff on the detail screen.
    expect(banner.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });

  it('shows no banner without pending proposals (negative)', async () => {
    const list = vi.spyOn(plannerClient, 'listReplanProposals');
    const { wrapper } = await mountView(TodayView, { path: '/today' });
    await waitForText(wrapper, TODAY_TASK_ONE_TITLE);
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending' })));
    await list.mock.results[0]?.value;
    expect(wrapper.find('[data-replan-banner]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('links to the list when several proposals wait', async () => {
    const pending = seedReplanScenario(mockDb);
    mockDb.replanProposals.set('01900000-0000-7000-8000-0000000002e1', {
      ...pending,
      id: '01900000-0000-7000-8000-0000000002e1',
      trigger: { ...pending.trigger, kind: 'deadline_risk', reason: 'deadline_slack_negative' },
    });
    const { wrapper } = await mountView(ReplanBanner, { path: '/today' });
    await waitForText(wrapper, '재계획 제안 2개가 기다리고 있어요');
    expect(wrapper.get('a').text()).toBe('모든 제안 보기');
    expect(wrapper.get('a').attributes('href')).toBe('/replan');
    wrapper.unmount();
  });

  it('offers “재계획 요청” on Today only once the server named a plan in a proposal (negative first)', async () => {
    const first = await mountView(TodayView, { path: '/today' });
    await waitForText(first.wrapper, TODAY_TASK_ONE_TITLE);
    expect(first.wrapper.find('[data-replan-request]').exists()).toBe(false);
    first.wrapper.unmount();

    seedReplanScenario(mockDb);
    const request = vi.spyOn(plannerClient, 'requestReplanProposal');
    const second = await mountView(TodayView, { path: '/today' });
    await waitForText(second.wrapper, TODAY_TASK_ONE_TITLE);
    await vi.waitFor(() => expect(second.wrapper.find('[data-replan-request]').exists()).toBe(true));
    await second.wrapper.get('[data-replan-request]').trigger('click');
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await request.mock.results[0]?.value;
    expect(request.mock.calls[0]?.[0]).toEqual({ planId: MOCK_PLAN_ID });
    // Nothing about the plan is kept on the device.
    expect(Object.keys(localStorage).some((key) => key.startsWith('ohmydate.plan'))).toBe(false);
    second.wrapper.unmount();
  });

  it('links a replan notification to its proposal and closes the panel', async () => {
    seedReplanScenario(mockDb);
    const { wrapper, router } = await mountView(NotificationsPanel, { path: '/today', props: { open: true } });
    await vi.waitFor(() => expect(document.querySelector('[data-open-proposal]')).not.toBeNull());
    const link = document.querySelector('[data-open-proposal]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/replan/${REPLAN_PENDING_ID}`);
    expect(link.textContent?.trim()).toBe('제안 보기');
    expect(link.getAttribute('aria-label')).toBe('재계획 제안 보기: 다시 짠 계획 제안이 준비됐어요');
    link.click();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/replan/${REPLAN_PENDING_ID}`));
    expect(wrapper.emitted('close')).toHaveLength(1);
    // Other kinds get no proposal link.
    expect(document.querySelectorAll('[data-open-proposal]')).toHaveLength(1);
    wrapper.unmount();
  });

  it('still renders the notification link without a router (negative)', async () => {
    seedReplanScenario(mockDb);
    const wrapper = mount(NotificationsPanel, {
      props: { open: true },
      global: { plugins: [createPinia()] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(document.querySelector('[data-open-proposal]')).not.toBeNull());
    expect(document.querySelector('[data-open-proposal]')?.getAttribute('href')).toBe(`/replan/${REPLAN_PENDING_ID}`);
    wrapper.unmount();
  });

  it('lists pending proposals first and the read-only history with Korean states', async () => {
    seedReplanScenario(mockDb, { history: true });
    const { wrapper } = await mountView(ReplanListView, { path: '/replan' });
    await waitForText(wrapper, '기다리는 제안');
    await vi.waitFor(() => expect(wrapper.findAll('.replan-item')).toHaveLength(4));
    const pending = wrapper.findAll('.replan-group')[0];
    const history = wrapper.findAll('.replan-group')[1];
    expect(pending?.findAll('.replan-item').map((item) => item.attributes('data-proposal-id'))).toEqual([REPLAN_PENDING_ID]);
    expect(pending?.text()).toContain('승인 대기');
    expect(pending?.text()).toContain('바뀌는 블록 2개');
    expect(history?.findAll('.replan-item').map((item) => item.attributes('data-proposal-id'))).toEqual([
      REPLAN_APPROVED_ID,
      REPLAN_REJECTED_ID,
      REPLAN_EXPIRED_ID,
    ]);
    expect(history?.text()).toContain('승인됨');
    expect(history?.text()).toContain('거절됨');
    expect(history?.text()).toContain('만료됨');
    expect(wrapper.text()).toContain('재계획 제안은 하루 최대 2번이고, 거절한 이유는 24시간 동안 다시 제안하지 않아요.');
    expect(wrapper.text()).not.toMatch(/deadline_risk|user_request|early_completion/);
    wrapper.unmount();
  });

  it('shows empty states without proposals (negative)', async () => {
    const { wrapper } = await mountView(ReplanListView, { path: '/replan' });
    await waitForText(wrapper, '지금 기다리는 재계획 제안이 없어요.');
    expect(wrapper.text()).toContain('아직 지난 제안이 없어요.');
    expect(wrapper.find('[data-replan-request]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('planner client replan contract', () => {
  it('exposes Retry-After on a suppressed request and sends the plan id', async () => {
    mockDb.replanSuppressions.set('user_request', Date.now() + 3_600_000);
    const client = createPlannerClient({ baseUrl: 'http://localhost/api/v1' });
    const failure = await client
      .requestReplanProposal({ planId: MOCK_PLAN_ID }, '0190a3c5-0000-7000-8000-000000000001')
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).code).toBe('replan_suppressed');
    expect((failure as ApiError).retryAfterSeconds).toBeGreaterThan(3_500);
    expect((failure as ApiError).retryAfterSeconds).toBeLessThanOrEqual(3_600);
  });

  it('rejects approval without the availability-prefixed If-Match tag (negative)', async () => {
    seedReplanScenario(mockDb);
    const response = await fetch(`http://localhost/api/v1/replan-proposals/${REPLAN_PENDING_ID}:approve`, {
      method: 'POST',
      headers: { 'If-Match': 'W/"2"', 'Idempotency-Key': '0190a3c5-0000-7000-8000-000000000002', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(mockDb.replanProposals.get(REPLAN_PENDING_ID)?.state).toBe('pending');
  });
});
