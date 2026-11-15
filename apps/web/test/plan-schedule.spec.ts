import { HttpResponse, http } from 'msw';
import { createPinia } from 'pinia';
import { createPlannerClient, newActionId, plannerClient, type Plan } from '../src/api';
import { planFlowKey, readPlanFlows, rememberPlanFlow } from '../src/composables/planFlowMemory';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { createUuidV7, mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { useOfflineStore } from '../src/stores/offline';
import { useSessionStore } from '../src/stores/session';
import PlanScheduleView from '../src/views/PlanScheduleView.vue';
import { buttonByText, mountWithPlugins, settle, testRouter } from './planning-test-utils';

/**
 * HOLO-03A — 계획 세우기 · 일정안 → 확정 (`/plan/schedule/:id`): the candidates
 * as cards, the picked one drawn as proposals on the week grid, the edits
 * the server checks, 확정 with its conflict handling, and the hand-off.
 */
const HORIZON = {
  start: '2026-11-11T00:00:00.000Z',
  end: '2026-11-25T00:00:00.000Z',
};

async function createPlan(): Promise<Plan> {
  const task = [...mockDb.tasks.values()][0];
  if (task === undefined) throw new Error('seed task missing');
  return createPlannerClient().createPlan(
    { scope: { taskIds: [task.id] }, horizon: HORIZON, policies: ['front_loaded', 'balanced', 'focus_blocked'] },
    newActionId('plan-create'),
  );
}

async function mountPlan(planId: string, pinia = createPinia(), query = '') {
  const router = testRouter();
  await router.push(`/plan/schedule/${planId}${query}`);
  await router.isReady();
  // The signed-in owner, so what the screen remembers on the device has a namespace.
  useSessionStore(pinia).setOwner(mockDb.user.id);
  const wrapper = mountWithPlugins(PlanScheduleView, { router, pinia, props: { id: planId } });
  await settle();
  await vi.waitFor(() => {
    expect(wrapper.findAll('.plan-option').length).toBeGreaterThan(0);
  });
  return wrapper;
}

async function proposals(wrapper: Awaited<ReturnType<typeof mountPlan>>) {
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-kind="proposal"]').length).toBeGreaterThan(0);
  });
  return wrapper.findAll('[data-kind="proposal"]');
}

function ensureTwoCandidates(plan: Plan): void {
  if (plan.candidates.length < 2) {
    const source = plan.candidates[0];
    if (source === undefined) throw new Error('plan has no candidate');
    const clone = structuredClone(source);
    clone.id = createUuidV7();
    clone.policy = 'balanced';
    plan.candidates.push(clone);
  }
}

/** Block ids of the plan's current confirmed version, as the grid keys them. */
function ownBlockKeys(planId: string): string[] {
  const versionId = storedPlan(planId).currentVersionId;
  const version = versionId === undefined ? undefined : mockDb.planVersions.get(versionId);
  return (version?.blocks ?? []).map((block) => `block:${block.id}@`);
}

function drawnBlockKeys(wrapper: Awaited<ReturnType<typeof mountPlan>>): string[] {
  return wrapper.findAll('.wg-item--block').map((item) => item.attributes('data-item') ?? '');
}

// What the screen remembers on the device is per owner and outlives a test.
beforeEach(() => {
  localStorage.clear();
});

function storedPlan(id: string): Plan {
  const stored = mockDb.plans.get(id);
  if (stored === undefined) throw new Error('plan was not stored');
  return stored;
}

