import { flushPromises } from '@vue/test-utils';
import { isUuidV7Key, plannerClient } from '../src/api';
import ReplanRequestButton from '../src/components/ReplanRequestButton.vue';
import { TODAY_TASK_ONE_TITLE, TODAY_TASK_TWO_TITLE, mockDb } from '../src/mocks/db';
import {
  LOCKED_BLOCK_ID,
  MOCK_PLAN_ID,
  REPLAN_PENDING_ID,
  seedReplanScenario,
} from '../src/mocks/replan';
import { rememberActivePlan, rememberedActivePlan } from '../src/session/activePlan';
import { useOfflineStore } from '../src/stores/offline';
import ReplanProposalView from '../src/views/ReplanProposalView.vue';
import { bodyText, buttonWith, mountView, waitForText, type Mounted } from './m5-test-utils';

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
}

/** Records every request the planner client sends (headers included). */
function captureRequests(): Captured[] {
  const seen: Captured[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    seen.push({ method: request.method, path: new URL(request.url).pathname, headers: request.headers, body });
    return original(request);
  });
  return seen;
}

async function mountPending(id = REPLAN_PENDING_ID): Promise<Mounted> {
  const mounted = await mountView(ReplanProposalView, { path: `/replan/${id}`, props: { id } });
  await waitForText(mounted.wrapper, '바뀌는 블록');
  await vi.waitFor(() => expect(mounted.wrapper.findAll('.replan-change').length).toBeGreaterThan(0));
  return mounted;
}

