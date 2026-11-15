/**
 * FU-76R-1 H2 (ADR-023 owner isolation), reproduced as failing tests first:
 * the AI-wait/pending-create record is owner-scoped, written only for the
 * verified owner, cleared on owner change/logout and restored only for the
 * same verified owner; every async continuation of the wait (create success,
 * poll, replay, answers, resume) drops itself when the owner changes, and
 * polling/replay stop. A client-side stop never cancels the server call.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent, nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createPlannerClient, newActionId, type DecompositionDraft, type IntakeSession } from '../src/api';
import PlanView from '../src/views/PlanView.vue';
import { mockDb, type MockIntakeSession } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { adoptActiveOwner, clearOwnerResetPending, ownerChanged, ownerState } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';

const OWNER_A = '01900000-0000-7000-8000-00000000aa01';
const OWNER_B = '01900000-0000-7000-8000-00000000bb02';
const A_TITLE = 'Owner A private task';
const A_DESCRIPTION = 'A only: 비밀 설명';
const Stub = defineComponent({ template: '<div />' });

const draft: DecompositionDraft = {
  steps: [
    { key: 's1', title: 'A 준비', deliverable: 'x', doneCriteria: 'x', kind: 'prep', estimate: { p50Minutes: 30, p90Minutes: 60 }, dependsOn: [], splittable: false },
    { key: 's2', title: 'A 작성', deliverable: 'x', doneCriteria: 'x', kind: 'work', estimate: { p50Minutes: 60, p90Minutes: 90 }, dependsOn: ['s1'], splittable: true },
    { key: 's3', title: 'A 검토', deliverable: 'x', doneCriteria: 'x', kind: 'review', estimate: { p50Minutes: 30, p90Minutes: 60 }, dependsOn: ['s2'], splittable: false },
  ],
  assumptions: [],
  questionsRemaining: [],
};

const mounted: VueWrapper[] = [];

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/settings/ai', name: 'ai-settings', component: Stub },
      { path: '/plan', name: 'plan', component: PlanView },
      { path: '/plan/schedule', name: 'plan-scope', component: Stub },
      { path: '/plan/schedule/:id', name: 'plan-schedule', component: Stub },
      { path: '/plan/:sessionId', name: 'plan-session', component: PlanView, props: true },
    ],
  });
}

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

async function mountAt(path: string, pinia: Pinia, sessionId?: string) {
  const router = testRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(PlanView, {
    ...(sessionId === undefined ? {} : { props: { sessionId } }),
    global: { plugins: [pinia, router, VueQueryPlugin] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await settle();
  return { wrapper, router };
}

function becomeOwner(id: string): void {
  mockDb.user = { ...mockDb.user, id, email: `${id}@example.test` };
}

/** Owner A signed in and confirmed by /me, like the app after login. */
async function signedInAs(id: string): Promise<Pinia> {
  becomeOwner(id);
  adoptActiveOwner(id, 'bootstrap');
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  return pinia;
}

function storageText(): string {
  const values: string[] = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (key !== null) values.push(`${key}=${sessionStorage.getItem(key) ?? ''}`);
  }
  return values.join('\n');
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

function inProgress() {
  return HttpResponse.json(
    { type: 'about:blank', title: 'In progress', status: 409, code: 'idempotency_in_progress', detail: 'x' },
    { status: 409, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '1' } },
  );
}

async function createClarification(title: string): Promise<IntakeSession> {
  return createPlannerClient().createIntakeSession({ title, dueAt: '2026-11-30T18:00:00.000Z' }, newActionId('c'));
}

function decomposing(id: string): void {
  const session = stored(id);
  session.state = 'decomposition';
  session.version += 1;
  delete session.questions;
  delete session.draft;
  delete session.error;
}

/** Counts requests per kind; POST /intake-sessions can be held open. */
function countRequests() {
  const counts = { createPosts: 0, sessionGets: 0 };
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path.endsWith('/api/v1/intake-sessions')) counts.createPosts += 1;
    if (request.method === 'GET' && /\/api\/v1\/intake-sessions\/[^/]+$/.test(path)) counts.sessionGets += 1;
  });
  return counts;
}

