import { ApiError, plannerClient, type ReplanProposal } from '../src/api';
import ReplanRequestButton from '../src/components/ReplanRequestButton.vue';
import { TODAY_TASK_ONE_ID, TODAY_TASK_TWO_ID, mockDb } from '../src/mocks/db';
import { MOCK_PLAN_ID, REPLAN_PENDING_ID, seedReplanScenario } from '../src/mocks/replan';
import { FEEDBACK_IDS } from '../src/mocks/replan-seed';
import InsightsView from '../src/views/InsightsView.vue';
import ReplanView from '../src/views/ReplanView.vue';
import { buttonWith, mountView, waitForText } from './m5-test-utils';

/**
 * M5-03R-1 regressions.
 * H1: the diff and the metrics come only from the server's authoritative
 *     `before` snapshot (FU-70) — never from a client calendar window.
 * M1: a transient answer (network loss, 409 idempotency_in_progress) keeps the
 *     logical action's Idempotency-Key; only a stored final result rotates it.
 */

const FAR_TASK = TODAY_TASK_ONE_ID;
const NEAR_TASK = TODAY_TASK_TWO_ID;
const LOCKED_TASK = '01900000-0000-7000-8000-0000000003a1';
const REMOVED_TASK = '01900000-0000-7000-8000-0000000003a2';
const REVIEW_ID = '01900000-0000-7000-8000-0000000003f1';

function block(id: string, taskId: string, startAt: string, endAt: string, locked = false) {
  return { id, planVersionId: '01900000-0000-7000-8000-0000000000d1', taskId, startAt, endAt, locked, status: 'planned' as const, version: 1 };
}

/** Reviewer case: original A on 2026-12-15, candidate A on 2026-11-15 (+ far removal and a far locked block). */
function reviewerProposal(overrides: Partial<ReplanProposal> = {}): ReplanProposal {
  return {
    id: REVIEW_ID,
    state: 'pending',
    planId: MOCK_PLAN_ID,
    basePlanVersion: 3,
    trigger: {
      kind: 'user_request',
      reason: 'user_request',
      detectedAt: '2026-11-14T09:30:00.000Z',
      affectedTaskIds: [FAR_TASK, REMOVED_TASK],
    },
    basePlanVersionId: '01900000-0000-7000-8000-0000000000d1',
    availabilityVersion: mockDb.availabilityVersion,
    candidate: {
      blocks: [
        { taskId: FAR_TASK, startAt: '2026-11-15T10:00:00.000Z', endAt: '2026-11-15T11:00:00.000Z' },
        { taskId: NEAR_TASK, startAt: '2026-11-16T02:00:00.000Z', endAt: '2026-11-16T02:40:00.000Z' },
      ],
      metrics: {
        totalFocusMin: 160,
        minSlackMin: 2_000,
        maxDailyLoadMin: 60,
        avgDailyLoadMin: 50,
        contextSwitches: 1,
        changedBlocks: 3,
        deficitMin: 0,
        capacityDeficitMin: 0,
        p90CoverageRatio: 1,
      },
      changedBlocks: 3,
      bound: 6,
      flags: [],
      explanation: [],
      explanationItems: [],
    },
    before: {
      capturedAt: '2026-11-14T09:30:00.000Z',
      blocks: [
        block('01900000-0000-7000-8000-0000000003b1', NEAR_TASK, '2026-11-16T02:00:00.000Z', '2026-11-16T02:40:00.000Z'),
        block('01900000-0000-7000-8000-0000000003b2', FAR_TASK, '2026-12-15T10:00:00.000Z', '2026-12-15T11:00:00.000Z'),
        block('01900000-0000-7000-8000-0000000003b3', LOCKED_TASK, '2027-01-05T10:00:00.000Z', '2027-01-05T11:00:00.000Z', true),
        block('01900000-0000-7000-8000-0000000003b4', REMOVED_TASK, '2027-01-10T10:00:00.000Z', '2027-01-10T11:00:00.000Z'),
      ],
      metrics: {
        totalFocusMin: 220,
        minSlackMin: -45,
        taskSlack: [
          { taskId: FAR_TASK, dueAt: '2026-12-15T10:15:00.000Z', slackMin: -45 },
          { taskId: NEAR_TASK, dueAt: '2026-11-17T09:00:00.000Z', slackMin: 1_700 },
        ],
      },
    },
    createdAt: '2026-11-14T09:30:00.000Z',
    expiresAt: '2026-11-15T09:30:00.000Z',
    version: 1,
    ...overrides,
  } as ReplanProposal;
}

