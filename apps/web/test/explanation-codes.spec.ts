import { mount } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import openapi from '../../../packages/contracts/openapi.json';
import { createPlannerClient, newActionId, type Plan, type Today, type TodayProposal, type Violation } from '../src/api';
import ExplanationList from '../src/components/ExplanationList.vue';
import ProposalPreview from '../src/components/ProposalPreview.vue';
import { ko } from '../src/i18n';
import {
  RENDERED_EXPLANATION_CODES,
  explanationItemText,
  renderExplanation,
  violationMessageText,
  type ExplanationCode,
  type ExplanationItem,
} from '../src/i18n/explanation';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import PlanComparisonView from '../src/views/PlanComparisonView.vue';
import { buttonByText, mountWithPlugins, settle, testRouter } from './planning-test-utils';

const HANGUL = /[가-힣]/;
const TASK = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const OTHER = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c57';
const TZ = 'Asia/Seoul';
const NAMES: Readonly<Record<string, string>> = { [TASK]: '보고서', [OTHER]: '발표 준비' };
const context = { timeZone: TZ, taskName: (id: string) => NAMES[id] };

const block = { taskId: TASK, startAt: '2026-11-14T09:00:00Z', endAt: '2026-11-14T10:30:00Z' };

/**
 * One realistic params object per contract code. Typed as an exhaustive
 * record, so a new code without a rendering fixture is a typecheck error.
 */
const SAMPLES: { readonly [C in ExplanationCode]: ExplanationItem['params'] } = {
  policy_summary: { policy: 'front_loaded', policyVersion: '1.0.0' },
  placement_summary: { placedMin: 90, requiredMin: 150, blockCount: 2, retainedCount: 1 },
  constraints_satisfied: {},
  infeasible_summary: { violationCount: 3 },
  heuristic_insufficient_available_time: {},
  heuristic_no_contiguous_window: {},
  heuristic_estimate_not_grid_aligned: {},
  heuristic_estimate_below_grid: {},
  heuristic_session_bounds_infeasible: {},
  unplaced_minutes: { deficitMin: 60 },
  capacity_deficit: { capacityDeficitMin: 45 },
  replan_bound_exceeded: { changedBlocks: 6, bound: 4, affectedExistingBlocks: 1 },
  input_rejected: { issueCount: 2 },
  heuristic_blocked_by_predecessor: {},
  auto_split_long_task: { taskId: TASK, sessionMaxMin: 60, reason: 'break_after' },
  input_invalid_time_zone: {},
  input_invalid_horizon_instant: {},
  input_horizon_not_increasing: {},
  input_horizon_too_long: { maxDays: 366 },
  input_invalid_now: {},
  input_duplicate_task: { taskId: TASK },
  input_invalid_estimate: { taskId: TASK, maxMin: 100_000 },
  input_invalid_buffer: { taskId: TASK, maxMin: 100_000 },
  input_invalid_session_minutes: { taskId: TASK, maxMin: 100_000 },
  input_invalid_session_bounds: { taskId: TASK },
  input_invalid_task_window_instant: { taskId: TASK },
  input_task_window_empty: { taskId: TASK },
  input_invalid_preference: { field: 'breakMin', maxMin: 100_000 },
  input_unknown_dependency: { taskId: TASK, dependencyId: OTHER },
  input_dependency_cycle: {},
  input_invalid_weekday: {},
  input_invalid_availability_window: { weekday: 2 },
  input_invalid_exception_date: {},
  input_exception_partial_window: {},
  input_invalid_exception_window: {},
  input_commitment_invalid_instant: {},
  input_commitment_end_before_start: {},
  input_commitment_too_long: { maxDays: 366 },
  input_unknown_block_task: { taskId: TASK },
  input_invalid_block_instant: { taskId: TASK },
  input_block_sub_millisecond: { taskId: TASK },
  input_block_off_grid: { taskId: TASK },
  input_block_end_before_start: { taskId: TASK },
  input_block_too_long: { taskId: TASK, maxDays: 366 },
  h0_unknown_task: { taskId: TASK },
  h0_outside_horizon: { ...block },
  h1_same_task_overlap: { taskId: TASK },
  h1_tasks_overlap: { taskId: TASK, otherTaskId: OTHER },
  h1_commitment_overlap: { ...block },
  h1_active_block_overlap: {},
  h2_outside_availability: { ...block },
  h3_dependency_order: { taskId: TASK, dependencyId: OTHER },
  h4_before_earliest_start: { taskId: TASK, earliestStartAt: '2026-11-15T00:00:00Z' },
  h4_inside_due_buffer: { taskId: TASK, dueAt: '2026-11-15T09:00:00Z', bufferMin: 120 },
  h4_after_due: { taskId: TASK, dueAt: '2026-11-15T09:00:00Z' },
  h5_unsplittable_no_remaining: { taskId: TASK },
  h5_unsplittable_required_out_of_bounds: { taskId: TASK, requiredMin: 240, minSessionMin: 30, maxSessionMin: 180 },
  h5_unsplittable_single_block: { taskId: TASK, requiredMin: 240 },
  h5_session_out_of_bounds: { ...block, durationMin: 15, minSessionMin: 30, maxSessionMin: 120 },
  h6_daily_focus_exceeded: { date: '2026-11-14', totalMin: 310, maxDailyFocusMin: 240 },
  h6_break_missing: { date: '2026-11-14', breakAfterMin: 90, breakMin: 15 },
  h7_deficit: { taskId: TASK, shortMin: 30 },
  h7_overallocated: { taskId: TASK, excessMin: 60 },
  h8_invalid_time_zone: {},
  h8_invalid_horizon: {},
  h8_invalid_instant: { taskId: TASK },
  h8_sub_millisecond: { taskId: TASK },
  h8_off_grid: { taskId: TASK },
  h8_end_before_start: { taskId: TASK },
};