describe('Replan proposal detail (M5-03)', () => {
  beforeEach(() => {
    localStorage.clear();
    seedReplanScenario(mockDb);
  });

  it('explains the reason in Korean and shows only the changed block, the locked block and before/after metrics', async () => {
    const { wrapper } = await mountPending();
    const text = wrapper.text();
    expect(text).toContain('약속과 겹침');
    expect(text).toContain('새로 생긴 약속이 계획된 블록과 겹쳐요.');
    expect(text).toContain('약속과 겹치는 블록이 있어요');
    expect(text).toContain('승인 대기');
    expect(text).not.toContain('commitment_overlap');
    expect(text).not.toContain('commitment_conflict');

    const changes = wrapper.findAll('.replan-change');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.attributes('data-change')).toBe('moved');
    expect(changes[0]?.text()).toContain(TODAY_TASK_TWO_TITLE);
    expect(changes[0]?.find('del').text()).toBe('11월 14일 (토) 오후 9:00~9:40');
    expect(changes[0]?.find('ins').text()).toBe('11월 16일 (월) 오전 11:00~11:40');

    const locked = wrapper.findAll('[data-locked]');
    expect(locked).toHaveLength(1);
    expect(locked[0]?.attributes('data-block-id')).toBe(LOCKED_BLOCK_ID);
    expect(locked[0]?.text()).toContain('고정됨');
    expect(locked[0]?.text()).toContain(TODAY_TASK_ONE_TITLE);
    expect(locked[0]?.find('svg').exists()).toBe(true);
    // The locked block is never listed as a change.
    expect(wrapper.findAll('.replan-change').some((item) => item.text().includes('오전 9:00~10:00'))).toBe(false);
    expect(text).toContain('그 밖의 블록 2개는 그대로예요.');

    const slack = wrapper.get('[data-metric="slack"]');
    expect(slack.text()).toContain('마감 여유');
    expect(slack.findAll('td').map((cell) => cell.text())).toEqual(['7시간 15분', '7시간 15분']);
    expect(wrapper.get('[data-metric="planned"]').findAll('td').map((cell) => cell.text())).toEqual([
      '3시간 55분',
      '3시간 55분',
    ]);
    expect(wrapper.get('[data-metric="changed"]').text()).toBe('2개 · 상한 4개');
    wrapper.unmount();
  });

  it('keeps server free text under “계산 근거 (원문)” marked lang="en"', async () => {
    const { wrapper } = await mountPending();
    const details = wrapper.get('.replan-explanation');
    expect(details.get('summary').text()).toBe('계산 근거 (원문)');
    expect(details.get('ul').attributes('lang')).toBe('en');
    expect(details.text()).toContain('Replan scope');
    // Outside the details element no English explanation leaks onto the screen.
    expect(wrapper.get('.replan-why').text()).not.toMatch(/[A-Za-z]{4,}/);
    wrapper.unmount();
  });

  it('approves with If-Match W/"availability:<n>" and a UUIDv7 Idempotency-Key, then turns read-only and remembers the plan', async () => {
    const proposal = mockDb.replanProposals.get(REPLAN_PENDING_ID);
    if (proposal === undefined) throw new Error('seeded proposal missing');
    const { wrapper } = await mountPending();
    const requests = captureRequests();
    await buttonWith(wrapper, '승인').trigger('click');

    await vi.waitFor(() => expect(mockDb.replanProposals.get(REPLAN_PENDING_ID)?.state).toBe('approved'));
    const approve = requests.find((request) => request.path.endsWith(`${REPLAN_PENDING_ID}:approve`));
    expect(approve?.method).toBe('POST');
    expect(approve?.headers.get('If-Match')).toBe(`W/"availability:${proposal.availabilityVersion}"`);
    expect(isUuidV7Key(approve?.headers.get('Idempotency-Key') ?? '')).toBe(true);

    await waitForText(wrapper, '읽기 전용');
    expect(wrapper.get('[data-proposal-state]').text()).toBe('승인됨');
    expect(wrapper.text()).toContain('제안을 승인했어요. 새 일정이 반영됐어요.');
    expect(wrapper.find('[data-replan-approve]').exists()).toBe(false);
    expect(wrapper.find('[data-replan-reject]').exists()).toBe(false);
    expect(rememberedActivePlan(null)).toBe(MOCK_PLAN_ID);
    // Only the overlapped block moved: the locked block row and the untouched blocks stay.
    expect(mockDb.extraScheduleBlocks.find((block) => block.id === LOCKED_BLOCK_ID)?.locked).toBe(true);
    expect(mockDb.today.blocks.map((block) => block.taskId)).not.toContain(proposal.trigger.affectedTaskIds[0]);
    wrapper.unmount();
  });

  it('412 availability_changed opens the conflict dialog with refresh and applies nothing (negative)', async () => {
    const { wrapper } = await mountPending();
    mockDb.availabilityVersion += 1;
    const reads = vi.spyOn(plannerClient, 'getReplanProposal');
    await buttonWith(wrapper, '승인').trigger('click');

    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('그사이 가용 시간이나 약속이 바뀌었어요');
    expect(mockDb.replanProposals.get(REPLAN_PENDING_ID)?.state).toBe('pending');
    expect(document.activeElement?.textContent).toContain('새로 고침');

    (Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.includes('새로 고침')) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(reads).toHaveBeenCalled();
    expect(wrapper.find('[data-replan-approve]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('409 proposal_state_conflict shows the refreshed read-only state', async () => {
    const { wrapper } = await mountPending();
    const current = mockDb.replanProposals.get(REPLAN_PENDING_ID);
    if (current === undefined) throw new Error('seeded proposal missing');
    mockDb.replanProposals.set(current.id, { ...current, state: 'expired', version: current.version + 1 });
    await buttonWith(wrapper, '승인').trigger('click');

    await waitForText(wrapper, '이 제안은 그사이 처리됐거나 만료됐어요');
    expect(wrapper.get('[data-proposal-state]').text()).toBe('만료됨');
    expect(wrapper.get('[data-readonly]').text()).toContain('더는 승인할 수 없어요');
    expect(wrapper.find('[data-replan-approve]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('asks before rejecting, explains the 24 h same-reason suppression and pins the proposal version', async () => {
    const { wrapper } = await mountPending();
    const requests = captureRequests();
    await buttonWith(wrapper, '거절').trigger('click');
    await vi.waitFor(() => expect(bodyText()).toContain('이 제안을 거절할까요?'));
    const dialog = document.querySelector('.replan-reject-dialog') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.textContent).toContain('같은 이유(약속과 겹침)의 재계획 제안은 24시간 동안');
    expect(dialog.textContent).toMatch(/\d{1,2}월 \d{1,2}일 \([월화수목금토일]\) 오[전후] \d{1,2}:\d{2}까지/);
    expect(dialog.textContent).toContain('[재계획 요청]으로 직접 다시 계산할 수는 있어요');
    expect(requests.some((request) => request.path.endsWith(':reject'))).toBe(false);

    (Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.includes('거절하기')) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mockDb.replanProposals.get(REPLAN_PENDING_ID)?.state).toBe('rejected'));
    const reject = requests.find((request) => request.path.endsWith(':reject'));
    expect(reject?.headers.get('If-Match')).toBe('W/"1"');
    expect(isUuidV7Key(reject?.headers.get('Idempotency-Key') ?? '')).toBe(true);
    expect(mockDb.replanSuppressions.has('commitment_overlap')).toBe(true);
    await waitForText(wrapper, '제안을 거절했어요. 같은 이유의 제안은 24시간 동안 다시 만들지 않아요.');
    expect(wrapper.get('[data-proposal-state]').text()).toBe('거절됨');
    wrapper.unmount();
  });

  it('cancelling the rejection sends nothing and keeps the proposal pending (negative)', async () => {
    const { wrapper } = await mountPending();
    const reject = vi.spyOn(plannerClient, 'rejectReplanProposal');
    await buttonWith(wrapper, '거절').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('.replan-reject-dialog')).not.toBeNull());
    (Array.from(document.querySelectorAll('.replan-reject-dialog button')).find((button) => button.textContent?.includes('취소')) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.replan-reject-dialog')).toBeNull());
    expect(reject).not.toHaveBeenCalled();
    expect(mockDb.replanProposals.get(REPLAN_PENDING_ID)?.state).toBe('pending');
    wrapper.unmount();
  });

  it.each([
    ['expired', '만료됨', '24시간이 지나서'],
    ['superseded', '새 제안으로 대체됨', '더 새로운 제안'],
  ] as const)('shows a %s proposal read-only without actions', async (state, label, body) => {
    const current = mockDb.replanProposals.get(REPLAN_PENDING_ID);
    if (current === undefined) throw new Error('seeded proposal missing');
    mockDb.replanProposals.set(current.id, { ...current, state, version: 2 });
    const { wrapper } = await mountView(ReplanProposalView, {
      path: `/replan/${current.id}`,
      props: { id: current.id },
    });
    await waitForText(wrapper, label);
    expect(wrapper.get('[data-readonly]').text()).toContain(body);
    expect(wrapper.find('[data-replan-approve]').exists()).toBe(false);
    expect(wrapper.find('[data-replan-reject]').exists()).toBe(false);
    // A processed proposal is not diffed against today's schedule.
    expect(wrapper.find('.replan-change').exists()).toBe(false);
    expect(wrapper.text()).toContain('제안했던 블록');
    wrapper.unmount();
  });

  it('disables approve and reject while offline (negative)', async () => {
    const mounted = await mountPending();
    useOfflineStore(mounted.pinia).setOnline(false);
    await flushPromises();
    expect(mounted.wrapper.get('[data-replan-approve]').attributes('disabled')).toBeDefined();
    expect(mounted.wrapper.get('[data-replan-reject]').attributes('disabled')).toBeDefined();
    const approve = vi.spyOn(plannerClient, 'approveReplanProposal');
    await mounted.wrapper.get('[data-replan-approve]').trigger('click');
    expect(approve).not.toHaveBeenCalled();
    mounted.wrapper.unmount();
  });
});

