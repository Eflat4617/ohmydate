import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createPlannerClient, newActionId, type IntakeSession, type Plan } from '../src/api';
import PlanResumeList from '../src/components/plan/PlanResumeList.vue';
import {
  PLAN_FLOW_LIMIT,
  PLAN_FLOW_MAX_AGE_MS,
  forgetPlanFlow,
  planFlowKey,
  readPlanFlows,
  rememberPlanFlow,
} from '../src/composables/planFlowMemory';
import { createUuidV7, mockDb } from '../src/mocks/db';
import { adoptActiveOwner, captureOwnerBinding, ownerChanged } from '../src/session/ownerEpoch';
import { useSessionStore } from '../src/stores/session';
import { testRouter } from './planning-test-utils';

/**
 * HOLO-03A — "하던 계획" (FLOW §5 되돌아오기): the device remembers which plans
 * the owner started and did not finish (ids only, per owner); 계획 세우기 and
 * 개요 read their names and stages from the server and offer the way back in.
 */
const OWNER = mockDb.user.id;
const OTHER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b77';

function signIn(ownerId: string = OWNER): void {
  adoptActiveOwner(ownerId);
}

async function createSession(title: string): Promise<IntakeSession> {
  return createPlannerClient().createIntakeSession({ title }, newActionId('create'));
}

async function createPlan(): Promise<Plan> {
  const task = [...mockDb.tasks.values()][0];
  if (task === undefined) throw new Error('seed task missing');
  return createPlannerClient().createPlan(
    { scope: { taskIds: [task.id] }, horizon: { start: '2026-11-11T00:00:00.000Z', end: '2026-11-25T00:00:00.000Z' } },
    newActionId('plan'),
  );
}

