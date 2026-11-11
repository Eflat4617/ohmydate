/**
 * FU-76: the planning wizard while it waits for a long AI call (30–45 s
 * typical, up to the server bound): calm progress with elapsed time, sane
 * aria-live cadence, 취소 / 직접 작성으로 계속 (POST :manual), resume after a
 * reload or a lost connection by polling (never re-submitting), and the
 * ai_interrupted / unknown-code notices.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia } from 'pinia';
import { defineComponent, nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import {
  AI_REQUEST_CLIENT_BOUND_MS,
  AiRequestTimeoutError,
  aiRequestSignal,
  createPlannerClient,
  newActionId,
  type DecompositionDraft,
  type IntakeSession,
} from '../src/api';
import PlanningWizardView from '../src/views/PlanningWizardView.vue';
import { aiWaitStorageKey } from '../src/composables/useAiWait';
import { useAuthStore } from '../src/stores/auth';
import { mockDb, type MockIntakeSession } from '../src/mocks/db';
import { server } from '../src/mocks/server';

const Stub = defineComponent({ template: '<div />' });
const DECOMPOSITION_TITLE = 'AI가 단계를 만들고 있어요 · 보통 30초–1분';

const draft: DecompositionDraft = {
  steps: [
    {
      key: 's1',
      title: 'AI 준비 단계',
      deliverable: '자료',
      doneCriteria: '자료 확보',
      kind: 'prep',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: [],
      splittable: false,
    },
    {
      key: 's2',
      title: 'AI 작성 단계',
      deliverable: '초안',
      doneCriteria: '초안 완성',
      kind: 'work',
      estimate: { p50Minutes: 120, p90Minutes: 180 },
      dependsOn: ['s1'],
      splittable: true,
    },
    {
      key: 's3',
      title: 'AI 검토 단계',
      deliverable: '검토본',
      doneCriteria: '검토 완료',
      kind: 'review',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: ['s2'],
      splittable: false,
    },
  ],
  assumptions: [],
  questionsRemaining: [],
};

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/plan/new', name: 'plan-new', component: PlanningWizardView },
      { path: '/plan/:sessionId', name: 'plan-session', component: PlanningWizardView, props: true },
    ],
  });
}

/** Vue Query batches notifications through zero-delay timers, so flush those too. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** Like the app (AppShell confirms /me on mount), the owner is verified before the view runs. */
async function mountAt(path: string, sessionId?: string) {
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  const router = testRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(PlanningWizardView, {
    ...(sessionId === undefined ? {} : { props: { sessionId } }),
    global: { plugins: [pinia, router, VueQueryPlugin] },
    attachTo: document.body,
  });
  await settle();
  mounted.push(wrapper);
  return { wrapper, router };
}

const mounted: VueWrapper[] = [];

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

function stored(id: string): MockIntakeSession {
  const session = mockDb.intakeSessions.get(id);
  if (session === undefined) throw new Error('missing mock session');
  return session;
}

function asJson(session: MockIntakeSession, status = 200) {
  return HttpResponse.json(session as unknown as Record<string, unknown>, {
    status,
    headers: { ETag: `W/"${session.version}"` },
  });
}

async function createClarificationSession(title: string): Promise<IntakeSession> {
  return createPlannerClient().createIntakeSession(
    { title, dueAt: '2026-11-30T18:00:00.000Z' },
    newActionId('create'),
  );
}

/** Puts the mock session into "the server is running the decomposition" (state written, no draft). */
function markDecomposing(id: string): void {
  const session = stored(id);
  session.state = 'decomposition';
  session.version += 1;
  delete session.questions;
  delete session.draft;
  delete session.error;
}

/** Holds POST /answers open like a 30–45 s decomposition; resolves on release, rejects on abort. */
function holdAnswers(sessionId: string) {
  const state = { posts: 0, aborted: false, release: () => undefined as void };
  const released = new Promise<void>((resolve) => {
    state.release = () => resolve();
  });
  server.use(
    http.post('*/api/v1/intake-sessions/:id/answers', async ({ request }) => {
      state.posts += 1;
      markDecomposing(sessionId);
      const aborted = new Promise<'aborted'>((resolve) => {
        request.signal.addEventListener('abort', () => {
          state.aborted = true;
          resolve('aborted');
        });
      });
      const outcome = await Promise.race([released.then(() => 'released' as const), aborted]);
      if (outcome === 'aborted') return HttpResponse.error();
      const session = stored(sessionId);
      session.draft = draft;
      return asJson(session);
    }),
  );
  return state;
}