function item<C extends ExplanationCode>(code: C, params: ExplanationItem['params'] = SAMPLES[code]): ExplanationItem {
  return { code, params };
}

function contractCodes(): string[] {
  const schema = (openapi as unknown as {
    components: { schemas: { ExplanationItem: { properties: { code: { anyOf: { const: string }[] } } } } };
  }).components.schemas.ExplanationItem;
  return schema.properties.code.anyOf.map((entry) => entry.const);
}

describe('explanation code catalog (FU-62)', () => {
  it('has a Korean message and a renderer for exactly the contract enum', () => {
    const codes = contractCodes();
    expect(codes.length).toBeGreaterThan(60);
    expect(Object.keys(ko.explain).sort()).toEqual([...codes].sort());
    expect([...RENDERED_EXPLANATION_CODES].sort()).toEqual([...codes].sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...codes].sort());
  });

  it('renders every code as a complete Korean sentence with Intl-formatted params', () => {
    for (const code of RENDERED_EXPLANATION_CODES) {
      const text = explanationItemText(item(code), context);
      expect(text, code).not.toBeNull();
      expect(HANGUL.test(text ?? ''), `${code} → ${text}`).toBe(true);
      expect(text, code).not.toMatch(/[{}]/);
      // No raw IDs, ISO instants or bare English words leak into the sentence.
      expect(text, code).not.toContain(TASK);
      expect(text, code).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect((text ?? '').replace(/\b(?:H1|H8|IANA|v1\.0\.0)\b/g, ''), code).not.toMatch(/[A-Za-z]{2,}/);
    }
  });

  it('formats task names, durations, ranges, dates and counts in Korean', () => {
    expect(explanationItemText(item('h7_deficit'), context)).toBe('“보고서” 작업에 30분이 모자라요.');
    expect(explanationItemText(item('h1_tasks_overlap'), context)).toBe('“보고서” 작업과 “발표 준비” 작업의 블록이 겹쳐요.');
    expect(explanationItemText(item('h3_dependency_order'), context)).toBe(
      '“보고서” 작업이 “발표 준비” 작업이 끝나기 전에 시작해요.',
    );
    expect(explanationItemText(item('h1_commitment_overlap'), context)).toBe(
      '“보고서” 작업의 블록(11월 14일 (토) 오후 6:00~7:30)이 약속과 겹쳐요.',
    );
    expect(explanationItemText(item('h6_daily_focus_exceeded'), context)).toBe(
      '11월 14일 (토) 집중 시간(5시간 10분)이 하루 한도(4시간)를 넘어요.',
    );
    expect(explanationItemText(item('h4_inside_due_buffer'), context)).toBe(
      '“보고서” 작업이 마감(11월 15일 (일) 오후 6:00) 전 여유 2시간 안에서 끝나요.',
    );
    expect(explanationItemText(item('placement_summary'), context)).toBe(
      '필요한 2시간 30분 중 1시간 30분을 블록 2개에 배치했어요. 기존 블록 1개는 그대로 뒀어요.',
    );
    expect(explanationItemText(item('policy_summary'), context)).toBe(
      '‘앞당겨 끝내기’ 정책 (v1.0.0): 일을 최대한 일찍 끝내서 마감까지 여유를 넉넉히 둬요.',
    );
    expect(explanationItemText(item('input_invalid_estimate'), context)).toBe(
      '“보고서” 작업의 예상 시간은 0분부터 100,000분까지의 정수여야 해요.',
    );
    expect(explanationItemText(item('input_invalid_availability_window'), context)).toBe(
      '화요일 가용 시간 구간이 올바르지 않아요.',
    );
    expect(explanationItemText(item('input_invalid_preference'), context)).toBe(
      '‘휴식 길이’ 설정은 0분부터 100,000분까지의 정수여야 해요.',
    );
  });

  it('uses a generic task word when a name is unknown, never the ID', () => {
    const anonymous = { timeZone: TZ };
    expect(explanationItemText(item('h7_deficit'), anonymous)).toBe('한 작업에 30분이 모자라요.');
    expect(explanationItemText(item('h1_tasks_overlap'), anonymous)).toBe('한 작업과 다른 작업의 블록이 겹쳐요.');
    expect(explanationItemText(item('h3_dependency_order'), anonymous)).toBe('한 작업이 선행 작업이 끝나기 전에 시작해요.');
  });

  it('returns null for unknown codes and missing or ill-typed params (negative)', () => {
    expect(explanationItemText({ code: 'brand_new_code', params: {} } as unknown as ExplanationItem, context)).toBeNull();
    expect(explanationItemText(item('h7_deficit', { taskId: TASK }), context)).toBeNull();
    expect(explanationItemText(item('h7_deficit', { taskId: TASK, shortMin: '30' }), context)).toBeNull();
    expect(explanationItemText(item('h1_commitment_overlap', { taskId: TASK, startAt: 'soon', endAt: 'later' }), context)).toBeNull();
    expect(explanationItemText(item('h6_break_missing', { date: 'today', breakAfterMin: 90, breakMin: 15 }), context)).toBeNull();
    expect(explanationItemText(item('policy_summary', { policy: 'mystery', policyVersion: '1' }), context)).toBeNull();
    expect(explanationItemText(item('input_invalid_availability_window', { weekday: 9 }), context)).toBeNull();
    expect(explanationItemText(item('input_invalid_preference', { field: 'title', maxMin: 1 }), context)).toBeNull();
    expect(
      explanationItemText({ code: 'h7_deficit', params: undefined } as unknown as ExplanationItem, context),
    ).toBeNull();
  });

  it('pairs items with lines and falls back to the original text when items are missing or misaligned', () => {
    const lines = ['Policy front_loaded v1.0.0: Finish work as early as possible.', 'All hard constraints H1-H8 satisfied.'];
    const coded = renderExplanation(lines, [item('policy_summary'), item('constraints_satisfied')], context);
    expect(coded.coded).toBe(true);
    expect(coded.entries.every((entry) => entry.translated)).toBe(true);

    expect(renderExplanation(lines, [], context)).toEqual({
      coded: false,
      entries: lines.map((text) => ({ text, translated: false })),
    });
    expect(renderExplanation(lines, undefined, context).coded).toBe(false);
    expect(renderExplanation(lines, [item('constraints_satisfied')], context).coded).toBe(false);

    // A single unrenderable item shows its own English line, not a broken sentence.
    const partial = renderExplanation(lines, [item('policy_summary', {}), item('constraints_satisfied')], context);
    expect(partial.coded).toBe(true);
    expect(partial.entries[0]).toEqual({ text: lines[0], translated: false });
    expect(partial.entries[1]?.translated).toBe(true);
  });

  it('renders coded violations and keeps legacy ones as code text plus original message', () => {
    const coded: Violation = {
      code: 'H7',
      taskId: TASK,
      message: `Task "${TASK}" is short by 30 minutes (deficit).`,
      messageCode: 'h7_deficit',
      params: { taskId: TASK, shortMin: 30 },
    };
    expect(violationMessageText(coded, context)).toBe('“보고서” 작업에 30분이 모자라요.');
    expect(violationMessageText({ code: 'H1', message: 'Blocks overlap.' }, context)).toBeNull();
    expect(violationMessageText({ code: 'H1', message: 'x', messageCode: 'h1_unknown', params: {} }, context)).toBeNull();
  });
});

