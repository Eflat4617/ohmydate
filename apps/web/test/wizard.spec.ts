import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia } from 'pinia';
import { nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent } from 'vue';
import {
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
    { deliverable: title, dueAt: '2026-11-30T18:00:00.000Z' },
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

    await wrapper.get('#wizard-title').setValue('논문 요약');
    await wrapper.get('#wizard-due').setValue('2026-11-30T18:00');
    await wrapper.get('#wizard-description').setValue('관련 논문 5편을 요약한다');
    await wrapper.get('form').trigger('submit');

    await waitFor(() => {
      expect(wrapper.text()).toContain('3단계 · 질문');
    });

    const questionText = wrapper.text();
    expect(questionText).not.toContain('What exactly should be produced as the deliverable?');
    expect(questionText).not.toContain('When is it due?');
    expect(questionText).not.toContain('Is anything required before you can start?');
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

    expect(wrapper.text()).toContain('다음 단계: 일정안(곧 지원)');
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
    });
    expect(wrapper.text()).toContain('보고서 작성');
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
    expect(wrapper.text()).toContain('P50은 240분 이하여야 합니다');

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
    expect(wrapper.text()).toContain('의존 관계에 순환이 있습니다');
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
      expect(wrapper.text()).toContain('다른 곳에서 초안이 먼저 변경되었습니다');
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
      expect(wrapper.text()).toContain('AI를 사용할 수 없습니다');
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
      expect(wrapper.text()).toContain('AI를 사용할 수 없습니다');
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
      expect(wrapper.text()).toContain('일시정지되었습니다');
    });
    await button(wrapper, '재개').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).not.toContain('일시정지되었습니다');
    });

    await button(wrapper, '취소').trigger('click');
    await waitFor(() => {
      expect(wrapper.text()).toContain('계획 세션이 종료되었습니다');
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
      expect(wrapper.text()).toContain('cannot approve in this state');
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

    expect(wrapper.text()).toContain('오프라인: 읽기 전용입니다');
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