describe('the candidates, side by side', () => {
  it('each card says its way, the day it ends, its three figures and its risk; one is picked', async () => {
    const created = await createPlan();
    const wrapper = await mountPlan(created.id);

    const cards = wrapper.findAll('.plan-option');
    expect(cards).toHaveLength(created.candidates.length);
    expect(wrapper.get('[data-plan-options]').attributes('role')).toBe('radiogroup');
    const first = cards[0]!;
    expect(first.classes()).toContain('plan-option--selected');
    expect((first.get('input[type="radio"]').element as HTMLInputElement).checked).toBe(true);
    expect(first.get('label').text()).toBe('앞당겨 끝내기');
    expect(first.text()).toContain('일을 최대한 일찍 끝내서 마감까지 여유를 넉넉히 둬요.');
    expect(first.get('[data-option-finish]').text()).toMatch(/^끝나는 날\d{1,2}월 \d{1,2}일\([월화수목금토일]\)$/);
    expect(first.findAll('[data-option-stat]').map((stat) => stat.attributes('data-option-stat'))).toEqual([
      'slack',
      'dailyMax',
      'switches',
    ]);
    expect(first.get('[data-option-risk]').text().length).toBeGreaterThan(0);
    // The strip of bars is one image with the numbers in words.
    expect(first.get('[data-chart="strip"]').attributes('aria-label')).toMatch(/^날마다 집중 시간: /);
    // The radio is named by the card's title and described by its summary, figures and risk.
    expect(first.get('input').attributes('aria-describedby')?.split(' ')).toHaveLength(3);
    // The one that is picked has no "difference from the picked one"; the others say it.
    expect(first.find('[data-option-diff]').exists()).toBe(false);
    if (cards.length > 1) expect(cards[1]!.get('[data-option-diff]').text()).toMatch(/^고른 안보다 /);
    // Exactly one filled button: the next step.
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['이 일정으로 확정']);
    expect(wrapper.attributes('data-plan-stage')).toBe('schedule');
    expect(wrapper.get('[data-stage="schedule"]').attributes('aria-current')).toBe('step');
    wrapper.unmount();
  });

  it('renders signed fractional slack, a candidate that does not fit, its reasons and the diversity note', async () => {
    const created = await createPlan();
    const stored = storedPlan(created.id);
    ensureTwoCandidates(stored);
    const first = stored.candidates[0]!;
    const second = stored.candidates[1]!;
    first.metrics.minSlackMin = -0.5;
    first.feasible = false;
    first.deficitMin = 120;
    first.diversityNote = 'Only two distinct plans are possible with this availability.';
    // Legacy row: the custom English note has no coded items, so the screen
    // must keep showing the original text.
    delete first.diversityNoteItems;
    first.explanation = ['Front-loads work before the first deadline.'];
    delete first.explanationItems;
    second.metrics.minSlackMin = 0.5;
    second.feasible = true;

    const wrapper = await mountPlan(created.id);
    const cards = wrapper.findAll('.plan-option');

    // A sub-minute slack keeps its sign instead of collapsing to "0분".
    expect(cards[0]!.get('[data-option-stat="slack"]').text()).toContain('−1분 미만');
    expect(cards[1]!.get('[data-option-stat="slack"]').text()).toContain('+1분 미만');
    expect(cards[0]!.attributes('data-risk')).toBe('unplaced');
    expect(cards[0]!.get('[data-option-risk]').text()).toBe('2시간은 넣을 자리가 없어요.');
    expect(cards[1]!.attributes('data-risk')).not.toBe('unplaced');
    // The picked candidate's reasons (a row from before coded reasons keeps its own words, marked as such).
    const why = wrapper.get('[data-plan-why] details');
    expect(why.attributes('data-explanation')).toBe('original');
    expect(why.get('summary').text()).toBe('계산 근거 (원문)');
    expect(why.get('.explanation-list').attributes('lang')).toBe('en');
    expect(why.text()).toContain('Front-loads work before the first deadline.');
    expect(cards[0]!.get('[data-option-note]').text()).toContain('Only two distinct plans are possible');
    expect(cards[0]!.get('[data-option-note]').attributes('lang')).toBe('en');
    wrapper.unmount();
  });

  it('a candidate that leaves work unplaced cannot be confirmed as it stands: said before the press, and nothing is sent', async () => {
    const created = await createPlan();
    const stored = storedPlan(created.id);
    ensureTwoCandidates(stored);
    stored.candidates[0]!.feasible = false;
    stored.candidates[0]!.deficitMin = 60;
    stored.candidates[1]!.feasible = true;
    const spy = vi.spyOn(plannerClient, 'approveCandidate');

    const wrapper = await mountPlan(created.id);
    const approve = wrapper.get('[data-plan-approve]');
    expect(wrapper.get('[data-plan-cannot-confirm]').text()).toContain('그대로는 확정할 수 없어요');
    expect(approve.attributes('disabled')).toBeDefined();
    expect(approve.attributes('aria-describedby')).toBe('plan-cannot-confirm');
    await approve.trigger('click');
    await settle();
    expect(spy).not.toHaveBeenCalled();

    // Negative: a candidate that fits has no such notice and can be confirmed.
    await wrapper.findAll('.plan-option input[type="radio"]')[1]!.setValue(true);
    await settle();
    expect(wrapper.find('[data-plan-cannot-confirm]').exists()).toBe(false);
    expect(wrapper.get('[data-plan-approve]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-plan-approve]').attributes('aria-describedby')).toBeUndefined();
    wrapper.unmount();
  });

  it('an unplaced candidate becomes confirmable once its blocks were edited and the server found they hold', async () => {
    const created = await createPlan();
    const stored = storedPlan(created.id);
    stored.candidates[0]!.feasible = false;
    stored.candidates[0]!.deficitMin = 30;
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:preview-edit$/, () =>
        HttpResponse.json({ feasible: true, violations: [], deficitMin: 0 }),
      ),
    );
    const wrapper = await mountPlan(created.id);
    expect(wrapper.get('[data-plan-approve]').attributes('disabled')).toBeDefined();
    await (await proposals(wrapper))[0]!.trigger('keydown', { key: 'ArrowDown', altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(wrapper.find('[data-plan-valid]').exists()).toBe(true), { timeout: 3_000 });
    expect(wrapper.find('[data-plan-cannot-confirm]').exists()).toBe(false);
    expect(wrapper.get('[data-plan-approve]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('prefers coded diversity note items over the English fallback (FU-68), and names coded reasons plainly', async () => {
    const created = await createPlan();
    const stored = storedPlan(created.id);
    ensureTwoCandidates(stored);
    const first = stored.candidates[0]!;
    first.diversityNote = '3 distinct plans from 3 policy candidates (pairwise distance >= 0.15).';
    first.diversityNoteItems = [{ code: 'diversity_distinct', params: { total: 3 } }];

    const wrapper = await mountPlan(created.id);

    expect(wrapper.get('.plan-option [data-option-note]').text()).toBe('일정안 3개가 모두 서로 충분히 달라요.');
    expect(wrapper.text()).not.toContain('3 distinct plans from 3 policy candidates');
    if (wrapper.find('[data-plan-why] details[data-explanation="coded"]').exists()) {
      expect(wrapper.get('[data-plan-why] summary').text()).toBe('이렇게 짠 이유');
    }
    wrapper.unmount();
  });

  it('picking another card redraws the week with its blocks and keeps exactly one picked', async () => {
    const created = await createPlan();
    const stored = storedPlan(created.id);
    ensureTwoCandidates(stored);
    const wrapper = await mountPlan(created.id);
    const cards = wrapper.findAll('.plan-option');

    await cards[1]!.get('input[type="radio"]').setValue(true);
    await settle();

    expect(wrapper.findAll('.plan-option--selected')).toHaveLength(1);
    expect(wrapper.findAll('.plan-option')[1]!.classes()).toContain('plan-option--selected');
    expect(wrapper.get('[data-plan-picked]').text()).toContain(wrapper.findAll('.plan-option')[1]!.get('label').text());
    // A press anywhere on a card picks it, too.
    await wrapper.findAll('.plan-option')[0]!.trigger('click');
    expect(wrapper.findAll('.plan-option')[0]!.classes()).toContain('plan-option--selected');
    wrapper.unmount();
  });
});