async function mountProposal(proposal: ReplanProposal) {
  mockDb.replanProposals.set(proposal.id, proposal);
  const mounted = await mountView(ReplanView, { path: `/replan/${proposal.id}`, props: { id: proposal.id } });
  await waitForText(mounted.wrapper, '왜 제안했나요');
  return mounted;
}

describe('M5-03R-1 H1: diff only from the authoritative before snapshot', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports the reviewer case as moved from December 15, the far block as removed and the far locked block as unchanged', async () => {
    const fetches = vi.spyOn(globalThis, 'fetch');
    const { wrapper } = await mountProposal(reviewerProposal());
    await vi.waitFor(() => expect(wrapper.findAll('.replan-change').length).toBe(2));
    const moved = wrapper.get(`.replan-change[data-task-id="${FAR_TASK}"]`);
    expect(moved.attributes('data-change')).toBe('moved');
    expect(moved.get('del').text()).toBe('12월 15일 (화) 오후 7:00~8:00');
    expect(moved.get('ins').text()).toBe('11월 15일 (일) 오후 7:00~8:00');
    expect(wrapper.get(`.replan-change[data-task-id="${REMOVED_TASK}"]`).attributes('data-change')).toBe('removed');
    const locked = wrapper.findAll('[data-locked]');
    expect(locked).toHaveLength(1);
    expect(locked[0]?.attributes('data-block-id')).toBe('01900000-0000-7000-8000-0000000003b3');
    expect(wrapper.text()).toContain('그 밖의 블록 1개는 그대로예요.');
    // No client calendar window is queried any more.
    const urls = fetches.mock.calls.map((call) => String(call[0] instanceof Request ? call[0].url : call[0]));
    expect(urls.some((url) => url.includes('/schedule-blocks'))).toBe(false);
    wrapper.unmount();
  });

  it('shows before metrics from the server snapshot next to the candidate metrics', async () => {
    const { wrapper } = await mountProposal(reviewerProposal());
    await vi.waitFor(() => expect(wrapper.find('[data-metric="slack"]').exists()).toBe(true));
    const slack = wrapper.get('[data-metric="slack"]');
    expect(slack.get('[data-before]').text()).toBe('전 −45분');
    expect(slack.get('[data-after]').text()).toBe('+1일 9시간');
    expect(slack.get('[data-delta]').text()).toBe('+1일 10시간');
    const planned = wrapper.get('[data-metric="planned"]');
    expect(planned.get('[data-before]').text()).toBe('전 3시간 40분');
    expect(planned.get('[data-after]').text()).toBe('2시간 40분');
    expect(planned.get('[data-delta]').text()).toBe('−1시간');
    wrapper.unmount();
  });

  it('never guesses a diff for a legacy proposal without a snapshot and says so', async () => {
    const legacy = reviewerProposal();
    delete (legacy as { before?: unknown }).before;
    const { wrapper } = await mountProposal(legacy);
    await waitForText(wrapper, '이 제안은 비교 정보 없이 저장돼서');
    expect(wrapper.find('.replan-change').exists()).toBe(false);
    // The proposal's own figures are shown; no "전" value and no difference is made up for them.
    expect(wrapper.get('[data-metric="slack"] [data-after]').text()).toBe('+1일 9시간');
    expect(wrapper.find('[data-before]').exists()).toBe(false);
    expect(wrapper.find('[data-delta]').exists()).toBe(false);
    expect(wrapper.find('[data-locked]').exists()).toBe(false);
    expect(wrapper.findAll('[data-proposed-block]')).toHaveLength(2);
    // On the grid too: the proposed blocks, with no "where it stood" and no kind of change.
    await vi.waitFor(() => expect(wrapper.findAll('.wg-item[data-kind="proposal"]')).toHaveLength(2));
    expect(wrapper.find('.wg-item[data-kind="ghost"]').exists()).toBe(false);
    expect(wrapper.find('.wg-item[data-change]').exists()).toBe(false);
    expect(wrapper.get('.replan-week .planner-legend').text()).not.toContain('옮기기 전 자리');
    // Approval itself stays possible; it is only the comparison that is unavailable.
    expect(wrapper.find('[data-replan-approve]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('requests a new replan for the proposal’s own planId without any remembered plan', async () => {
    const processed = reviewerProposal({ state: 'rejected', version: 2 });
    const request = vi.spyOn(plannerClient, 'requestReplanProposal');
    const { wrapper } = await mountProposal(processed);
    await buttonWith(wrapper, '다시 맞추기 요청').trigger('click');
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await request.mock.results[0]?.value;
    expect(request.mock.calls[0]?.[0]).toEqual({ planId: MOCK_PLAN_ID });
    expect(Object.keys(localStorage).some((key) => key.startsWith('ohmydate.plan'))).toBe(false);
    wrapper.unmount();
  });
});

