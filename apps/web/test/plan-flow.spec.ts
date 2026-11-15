import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia } from 'pinia';
import { nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import {
  ApiError,
  createPlannerClient,
  newActionId,
  plannerClient,
  type IntakeSession,
} from '../src/api';
import { readPlanFlows } from '../src/composables/planFlowMemory';
import { sessionStage } from '../src/domain/planFlow';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { useSessionStore } from '../src/stores/session';
import PlanView from '../src/views/PlanView.vue';
import { testRouter } from './planning-test-utils';

/**
 * HOLO-03A — 계획 세우기 · 목표 → 질문 → 단계 (`/plan`, `/plan/:sessionId`).
 * What the flow does is what the planning wizard did (M2/M3, FU-40, FU-91);
 * these tests describe it in its new shape: one page per stage, the
 * questions answered in one go, and confirming the steps leads straight on
 * to the schedules.
 */

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

async function waitFor(check: () => void, timeout = 3000): Promise<void> {
  await vi.waitFor(check, { timeout });
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

async function mountFlow(sessionId?: string) {
  const pinia = createPinia();
  const router = testRouter();
  await router.push(sessionId === undefined ? '/plan' : `/plan/${sessionId}`);
  await router.isReady();
  // The signed-in owner, so what the flow remembers on the device has a namespace.
  useSessionStore(pinia).setOwner(mockDb.user.id);
  const wrapper = mount(PlanView, {
    ...(sessionId === undefined ? {} : { props: { sessionId } }),
    global: { plugins: [pinia, router, VueQueryPlugin] },
    attachTo: document.body,
  });
  await settle();
  return { wrapper, router, pinia };
}

function stageOf(wrapper: VueWrapper): string | undefined {
  return wrapper.attributes('data-plan-stage');
}

async function atStage(wrapper: VueWrapper, stage: string): Promise<void> {
  await waitFor(() => expect(stageOf(wrapper)).toBe(stage));
}

async function createSession(title: string): Promise<IntakeSession> {
  return createPlannerClient().createIntakeSession({ title, dueAt: '2026-11-30T18:00:00.000Z' }, newActionId('create'));
}

async function answerAllWithIdk(session: IntakeSession): Promise<IntakeSession> {
  const client = createPlannerClient();
  let current = session;
  for (let round = 0; round < 5; round += 1) {
    const questions = current.questions ?? [];
    if (questions.length === 0) break;
    current = await client.answerIntakeQuestions(
      current.id,
      questions.map((question) => ({ questionKey: question.field, action: 'idk' as const })),
      newActionId('answers'),
      current.version,
    );
  }
  return current;
}

async function seedDraftSession(title = '논문 요약'): Promise<IntakeSession> {
  const created = await createSession(title);
  return answerAllWithIdk(created);
}

async function manualSession(title: string): Promise<IntakeSession> {
  const session = await createSession(title);
  return createPlannerClient().enterManualIntakeMode(session.id, newActionId('manual'), session.version);
}

/** Answer every round of questions the way a person in a hurry does: 모름 for all, or nothing at all. */
async function answerRounds(wrapper: VueWrapper, how: 'idk' | 'blank'): Promise<void> {
  for (let guard = 0; guard < 10; guard += 1) {
    if (stageOf(wrapper) !== 'questions' || !wrapper.find('[data-plan-questions]').exists()) return;
    if (how === 'idk') {
      for (const box of wrapper.findAll('input[data-idk]')) await box.setValue(true);
    }
    await wrapper.get('[data-plan-questions]').trigger('submit');
    await settle();
  }
  throw new Error('the questions did not end');
}

beforeEach(() => {
  localStorage.clear();
});

describe('the stages of a planning session (pure)', () => {
  it('reads the stage off the session’s own state', () => {
    expect(sessionStage({ state: 'created' })).toBe('questions');
    expect(sessionStage({ state: 'type_detection' })).toBe('questions');
    expect(sessionStage({ state: 'clarification' })).toBe('questions');
    expect(sessionStage({ state: 'decomposition' })).toBe('steps');
    expect(sessionStage({ state: 'feasibility_check' })).toBe('schedule');
    expect(sessionStage({ state: 'plan_proposals' })).toBe('schedule');
    expect(sessionStage({ state: 'awaiting_approval' })).toBe('schedule');
    expect(sessionStage({ state: 'scheduled' })).toBe('confirmed');
  });

  it('a session set aside is where it stopped; one given up or failed has ended (negative)', () => {
    expect(sessionStage({ state: 'needs_input' })).toBe('questions');
    expect(sessionStage({ state: 'needs_input', draft: { steps: [] } })).toBe('steps');
    expect(sessionStage({ state: 'cancelled' })).toBe('ended');
    expect(sessionStage({ state: 'failed', draft: { steps: [] } })).toBe('ended');
  });
});

describe('목표 → 질문 → 단계 → 일정안 (a new kind of work)', () => {
  it('starts from one sentence, never re-asks what was given, says what it assumed, and confirming the steps makes the tasks and the schedules', async () => {
    const { wrapper, router } = await mountFlow();
    expect(stageOf(wrapper)).toBe('goal');
    expect(wrapper.get('h1').text()).toBe('계획 세우기');
    // The rail names the whole flow, with 목표 current.
    expect(wrapper.findAll('[data-plan-rail] .plan-rail-label').map((item) => item.text().trim())).toEqual([
      '목표',
      '질문',
      '단계',
      '일정안',
      '확정',
    ]);
    expect(wrapper.get('[data-stage="goal"]').attributes('aria-current')).toBe('step');
    // Exactly one filled button: the next step.
    expect(wrapper.findAll('.btn--primary').map((item) => item.text())).toEqual(['계획 세우기 시작']);

    await wrapper.get('#plan-goal-title').setValue('논문 요약');
    await wrapper.get('#plan-goal-due').setValue('2026-11-30T18:00');
    await wrapper.get('#plan-goal-description').setValue('관련 논문 5편을 요약한다');
    await wrapper.get('form').trigger('submit');

    await atStage(wrapper, 'questions');
    // The goal is the page's title from here on, with when it is due.
    expect(wrapper.get('h1').text()).toBe('논문 요약');
    expect(wrapper.get('[data-plan-lede]').text()).toMatch(/^11월 30일 \(월\) 오후 6:00까지$/);
    const questionText = wrapper.get('[data-plan-questions]').text();
    expect(questionText).not.toContain('언제까지 끝내야 하나요?');
    expect(questionText).not.toContain('When is it due?');
    expect(wrapper.findAll('.plan-question').length).toBeGreaterThan(0);
    expect(wrapper.findAll('.plan-question').length).toBeLessThanOrEqual(5);

    await answerRounds(wrapper, 'idk');
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));
    const assumptions = wrapper.findAll('[data-assumption]');
    expect(assumptions.length).toBeGreaterThan(0);
    expect(wrapper.get('[data-plan-assumptions]').text()).toContain('모름');

    const before = mockDb.tasks.size;
    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'));

    // The steps are tasks, filed under one goal (FU-98)…
    const approved = [...mockDb.intakeSessions.values()][0];
    expect(approved?.goalId).toBeDefined();
    expect(mockDb.tasks.size).toBe(before + 4);
    expect(mockDb.intakeSessions.size).toBe(1);
    const goals = await plannerClient.listGoals();
    expect(goals.items[0]?.id).toBe(approved?.goalId);
    expect(goals.items[0]?.taskIds).toEqual(approved?.createdTaskIds);
    expect(goals.items[0]?.taskIds).toHaveLength(4);
    // …and the three schedules were made for that goal and opened, with the session they came from.
    const plan = [...mockDb.plans.values()][0];
    expect(plan?.scope).toEqual({ goalId: approved?.goalId });
    expect(plan?.status).toBe('draft');
    expect(router.currentRoute.value.params['id']).toBe(plan?.id);
    expect(router.currentRoute.value.query['session']).toBe(approved?.id);
    // The plan (not the session any more) is what the device remembers as unfinished.
    expect(readPlanFlows(mockDb.user.id)).toMatchObject([{ kind: 'plan', id: plan?.id, sessionId: approved?.id }]);
    wrapper.unmount();
  });

  it('sends the answers of a round in one request: a value, 모름, or skipped when left blank', async () => {
    const session = await createSession('한 번에 답하기');
    const sent: unknown[] = [];
    server.use(
      http.post('*/api/v1/intake-sessions/:id/answers', async ({ request }) => {
        sent.push(await request.clone().json());
      }),
    );
    const { wrapper } = await mountFlow(session.id);
    await atStage(wrapper, 'questions');
    const fields = wrapper.findAll('.plan-question').map((item) => item.attributes('data-question') ?? '');
    expect(fields.length).toBeGreaterThanOrEqual(2);
    expect(fields).toContain('deliverable');

    await wrapper.get('#answer-deliverable').setValue('  요약 보고서 한 편  ');
    const other = fields.find((field) => field !== 'deliverable') ?? '';
    await wrapper.get(`input[data-idk="${other}"]`).setValue(true);
    // 모름 takes the field's own answer away.
    expect(wrapper.get(`#answer-${other}`).attributes('disabled')).toBeDefined();
    await wrapper.get('[data-plan-questions]').trigger('submit');
    await waitFor(() => expect(sent).toHaveLength(1));

    const answers = (sent[0] as { answers: { questionKey: string; action: string; value?: unknown }[] }).answers;
    expect(answers.map((answer) => answer.questionKey)).toEqual(fields);
    expect(answers.find((answer) => answer.questionKey === 'deliverable')).toEqual({
      questionKey: 'deliverable',
      action: 'answer',
      value: '요약 보고서 한 편',
    });
    expect(answers.find((answer) => answer.questionKey === other)).toEqual({ questionKey: other, action: 'idk' });
    for (const answer of answers.filter((item) => item.questionKey !== 'deliverable' && item.questionKey !== other)) {
      expect(answer).toEqual({ questionKey: answer.questionKey, action: 'skip' });
    }
    wrapper.unmount();
  });

  it('keeps confirming idempotent when the button is pressed twice', async () => {
    const session = await seedDraftSession();
    const { wrapper, router } = await mountFlow(session.id);
    await atStage(wrapper, 'steps');

    const before = mockDb.tasks.size;
    const approve = wrapper.get('[data-plan-approve-steps]');
    await Promise.all([approve.trigger('click'), approve.trigger('click')]);
    await waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'));

    expect(mockDb.tasks.size).toBe(before + 4);
    expect(mockDb.plans.size).toBe(1);
    wrapper.unmount();
  });

  it('with no hours to plan within, confirming the steps opens 일정안 만들기 (where they are asked) and makes no plan yet', async () => {
    mockDb.availability = { ...mockDb.availability, rules: [] };
    const session = await seedDraftSession('가용 시간 없는 계획');
    const { wrapper, router } = await mountFlow(session.id);
    await atStage(wrapper, 'steps');

    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await waitFor(() => expect(router.currentRoute.value.name).toBe('plan-scope'));
    const stored = mockDb.intakeSessions.get(session.id);
    expect(router.currentRoute.value.query).toEqual({ goalId: stored?.goalId, session: session.id });
    expect(stored?.state).toBe('feasibility_check');
    expect(mockDb.plans.size).toBe(0);
    wrapper.unmount();
  });

  it('a plan that could not be made also opens 일정안 만들기, with the goal picked (negative)', async () => {
    const session = await seedDraftSession('일정안 실패');
    server.use(http.post('*/api/v1/plans', () => HttpResponse.json({ code: 'internal', title: 'x', status: 500 }, { status: 500 })));
    const { wrapper, router } = await mountFlow(session.id);
    await atStage(wrapper, 'steps');
    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await waitFor(() => expect(router.currentRoute.value.name).toBe('plan-scope'), 8_000);
    expect(router.currentRoute.value.query['goalId']).toBe(mockDb.intakeSessions.get(session.id)?.goalId);
    // The steps were confirmed all the same: the tasks exist, and nothing is lost.
    expect(mockDb.intakeSessions.get(session.id)?.state).toBe('feasibility_check');
    wrapper.unmount();
  }, 15_000);

  it('opened again after its steps were confirmed, it says so and leads on to the schedules', async () => {
    const session = await seedDraftSession('확정한 계획');
    const approved = await createPlannerClient().approveIntakeDraft(session.id, newActionId('approve'), session.version);
    const { wrapper } = await mountFlow(approved.id);
    await atStage(wrapper, 'schedule');
    const done = wrapper.get('[data-plan-done]');
    expect(done.get('h2').text()).toBe('단계를 확정했어요');
    // One filled button, and it is the next step of the flow.
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1);
    const next = wrapper.get('[data-plan-to-schedule]');
    expect(next.classes()).toContain('btn--primary');
    expect(next.text()).toBe('일정안 만들기');
    expect(next.attributes('href')).toBe(`/plan/schedule?session=${approved.id}&goalId=${approved.goalId ?? ''}`);
    // The steps cannot be edited any more (negative).
    expect(wrapper.find('#step-title-s1').exists()).toBe(false);
    expect(wrapper.find('[data-plan-approve-steps]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('an earlier kind of work (the type check)', () => {
  it('says what it resembles, how sure it is and why; taking it over gives that kind’s steps', async () => {
    const { wrapper } = await mountFlow();
    await wrapper.get('#plan-goal-title').setValue('보고서 작성');
    await wrapper.get('form').trigger('submit');

    await waitFor(() => {
      expect(wrapper.find('[data-plan-type]').exists()).toBe(true);
      // The kind's name comes from its own query after the card renders: wait for it instead of racing it.
      expect(wrapper.get('[data-plan-type]').text()).toContain('‘보고서 작성’');
    });
    expect(stageOf(wrapper)).toBe('questions');
    const check = wrapper.get('[data-plan-type]');
    expect(check.text()).toContain('82%');
    expect(check.text()).toContain('태그: 보고서');
    expect(check.text()).toContain('과거 작업 3건');
    // One filled button on the page: the answer that moves the flow on fastest.
    expect(wrapper.findAll('.btn--primary').map((item) => item.text())).toEqual(['같은 방식으로 나누기']);

    await wrapper.get('[data-plan-type-yes]').trigger('click');
    await waitFor(() => expect(wrapper.find('[data-plan-type]').exists()).toBe(false));
    await answerRounds(wrapper, 'blank');
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));
    const names = wrapper.findAll('.plan-step-name').map((input) => (input.element as HTMLInputElement).value);
    expect(names).toEqual(expect.arrayContaining(['자료 조사', '초안 작성', '검토 및 수정']));
    wrapper.unmount();
  });

  it('“새로 나누기” goes on to the questions of a new kind of work', async () => {
    const { wrapper } = await mountFlow();
    await wrapper.get('#plan-goal-title').setValue('보고서 작성');
    await wrapper.get('form').trigger('submit');
    await waitFor(() => expect(wrapper.find('[data-plan-type]').exists()).toBe(true));

    await wrapper.get('[data-plan-type-no]').trigger('click');
    await waitFor(() => expect(wrapper.find('[data-plan-questions]').exists()).toBe(true));
    expect(wrapper.find('[data-plan-type]').exists()).toBe(false);
    expect(wrapper.findAll('.plan-question').length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it('never shows the kind’s id when its name cannot be read (negative)', async () => {
    server.use(http.get('*/api/v1/templates/:id', () => HttpResponse.json({ code: 'not_found', title: 'x', status: 404 }, { status: 404 })));
    const { wrapper } = await mountFlow();
    await wrapper.get('#plan-goal-title').setValue('보고서 작성');
    await wrapper.get('form').trigger('submit');
    await waitFor(() => expect(wrapper.find('[data-plan-type]').exists()).toBe(true));
    const templateId = [...mockDb.intakeSessions.values()][0]?.detectedType?.templateId ?? 'missing';
    expect(wrapper.get('[data-plan-type]').text()).toContain('‘이전 작업’');
    expect(wrapper.text()).not.toContain(templateId);
    wrapper.unmount();
  });
});

describe('without the AI, and the rules of a draft', () => {
  it('“AI 없이 직접 짜기” in 질문 gives steps to fill in by hand', async () => {
    const session = await createSession('수동 작성 과제');
    const { wrapper } = await mountFlow(session.id);
    await atStage(wrapper, 'questions');

    await wrapper.get('[data-plan-manual]').trigger('click');
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));
    expect(wrapper.findAll('.plan-step').length).toBeGreaterThanOrEqual(3);
    expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', '요구사항 정리');
    wrapper.unmount();
  });

  it('shows the steps as rows a person reads: names and two times, the total as the card’s number, no internal key or percentile', async () => {
    const manual = await manualSession('읽기 쉬운 단계');
    const { wrapper } = await mountFlow(manual.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));

    const card = wrapper.get('[data-plan-steps-card]');
    expect(card.get('[data-plan-steps-total]').text()).toMatch(/^\d+단계(\d+시간)?( ?\d+분)?넉넉히 /);
    expect(card.findAll('.plan-step-index').map((index) => index.text())).toEqual(
      card.findAll('.plan-step').map((_, position) => String(position + 1)),
    );
    expect(card.get('#step-title-s1').attributes('aria-label')).toBe('1단계 이름');
    expect(card.get('#step-p50-s1').attributes('aria-label')).toBe('1단계 보통 걸리는 시간 (분)');
    expect(card.get('#step-p90-s1').attributes('aria-label')).toBe('1단계 넉넉히 잡은 시간 (분)');
    expect(card.text()).not.toMatch(/P50|P90/);
    expect(card.text()).not.toMatch(/\bs\d\b/);
    // The details are one press away, and say where they are.
    const more = card.get('[data-step-more="s1"]');
    expect(more.attributes('aria-expanded')).toBe('false');
    await more.trigger('click');
    expect(more.attributes('aria-expanded')).toBe('true');
    expect((card.get('#step-more-s1').element as HTMLElement).style.display).toBe('');
    // One filled button: the next step of the flow.
    expect(wrapper.findAll('.btn--primary').map((item) => item.text())).toEqual(['일정안 만들기']);
    wrapper.unmount();
  });

  it('says what breaks a rule under the row it belongs to, and sends no invalid draft', async () => {
    const manual = await manualSession('검증 과제');
    const { wrapper } = await mountFlow(manual.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('#step-p50-s1').exists()).toBe(true));

    const spy = vi.spyOn(plannerClient, 'updateIntakeDraft');
    const approveSpy = vi.spyOn(plannerClient, 'approveIntakeDraft');
    await wrapper.get('#step-p50-s1').setValue('300');
    await settle();
    expect(wrapper.get('[data-step="s1"] [data-issue="step_too_large"]').text()).toContain(
      '보통 걸리는 시간은 240분 이하여야 해요',
    );
    expect(wrapper.get('[data-step="s1"]').classes()).toContain('plan-step--invalid');

    await wrapper.get('[data-plan-save]').trigger('click');
    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(approveSpy).not.toHaveBeenCalled();
    expect(wrapper.get('[data-plan-error]').text()).toBe('고쳐야 할 곳이 있어요. 표시된 항목을 고쳐 주세요.');
    wrapper.unmount();
  });

  it('finds steps that wait on each other, and names them by number', async () => {
    const manual = await manualSession('순환 과제');
    const { wrapper } = await mountFlow(manual.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('[data-step="s1"]').exists()).toBe(true));

    // The manual draft has 2단계 after 1단계; making 1단계 wait for 2단계 closes the loop.
    await wrapper.get('[data-step="s1"] input[data-step-dep="s2"]').setValue(true);
    await settle();
    const issue = wrapper.get('[data-issue="cycle"]').text();
    expect(issue).toContain('먼저 끝낼 단계가 서로 물려 있어요');
    expect(issue).toMatch(/\d단계 → \d단계/);
    expect(issue).not.toMatch(/\bs\d\b/);
    wrapper.unmount();
  });

  it('adds a step and takes one out, never below three (negative)', async () => {
    const manual = await manualSession('단계 수');
    const { wrapper } = await mountFlow(manual.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('[data-step-add]').exists()).toBe(true));
    const count = wrapper.findAll('.plan-step').length;

    await wrapper.get('[data-step-add]').trigger('click');
    expect(wrapper.findAll('.plan-step')).toHaveLength(count + 1);
    const added = wrapper.findAll('.plan-step-name').at(-1);
    expect((added?.element as HTMLInputElement).value).toBe('새 단계');

    for (let guard = 0; guard < 12 && wrapper.findAll('.plan-step').length > 3; guard += 1) {
      await wrapper.findAll('[data-step-remove]').at(-1)?.trigger('click');
    }
    expect(wrapper.findAll('.plan-step')).toHaveLength(3);
    for (const remove of wrapper.findAll('[data-step-remove]')) expect(remove.attributes('disabled')).toBeDefined();
    await wrapper.findAll('[data-step-remove]')[0]?.trigger('click');
    expect(wrapper.findAll('.plan-step')).toHaveLength(3);
    wrapper.unmount();
  });

  it('keeps what was typed on a 412 draft conflict and reloads only on request', async () => {
    const session = await seedDraftSession('충돌 과제');
    const { wrapper } = await mountFlow(session.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));

    const other = createPlannerClient();
    const current = await other.getIntakeSession(session.id, { fresh: true });
    const otherDraft = await other.getIntakeDraft(session.id);
    await other.updateIntakeDraft(session.id, { steps: otherDraft.steps }, newActionId('other'), current.version);

    await wrapper.get('#step-title-s1').setValue('내가 고친 제목');
    await wrapper.get('[data-plan-save]').trigger('click');
    await waitFor(() => {
      expect(wrapper.get('[data-plan-draft-conflict]').text()).toContain('다른 곳에서 단계가 먼저 바뀌었어요');
    });
    expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', '내가 고친 제목');

    await button(wrapper, '최신 단계 불러오기').trigger('click');
    await settle();
    expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', '요구사항 정리');
    expect(wrapper.find('[data-plan-draft-conflict]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('coming back, and what the server reports about the AI', () => {
  it('opens a session where it stopped, with only the questions still open', async () => {
    const session = await createSession('재개 과제');
    const first = session.questions?.[0];
    if (first === undefined) throw new Error('expected a first question');
    const partial = await createPlannerClient().answerIntakeQuestions(
      session.id,
      [{ questionKey: first.field, action: 'skip' }],
      newActionId('partial'),
      session.version,
    );

    const { wrapper } = await mountFlow(partial.id);
    await atStage(wrapper, 'questions');
    expect(wrapper.findAll('.plan-question').length).toBe(partial.questions?.length ?? 0);
    expect(wrapper.get('h1').text()).toBe('재개 과제');
    wrapper.unmount();
  });

  it('says in words that the AI cannot be used (the code is data, not copy) and still offers the way on by hand', async () => {
    const session = await createSession('예산 초과 과제');
    const stored = mockDb.intakeSessions.get(session.id);
    if (stored === undefined) throw new Error('missing stored session');
    stored.error = { code: 'budget_exceeded', message: 'Monthly budget exceeded' };

    const { wrapper } = await mountFlow(session.id);
    await waitFor(() => expect(wrapper.find('[data-plan-llm-issue]').exists()).toBe(true));
    const banner = wrapper.get('[data-plan-llm-issue]');
    expect(banner.text()).toContain('AI를 쓸 수 없어요');
    expect(banner.attributes('data-code')).toBe('budget_exceeded');
    expect(banner.text()).not.toContain('budget_exceeded');
    expect(banner.text()).not.toContain('Monthly budget exceeded');
    await button(wrapper, '직접 짜기로 계속').trigger('click');
    await atStage(wrapper, 'steps');
    wrapper.unmount();
  });

  it('keeps the way on by hand working when the AI fails mid-flow (503 llm_unavailable)', async () => {
    const session = await createSession('LLM 실패 과제');
    server.use(
      http.post('*/api/v1/intake-sessions/:id/answers', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'LLM unavailable', status: 503, code: 'llm_unavailable', detail: 'Provider is unavailable' },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const { wrapper } = await mountFlow(session.id);
    await atStage(wrapper, 'questions');
    await wrapper.get('[data-plan-questions]').trigger('submit');
    await waitFor(() => expect(wrapper.find('[data-plan-llm-issue]').exists()).toBe(true));
    expect(wrapper.get('[data-plan-llm-issue]').attributes('data-code')).toBe('llm_unavailable');
    expect(wrapper.get('[data-plan-llm-issue]').text()).not.toContain('Provider is unavailable');
    // What was typed stays where it was: the questions are still there.
    expect(wrapper.find('[data-plan-questions]').exists()).toBe(true);

    await button(wrapper, '직접 짜기로 계속').trigger('click');
    await atStage(wrapper, 'steps');
    wrapper.unmount();
  });
});

describe('setting a plan aside, going on with it, giving it up', () => {
  it('a session set aside says so and holds its questions until “이어서 하기”', async () => {
    const session = await createSession('멈춰 둔 과제');
    const paused = await createPlannerClient().pauseIntakeSession(session.id, newActionId('pause'), session.version);
    expect(paused.state).toBe('needs_input');

    const { wrapper } = await mountFlow(paused.id);
    await atStage(wrapper, 'questions');
    expect(wrapper.get('[data-plan-paused]').text()).toContain('멈춰 둔 계획이에요');
    expect(wrapper.get('[data-plan-answer]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-plan-continue]').trigger('click');
    await waitFor(() => expect(wrapper.find('[data-plan-paused]').exists()).toBe(false));
    expect(wrapper.find('[data-plan-continue]').exists()).toBe(false);
    expect(wrapper.get('[data-plan-answer]').attributes('disabled')).toBeUndefined();
    expect(mockDb.intakeSessions.get(session.id)?.state).toBe('clarification');
    wrapper.unmount();
  });

  it('“그만두기” ends the session, leads to a new start and drops it from the device’s list', async () => {
    const { wrapper, router } = await mountFlow();
    await wrapper.get('#plan-goal-title').setValue('그만둘 과제');
    await wrapper.get('form').trigger('submit');
    await waitFor(() => expect(router.currentRoute.value.name).toBe('plan-session'));
    const id = String(router.currentRoute.value.params['sessionId']);
    // Remembered as unfinished from the moment it exists.
    expect(readPlanFlows(mockDb.user.id)).toMatchObject([{ kind: 'session', id }]);
    wrapper.unmount();

    const opened = await mountFlow(id);
    await atStage(opened.wrapper, 'questions');
    await opened.wrapper.get('[data-plan-stop]').trigger('click');
    await atStage(opened.wrapper, 'ended');
    const ended = opened.wrapper.get('[data-plan-ended]');
    expect(ended.text()).toContain('끝난 계획이에요');
    expect(ended.get('a').attributes('href')).toBe('/plan');
    expect(ended.get('a').classes()).toContain('btn--primary');
    expect(readPlanFlows(mockDb.user.id)).toEqual([]);
    // Nothing of it can be changed any more (negative).
    expect(opened.wrapper.find('[data-plan-questions]').exists()).toBe(false);
    expect(opened.wrapper.find('[data-plan-stop]').exists()).toBe(false);
    opened.wrapper.unmount();
  });

  it('reports a step the server refuses (409) in words and re-reads the session without leaving the page', async () => {
    const manual = await manualSession('충돌 전이 과제');
    const { wrapper } = await mountFlow(manual.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('[data-plan-approve-steps]').exists()).toBe(true));

    server.use(
      http.post(/\/api\/v1\/intake-sessions\/[^/]+\/draft:approve$/, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'State conflict', status: 409, code: 'illegal_transition', detail: 'cannot approve in this state' },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await waitFor(() => {
      expect(wrapper.get('[data-plan-error]').text()).toBe('지금 상태에서는 할 수 없는 작업이에요. 화면을 새로 고쳤어요.');
    });
    expect(stageOf(wrapper)).toBe('steps');
    expect(mockDb.plans.size).toBe(0);
    wrapper.unmount();
  });
});

describe('offline and accessibility', () => {
  it('is read-only while offline: nothing can be answered, saved or confirmed', async () => {
    const session = await createSession('오프라인 과제');
    const { wrapper, pinia } = await mountFlow(session.id);
    await atStage(wrapper, 'questions');

    const { useOfflineStore } = await import('../src/stores/offline');
    const offline = useOfflineStore(pinia);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    offline.setOnline(false);
    await settle();

    expect(wrapper.text()).toContain('오프라인이라 읽기만 할 수 있어요');
    expect(wrapper.get('[data-plan-answer]').attributes('disabled')).toBeDefined();
    for (const box of wrapper.findAll('input[data-idk]')) expect(box.attributes('disabled')).toBeDefined();
    const spy = vi.spyOn(plannerClient, 'answerIntakeQuestions');
    await wrapper.get('[data-plan-questions]').trigger('submit');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    offline.setOnline(true);
    wrapper.unmount();
  });

  it('offline, a plan cannot be started either (negative)', async () => {
    const { wrapper, pinia } = await mountFlow();
    const { useOfflineStore } = await import('../src/stores/offline');
    useOfflineStore(pinia).setOnline(false);
    await settle();
    const spy = vi.spyOn(plannerClient, 'createIntakeSession');
    await wrapper.get('#plan-goal-title').setValue('오프라인 시작');
    expect(wrapper.get('[data-plan-start]').attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('오프라인이라 지금은 계획을 시작할 수 없어요');
    useOfflineStore(pinia).setOnline(true);
    wrapper.unmount();
  });

  it('moves focus to the page’s heading at each stage, announces the stage, and names every control', async () => {
    const { wrapper } = await mountFlow();
    expect(wrapper.find('[aria-live="polite"]').exists()).toBe(true);

    await wrapper.get('#plan-goal-title').setValue('접근성 과제');
    await wrapper.get('form').trigger('submit');
    await atStage(wrapper, 'questions');

    await settle();
    const heading = wrapper.get('#plan-heading');
    expect(document.activeElement).toBe(heading.element);
    expect(wrapper.get('[data-plan-live]').text()).toBe('질문 단계예요.');
    expect(wrapper.get('[data-stage="questions"]').attributes('aria-current')).toBe('step');
    expect(wrapper.get('[data-stage="goal"]').attributes('data-state')).toBe('done');

    for (const input of wrapper.findAll('input, select, textarea')) {
      const id = input.attributes('id');
      const named = input.attributes('aria-label') !== undefined || (id !== undefined && wrapper.find(`label[for="${id}"]`).exists());
      expect(named, input.html()).toBe(true);
    }
    for (const control of wrapper.findAll('button')) {
      expect(control.text().trim().length > 0 || control.attributes('aria-label') !== undefined).toBe(true);
    }
    expect(wrapper.findAll('h1').length).toBe(1);
    wrapper.unmount();
  });

  it('a start without a goal sends nothing and says what is missing (negative)', async () => {
    const { wrapper } = await mountFlow();
    const spy = vi.spyOn(plannerClient, 'createIntakeSession');
    expect(wrapper.get('[data-plan-start]').attributes('disabled')).toBeDefined();
    await wrapper.get('#plan-goal-title').setValue('   ');
    await wrapper.get('form').trigger('submit');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.get('[data-plan-error]').text()).toBe('무엇을 끝내야 하는지 적어 주세요.');
    expect(stageOf(wrapper)).toBe('goal');
    wrapper.unmount();
  });
});

describe('FU-40 input mapping and transient approval retry', () => {
  it('sends the goal and what was added to it as title and description, nothing else', async () => {
    const { wrapper } = await mountFlow();
    await wrapper.get('#plan-goal-title').setValue('FU-40 제목');
    await wrapper.get('#plan-goal-description').setValue('설명 본문');
    await wrapper.get('form').trigger('submit');
    await atStage(wrapper, 'questions');

    const stored = [...mockDb.intakeSessions.values()][0];
    if (stored === undefined) throw new Error('expected a stored intake session');
    expect(stored.input.title).toBe('FU-40 제목');
    expect(stored.input.description).toBe('설명 본문');
    expect(stored.input.deliverable).toBeUndefined();
    expect(stored.input.prerequisites).toBeUndefined();
    expect(stored.input.dueAt).toBeUndefined();
    wrapper.unmount();
  });

  it('waits for Retry-After and retries the confirmation with the same idempotency key', async () => {
    const manual = await manualSession('승인 재시도 과제');
    const retryable = new ApiError(409, 'approval_in_progress', 'Approval in progress', undefined, 0);
    const spy = vi
      .spyOn(plannerClient, 'approveIntakeDraft')
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({ ...manual, state: 'feasibility_check', version: manual.version + 1 });
    const { wrapper } = await mountFlow(manual.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('[data-plan-approve-steps]').exists()).toBe(true));

    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await atStage(wrapper, 'schedule');

    expect(spy).toHaveBeenCalledTimes(2);
    const firstKey = spy.mock.calls[0]?.[1];
    const secondKey = spy.mock.calls[1]?.[1];
    expect(firstKey).toBeDefined();
    expect(secondKey).toBe(firstKey);
    spy.mockRestore();
    wrapper.unmount();
  });
});

describe('offline transitions during a delayed confirmation', () => {
  it('defers the Retry-After retry while offline and reuses the key after reconnect', async () => {
    const manual = await manualSession('오프라인 재시도 과제');
    const { wrapper, pinia } = await mountFlow(manual.id);
    await atStage(wrapper, 'steps');
    await waitFor(() => expect(wrapper.find('[data-plan-approve-steps]').exists()).toBe(true));

    const { useOfflineStore } = await import('../src/stores/offline');
    const offline = useOfflineStore(pinia);
    const spy = vi.spyOn(plannerClient, 'approveIntakeDraft');
    spy.mockImplementationOnce(async () => {
      offline.setOnline(false);
      throw new ApiError(409, 'approval_in_progress', 'Approval in progress', undefined, 0);
    });
    spy.mockResolvedValueOnce({ ...manual, state: 'feasibility_check', version: manual.version + 1 });

    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await waitFor(() => {
      expect(wrapper.get('[data-plan-error]').text()).toContain('연결이 끊겨서 확정을 미뤘어요');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockDb.plans.size).toBe(0);

    offline.setOnline(true);
    await settle();
    await wrapper.get('[data-plan-approve-steps]').trigger('click');
    await atStage(wrapper, 'schedule');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[1]).toBe(spy.mock.calls[0]?.[1]);

    spy.mockRestore();
    wrapper.unmount();
  });
});
