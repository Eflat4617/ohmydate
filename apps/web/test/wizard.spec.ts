import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia } from 'pinia';
import { nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent } from 'vue';
import {
  ApiError,
  createPlannerClient,
  newActionId,
  plannerClient,
  type IntakeSession,
} from '../src/api';
import PlanningWizardView from '../src/views/PlanningWizardView.vue';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';

const Stub = defineComponent({ template: '<div />' });

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/plans/new', name: 'plans-new', component: Stub },
      { path: '/plan/new', name: 'plan-new', component: PlanningWizardView },
      {
        path: '/plan/:sessionId',
        name: 'plan-session',
        component: PlanningWizardView,
        props: true,
      },
    ],
  });
}

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

async function mountWizard(sessionId?: string) {
  const pinia = createPinia();
  const router = testRouter();
  const path = sessionId === undefined ? '/plan/new' : `/plan/${sessionId}`;
  await router.push(path);
  await router.isReady();
  const wrapper = mount(PlanningWizardView, {
    ...(sessionId === undefined ? {} : { props: { sessionId } }),
    global: { plugins: [pinia, router, VueQueryPlugin] },
    attachTo: document.body,
  });
  await settle();
  return { wrapper, router, pinia };
}

async function createSession(title: string): Promise<IntakeSession> {
  return createPlannerClient().createIntakeSession(
    { title, dueAt: '2026-11-30T18:00:00.000Z' },
    newActionId('create'),
  );
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

async function answerAllViaUi(wrapper: VueWrapper, action: '모름' | '건너뛰기'): Promise<void> {
  for (let guard = 0; guard < 10; guard += 1) {
    const cards = wrapper.findAll('.question-card');
    if (cards.length === 0) return;
    const card = cards[0];
    if (card === undefined) return;
    const target = card.findAll('button').find((item) => item.text().includes(action));
    if (target === undefined) throw new Error(`answer button not found: ${action}`);
    await target.trigger('click');
    await settle();
  }
  throw new Error('question loop did not terminate');
}

describe('planning wizard scenario A (new type)', () => {
  it('collects basics, never re-asks provided fields, shows assumptions, approves a draft, and links to created work', async () => {
    const { wrapper } = await mountWizard();
    expect(wrapper.text()).toContain('1단계 · 기본정보');
    // FU-91: the stepper no longer says 일정안 is coming soon.
    // (File upload really is not supported yet; its field label still says so.)
    expect(wrapper.get('.wizard-stepper').text()).toContain('일정안');
    expect(wrapper.get('.wizard-stepper').text()).not.toContain('곧 지원');

    await wrapper.get('#wizard-title').setValue('논문 요약');
    await wrapper.get('#wizard-due').setValue('2026-11-30T18:00');
    await wrapper.get('#wizard-description').setValue('관련 논문 5편을 요약한다');
    await wrapper.get('form').trigger('submit');

    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    const questionText = wrapper.text();
    expect(questionText).not.toContain('언제까지 끝내야 하나요?');
    expect(questionText).not.toContain('When is it due?');
    expect(wrapper.findAll('.question-card').length).toBeGreaterThan(0);
    expect(wrapper.findAll('.question-card').length).toBeLessThanOrEqual(5);

    await answerAllViaUi(wrapper, '모름');

    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });
    expect(wrapper.text()).toContain('모름');
    expect(wrapper.findAll('.assumption-item').length).toBeGreaterThan(0);

    const before = mockDb.tasks.size;
    await button(wrapper, '초안 승인').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('초안 승인 완료');
    });

    // FU-91: step 5 leads to the real 일정안 flow, scoped to this plan's goal.
    expect(wrapper.text()).toContain('다음 단계: 만든 작업으로 일정안 후보를 만들어 비교하고 확정해요.');
    expect(wrapper.text()).not.toContain('곧 지원');
    const approved = [...mockDb.intakeSessions.values()][0];
    expect(approved?.goalId).toBeDefined();
    const makePlan = wrapper.get('[data-testid="wizard-make-plan"]');
    expect(makePlan.text()).toBe('일정안 만들기');
    expect(makePlan.attributes('href')).toBe(`/plans/new?goalId=${approved?.goalId ?? ''}`);
    expect(makePlan.classes()).toContain('btn--primary');
    expect(wrapper.find('a[href="/inbox"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/projects"]').exists()).toBe(true);
    expect(mockDb.tasks.size).toBe(before + 4);
    expect(mockDb.intakeSessions.size).toBe(1);

    wrapper.unmount();
  });

  it('keeps approve idempotent when the user double-clicks', async () => {
    const session = await seedDraftSession();
    const { wrapper } = await mountWizard(session.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });

    const before = mockDb.tasks.size;
    const approve = button(wrapper, '초안 승인');
    await Promise.all([approve.trigger('click'), approve.trigger('click')]);
    await waitFor(() => {
      expect(wrapper.text()).toContain('초안 승인 완료');
    });

    expect(mockDb.tasks.size).toBe(before + 4);
    wrapper.unmount();
  });
});