function holdCreate(): { release(session: MockIntakeSession): void } {
  let release: (session: MockIntakeSession) => void = () => undefined;
  const released = new Promise<MockIntakeSession>((resolve) => {
    release = resolve;
  });
  server.use(
    http.post('*/api/v1/intake-sessions', async () => asJson(await released, 201)),
  );
  return { release: (session) => release(session) };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) {
    try {
      wrapper.unmount();
    } catch {
      // already unmounted
    }
  }
  server.events.removeAllListeners();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

describe('H2 — the pending create never crosses owners', () => {
  it('owner A pending create -> logout -> login as B: /plan shows nothing of A and sends no POST', async () => {
    const pinia = await signedInAs(OWNER_A);
    const counts = countRequests();
    holdCreate();
    const first = await mountAt('/plan', pinia);
    await first.wrapper.get('#plan-goal-title').setValue(A_TITLE);
    await first.wrapper.get('#plan-goal-description').setValue(A_DESCRIPTION);
    await first.wrapper.get('form').trigger('submit');
    await advance(1_000);
    expect(first.wrapper.find('[data-testid="ai-wait"]').exists()).toBe(true);
    expect(counts.createPosts).toBe(1);
    // A's pending create is kept for A's own reload.
    expect(storageText()).toContain(A_TITLE);
    first.wrapper.unmount();

    const auth = useAuthStore(pinia);
    await auth.logout();
    expect(storageText()).not.toContain(A_TITLE);
    becomeOwner(OWNER_B);
    await auth.login(`${OWNER_B}@example.test`, 'pw');
    expect(ownerState.ownerId.value).toBe(OWNER_B);
    clearOwnerResetPending();

    // The reloaded page as owner B.
    const second = await mountAt('/plan', createPinia());
    await advance(5_000);
    expect(second.wrapper.get('#plan-goal-title').element).toHaveProperty('value', '');
    expect(second.wrapper.get('#plan-goal-description').element).toHaveProperty('value', '');
    expect(second.wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
    expect(second.wrapper.text()).not.toContain(A_TITLE);
    expect(counts.createPosts).toBe(1);
  });

  it('a record left in storage for owner A (or unscoped) is never restored for verified owner B', async () => {
    const record = {
      kind: 'type_detection',
      startedAt: Date.now() - 2_000,
      ownerId: OWNER_A,
      create: {
        key: '01936d2e-7c4a-7b2e-8f00-00000000aa01',
        input: { title: A_TITLE, description: A_DESCRIPTION },
        form: { title: A_TITLE, dueAt: '', description: A_DESCRIPTION },
      },
    };
    const pinia = await signedInAs(OWNER_B);
    // Left behind by any path that skipped the owner-change clear.
    sessionStorage.setItem('ohmydate.intake.aiWait.v1', JSON.stringify(record));
    sessionStorage.setItem(`ohmydate.intake.aiWait.v2:${OWNER_A}`, JSON.stringify(record));
    // Even a record under B's own key that claims another owner is refused.
    sessionStorage.setItem(`ohmydate.intake.aiWait.v2:${OWNER_B}`, JSON.stringify(record));
    const counts = countRequests();
    const { wrapper } = await mountAt('/plan', pinia);
    await advance(5_000);
    expect(wrapper.get('#plan-goal-title').element).toHaveProperty('value', '');
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
    expect(counts.createPosts).toBe(0);
  });

  it('negative: the same verified owner still resumes their own pending create', async () => {
    const pinia = await signedInAs(OWNER_A);
    const created = stored((await createClarification('A 복원')).id);
    server.use(http.post('*/api/v1/intake-sessions', () => asJson(created, 201)));
    sessionStorage.setItem(
      `ohmydate.intake.aiWait.v2:${OWNER_A}`,
      JSON.stringify({
        kind: 'type_detection',
        startedAt: Date.now() - 2_000,
        ownerId: OWNER_A,
        create: {
          key: '01936d2e-7c4a-7b2e-8f00-00000000aa02',
          input: { title: 'A 복원' },
          form: { title: 'A 복원', dueAt: '', description: '' },
        },
      }),
    );
    const { router } = await mountAt('/plan', pinia);
    await advance(1_000);
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('plan-session');
    });
  });
});