describe('재계획 요청 (user_request)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a pending proposal and opens it', async () => {
    const { wrapper, router } = await mountView(ReplanRequestButton, { path: '/today', props: { planId: MOCK_PLAN_ID } });
    const request = vi.spyOn(plannerClient, 'requestReplanProposal');
    await buttonWith(wrapper, '재계획 요청').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/replan\/[0-9a-f-]{36}$/));
    expect(request).toHaveBeenCalledWith({ planId: MOCK_PLAN_ID }, expect.any(String), expect.any(AbortSignal));
    const created = [...mockDb.replanProposals.values()].find((item) => item.trigger.kind === 'user_request');
    expect(created?.state).toBe('pending');
    wrapper.unmount();
  });

  it('shows replan_suppressed with Retry-After as a human-readable wait and uses a fresh key on retry', async () => {
    mockDb.replanSuppressions.set('user_request', Date.now() + 24 * 60 * 60 * 1000);
    const { wrapper } = await mountView(ReplanRequestButton, { path: '/today', props: { planId: MOCK_PLAN_ID } });
    const request = vi.spyOn(plannerClient, 'requestReplanProposal');
    await buttonWith(wrapper, '재계획 요청').trigger('click');
    await waitForText(wrapper, '지금은 재계획을 더 요청할 수 없어요.');
    const status = wrapper.get('[role="status"]');
    expect(status.attributes('aria-live')).toBe('polite');
    expect(status.text()).toMatch(/(1일|23시간 59분|24시간) 뒤\(\d{1,2}월 \d{1,2}일 \([월화수목금토일]\) 오[전후] \d{1,2}:\d{2}\)에 다시 요청할 수 있어요/);
    expect(status.text()).toContain('거절한 이유는 24시간 동안 다시 제안하지 않고, 제안은 하루 2번까지예요.');
    expect(status.text()).not.toMatch(/\d{4,}\s*초/);

    await buttonWith(wrapper, '재계획 요청').trigger('click');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const keys = request.mock.calls.map((call) => call[1]);
    expect(keys[0]).not.toBe(keys[1]);
    expect([...mockDb.replanProposals.values()].some((item) => item.trigger.kind === 'user_request')).toBe(false);
    wrapper.unmount();
  });

  it('keeps the daily cap (two a day) and says when the next request is allowed', async () => {
    seedReplanScenario(mockDb);
    const today = new Date().toISOString();
    const base = mockDb.replanProposals.get(REPLAN_PENDING_ID);
    if (base === undefined) throw new Error('seeded proposal missing');
    mockDb.replanProposals.set(base.id, { ...base, createdAt: today });
    mockDb.replanProposals.set('01900000-0000-7000-8000-0000000002e9', {
      ...base,
      id: '01900000-0000-7000-8000-0000000002e9',
      state: 'rejected',
      createdAt: today,
      trigger: { ...base.trigger, reason: 'deadline_slack_negative', kind: 'deadline_risk' },
    });
    const { wrapper } = await mountView(ReplanRequestButton, { path: '/today', props: { planId: MOCK_PLAN_ID } });
    await buttonWith(wrapper, '재계획 요청').trigger('click');
    await waitForText(wrapper, '에 다시 요청할 수 있어요');
    expect([...mockDb.replanProposals.values()].filter((item) => item.trigger.kind === 'user_request')).toHaveLength(0);
    wrapper.unmount();
  });

  it('forgets a plan the server no longer knows (negative)', async () => {
    const missing = '01900000-0000-7000-8000-00000000ffff';
    rememberActivePlan(null, missing);
    const { wrapper } = await mountView(ReplanRequestButton, { path: '/today', props: { planId: missing } });
    await buttonWith(wrapper, '재계획 요청').trigger('click');
    await waitForText(wrapper, '이 계획을 찾을 수 없어요');
    expect(rememberedActivePlan(null)).toBeNull();
    wrapper.unmount();
  });
});