async function mountList(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const pinia = createPinia();
  useSessionStore(pinia).setOwner(OWNER);
  const router = testRouter();
  await router.push('/plan');
  await router.isReady();
  const wrapper = mount(PlanResumeList, { props, global: { plugins: [pinia, router, VueQueryPlugin] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  adoptActiveOwner(null);
  signIn();
});

describe('what the device remembers (ids only, per owner)', () => {
  it('keeps the newest few, newest first, and nothing but ids and a time', () => {
    const ids = Array.from({ length: PLAN_FLOW_LIMIT + 2 }, () => createUuidV7());
    ids.forEach((id, index) => rememberPlanFlow(captureOwnerBinding(), { kind: 'session', id }, 1_000 + index));
    const kept = readPlanFlows(OWNER, 2_000);
    expect(kept.map((entry) => entry.id)).toEqual(ids.slice(-PLAN_FLOW_LIMIT).reverse());
    const stored = JSON.parse(localStorage.getItem(planFlowKey(OWNER)) ?? '[]') as Record<string, unknown>[];
    for (const entry of stored) expect(Object.keys(entry).sort()).toEqual(['at', 'id', 'kind']);
  });

  it('a plan made from a session takes the session’s place; forgetting removes exactly one', () => {
    const session = createUuidV7();
    const other = createUuidV7();
    const plan = createUuidV7();
    const t0 = Date.now() - 10_000;
    rememberPlanFlow(captureOwnerBinding(), { kind: 'session', id: session }, t0 + 1);
    rememberPlanFlow(captureOwnerBinding(), { kind: 'session', id: other }, t0 + 2);
    rememberPlanFlow(captureOwnerBinding(), { kind: 'plan', id: plan, sessionId: session }, t0 + 3);
    expect(readPlanFlows(OWNER)).toEqual([
      { kind: 'plan', id: plan, sessionId: session, at: t0 + 3 },
      { kind: 'session', id: other, at: t0 + 2 },
    ]);
    // The kind is part of what is forgotten: a session of that id was never remembered (negative).
    forgetPlanFlow(captureOwnerBinding(), 'session', plan);
    expect(readPlanFlows(OWNER)).toHaveLength(2);
    forgetPlanFlow(captureOwnerBinding(), 'plan', plan);
    expect(readPlanFlows(OWNER)).toEqual([{ kind: 'session', id: other, at: t0 + 2 }]);
    forgetPlanFlow(captureOwnerBinding(), 'session', other);
    expect(localStorage.getItem(planFlowKey(OWNER))).toBeNull();
  });

  it('ignores what it cannot read, what is too old, and anything that is not an id (negative)', () => {
    localStorage.setItem(planFlowKey(OWNER), '{not json');
    expect(readPlanFlows(OWNER)).toEqual([]);
    const good = createUuidV7();
    localStorage.setItem(
      planFlowKey(OWNER),
      JSON.stringify([
        { kind: 'session', id: good, at: 5_000 },
        { kind: 'session', id: 'not-an-id', at: 5_000 },
        { kind: 'draft', id: createUuidV7(), at: 5_000 },
        { kind: 'plan', id: createUuidV7(), at: 'yesterday' },
        { kind: 'plan', id: createUuidV7(), sessionId: 'x', at: 5_000 },
        'text',
        null,
      ]),
    );
    expect(readPlanFlows(OWNER, 6_000)).toEqual([{ kind: 'session', id: good, at: 5_000 }]);
    expect(readPlanFlows(OWNER, 5_000 + PLAN_FLOW_MAX_AGE_MS + 1)).toEqual([]);
    rememberPlanFlow(captureOwnerBinding(), { kind: 'session', id: 'nope' });
    expect(readPlanFlows(OWNER, 6_000)).toEqual([{ kind: 'session', id: good, at: 5_000 }]);
  });

  it('one owner’s list is never another’s, and a write that outlived its owner is dropped (negative)', () => {
    const mine = createUuidV7();
    const binding = captureOwnerBinding();
    rememberPlanFlow(binding, { kind: 'session', id: mine });
    expect(readPlanFlows(OTHER)).toEqual([]);
    expect(readPlanFlows(null)).toEqual([]);

    // Another user signs in; a continuation of the first owner's action then tries to write.
    ownerChanged(OWNER, OTHER, 'login');
    rememberPlanFlow(binding, { kind: 'session', id: createUuidV7() });
    forgetPlanFlow(binding, 'session', mine);
    expect(readPlanFlows(OTHER)).toEqual([]);
    expect(localStorage.getItem(planFlowKey(OTHER))).toBeNull();
    // The first owner's own list is as it was: preserved for when they sign in again.
    expect(readPlanFlows(OWNER).map((entry) => entry.id)).toEqual([mine]);
  });
});

describe('하던 계획 — the way back in', () => {
  it('renders nothing when nothing is unfinished (negative)', async () => {
    const wrapper = await mountList();
    expect(wrapper.find('[data-plan-resume]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('names a session by its goal and says where it stopped, with the link back', async () => {
    const session = await createSession('논문 요약');
    rememberPlanFlow(captureOwnerBinding(), { kind: 'session', id: session.id });
    const wrapper = await mountList();
    await vi.waitFor(() => expect(wrapper.find('[data-resume]').exists()).toBe(true));
    const row = wrapper.get(`[data-resume="${session.id}"]`);
    expect(row.get('.plan-resume-name').text()).toBe('논문 요약');
    expect(row.get('.plan-resume-state').text()).toBe('질문에서 멈췄어요');
    const link = row.get('a');
    expect(link.attributes('href')).toBe(`/plan/${session.id}`);
    expect(link.attributes('aria-label')).toBe('‘논문 요약’ 이어서 하기');
    // A way back is never a filled button: the screen it sits on has its own.
    expect(wrapper.find('.btn--primary').exists()).toBe(false);
    wrapper.unmount();
  });

  it('a plan being compared is named after the goal it came from, or by its tasks, and opens its schedules', async () => {
    const session = await createSession('발표 준비');
    const fromSession = await createPlan();
    const fromTasks = await createPlan();
    rememberPlanFlow(captureOwnerBinding(), { kind: 'plan', id: fromTasks.id }, Date.now() - 2_000);
    rememberPlanFlow(captureOwnerBinding(), { kind: 'plan', id: fromSession.id, sessionId: session.id }, Date.now() - 1_000);
    const wrapper = await mountList();
    await vi.waitFor(() => expect(wrapper.findAll('[data-resume]')).toHaveLength(2));

    const first = wrapper.get(`[data-resume="${fromSession.id}"]`);
    expect(first.get('.plan-resume-name').text()).toBe('발표 준비');
    expect(first.get('.plan-resume-state').text()).toBe('일정안을 고르는 중이에요');
    expect(first.get('a').attributes('href')).toBe(`/plan/schedule/${fromSession.id}?session=${session.id}`);
    const second = wrapper.get(`[data-resume="${fromTasks.id}"]`);
    expect(second.get('.plan-resume-name').text()).toBe('작업 1개 일정안');
    expect(second.get('a').attributes('href')).toBe(`/plan/schedule/${fromTasks.id}`);
    wrapper.unmount();
  });

  it('drops what turned out finished, given up or gone, and shows only what can be gone on with', async () => {
    const open = await createSession('아직 하는 중');
    const cancelled = await createSession('그만둔 계획');
    await createPlannerClient().cancelIntakeSession(cancelled.id, newActionId('cancel'), cancelled.version);
    const confirmed = await createPlan();
    const candidate = confirmed.candidates[0];
    if (candidate === undefined) throw new Error('candidate missing');
    await createPlannerClient().approveCandidate(confirmed.id, candidate.id, newActionId('approve'), confirmed.availabilityVersion);
    localStorage.setItem(
      planFlowKey(OWNER),
      JSON.stringify([
        { kind: 'session', id: open.id, at: Date.now() - 4 },
        { kind: 'session', id: cancelled.id, at: Date.now() - 3 },
        { kind: 'plan', id: confirmed.id, at: Date.now() - 2 },
      ]),
    );
    const gone = createUuidV7();
    rememberPlanFlow(captureOwnerBinding(), { kind: 'plan', id: gone });
    // (Only the newest few are kept: the oldest of the four already fell off.)
    const before = readPlanFlows(OWNER).map((entry) => entry.id);
    expect(before).toContain(gone);

    const wrapper = await mountList();
    await vi.waitFor(() => expect(readPlanFlows(OWNER).map((entry) => entry.id)).not.toContain(gone));
    await vi.waitFor(() => expect(readPlanFlows(OWNER).map((entry) => entry.id)).not.toContain(confirmed.id));
    await vi.waitFor(() => expect(readPlanFlows(OWNER).map((entry) => entry.id)).not.toContain(cancelled.id));
    expect(wrapper.find(`[data-resume="${gone}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-resume="${confirmed.id}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-resume="${cancelled.id}"]`).exists()).toBe(false);
    wrapper.unmount();
  });

  it('“목록에서 빼기” removes one at the press; `limit` shows only the newest', async () => {
    const older = await createSession('먼저 시작한 계획');
    const newer = await createSession('나중에 시작한 계획');
    rememberPlanFlow(captureOwnerBinding(), { kind: 'session', id: older.id }, Date.now() - 2_000);
    rememberPlanFlow(captureOwnerBinding(), { kind: 'session', id: newer.id }, Date.now() - 1_000);

    const one = await mountList({ limit: 1, compact: true });
    await vi.waitFor(() => expect(one.findAll('[data-resume]')).toHaveLength(1));
    expect(one.get('[data-resume]').attributes('data-resume')).toBe(newer.id);
    expect(one.get('[data-plan-resume]').classes()).toContain('plan-resume--compact');
    one.unmount();

    const wrapper = await mountList();
    await vi.waitFor(() => expect(wrapper.findAll('[data-resume]')).toHaveLength(2));
    const forget = wrapper.get(`[data-resume="${newer.id}"] [data-resume-forget]`);
    expect(forget.attributes('aria-label')).toBe('‘나중에 시작한 계획’ 목록에서 빼기');
    await forget.trigger('click');
    await vi.waitFor(() => expect(wrapper.findAll('[data-resume]')).toHaveLength(1));
    expect(readPlanFlows(OWNER).map((entry) => entry.id)).toEqual([older.id]);
    // The session itself is untouched: only the pointer is gone.
    expect(mockDb.intakeSessions.get(newer.id)?.state).not.toBe('cancelled');
    wrapper.unmount();
  });
});