function transient(): [TypeError, ApiError] {
  return [
    new TypeError('Failed to fetch'),
    new ApiError(409, 'idempotency_in_progress', 'Another request with this Idempotency-Key is still in progress', undefined, 1),
  ];
}

describe('M5-03R-1 M1: transient answers keep the logical Idempotency-Key', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('다시 맞추기 요청: timeout → in-progress → success replays with one key', async () => {
    const [lost, busy] = transient();
    const request = vi.spyOn(plannerClient, 'requestReplanProposal');
    request.mockRejectedValueOnce(lost).mockRejectedValueOnce(busy);
    const { wrapper, router } = await mountView(ReplanRequestButton, { path: '/overview', props: { planId: MOCK_PLAN_ID } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await buttonWith(wrapper, '다시 맞추기 요청').trigger('click');
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(attempt + 1));
      await request.mock.results[attempt]?.value?.catch?.(() => undefined);
    }
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/replan\//));
    const keys = request.mock.calls.map((call) => call[1]);
    expect(new Set(keys).size).toBe(1);
    expect([...mockDb.replanProposals.values()].filter((item) => item.trigger.kind === 'user_request')).toHaveLength(1);
    wrapper.unmount();
  });

  it('다시 맞추기 요청: a stored replan_suppressed still rotates the key (negative)', async () => {
    mockDb.replanSuppressions.set('user_request', Date.now() + 3_600_000);
    const request = vi.spyOn(plannerClient, 'requestReplanProposal');
    const { wrapper } = await mountView(ReplanRequestButton, { path: '/overview', props: { planId: MOCK_PLAN_ID } });
    await buttonWith(wrapper, '다시 맞추기 요청').trigger('click');
    await waitForText(wrapper, '지금은 다시 맞추기를 더 요청할 수 없어요.');
    await buttonWith(wrapper, '다시 맞추기 요청').trigger('click');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]?.[1]).not.toBe(request.mock.calls[1]?.[1]);
    wrapper.unmount();
  });

  it('승인 and 거절: timeout → in-progress → success replays with one key each', async () => {
    seedReplanScenario(mockDb);
    const approveSpy = vi.spyOn(plannerClient, 'approveReplanProposal');
    const [lostA, busyA] = transient();
    approveSpy.mockRejectedValueOnce(lostA).mockRejectedValueOnce(busyA);
    const { wrapper } = await mountView(ReplanView, { path: `/replan/${REPLAN_PENDING_ID}`, props: { id: REPLAN_PENDING_ID } });
    await vi.waitFor(() => expect(wrapper.find('[data-replan-approve]').exists()).toBe(true));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.waitFor(() => expect(wrapper.get('[data-replan-approve]').attributes('disabled')).toBeUndefined());
      await wrapper.get('[data-replan-approve]').trigger('click');
      await vi.waitFor(() => expect(approveSpy).toHaveBeenCalledTimes(attempt + 1));
      await approveSpy.mock.results[attempt]?.value?.catch?.(() => undefined);
    }
    await vi.waitFor(() => expect(mockDb.replanProposals.get(REPLAN_PENDING_ID)?.state).toBe('approved'));
    expect(new Set(approveSpy.mock.calls.map((call) => call[1])).size).toBe(1);
    wrapper.unmount();

    // Reject on a fresh pending proposal.
    const fresh = reviewerProposal({ id: '01900000-0000-7000-8000-0000000003f2' });
    const rejectSpy = vi.spyOn(plannerClient, 'rejectReplanProposal');
    const [lostR, busyR] = transient();
    rejectSpy.mockRejectedValueOnce(lostR).mockRejectedValueOnce(busyR);
    const mounted = await mountProposal(fresh);
    await mounted.wrapper.get('[data-replan-reject]').trigger('click');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.waitFor(() => expect(document.querySelector('.replan-reject-dialog')).not.toBeNull());
      const confirm = Array.from(document.querySelectorAll('.replan-reject-dialog button')).find((item) =>
        item.textContent?.includes('거절하기'),
      ) as HTMLButtonElement;
      await vi.waitFor(() => expect(confirm.disabled).toBe(false));
      confirm.click();
      await vi.waitFor(() => expect(rejectSpy).toHaveBeenCalledTimes(attempt + 1));
      await rejectSpy.mock.results[attempt]?.value?.catch?.(() => undefined);
    }
    await vi.waitFor(() => expect(mockDb.replanProposals.get(fresh.id)?.state).toBe('rejected'));
    expect(new Set(rejectSpy.mock.calls.map((call) => call[1])).size).toBe(1);
    mounted.wrapper.unmount();
  });

  it('AI 분석 toggle and reset: timeout → in-progress → success replays with one key each', async () => {
    const patch = vi.spyOn(plannerClient, 'patchEstimationFeedback');
    const [lostP, busyP] = transient();
    patch.mockRejectedValueOnce(lostP).mockRejectedValueOnce(busyP);
    const { wrapper } = await mountView(InsightsView, { path: '/insights' });
    await vi.waitFor(() => expect(wrapper.findAll('.insights-record').length).toBe(6));
    const toggle = () => wrapper.get(`[data-feedback-id="${FEEDBACK_IDS.one}"] [data-include]`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.waitFor(() => expect(toggle().attributes('disabled')).toBeUndefined());
      await toggle().trigger('change');
      await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(attempt + 1));
      await patch.mock.results[attempt]?.value?.catch?.(() => undefined);
    }
    await vi.waitFor(() => expect(mockDb.estimation.items.find((item) => item.feedbackId === FEEDBACK_IDS.one)?.excluded).toBe(true));
    expect(new Set(patch.mock.calls.map((call) => call[2])).size).toBe(1);

    const reset = vi.spyOn(plannerClient, 'resetEstimation');
    const [lostX, busyX] = transient();
    reset.mockRejectedValueOnce(lostX).mockRejectedValueOnce(busyX);
    await wrapper.get('[data-reset-all]').trigger('click');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.waitFor(() => expect(document.querySelector('[data-reset-confirm]')).not.toBeNull());
      const confirm = document.querySelector('[data-reset-confirm]') as HTMLButtonElement;
      await vi.waitFor(() => expect(confirm.disabled).toBe(false));
      confirm.click();
      await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(attempt + 1));
      await reset.mock.results[attempt]?.value?.catch?.(() => undefined);
    }
    await vi.waitFor(() => expect(mockDb.estimation.items).toHaveLength(0));
    expect(new Set(reset.mock.calls.map((call) => call[1])).size).toBe(1);
    wrapper.unmount();
  });
});