describe('a proposal never looks like a confirmed block', () => {
  it('draws the picked candidate as proposals; after 확정 the same blocks are approved blocks and the page hands over', async () => {
    const plan = await createPlan();
    const wrapper = await mountPlan(plan.id);
    const drawn = await proposals(wrapper);
    for (const item of drawn) {
      expect(item.classes()).toContain('wg-item--proposal');
      expect(item.classes()).not.toContain('wg-item--block');
      expect(item.attributes('aria-label')).toMatch(/^일정안 블록, /);
    }
    expect(wrapper.get('[data-plan-legend]').text()).toContain('일정안 (아직 확정 전)');
    expect(wrapper.find('[data-plan-next]').exists()).toBe(false);

    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-plan-next]').exists()).toBe(true), { timeout: 3_000 });

    expect(wrapper.attributes('data-plan-stage')).toBe('confirmed');
    expect(wrapper.findAll('[data-kind="proposal"]')).toHaveLength(0);
    expect(wrapper.find('[data-plan-options]').exists()).toBe(false);
    expect(wrapper.find('[data-plan-approve]').exists()).toBe(false);
    // The confirmed blocks are on the grid as what they are: approved blocks.
    const own = ownBlockKeys(plan.id);
    expect(own.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(drawnBlockKeys(wrapper).some((key) => own.some((prefix) => key.startsWith(prefix)))).toBe(true));
    for (const item of wrapper.findAll('.wg-item--block')) expect(item.classes()).not.toContain('wg-item--proposal');
    expect(wrapper.get('[data-plan-legend]').text()).not.toContain('일정안 (아직 확정 전)');
    // The flow is over: no stage is "current". This plan was made straight from
    // tasks, so its first three stages are marked as passed over, never ticked.
    expect(wrapper.findAll('[data-plan-rail] [aria-current]')).toHaveLength(0);
    expect(wrapper.findAll('[data-plan-rail] li').map((item) => item.attributes('data-state'))).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'done',
      'done',
    ]);
    wrapper.unmount();
  });

  it('negative: a plan that was never confirmed shows no hand-off, however it is opened', async () => {
    const plan = await createPlan();
    const wrapper = await mountPlan(plan.id);
    expect(wrapper.find('[data-plan-next]').exists()).toBe(false);
    expect(wrapper.find('[data-plan-choose]').exists()).toBe(false);
    expect(wrapper.attributes('data-plan-stage')).toBe('schedule');
    wrapper.unmount();
  });
});