/** Mirrors the server's :manual during a run: abort -> manual draft + ai_cancelled. */
function serverLikeManual(sessionId: string) {
  const state = { ifMatch: [] as string[] };
  server.use(
    http.post(/\/api\/v1\/intake-sessions\/[^/]+:manual$/, ({ request }) => {
      state.ifMatch.push(request.headers.get('If-Match') ?? '');
      const session = stored(sessionId);
      if (request.headers.get('If-Match') !== `W/"${session.version}"`) {
        return HttpResponse.json(
          { type: 'about:blank', title: 'Conflict', status: 412, code: 'version_conflict', detail: 'x' },
          { status: 412, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      session.manual = true;
      session.version += 1;
      session.error = { code: 'ai_cancelled', message: 'cancelled' };
      session.draft = { ...draft, steps: draft.steps.map((step) => ({ ...step, title: `직접 ${step.key}` })) };
      return asJson(session);
    }),
  );
  return state;
}

async function answerFirstQuestionWithIdk(wrapper: VueWrapper): Promise<void> {
  const card = wrapper.get('.question-card');
  const idk = card.findAll('button').find((item) => item.text().includes('모름'));
  if (idk === undefined) throw new Error('missing idk button');
  await idk.trigger('click');
  await settle();
}

function liveText(wrapper: VueWrapper): string {
  return wrapper.get('[data-testid="ai-wait-live"]').text();
}

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  // A failing test must not leave a wizard polling into the next one.
  for (const wrapper of mounted.splice(0)) {
    try {
      wrapper.unmount();
    } catch {
      // already unmounted by the test
    }
  }
  vi.useRealTimers();
  sessionStorage.clear();
});

describe('AI wait: progress', () => {
  it('shows calm progress with elapsed time, announces at milestones only and keeps focus on the panel', async () => {
    const session = await createClarificationSession('긴 분해 과제');
    const hold = holdAnswers(session.id);
    const { wrapper } = await mountAt(`/plan/${session.id}`, session.id);
    expect(wrapper.text()).toContain('3단계 · 질문');

    await answerFirstQuestionWithIdk(wrapper);
    // A quick answer never flashes the panel.
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);

    await advance(1_000);
    const panel = wrapper.get('[data-testid="ai-wait"]');
    expect(panel.text()).toContain(DECOMPOSITION_TITLE);
    expect(panel.get('[role="timer"]').text()).toBe('1초 지났어요');
    expect(document.activeElement?.id).toBe('ai-wait-heading');
    expect(liveText(wrapper)).toBe(DECOMPOSITION_TITLE);
    // Other mutations are paused, the wait itself stays actionable.
    expect(button(wrapper, '일시정지').attributes('disabled')).toBeDefined();
    const panelButtons = panel.findAll('button');
    const panelCancel = panelButtons.find((item) => item.text() === '취소');
    const panelManual = panelButtons.find((item) => item.text() === '직접 작성으로 계속');
    expect(panelCancel?.attributes('disabled')).toBeUndefined();
    expect(panelManual?.attributes('disabled')).toBeUndefined();

    // Visible timer ticks every second; the live region does not.
    await advance(12_000);
    expect(panel.get('[role="timer"]').text()).toBe('13초 지났어요');
    expect(liveText(wrapper)).toBe(DECOMPOSITION_TITLE);
    await advance(17_000);
    expect(liveText(wrapper)).toBe('아직 작업 중이에요. 30초 지났어요.');
    await advance(31_000);
    expect(liveText(wrapper)).toBe('평소보다 오래 걸리고 있어요. 1분 지났어요.');
    expect(wrapper.text()).toContain('평소보다 오래 걸리고 있어요');

    hold.release();
    await advance(0);
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
    });
    expect(wrapper.text()).toContain('4단계 · 단계 초안');
    expect(wrapper.get('#step-title-s2').element).toHaveProperty('value', 'AI 작성 단계');
    expect(liveText(wrapper)).toBe('AI 작업이 끝났어요.');
    expect(document.activeElement?.id).toBe('wizard-heading');
    expect(hold.posts).toBe(1);
    expect(sessionStorage.getItem(aiWaitStorageKey(mockDb.user.id))).toBeNull();
    wrapper.unmount();
  });
});