describe('planning wizard scenario B (similar type)', () => {
  it('shows confidence and reasons, accepts the template, and produces its draft', async () => {
    const { wrapper } = await mountWizard();
    await wrapper.get('#wizard-title').setValue('보고서 작성');
    await wrapper.get('form').trigger('submit');

    await waitFor(() => {
      expect(wrapper.text()).toContain('2단계 · 유형 확인');
      // The template name comes from its own query after the step renders
      // (same no-timing rule as FU-60): wait for it instead of racing it.
      expect(wrapper.text()).toContain('보고서 작성');
    });
    expect(wrapper.text()).toContain('82%');
    expect(wrapper.text()).toContain('태그: 보고서');
    expect(wrapper.text()).toContain('과거 작업 3건');

    await button(wrapper, '예').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    await answerAllViaUi(wrapper, '건너뛰기');
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });
    expect(wrapper.text()).toContain('자료 조사');
    expect(wrapper.text()).toContain('초안 작성');
    expect(wrapper.text()).toContain('검토 및 수정');

    wrapper.unmount();
  });

  it('falls back to a new-type interview when the user rejects the similar type', async () => {
    const { wrapper } = await mountWizard();
    await wrapper.get('#wizard-title').setValue('보고서 작성');
    await wrapper.get('form').trigger('submit');
    await waitFor(() => {
      expect(wrapper.text()).toContain('2단계 · 유형 확인');
    });

    await button(wrapper, '아니오').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });
    expect(wrapper.findAll('.question-card').length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});

describe('manual mode and draft validation', () => {
  it('switches to manual writing from the question step', async () => {
    const session = await createSession('수동 작성 과제');
    const { wrapper } = await mountWizard(session.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    await button(wrapper, '직접 작성으로 전환').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });
    expect(wrapper.findAll('.draft-step-card').length).toBeGreaterThanOrEqual(3);
    expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', '요구사항 정리');
    wrapper.unmount();
  });

  it('shows inline draft errors and does not send an invalid PATCH', async () => {
    const session = await createSession('검증 과제');
    const client = createPlannerClient();
    const manual = await client.enterManualIntakeMode(
      session.id,
      newActionId('manual'),
      session.version,
    );
    const { wrapper } = await mountWizard(manual.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });

    const spy = vi.spyOn(plannerClient, 'updateIntakeDraft');
    await wrapper.get('#step-p50-s1').setValue('300');
    await settle();
    expect(wrapper.text()).toContain('P50은 240분 이하여야 해요');

    await button(wrapper, '초안 저장').trigger('click');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    wrapper.unmount();
  });

  it('detects dependency cycles inline', async () => {
    const session = await createSession('순환 과제');
    const manual = await createPlannerClient().enterManualIntakeMode(
      session.id,
      newActionId('manual'),
      session.version,
    );
    const { wrapper } = await mountWizard(manual.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });

    const cards = wrapper.findAll('.draft-step-card');
    const first = cards[0];
    if (first === undefined) throw new Error('missing first draft step');
    const checkbox = first.findAll('input[type="checkbox"]')[1];
    if (checkbox === undefined) throw new Error('missing dependency checkbox');
    await checkbox.setValue(true);
    await settle();
    expect(wrapper.text()).toContain('선행 관계에 순환이 있어요');
    wrapper.unmount();
  });

  it('keeps local edits on a 412 draft conflict and reloads on request', async () => {
    const session = await seedDraftSession('충돌 과제');
    const { wrapper } = await mountWizard(session.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });

    const other = createPlannerClient();
    const current = await other.getIntakeSession(session.id, { fresh: true });
    const otherDraft = await other.getIntakeDraft(session.id);
    await other.updateIntakeDraft(
      session.id,
      { steps: otherDraft.steps },
      newActionId('other'),
      current.version,
    );

    await wrapper.get('#step-title-s1').setValue('내가 고친 제목');
    await button(wrapper, '초안 저장').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('다른 곳에서 초안이 먼저 바뀌었어요');
    });
    expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', '내가 고친 제목');

    await button(wrapper, '최신 초안 불러오기').trigger('click');
    await settle();
    expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', '요구사항 정리');
    wrapper.unmount();
  });
});