describe('plan editing preview API', () => {
  it('uses the scheduler validator and reports /blocks/<i> preflight errors', async () => {
    const plan = await createPlan();
    const candidate = plan.candidates.find((item) => item.feasible) ?? plan.candidates[0];
    if (candidate === undefined) throw new Error('candidate missing');
    const task = [...mockDb.tasks.values()][0];
    if (task === undefined) throw new Error('seed task missing');
    const client = createPlannerClient();

    const valid = await client.previewCandidateEdit(plan.id, candidate.id, candidate.blocks, newActionId('preview-valid'), plan.version);
    expect(valid.feasible).toBe(true);

    const outsideAvailability = await client.previewCandidateEdit(
      plan.id,
      candidate.id,
      [{ taskId: task.id, startAt: '2026-11-11T20:00:00.000Z', endAt: '2026-11-11T21:00:00.000Z' }],
      newActionId('preview-h2'),
      plan.version,
    );
    expect(outsideAvailability.feasible).toBe(false);
    expect(outsideAvailability.violations.map((violation) => violation.code)).toContain('H2');

    await expect(
      client.previewCandidateEdit(
        plan.id,
        candidate.id,
        [{ taskId: task.id, startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-10-01T01:00:00.000Z' }],
        newActionId('preview-preflight'),
        plan.version,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      problem: { errors: [{ path: '/blocks/0' }] },
    });
  });
});

describe('editing the picked candidate', () => {
  it('a keyboard edit is checked by the server; an overlap is said in a sentence, without the rule’s code', async () => {
    const plan = await createPlan();
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:preview-edit$/, () =>
        HttpResponse.json({
          feasible: false,
          violations: [{ code: 'H1', message: 'Blocks overlap each other.' }],
          deficitMin: 0,
        }),
      ),
    );

    const wrapper = await mountPlan(plan.id);
    const block = (await proposals(wrapper))[0]!;
    expect(wrapper.get('[data-plan-draft-state]').text()).toBe('만들어진 그대로');
    await block.trigger('keydown', { key: 'ArrowDown', altKey: true });
    expect(wrapper.get('[data-plan-draft-state]').text()).toBe('고친 일정안');

    await vi.waitFor(
      () => {
        expect(wrapper.get('[data-plan-violations]').text()).toContain('블록이 다른 블록, 약속 또는 고정된 블록과 겹쳐요');
      },
      { timeout: 3_000 },
    );
    const finding = wrapper.get('[data-plan-violations] .violation-list li');
    expect(finding.attributes('data-code')).toBe('H1');
    expect(finding.text()).not.toMatch(/\bH1\b/);
    wrapper.unmount();
  });

  it('maps preview 422 errors to the right block: it is marked on the grid and named in the list', async () => {
    const plan = await createPlan();
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:preview-edit$/, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            code: 'validation_failed',
            detail: 'Edited blocks failed pre-flight validation',
            errors: [{ path: '/blocks/0', message: 'block lies outside the plan horizon' }],
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const wrapper = await mountPlan(plan.id);
    const firstBlock = (await proposals(wrapper))[0]!;
    await firstBlock.trigger('keydown', { key: 'ArrowUp', altKey: true });

    await vi.waitFor(
      () => {
        expect(wrapper.get('[data-plan-violations]').text()).toContain('블록 1: 일정안 기간을 벗어났어요');
      },
      { timeout: 3_000 },
    );
    const marked = wrapper.get('[data-proposal="0"]');
    expect(marked.classes()).toContain('wg-item--invalid');
    expect(marked.attributes('aria-invalid')).toBe('true');
    wrapper.unmount();
  });

  it('the block’s card moves and resizes it in five-minute steps; 되돌리기 puts the candidate back', async () => {
    const plan = await createPlan();
    const wrapper = await mountPlan(plan.id);
    const spy = vi.spyOn(plannerClient, 'previewCandidateEdit');
    const block = (await proposals(wrapper))[0]!;
    const before = block.attributes('aria-label');

    await block.trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-planner-card="proposal"]').exists()).toBe(true));
    const card = wrapper.get('[data-planner-card="proposal"]');
    expect(card.get('[data-planner-card-kind]').text()).toBe('일정안');
    await card.get('[data-card-later]').trigger('click');
    await settle();

    expect(wrapper.get('[data-proposal="0"]').attributes('aria-label')).not.toBe(before);
    expect(wrapper.get('[data-plan-draft-state]').text()).toBe('고친 일정안');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    const sent = spy.mock.calls[0]?.[2] ?? [];
    const original = plan.candidates[0]?.blocks[0];
    expect(Date.parse(sent[0]?.startAt ?? '') - Date.parse(original?.startAt ?? '')).toBe(5 * 60_000);
    expect(Date.parse(sent[0]?.endAt ?? '') - Date.parse(original?.endAt ?? '')).toBe(5 * 60_000);

    await wrapper.get('[data-plan-reset]').trigger('click');
    await settle();
    expect(wrapper.get('[data-proposal="0"]').attributes('aria-label')).toBe(before);
    expect(wrapper.get('[data-plan-draft-state]').text()).toBe('만들어진 그대로');
    expect(wrapper.get('[data-plan-status]').text()).toBe('만들어진 일정안으로 되돌렸어요.');
    wrapper.unmount();
  });

  it('negative: without an edit nothing is sent to be checked, and 되돌리기 has nothing to undo', async () => {
    const plan = await createPlan();
    const spy = vi.spyOn(plannerClient, 'previewCandidateEdit');
    const wrapper = await mountPlan(plan.id);
    await proposals(wrapper);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.get('[data-plan-reset]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

describe('plan approval API idempotency', () => {
  it('replays the same plan version for a retried Idempotency-Key', async () => {
    const plan = await createPlan();
    const candidate = plan.candidates.find((item) => item.feasible) ?? plan.candidates[0];
    if (candidate === undefined) throw new Error('candidate missing');
    const client = createPlannerClient();
    const key = newActionId('approve-retry');

    const first = await client.approveCandidate(plan.id, candidate.id, key, plan.availabilityVersion);
    const replay = await client.approveCandidate(plan.id, candidate.id, key, plan.availabilityVersion);

    expect(replay.id).toBe(first.id);
    expect([...mockDb.planVersions.values()]).toHaveLength(1);
  });
});

describe('확정', () => {
  it('sends only one approve request for a double click, then hands over to today', async () => {
    const plan = await createPlan();
    const realApprove = plannerClient.approveCandidate.bind(plannerClient);
    let calls = 0;
    const spy = vi.spyOn(plannerClient, 'approveCandidate').mockImplementation(async (...args) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return realApprove(...args);
    });

    const wrapper = await mountPlan(plan.id);
    const approve = buttonByText(wrapper, '이 일정으로 확정');
    await approve.trigger('click');
    await approve.trigger('click');

    await vi.waitFor(() => expect(wrapper.find('[data-plan-next]').exists()).toBe(true), { timeout: 3_000 });
    expect(calls).toBe(1);
    const next = wrapper.get('[data-plan-next]');
    expect(next.get('h2').text()).toBe('확정했어요');
    expect(next.get('[data-plan-next-today]').text()).toMatch(/^(오늘 할 일 \d+개|오늘은 잡힌 블록이 없어요)$/);
    expect(next.text()).toMatch(/블록 \d+개가 오늘과 플래너에 들어갔어요\./);
    // The hand-off is the screen's one filled button now, and it leads on: a focus session, or today.
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.attributes('data-plan-next-primary')).toMatch(/^(start|resume|today)$/);
    // No developer detail on the page.
    expect(wrapper.text()).not.toContain('가용 시간 버전');
    expect(wrapper.text()).not.toMatch(/버전 \d/);
    expect(storedPlan(plan.id).status).toBe('active');
    spy.mockRestore();
    wrapper.unmount();
  });

  it('says the phone calendar got it only when the integration can export blocks (negative first)', async () => {
    const plan = await createPlan();
    const wrapper = await mountPlan(plan.id);
    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-plan-next]').exists()).toBe(true), { timeout: 3_000 });
    await settle();
    // The mock's default connection is "not configured": nothing is claimed.
    expect(wrapper.find('[data-plan-next-google]').exists()).toBe(false);
    wrapper.unmount();

    const { seedGoogle } = await import('../src/mocks/google');
    seedGoogle(mockDb, 'connected');
    const again = await createPlan();
    const connected = await mountPlan(again.id);
    await buttonByText(connected, '이 일정으로 확정').trigger('click');
    await vi.waitFor(() => expect(connected.find('[data-plan-next-google]').exists()).toBe(true), { timeout: 3_000 });
    expect(connected.get('[data-plan-next-google]').text()).toBe('폰의 구글 캘린더에도 보냈어요.');
    connected.unmount();

    // Connected, but without the permission to export: still nothing is claimed.
    seedGoogle(mockDb, 'partial');
    const partialPlan = await createPlan();
    const partial = await mountPlan(partialPlan.id);
    await buttonByText(partial, '이 일정으로 확정').trigger('click');
    await vi.waitFor(() => expect(partial.find('[data-plan-next]').exists()).toBe(true), { timeout: 3_000 });
    await settle();
    expect(partial.find('[data-plan-next-google]').exists()).toBe(false);
    partial.unmount();
  });

  it('supports a keyboard-only pick and approve path', async () => {
    const plan = await createPlan();
    const stored = storedPlan(plan.id);
    ensureTwoCandidates(stored);
    const wrapper = await mountPlan(plan.id);

    // The radios are native: arrows move the choice, the change picks the card.
    const radios = wrapper.findAll('.plan-option input[type="radio"]');
    (radios[0]!.element as HTMLElement).focus();
    await radios[1]!.setValue(true);
    await settle();
    expect(wrapper.findAll('.plan-option')[1]!.classes()).toContain('plan-option--selected');

    const approve = buttonByText(wrapper, '이 일정으로 확정');
    (approve.element as HTMLElement).focus();
    expect(document.activeElement).toBe(approve.element);
    // A native button: Enter is its click.
    await approve.trigger('click');

    await vi.waitFor(() => expect(wrapper.find('[data-plan-next]').exists()).toBe(true), { timeout: 3_000 });
    const version = [...mockDb.planVersions.values()].find((item) => item.planId === plan.id);
    expect(version?.candidateId).toBe(stored.candidates[1]?.id);
    wrapper.unmount();
  });

  it('a 412 says the hours or 약속 changed, offers only “다시 만들기”, and regenerates against the latest availability', async () => {
    const plan = await createPlan();
    const other = createPlannerClient();
    const availability = await other.getAvailability({ fresh: true });
    await other.putAvailability(
      {
        timeZone: availability.timeZone,
        rules: availability.rules,
        exceptions: availability.exceptions,
        prefs: { ...availability.prefs, maxDailyFocusMin: 240 },
      },
      newActionId('availability-change'),
      availability.version,
    );

    const wrapper = await mountPlan(plan.id);
    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    await vi.waitFor(
      () => {
        expect(wrapper.get('[data-plan-stale]').text()).toContain('그사이 가용 시간이나 약속이 바뀌었어요.');
      },
      { timeout: 3_000 },
    );
    // Nothing was confirmed, and the stale candidates cannot be: the one filled button is "다시 만들기".
    expect(storedPlan(plan.id).status).toBe('draft');
    expect(wrapper.find('[data-plan-approve]').exists()).toBe(false);
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['일정안 다시 만들기']);

    await buttonByText(wrapper, '일정안 다시 만들기').trigger('click');
    await vi.waitFor(
      () => {
        expect(wrapper.get('[data-plan-status]').text()).toBe('지금 가용 시간과 약속으로 일정안을 다시 만들었어요.');
      },
      { timeout: 5_000 },
    );

    const regenerated = storedPlan(plan.id);
    expect(regenerated.version).toBeGreaterThan(plan.version);
    expect(regenerated.availabilityVersion).toBe(availability.version + 1);
    expect(wrapper.find('[data-plan-stale]').exists()).toBe(false);
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['이 일정으로 확정']);
    wrapper.unmount();
  });

  it('a confirmed plan can be compared again and confirmed with another candidate; going back changes nothing', async () => {
    const plan = await createPlan();
    const wrapper = await mountPlan(plan.id);
    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-plan-next]').exists()).toBe(true), { timeout: 3_000 });
    const firstVersion = storedPlan(plan.id).currentVersionId;

    await wrapper.get('[data-plan-choose]').trigger('click');
    await settle();
    expect(wrapper.attributes('data-plan-stage')).toBe('schedule');
    expect(wrapper.find('[data-plan-next]').exists()).toBe(false);
    await proposals(wrapper);
    // While comparing again, the plan's own confirmed blocks give way to the proposals
    // (what other plans confirmed stays on the grid).
    const own = ownBlockKeys(plan.id);
    expect(own.length).toBeGreaterThan(0);
    expect(drawnBlockKeys(wrapper).filter((key) => own.some((prefix) => key.startsWith(prefix)))).toEqual([]);

    await wrapper.get('[data-plan-back]').trigger('click');
    await settle();
    expect(wrapper.find('[data-plan-next]').exists()).toBe(true);
    expect(storedPlan(plan.id).currentVersionId).toBe(firstVersion);

    await wrapper.get('[data-plan-choose]').trigger('click');
    await settle();
    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    await vi.waitFor(() => expect(storedPlan(plan.id).currentVersionId).not.toBe(firstVersion), { timeout: 3_000 });
    await vi.waitFor(() => expect(wrapper.find('[data-plan-next]').exists()).toBe(true));
    wrapper.unmount();
  });
});