describe('H2 — every wait continuation drops itself on an owner change', () => {
  it('create success after an owner change: no navigation, no cache or storage write', async () => {
    const pinia = await signedInAs(OWNER_A);
    const created = stored((await createClarification(A_TITLE)).id);
    const hold = holdCreate();
    const { wrapper, router } = await mountAt('/plan', pinia);
    await wrapper.get('#plan-goal-title').setValue(A_TITLE);
    await wrapper.get('form').trigger('submit');
    await advance(1_000);

    ownerChanged(OWNER_A, OWNER_B, 'storage');
    hold.release(created);
    await advance(1_000);
    expect(router.currentRoute.value.name).toBe('plan');
    expect(storageText()).not.toContain(A_TITLE);
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
  });

  it('polling stops on an owner change', async () => {
    const pinia = await signedInAs(OWNER_A);
    const session = await createClarification('A 폴링');
    decomposing(session.id);
    const counts = countRequests();
    const { wrapper } = await mountAt(`/plan/${session.id}`, pinia, session.id);
    await advance(6_000);
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(true);
    const before = counts.sessionGets;
    expect(before).toBeGreaterThan(1);

    ownerChanged(OWNER_A, OWNER_B, 'storage');
    stored(session.id).draft = draft;
    await advance(15_000);
    expect(counts.sessionGets).toBe(before);
    expect(wrapper.text()).not.toContain('A 작성');
  });

  it('the create replay stops on an owner change', async () => {
    const pinia = await signedInAs(OWNER_A);
    sessionStorage.setItem(
      `ohmydate.intake.aiWait.v2:${OWNER_A}`,
      JSON.stringify({
        kind: 'type_detection',
        startedAt: Date.now() - 2_000,
        ownerId: OWNER_A,
        create: {
          key: '01936d2e-7c4a-7b2e-8f00-00000000aa03',
          input: { title: A_TITLE },
          form: { title: A_TITLE, dueAt: '', description: '' },
        },
      }),
    );
    server.use(http.post('*/api/v1/intake-sessions', () => inProgress()));
    const counts = countRequests();
    await mountAt('/plan', pinia);
    await advance(3_000);
    const before = counts.createPosts;
    expect(before).toBeGreaterThan(1);

    ownerChanged(OWNER_A, OWNER_B, 'storage');
    await advance(15_000);
    expect(counts.createPosts).toBe(before);
    expect(storageText()).not.toContain(A_TITLE);
  });

  it('an answers response that lands after an owner change is not applied', async () => {
    const pinia = await signedInAs(OWNER_A);
    const session = await createClarification('A 답변');
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('*/api/v1/intake-sessions/:id/answers', async () => {
        decomposing(session.id);
        await released;
        const current = stored(session.id);
        current.draft = draft;
        return asJson(current);
      }),
    );
    const { wrapper } = await mountAt(`/plan/${session.id}`, pinia, session.id);
    await vi.waitFor(
      () => {
        expect(wrapper.find('.plan-question').exists()).toBe(true);
      },
      { timeout: 5_000 },
    );
    // HOLO-03A: the round's answers go in one request.
    await wrapper.get('input[data-idk]').setValue(true);
    await wrapper.get('[data-plan-questions]').trigger('submit');
    await advance(2_000);
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(true);

    ownerChanged(OWNER_A, OWNER_B, 'storage');
    release();
    await advance(1_000);
    expect(wrapper.attributes('data-plan-stage')).not.toBe('steps');
    expect(wrapper.find('#step-title-s2').exists()).toBe(false);
  });

  it('a 다시 시도 (:resume) response that lands after an owner change is not applied', async () => {
    const pinia = await signedInAs(OWNER_A);
    const session = await createClarification('A 재시도');
    decomposing(session.id);
    stored(session.id).error = { code: 'ai_interrupted', message: 'restart' };
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(/\/api\/v1\/intake-sessions\/[^/]+:resume$/, async () => {
        const current = stored(session.id);
        delete current.error;
        current.version += 1;
        await released;
        current.draft = draft;
        return asJson(current);
      }),
    );
    const { wrapper } = await mountAt(`/plan/${session.id}`, pinia, session.id);
    await vi.waitFor(
      () => {
        expect(wrapper.find('[data-testid="ai-interrupted"]').exists()).toBe(true);
      },
      { timeout: 5_000 },
    );
    const retry = wrapper.findAll('button').find((item) => item.text().includes('다시 시도'));
    expect(retry).toBeDefined();
    await retry?.trigger('click');
    await advance(1_000);
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(true);

    ownerChanged(OWNER_A, OWNER_B, 'storage');
    release();
    await advance(1_000);
    expect(wrapper.find('#step-title-s2').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ai-wait"]').exists()).toBe(false);
  });
});