describe('ExplanationList component (FU-62)', () => {
  const lines = ['Policy front_loaded v1.0.0: Finish work as early as possible.', 'Unplaced minutes (H7 shortfall): 60 min.'];

  it('shows coded explanations as Korean "계산 근거" without the original text', () => {
    const wrapper = mount(ExplanationList, {
      props: { lines, items: [item('policy_summary'), item('unplaced_minutes')], timeZone: TZ, taskNames: NAMES },
    });
    expect(wrapper.get('summary').text()).toBe('계산 근거');
    expect(wrapper.get('details').attributes('data-explanation')).toBe('coded');
    expect(wrapper.findAll('li').map((entry) => entry.text())).toEqual([
      '‘앞당겨 끝내기’ 정책 (v1.0.0): 일을 최대한 일찍 끝내서 마감까지 여유를 넉넉히 둬요.',
      '배치하지 못한 시간은 1시간이에요.',
    ]);
    expect(wrapper.find('[lang="en"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Unplaced');
  });

  it('keeps the "계산 근거 (원문)" disclosure for rows without items (fallback)', () => {
    const wrapper = mount(ExplanationList, { props: { lines, items: [], timeZone: TZ } });
    expect(wrapper.get('summary').text()).toBe('계산 근거 (원문)');
    expect(wrapper.get('details').attributes('data-explanation')).toBe('original');
    expect(wrapper.get('ul').attributes('lang')).toBe('en');
    expect(wrapper.findAll('li').map((entry) => entry.text())).toEqual(lines);
  });

  it('marks only the unrenderable entry as English inside a coded list', () => {
    const wrapper = mount(ExplanationList, {
      props: { lines, items: [item('policy_summary'), item('unplaced_minutes', {})], timeZone: TZ },
    });
    const entries = wrapper.findAll('li');
    expect(entries[0]?.attributes('lang')).toBeUndefined();
    expect(entries[1]?.attributes('lang')).toBe('en');
    expect(entries[1]?.text()).toBe(lines[1]);
  });

  it('renders coded and legacy violations side by side', () => {
    const violations: Violation[] = [
      {
        code: 'H1',
        taskId: TASK,
        message: `Block for task "${TASK}" overlaps a commitment.`,
        messageCode: 'h1_commitment_overlap',
        params: { ...block },
      },
      { code: 'H2', message: 'Block is outside availability.' },
    ];
    const wrapper = mount(ExplanationList, { props: { violations, timeZone: TZ, taskNames: NAMES } });
    const [first, second] = wrapper.findAll('.violation-list li');
    expect(first?.text()).toBe('H1 — “보고서” 작업의 블록(11월 14일 (토) 오후 6:00~7:30)이 약속과 겹쳐요.');
    expect(first?.find('[lang="en"]').exists()).toBe(false);
    expect(second?.text()).toContain('H2');
    expect(second?.text()).toContain('블록이 가용 시간 밖에 있어요.');
    expect(second?.get('[lang="en"]').text()).toBe('Block is outside availability.');
    expect(wrapper.find('details').exists()).toBe(false);
  });
});

describe('plan comparison with coded explanations (FU-62)', () => {
  const HORIZON = { start: '2026-11-11T00:00:00.000Z', end: '2026-11-25T00:00:00.000Z' };

  async function createPlan(): Promise<Plan> {
    const task = [...mockDb.tasks.values()][0];
    if (task === undefined) throw new Error('seed task missing');
    return createPlannerClient().createPlan(
      { scope: { taskIds: [task.id] }, horizon: HORIZON, policies: ['front_loaded'] },
      newActionId('plan-create'),
    );
  }

  async function mountPlan(planId: string) {
    const router = testRouter();
    await router.push(`/plans/${planId}`);
    await router.isReady();
    const wrapper = mountWithPlugins(PlanComparisonView, { router });
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.findAll('.candidate-card').length).toBeGreaterThan(0);
    });
    return wrapper;
  }

  it('renders the scheduler explanation of a new plan in Korean', async () => {
    const plan = await createPlan();
    const candidate = plan.candidates[0];
    expect(candidate?.explanationItems).toHaveLength(candidate?.explanation.length ?? -1);
    const wrapper = await mountPlan(plan.id);
    const details = wrapper.get('.candidate-explanation');
    expect(details.get('summary').text()).toBe('계산 근거');
    expect(details.text()).toContain('‘앞당겨 끝내기’ 정책 (v1.0.0)');
    expect(details.find('[lang="en"]').exists()).toBe(false);
    expect(details.text()).not.toContain('Policy front_loaded');
    wrapper.unmount();
  });

  it('falls back to the original text for a plan stored without items', async () => {
    const plan = await createPlan();
    const stored = mockDb.plans.get(plan.id);
    if (stored === undefined) throw new Error('plan was not stored');
    for (const candidate of stored.candidates) delete candidate.explanationItems;
    const wrapper = await mountPlan(plan.id);
    const details = wrapper.get('.candidate-explanation');
    expect(details.get('summary').text()).toBe('계산 근거 (원문)');
    expect(details.get('ul').attributes('lang')).toBe('en');
    expect(details.text()).toContain('Policy front_loaded');
    wrapper.unmount();
  });

  it('shows a coded 422 constraint_violation from approve as a Korean sentence with the task name', async () => {
    const plan = await createPlan();
    const task = [...mockDb.tasks.values()][0];
    if (task === undefined) throw new Error('seed task missing');
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:approve$/, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Constraint violation',
            status: 422,
            code: 'constraint_violation',
            violations: [
              {
                code: 'H7',
                taskId: task.id,
                message: `Task "${task.id}" is short by 30 minutes (deficit).`,
                messageCode: 'h7_deficit',
                params: { taskId: task.id, shortMin: 30 },
              },
            ],
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const wrapper = await mountPlan(plan.id);
    await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain(`“${task.title}” 작업에 30분이 모자라요.`);
      },
      { timeout: 3_000 },
    );
    expect(wrapper.find('.violation-list [lang="en"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('is short by');
    wrapper.unmount();
  });
});