describe('approval problem payloads from the real client', () => {
  it('renders constraint_violation findings parsed from the problem body', async () => {
    const plan = await createPlan();
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:approve$/, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Constraint violation',
            status: 422,
            code: 'constraint_violation',
            detail: 'Edited blocks overlap',
            violations: [{ code: 'H1', message: 'Blocks overlap each other.' }],
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const wrapper = await mountPlan(plan.id);
    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');

    await vi.waitFor(
      () => {
        expect(wrapper.get('[data-plan-violations]').text()).toContain('블록이 다른 블록, 약속 또는 고정된 블록과 겹쳐요.');
      },
      { timeout: 3_000 },
    );
    expect(wrapper.get('.violation-list li').attributes('data-code')).toBe('H1');
    // The server's own finding text stays available (marked lang="en")…
    expect(wrapper.get('.violation-list [lang="en"]').text()).toBe('Blocks overlap each other.');
    // …while the problem `detail` is replaced by the Korean message for its code.
    expect(wrapper.get('[data-plan-error]').text()).toContain('일정 규칙에 맞지 않아요. 표시된 항목을 확인해 주세요.');
    expect(wrapper.text()).not.toContain('Edited blocks overlap');
    // Nothing was confirmed.
    expect(wrapper.find('[data-plan-next]').exists()).toBe(false);
    expect(storedPlan(plan.id).status).toBe('draft');
    wrapper.unmount();
  });

  it('marks the block named by /editedBlocks/<i>', async () => {
    const plan = await createPlan();
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:approve$/, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            code: 'validation_failed',
            detail: 'Edited blocks failed pre-flight validation',
            errors: [{ path: '/editedBlocks/0', message: 'block lies outside the plan horizon' }],
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const wrapper = await mountPlan(plan.id);
    await proposals(wrapper);
    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');

    await vi.waitFor(
      () => {
        expect(wrapper.get('[data-plan-violations]').text()).toContain('블록 1: 일정안 기간을 벗어났어요');
      },
      { timeout: 3_000 },
    );
    expect(wrapper.get('[data-proposal="0"]').classes()).toContain('wg-item--invalid');
    wrapper.unmount();
  });
});