describe('resume and server-reported LLM errors', () => {
  it('resumes at the server step after reloading /plan/:id', async () => {
    const session = await createSession('재개 과제');
    const first = session.questions?.[0];
    if (first === undefined) throw new Error('expected a first question');
    const partial = await createPlannerClient().answerIntakeQuestions(
      session.id,
      [{ questionKey: first.field, action: 'skip' }],
      newActionId('partial'),
      session.version,
    );

    const { wrapper } = await mountWizard(partial.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });
    expect(wrapper.findAll('.question-card').length).toBe(partial.questions?.length ?? 0);
    wrapper.unmount();
  });

  it('shows the banner for a session.error and still offers the manual path', async () => {
    const session = await createSession('예산 초과 과제');
    const stored = mockDb.intakeSessions.get(session.id);
    if (stored === undefined) throw new Error('missing stored session');
    stored.error = { code: 'budget_exceeded', message: 'Monthly budget exceeded' };

    const { wrapper } = await mountWizard(session.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('AI를 쓸 수 없어요');
    });
    expect(wrapper.text()).toContain('budget_exceeded');
    await button(wrapper, '직접 작성으로 전환').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });
    wrapper.unmount();
  });
});

describe('LLM failure and recovery', () => {
  it('shows a banner and keeps the manual path working on 503 llm_unavailable', async () => {
    const session = await createSession('LLM 실패 과제');
    server.use(
      http.post('*/api/v1/intake-sessions/:id/answers', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'LLM unavailable',
            status: 503,
            code: 'llm_unavailable',
            detail: 'Provider is unavailable',
          },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const { wrapper } = await mountWizard(session.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    const firstCard = wrapper.get('.question-card');
    const idk = firstCard.findAll('button').find((item) => item.text().includes('모름'));
    if (idk === undefined) throw new Error('missing idk button');
    await idk.trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('AI를 쓸 수 없어요');
    });
    expect(wrapper.text()).toContain('llm_unavailable');

    await button(wrapper, '직접 작성으로 전환').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });
    wrapper.unmount();
  });
});

describe('pause, resume, cancel and illegal transitions', () => {
  it('pauses, resumes, and shows a non-destructive conflict message on an illegal transition', async () => {
    const session = await createSession('일시정지 과제');
    const { wrapper } = await mountWizard(session.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    await button(wrapper, '일시정지').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('일시정지했어요');
    });
    await button(wrapper, '재개').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).not.toContain('일시정지했어요');
    });

    await button(wrapper, '취소').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('계획 세션이 끝났어요');
    });
    wrapper.unmount();
  });

  it('reports an illegal transition with a 409 and refreshes without losing the page', async () => {
    const session = await createSession('충돌 전이 과제');
    const manual = await createPlannerClient().enterManualIntakeMode(
      session.id,
      newActionId('manual'),
      session.version,
    );
    const { wrapper } = await mountWizard(manual.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });

    server.use(
      http.post(/\/api\/v1\/intake-sessions\/[^/]+\/draft:approve$/, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'State conflict',
            status: 409,
            code: 'illegal_transition',
            detail: 'cannot approve in this state',
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    await button(wrapper, '초안 승인').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('지금 상태에서는 할 수 없는 작업이에요. 화면을 새로 고쳤어요.');
    });
    expect(wrapper.text()).toContain('4단계 · 단계 초안');
    wrapper.unmount();
  });
});