describe('today proposal dialog with coded findings (FU-62)', () => {
  const proposal: TodayProposal = {
    id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c60',
    kind: 'reschedule',
    date: '2026-11-14',
    timeZone: TZ,
    availabilityVersion: 3,
    basePlanVersionId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c61',
    blocks: [{ blockId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c62', ...block }],
    createdAt: '2026-11-14T00:00:00Z',
    version: 1,
  };
  const today = { blocks: [{ taskId: TASK, title: '보고서' }] } as unknown as Today;

  it('lists the approval findings in Korean using the titles of today', () => {
    const wrapper = mount(ProposalPreview, {
      props: {
        proposal,
        today,
        error: '일정 규칙에 맞지 않아요. 표시된 항목을 확인해 주세요.',
        violations: [
          {
            code: 'H1',
            message: 'an approved block overlaps an active schedule block',
            messageCode: 'h1_active_block_overlap',
            params: {},
          },
          {
            code: 'H2',
            taskId: TASK,
            message: `Block for task "${TASK}" is outside availability.`,
            messageCode: 'h2_outside_availability',
            params: { ...block },
          },
        ],
      },
      attachTo: document.body,
    });
    const findings = wrapper.findAll('.violation-list li').map((entry) => entry.text());
    expect(findings).toEqual([
      'H1 — 확정하려는 블록이 이미 확정된 다른 블록과 겹쳐요. 새로 고친 뒤 다시 시도해 주세요.',
      'H2 — “보고서” 작업의 블록(11월 14일 (토) 오후 6:00~7:30)이 가용 시간 밖에 있어요.',
    ]);
    expect(wrapper.find('.violation-list [lang="en"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows no finding list without violations (negative)', () => {
    const wrapper = mount(ProposalPreview, { props: { proposal, today }, attachTo: document.body });
    expect(wrapper.find('.violation-list').exists()).toBe(false);
    wrapper.unmount();
  });
});