describe('AI wait: cancel and manual fallback', () => {
  for (const label of ['취소', '직접 작성으로 계속'] as const) {
    it(`${label} aborts the request, calls :manual with the fresh version and lands on the manual path`, async () => {
      const session = await createClarificationSession(`취소 과제 ${label}`);
      const hold = holdAnswers(session.id);
      const manual = serverLikeManual(session.id);
      const { wrapper } = await mountAt(`/plan/${session.id}`, session.id);
      await answerFirstQuestionWithIdk(wrapper);
      await advance(5_000);
      expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(true);

      await button(wrapper.get('[data-testid="ai-wait"]') as unknown as VueWrapper, label).trigger('click');
      await advance(0);
      await vi.waitFor(() => {
        expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
      });

      expect(hold.aborted).toBe(true);
      expect(manual.ifMatch).toEqual([`W/"${session.version + 1}"`]);
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
      expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', '직접 s1');
      expect(wrapper.get('[data-testid="ai-cancelled"]').text()).toContain('AI 작업을 취소했어요');
      expect(liveText(wrapper)).toBe('AI 작업을 취소했어요. 직접 작성으로 계속해요.');
      // Inputs kept: the session's input is untouched by the cancel.
      expect(stored(session.id).input.title).toBe(`취소 과제 ${label}`);
      expect(hold.posts).toBe(1);
      wrapper.unmount();
    });
  }

  it('the footer 직접 작성으로 전환 also works while waiting', async () => {
    const session = await createClarificationSession('푸터 수동 과제');
    const hold = holdAnswers(session.id);
    const manual = serverLikeManual(session.id);
    const { wrapper } = await mountAt(`/plan/${session.id}`, session.id);
    await answerFirstQuestionWithIdk(wrapper);
    await advance(3_000);
    await button(wrapper, '직접 작성으로 전환').trigger('click');
    await advance(0);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });
    expect(hold.aborted).toBe(true);
    expect(manual.ifMatch).toHaveLength(1);
    wrapper.unmount();
  });
});

describe('AI wait: resume after reload or lost connection (no re-submit)', () => {
  it('a reload during the decomposition polls the session and shows the draft when it lands', async () => {
    const session = await createClarificationSession('새로고침 과제');
    markDecomposing(session.id);
    let posts = 0;
    server.use(
      http.post('*/api/v1/intake-sessions/:id/answers', () => {
        posts += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const startedAt = Date.now() - 20_000;
    sessionStorage.setItem(
      aiWaitStorageKey(mockDb.user.id),
      JSON.stringify({ kind: 'decomposition', startedAt, sessionId: session.id, ownerId: mockDb.user.id }),
    );

    const { wrapper } = await mountAt(`/plan/${session.id}`, session.id);
    const panel = wrapper.get('[data-testid="ai-wait"]');
    expect(panel.text()).toContain(DECOMPOSITION_TITLE);
    expect(panel.get('[role="timer"]').text()).toBe('20초 지났어요');

    await advance(3_000);
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(true);
    stored(session.id).draft = draft;
    await advance(3_000);
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
    });
    expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', 'AI 준비 단계');
    expect(posts).toBe(0);
    wrapper.unmount();
  });

  it('a lost connection while waiting switches to polling instead of sending the answer again', async () => {
    const session = await createClarificationSession('연결 끊김 과제');
    let posts = 0;
    server.use(
      http.post('*/api/v1/intake-sessions/:id/answers', () => {
        posts += 1;
        markDecomposing(session.id);
        return HttpResponse.error();
      }),
    );
    const { wrapper } = await mountAt(`/plan/${session.id}`, session.id);
    await answerFirstQuestionWithIdk(wrapper);
    await advance(1_000);
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(true);
    await advance(6_000);
    stored(session.id).draft = draft;
    await advance(3_000);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('4단계 · 단계 초안');
    });
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
    expect(posts).toBe(1);
    wrapper.unmount();
  });

  it('a reload during the create replays the same Idempotency-Key and body, then continues', async () => {
    const keys: string[] = [];
    const bodies: string[] = [];
    // The stored outcome of the original create (made before the handler is overridden).
    const created = stored((await createClarificationSession('복원 과제')).id);
    server.use(
      http.post('*/api/v1/intake-sessions', async ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
        bodies.push(await request.text());
        if (keys.length === 1) {
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'In progress',
              status: 409,
              code: 'idempotency_in_progress',
              detail: 'pending',
            },
            { status: 409, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '1' } },
          );
        }
        return asJson(created, 201);
      }),
    );
    const input = { title: '복원 과제', description: '설명 그대로' };
    sessionStorage.setItem(
      aiWaitStorageKey(mockDb.user.id),
      JSON.stringify({
        kind: 'type_detection',
        startedAt: Date.now() - 4_000,
        ownerId: mockDb.user.id,
        create: {
          key: '01936d2e-7c4a-7b2e-8f00-000000000001',
          input,
          form: { title: '복원 과제', dueAt: '', description: '설명 그대로', fileName: '' },
        },
      }),
    );

    const { wrapper, router } = await mountAt('/plan/new');
    expect(wrapper.get('[data-testid="ai-wait"]').text()).toContain('AI가 비슷한 작업을 찾고 있어요');
    await advance(1_000);
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('plan-session');
    });
    expect(keys).toEqual([
      '01936d2e-7c4a-7b2e-8f00-000000000001',
      '01936d2e-7c4a-7b2e-8f00-000000000001',
    ]);
    expect(bodies.every((body) => JSON.parse(body).input.title === '복원 과제')).toBe(true);
    expect(sessionStorage.getItem(aiWaitStorageKey(mockDb.user.id))).toBeNull();
    wrapper.unmount();
  });
});