describe('offline and accessibility', () => {
  it('is read-only while offline and disables mutations', async () => {
    const session = await createSession('오프라인 과제');
    const { wrapper, pinia } = await mountWizard(session.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    const { useOfflineStore } = await import('../src/stores/offline');
    const offline = useOfflineStore(pinia);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    offline.setOnline(false);
    await settle();

    expect(wrapper.text()).toContain('오프라인이라 읽기만 할 수 있어요');
    const idk = wrapper.findAll('button').find((item) => item.text().includes('모름'));
    if (idk === undefined) throw new Error('missing idk button');
    expect(idk.attributes('disabled')).toBeDefined();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    offline.setOnline(true);
    wrapper.unmount();
  });

  it('moves focus to the step heading, announces changes, and labels every control', async () => {
    const { wrapper } = await mountWizard();
    expect(wrapper.find('[aria-live="polite"]').exists()).toBe(true);

    await wrapper.get('#wizard-title').setValue('접근성 과제');
    await wrapper.get('form').trigger('submit');
    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    await settle();
    const heading = wrapper.get('#wizard-heading');
    expect(document.activeElement).toBe(heading.element);
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('3단계');

    for (const input of wrapper.findAll('input, select, textarea')) {
      const id = input.attributes('id');
      expect(id).toBeDefined();
      expect(wrapper.find(`label[for="${id}"]`).exists()).toBe(true);
    }
    for (const control of wrapper.findAll('button')) {
      expect((control.text().trim().length > 0) || control.attributes('aria-label') !== undefined).toBe(true);
    }
    expect(wrapper.findAll('h1').length).toBe(1);
    wrapper.unmount();
  });
});

describe('FU-40 input mapping and transient approval retry', () => {
  it('sends title and description without the legacy deliverable/prerequisites mapping', async () => {
    const { wrapper } = await mountWizard();
    await wrapper.get('#wizard-title').setValue('FU-40 제목');
    await wrapper.get('#wizard-description').setValue('설명 본문');
    await wrapper.get('form').trigger('submit');

    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    const stored = [...mockDb.intakeSessions.values()][0];
    if (stored === undefined) throw new Error('expected a stored intake session');
    expect(stored.input.title).toBe('FU-40 제목');
    expect(stored.input.description).toBe('설명 본문');
    expect(stored.input.deliverable).toBeUndefined();
    expect(stored.input.prerequisites).toBeUndefined();
    wrapper.unmount();
  });

  it('waits for Retry-After and retries approval with the same idempotency key', async () => {
    const session = await createSession('승인 재시도 과제');
    const manual = await createPlannerClient().enterManualIntakeMode(
      session.id,
      newActionId('manual'),
      session.version,
    );
    const retryable = new ApiError(
      409,
      'approval_in_progress',
      'Approval in progress',
      undefined,
      0,
    );
    const spy = vi
      .spyOn(plannerClient, 'approveIntakeDraft')
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({
        ...manual,
        state: 'feasibility_check',
        version: manual.version + 1,
      });
    const { wrapper } = await mountWizard(manual.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });

    await button(wrapper, '초안 승인').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('초안 승인 완료');
    });

    expect(spy).toHaveBeenCalledTimes(2);
    const firstKey = spy.mock.calls[0]?.[1];
    const secondKey = spy.mock.calls[1]?.[1];
    expect(firstKey).toBeDefined();
    expect(secondKey).toBe(firstKey);
    spy.mockRestore();
    wrapper.unmount();
  });
});

describe('offline transitions during delayed approval', () => {
  it('defers the Retry-After retry while offline and reuses the key after reconnect', async () => {
    const session = await createSession('오프라인 재시도 과제');
    const manual = await createPlannerClient().enterManualIntakeMode(
      session.id,
      newActionId('manual'),
      session.version,
    );
    const { wrapper, pinia } = await mountWizard(manual.id);
    await waitFor(() => {
      expect(wrapper.text()).toContain('4단계 - 단계 초안'.replace(' - ', ' · '));
    });

    const { useOfflineStore } = await import('../src/stores/offline');
    const offline = useOfflineStore(pinia);
    const spy = vi.spyOn(plannerClient, 'approveIntakeDraft');
    spy.mockImplementationOnce(async () => {
      offline.setOnline(false);
      throw new ApiError(409, 'approval_in_progress', 'Approval in progress', undefined, 0);
    });
    spy.mockResolvedValueOnce({
      ...manual,
      state: 'feasibility_check',
      version: manual.version + 1,
    });

    await button(wrapper, '초안 승인').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('연결이 끊겨서 승인을 미뤘어요');
    });
    expect(spy).toHaveBeenCalledTimes(1);

    offline.setOnline(true);
    await settle();
    await button(wrapper, '초안 승인').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('초안 승인 완료');
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[1]).toBe(spy.mock.calls[0]?.[1]);

    spy.mockRestore();
    wrapper.unmount();
  });
});