describe('offline', () => {
  it('cancels a debounced preview when the connection drops before it fires', async () => {
    const plan = await createPlan();
    const pinia = createPinia();
    const wrapper = await mountPlan(plan.id, pinia);
    const offline = useOfflineStore(pinia);
    const spy = vi.spyOn(plannerClient, 'previewCandidateEdit');

    const block = (await proposals(wrapper))[0]!;
    await block.trigger('keydown', { key: 'ArrowDown', altKey: true });
    offline.setOnline(false);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await settle();

    expect(spy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('is read-only offline: nothing can be edited, regenerated or confirmed (negative)', async () => {
    const plan = await createPlan();
    const pinia = createPinia();
    const wrapper = await mountPlan(plan.id, pinia);
    const block = (await proposals(wrapper))[0]!;
    const before = block.attributes('aria-label');
    useOfflineStore(pinia).setOnline(false);
    await settle();

    const approveSpy = vi.spyOn(plannerClient, 'approveCandidate');
    const regenerateSpy = vi.spyOn(plannerClient, 'regeneratePlan');
    expect(wrapper.get('[data-plan-approve]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-plan-regenerate]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-plan-approve]').trigger('click');
    await wrapper.get('[data-plan-regenerate]').trigger('click');
    await block.trigger('keydown', { key: 'ArrowDown', altKey: true });
    await settle();
    expect(approveSpy).not.toHaveBeenCalled();
    expect(regenerateSpy).not.toHaveBeenCalled();
    expect(wrapper.get('[data-proposal="0"]').attributes('aria-label')).toBe(before);
    expect(wrapper.get('[data-plan-draft-state]').text()).toBe('만들어진 그대로');
    wrapper.unmount();
  });
});

describe('pending preview cleanup on unmount', () => {
  it('does not fire a debounced preview after the view is unmounted', async () => {
    const plan = await createPlan();
    const wrapper = await mountPlan(plan.id);
    const spy = vi.spyOn(plannerClient, 'previewCandidateEdit');

    await (await proposals(wrapper))[0]!.trigger('keydown', { key: 'ArrowDown', altKey: true });
    wrapper.unmount();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the plan is unfinished business until it is confirmed', () => {
  it('a plan remembered as unfinished (ids only, per owner) is forgotten once it is confirmed', async () => {
    const plan = await createPlan();
    const session = createUuidV7();
    const owner = mockDb.user.id;
    // What 일정안 만들기 wrote when it made the plan (plan-scope.spec.ts covers that write).
    adoptActiveOwner(owner);
    rememberPlanFlow(captureOwnerBinding(), { kind: 'plan', id: plan.id, sessionId: session });
    const wrapper = await mountPlan(plan.id, createPinia(), `?session=${session}`);

    expect(readPlanFlows(owner)).toMatchObject([{ kind: 'plan', id: plan.id, sessionId: session }]);
    // Ids and a time: nothing the owner wrote is on the device.
    expect(Object.keys(JSON.parse(localStorage.getItem(planFlowKey(owner)) ?? '[]')[0]).sort()).toEqual(['at', 'id', 'kind', 'sessionId']);
    // The rail leads back to the steps of the session it came from.
    expect(wrapper.get('[data-stage="steps"] a').attributes('href')).toBe(`/plan/${session}`);

    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-plan-next]').exists()).toBe(true), { timeout: 3_000 });
    expect(readPlanFlows(owner)).toEqual([]);
    wrapper.unmount();
  });

  it('negative: a plan that does not exist says so and leads back to the start, and remembers nothing', async () => {
    const router = testRouter();
    const missing = createUuidV7();
    await router.push(`/plan/schedule/${missing}`);
    await router.isReady();
    const pinia = createPinia();
    useSessionStore(pinia).setOwner(mockDb.user.id);
    const wrapper = mountWithPlugins(PlanScheduleView, { router, pinia, props: { id: missing } });
    await vi.waitFor(() => expect(wrapper.find('[data-plan-missing]').exists()).toBe(true), { timeout: 5_000 });
    expect(wrapper.get('[data-plan-missing]').text()).toContain('이 일정안을 찾을 수 없어요');
    expect(wrapper.get('[data-plan-missing] a').attributes('href')).toBe('/plan');
    expect(readPlanFlows(mockDb.user.id)).toEqual([]);
    wrapper.unmount();
  });
});