describe('AI wait: interrupted and unknown codes', () => {
  it('offers 다시 시도 for an interrupted decomposition and waits for the retry', async () => {
    const session = await createClarificationSession('중단 과제');
    markDecomposing(session.id);
    stored(session.id).error = { code: 'ai_interrupted', message: 'restart' };
    const resumes: string[] = [];
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(/\/api\/v1\/intake-sessions\/[^/]+:resume$/, async ({ request }) => {
        resumes.push(request.headers.get('If-Match') ?? '');
        const current = stored(session.id);
        delete current.error;
        current.version += 1;
        await released;
        current.draft = draft;
        return asJson(current);
      }),
    );
    const { wrapper } = await mountAt(`/plan/${session.id}`, session.id);
    const banner = wrapper.get('[data-testid="ai-interrupted"]');
    expect(banner.text()).toContain('AI 작업이 중단됐어요');
    // Not a stuck "running" state: no wait panel until the user retries.
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);

    await button(wrapper, '다시 시도').trigger('click');
    await advance(0);
    expect(wrapper.get('[data-testid="ai-wait"]').text()).toContain(DECOMPOSITION_TITLE);
    release();
    await advance(0);
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
    });
    expect(resumes).toEqual([`W/"${session.version + 1}"`]);
    expect(wrapper.get('#step-title-s3').element).toHaveProperty('value', 'AI 검토 단계');
    wrapper.unmount();
  });

  it('negative: an unknown session error code falls back to generic Korean copy with the code', async () => {
    const session = await createClarificationSession('알 수 없는 코드 과제');
    stored(session.id).error = { code: 'mystery_failure', message: 'x' };
    const { wrapper } = await mountAt(`/plan/${session.id}`, session.id);
    expect(wrapper.text()).toContain('AI 작업을 끝내지 못했어요.');
    expect(wrapper.text()).toContain('(코드: mystery_failure)');
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('AI request client bound', () => {
  it('is never shorter than the server bound and aborts with a typed error once it expires', async () => {
    // Server: 270 s request bound, 300 s HTTP socket guard (services/api ai-runs.ts / app.ts).
    expect(AI_REQUEST_CLIENT_BOUND_MS).toBeGreaterThanOrEqual(300_000);
    const ai = aiRequestSignal({ boundMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ai.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ai.signal.aborted).toBe(true);
    expect(ai.signal.reason).toBeInstanceOf(AiRequestTimeoutError);
    ai.dispose();
  });

  it('negative: the caller abort passes through and dispose stops the timer', async () => {
    const user = new AbortController();
    const ai = aiRequestSignal({ signal: user.signal, boundMs: 1_000 });
    user.abort();
    expect(ai.signal.aborted).toBe(true);
    expect(ai.signal.reason).not.toBeInstanceOf(AiRequestTimeoutError);
    const idle = aiRequestSignal({ boundMs: 1_000 });
    idle.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(idle.signal.aborted).toBe(false);
  });
});
