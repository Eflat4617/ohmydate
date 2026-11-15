import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { ApiError, createPlannerClient, plannerClient } from '../src/api';
import NotificationsPanel from '../src/components/NotificationsPanel.vue';
import PlannerWeek from '../src/components/planner/PlannerWeek.vue';
import ReplanCard from '../src/components/replan/ReplanCard.vue';
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
import ReplanView from '../src/views/ReplanView.vue';
import TodayView from '../src/views/TodayView.vue';
import { mountView, waitForText } from './m5-test-utils';

describe('Pending replan entry points (M5-03)', () => {
  beforeEach(async () => {
    localStorage.clear();
    resetFocusClientIdForTests();
    await sessionJournal.clear();
  });

  // HOLO-03A (FLOW §2 ⑥): the same card on every screen where the plan is looked at.
  it('오늘 says a proposal waits, with why and how much would move, and links to its 전 → 후', async () => {
    seedReplanScenario(mockDb);
    const { wrapper } = await mountView(TodayView, { path: '/today' });
    await waitForText(wrapper, TODAY_TASK_ONE_TITLE);
    await vi.waitFor(() => expect(wrapper.find('[data-replan-card]').exists()).toBe(true));
    const card = wrapper.get('[data-replan-card]');
    expect(card.get('h2').text()).toBe('일정을 다시 맞출까요?');
    expect(card.get('[data-replan-card-reason]').text()).toBe('약속과 겹치는 블록이 있어요 · 바뀌는 블록 2개');
    expect(card.text()).toContain('승인하기 전에는 아무것도 바뀌지 않아요.');
    const link = card.get('[data-replan-card-open]');
    expect(link.text()).toBe('전 → 후 보기');
    expect(link.attributes('href')).toBe(`/replan/${REPLAN_PENDING_ID}`);
    // The card only links: approving needs the whole comparison, and it is never the screen's filled button.
    expect(card.findAll('button')).toHaveLength(0);
    expect(card.find('.btn--primary').exists()).toBe(false);
    expect(card.text()).not.toMatch(/commitment_overlap|commitment_conflict/);
    wrapper.unmount();
  });

  it('shows no card without pending proposals (negative)', async () => {
    const list = vi.spyOn(plannerClient, 'listReplanProposals');
    const { wrapper } = await mountView(TodayView, { path: '/today' });
    await waitForText(wrapper, TODAY_TASK_ONE_TITLE);
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending' })));
    await list.mock.results[0]?.value;
    expect(wrapper.find('[data-replan-card]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('links to the list when several proposals wait', async () => {
    const pending = seedReplanScenario(mockDb);
    mockDb.replanProposals.set('01900000-0000-7000-8000-0000000002e1', {
      ...pending,
      id: '01900000-0000-7000-8000-0000000002e1',
      trigger: { ...pending.trigger, kind: 'deadline_risk', reason: 'deadline_slack_negative' },
    });
    const { wrapper } = await mountView(ReplanCard, { path: '/today' });
    await waitForText(wrapper, '제안 2개가 기다리고 있어요');
    expect(wrapper.get('[data-replan-card-open]').text()).toBe('제안 모두 보기');
    expect(wrapper.get('[data-replan-card-open]').attributes('href')).toBe('/replan');
    wrapper.unmount();
  });

  it('플래너 carries the same card above the week, and nothing when no proposal waits (negative)', async () => {
    const quiet = await mountView(PlannerWeek, { path: '/planner' });
    await vi.waitFor(() => expect(quiet.wrapper.find('.wg-item').exists()).toBe(true));
    expect(quiet.wrapper.find('[data-replan-card]').exists()).toBe(false);
    quiet.wrapper.unmount();

    seedReplanScenario(mockDb);
    const { wrapper } = await mountView(PlannerWeek, { path: '/planner' });
    await vi.waitFor(() => expect(wrapper.find('[data-replan-card]').exists()).toBe(true));
    expect(wrapper.get('[data-replan-card-open]').attributes('href')).toBe(`/replan/${REPLAN_PENDING_ID}`);
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

  it('lists every proposal beside the one on show: the one that waits first, then the history, in Korean', async () => {
    seedReplanScenario(mockDb, { history: true });
    const { wrapper } = await mountView(ReplanView, { path: '/replan' });
    await vi.waitFor(() => expect(wrapper.findAll('.replan-item')).toHaveLength(4));
    const list = wrapper.get('[data-replan-list]');
    expect(list.get('h2').text()).toBe('제안 기록');
    const rows = list.findAll('.replan-item');
    expect(rows.map((item) => item.attributes('data-proposal-id'))).toEqual([
      REPLAN_PENDING_ID,
      REPLAN_APPROVED_ID,
      REPLAN_REJECTED_ID,
      REPLAN_EXPIRED_ID,
    ]);
    expect(rows.map((item) => item.attributes('data-state'))).toEqual(['pending', 'approved', 'rejected', 'expired']);
    expect(rows[0]?.text()).toContain('승인 대기');
    expect(rows[0]?.text()).toContain('바뀌는 블록 2개');
    expect(rows[1]?.text()).toContain('승인됨');
    expect(rows[2]?.text()).toContain('거절됨');
    expect(rows[3]?.text()).toContain('만료됨');
    expect(rows.map((item) => item.get('a').attributes('href'))).toEqual(
      [REPLAN_PENDING_ID, REPLAN_APPROVED_ID, REPLAN_REJECTED_ID, REPLAN_EXPIRED_ID].map((id) => `/replan/${id}`),
    );
    expect(wrapper.text()).toContain('재계획 제안은 하루 최대 2번이고, 거절한 이유는 24시간 동안 다시 제안하지 않아요.');
    expect(wrapper.text()).not.toMatch(/deadline_risk|user_request|early_completion/);

    // `/replan` shows the newest proposal that waits — and marks it in the list.
    await vi.waitFor(() => expect(wrapper.find('[data-replan-approve]').exists()).toBe(true));
    expect(wrapper.get('[data-replan-trigger]').text()).toBe('약속과 겹침');
    expect(rows[0]?.get('a').attributes('aria-current')).toBe('true');
    expect(rows.slice(1).every((item) => item.get('a').attributes('aria-current') === undefined)).toBe(true);
    wrapper.unmount();
  });

  // Found in the visual check: at `/replan` the approved proposal vanished into "nothing waits".
  it('at `/replan` the proposal taken up stays on show after it is approved, with the way to 오늘', async () => {
    const pending = seedReplanScenario(mockDb);
    // An older proposal waits too: the newest one is taken up.
    const older = '01900000-0000-7000-8000-0000000002e7';
    mockDb.replanProposals.set(older, {
      ...pending,
      id: older,
      createdAt: '2026-11-14T08:00:00.000Z',
      trigger: { ...pending.trigger, kind: 'deadline_risk', reason: 'deadline_slack_negative' },
    });
    const { wrapper } = await mountView(ReplanView, { path: '/replan' });
    await vi.waitFor(() => expect(wrapper.find('[data-replan-approve]').exists()).toBe(true));
    expect(wrapper.get('[data-replan-trigger]').text()).toBe('약속과 겹침');
    await wrapper.get('[data-replan-approve]').trigger('click');
    await vi.waitFor(() => expect(mockDb.replanProposals.get(pending.id)?.state).toBe('approved'));
    await waitForText(wrapper, '제안을 승인했어요. 새 일정이 반영됐어요.');
    expect(wrapper.get('[data-proposal-state]').text()).toBe('승인됨');
    expect(wrapper.get('[data-replan-today]').attributes('href')).toBe('/today');
    expect(wrapper.find('[data-replan-none]').exists()).toBe(false);

    // Approving changed the plan, so the other proposal ran out (05 §11). Neither it nor
    // "nothing waits" takes the place of what was just approved (negative).
    await vi.waitFor(() => expect(wrapper.get(`[data-proposal-id="${pending.id}"]`).attributes('data-state')).toBe('approved'));
    expect(wrapper.get('[data-replan-trigger]').text()).toBe('약속과 겹침');
    expect(wrapper.get(`[data-proposal-id="${pending.id}"] a`).attributes('aria-current')).toBe('true');
    expect(wrapper.get(`[data-proposal-id="${older}"]`).attributes('data-state')).toBe('expired');
    expect(wrapper.get(`[data-proposal-id="${older}"] a`).attributes('aria-current')).toBeUndefined();
    expect(wrapper.find('[data-replan-approve]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('`/replan/:id` shows that proposal read-only with the same list, and offers to ask again', async () => {
    seedReplanScenario(mockDb, { history: true });
    const { wrapper } = await mountView(ReplanView, { path: `/replan/${REPLAN_REJECTED_ID}`, props: { id: REPLAN_REJECTED_ID } });
    await waitForText(wrapper, '거절한 제안이에요.');
    expect(wrapper.get('[data-replan-trigger]').text()).toBe('마감 위험');
    expect(wrapper.find('[data-replan-approve]').exists()).toBe(false);
    expect(wrapper.find('[data-replan-reject]').exists()).toBe(false);
    expect(wrapper.get('[data-replan-again] [data-replan-request]').text()).toContain('재계획 요청');
    expect(wrapper.get(`[data-proposal-id="${REPLAN_REJECTED_ID}"] a`).attributes('aria-current')).toBe('true');
    expect(wrapper.get(`[data-proposal-id="${REPLAN_PENDING_ID}"] a`).attributes('aria-current')).toBeUndefined();
    wrapper.unmount();
  });

  it('says the plan is on track when nothing waits, and offers to ask once a plan is known', async () => {
    const pending = seedReplanScenario(mockDb);
    mockDb.replanProposals.set(pending.id, { ...pending, state: 'expired', version: pending.version + 1 });
    const { wrapper } = await mountView(ReplanView, { path: '/replan' });
    await waitForText(wrapper, '지금은 계획대로예요');
    const none = wrapper.get('[data-replan-none]');
    expect(none.text()).toContain('일정이 밀리거나 약속이 새로 생기면 여기에서 새 일정을 제안해요.');
    expect(none.get('[data-replan-request]').text()).toContain('재계획 요청');
    // The expired proposal stays in the history, and is not put on show as if it waited.
    expect(wrapper.findAll('.replan-item')).toHaveLength(1);
    expect(wrapper.find('[data-replan-trigger]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('with no proposal and no plan it leads back to 계획 세우기 instead of offering a request (negative)', async () => {
    const { wrapper } = await mountView(ReplanView, { path: '/replan' });
    await waitForText(wrapper, '지금은 계획대로예요');
    const none = wrapper.get('[data-replan-none]');
    expect(none.text()).toContain('확정한 일정이 생기면 여기에서 다시 맞출 수 있어요.');
    expect(none.get('a').text()).toBe('계획 세우기');
    expect(none.get('a').attributes('href')).toBe('/plan');
    expect(wrapper.get('[data-replan-list-empty]').text()).toBe('아직 제안이 없어요.');
    expect(wrapper.find('[data-replan-request]').exists()).toBe(false);
    // An empty state is never the screen's filled button.
    expect(wrapper.find('.btn--primary').exists()).toBe(false);
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
