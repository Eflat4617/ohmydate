import { HttpResponse, http } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import PlanScopeView from '../src/views/PlanScopeView.vue';
import { plannerClient, type GoalSummary, type Task } from '../src/api';
import { readPlanFlows } from '../src/composables/planFlowMemory';
import { AVAILABILITY_PRESETS, applyPreset, presetActive, removePreset } from '../src/domain/availabilityPresets';
import {
  PICKER_GOAL_PAGES,
  PICKER_PAGE_SIZE,
  PICKER_TASK_PAGES,
  defaultGroupOpen,
  groupPickerTasks,
  groupSelection,
  selectedTaskIdsInOrder,
  selectionSummary,
  toggleGroup,
} from '../src/domain/planPicker';
import { INBOX_PROJECT_ID, USER_ID, mockDb, type MockIntakeSession } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { createPinia } from 'pinia';
import { useOfflineStore } from '../src/stores/offline';
import { useSessionStore } from '../src/stores/session';
import { buttonByText, mountWithPlugins, settle, testRouter } from './planning-test-utils';

/**
 * 계획 세우기 · 일정안 만들기 (`/plan/schedule`, HOLO-03A): what goes into the
 * three schedules.
 *
 * FU-98 (GU-1 feedback): "계획을 한번에 생성한건 한 폴더안에 묶어놓고 한번에
 * 선택하게 해줬으면 해." The picker groups open tasks by the plan (goal) whose
 * approval created them, with a tri-state "모두 선택" per group.
 *
 * FLOW §2: what came before arrives picked, and what is not ready is asked
 * right here — the hours the owner can work, and (optionally) their 약속.
 */

let sequence = 0;

/** Deterministic UUIDv7-shaped ids, ordered by creation. */
function nextId(): string {
  sequence += 1;
  return `01930000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

function makeTask(title: string, options: { status?: Task['status']; createdAt?: string } = {}): Task {
  const createdAt = options.createdAt ?? '2026-11-10T09:00:00.000Z';
  return {
    id: nextId(),
    ownerId: USER_ID,
    projectId: INBOX_PROJECT_ID,
    title,
    status: options.status ?? 'todo',
    splittable: true,
    priority: 2,
    dependsOn: [],
    version: 1,
    createdAt,
    updatedAt: createdAt,
    external: [],
  };
}

function makeGoal(title: string, createdAt: string, taskIds: readonly string[]): GoalSummary {
  return { id: nextId(), title, status: 'active', createdAt, taskIds: [...taskIds] };
}

/** Seed tasks into the mock DB (visible through GET /tasks). */
function seedTasks(...tasks: Task[]): Task[] {
  for (const task of tasks) mockDb.tasks.set(task.id, task);
  mockDb.taskRevision += 1;
  return tasks;
}

/**
 * Seed a goal the way the wizard does in the mock: the goal title plus an
 * approved session whose created tasks are `tasks` (GET /goals reads both).
 */
function seedWizardGoal(title: string, createdAt: string, tasks: readonly Task[]): string {
  const goalId = nextId();
  mockDb.notes.goals.set(goalId, title);
  const session = {
    id: nextId(),
    ownerId: USER_ID,
    goalId,
    state: 'scheduled',
    input: { title },
    round: 1,
    manual: false,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    askedFields: [],
    createdTaskIds: tasks.map((task) => task.id),
  } as unknown as MockIntakeSession;
  mockDb.intakeSessions.set(session.id, session);
  return goalId;
}

async function mountPicker(path = '/plan/schedule'): Promise<{ wrapper: VueWrapper; router: ReturnType<typeof testRouter> }> {
  const router = testRouter();
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  useSessionStore(pinia).setOwner(mockDb.user.id);
  const wrapper = mountWithPlugins(PlanScopeView, { router, pinia });
  await settle();
  return { wrapper, router };
}

async function waitForGroups(wrapper: VueWrapper, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.findAll('.picker-group').length).toBe(count);
  });
}

function group(wrapper: VueWrapper, key: string) {
  return wrapper.get(`[data-group-key="${key}"]`);
}

function groupAll(wrapper: VueWrapper, key: string): HTMLInputElement {
  return group(wrapper, key).get('input[data-group-all]').element as HTMLInputElement;
}

function taskBox(wrapper: VueWrapper, taskId: string): HTMLInputElement {
  return wrapper.get(`input[value="${taskId}"]`).element as HTMLInputElement;
}

/** Press 일정안 만들기 once it can be pressed (the hours it plans within are read first). */
async function pressCreate(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(buttonByText(wrapper, '일정안 만들기').attributes('disabled')).toBeUndefined());
  await buttonByText(wrapper, '일정안 만들기').trigger('click');
}

async function click(input: HTMLInputElement): Promise<void> {
  input.click();
  await settle();
}

const SEEDED_OPEN = 3; // the mock's three seeded inbox tasks (no goal)

describe('FU-98 grouping (pure)', () => {
  it('orders goals newest first, keeps step order, puts every task in exactly one group, other last', () => {
    const [a, b, c, d, loose] = [makeTask('A'), makeTask('B'), makeTask('C'), makeTask('D'), makeTask('loose')];
    const older = makeGoal('older', '2026-11-10T00:00:00.000Z', [a!.id, b!.id]);
    // The newer goal names `b` too: it is claimed once, by the newest goal.
    const newer = makeGoal('newer', '2026-11-12T00:00:00.000Z', [d!.id, c!.id, b!.id]);
    const groups = groupPickerTasks([older, newer], [a!, b!, c!, d!, loose!]);
    expect(groups.map((entry) => entry.key)).toEqual([`goal:${newer.id}`, `goal:${older.id}`, 'other']);
    expect(groups[0]?.tasks.map((task) => task.title)).toEqual(['D', 'C', 'B']);
    expect(groups[1]?.tasks.map((task) => task.title)).toEqual(['A']);
    expect(groups[2]?.tasks.map((task) => task.title)).toEqual(['loose']);
    const all = groups.flatMap((entry) => entry.tasks.map((task) => task.id));
    expect(new Set(all).size).toBe(all.length);
  });

  it('negative: done or deleted tasks are not offered, and a goal with nothing open is left out', () => {
    const done = makeTask('done', { status: 'done' });
    const deleted = { ...makeTask('deleted'), deletedAt: '2026-11-11T00:00:00.000Z' };
    const open = makeTask('open', { status: 'in_progress' });
    const finished = makeGoal('finished', '2026-11-12T00:00:00.000Z', [done.id, deleted.id]);
    const active = makeGoal('active', '2026-11-11T00:00:00.000Z', [done.id, open.id]);
    const groups = groupPickerTasks([finished, active], [done, deleted, open]);
    expect(groups.map((entry) => entry.key)).toEqual([`goal:${active.id}`]);
    expect(groups[0]?.tasks.map((task) => task.id)).toEqual([open.id]);
    expect(groupPickerTasks([], [])).toEqual([]);
  });

  it('tri-state: none → all → none, partial is "some", and toggling one group leaves the others', () => {
    const [a, b, c] = [makeTask('A'), makeTask('B'), makeTask('C')];
    const [first, second] = groupPickerTasks([makeGoal('g', '2026-11-12T00:00:00.000Z', [a!.id, b!.id])], [a!, b!, c!]);
    if (first === undefined || second === undefined) throw new Error('groups missing');
    let selected: ReadonlySet<string> = new Set([c!.id]);
    expect(groupSelection(first, selected)).toBe('none');
    selected = toggleGroup(first, selected);
    expect(groupSelection(first, selected)).toBe('all');
    expect(selected.has(c!.id)).toBe(true);
    selected = toggleGroup(first, selected);
    expect(groupSelection(first, selected)).toBe('none');
    expect([...selected]).toEqual([c!.id]);
    selected = new Set([a!.id]);
    expect(groupSelection(first, selected)).toBe('some');
    expect(groupSelection(first, toggleGroup(first, selected))).toBe('all');
    expect(selectedTaskIdsInOrder([first, second], new Set([c!.id, b!.id, 'gone']))).toEqual([b!.id, c!.id]);
    expect(selectionSummary([first, second], new Set([a!.id, c!.id]))).toEqual({ tasks: 2, plans: 1, other: true });
  });

  it('opens every group when there are at most three, otherwise only the newest', () => {
    expect([0, 1, 2].map((index) => defaultGroupOpen(index, 3))).toEqual([true, true, true]);
    expect([0, 1, 2, 3].map((index) => defaultGroupOpen(index, 4))).toEqual([true, false, false, false]);
  });
});

describe('FU-98 the task picker of 일정안 만들기', () => {
  beforeEach(() => {
    sequence = 0;
    localStorage.clear();
  });

  it('groups a wizard plan into one folder on top, with the plain tasks in "기타 작업" last', async () => {
    const steps = seedTasks(makeTask('자료 조사'), makeTask('초안 쓰기'), makeTask('퇴고'));
    const goalId = seedWizardGoal('논문 초안', '2026-11-12T09:00:00.000Z', steps);
    const { wrapper } = await mountPicker();
    await waitForGroups(wrapper, 2);

    const groups = wrapper.findAll('.picker-group');
    expect(groups[0]?.attributes('data-group-key')).toBe(`goal:${goalId}`);
    expect(groups[0]?.text()).toContain('논문 초안');
    expect(groups[0]?.text()).toContain('작업 3개');
    expect(groups[0]?.findAll('.task-picker li').map((row) => row.text())).toEqual(['자료 조사', '초안 쓰기', '퇴고']);
    expect(groups[1]?.attributes('data-group-key')).toBe('other');
    expect(groups[1]?.text()).toContain('기타 작업');
    expect(groups[1]?.text()).toContain(`작업 ${SEEDED_OPEN}개`);
    // Group headers are real disclosure buttons that control their task list.
    const toggle = groups[0]?.get('button.picker-group-toggle');
    expect(toggle?.attributes('aria-expanded')).toBe('true');
    expect(toggle?.attributes('aria-controls')).toBe(`picker-group-${goalId}-tasks`);
    expect(wrapper.find(`#picker-group-${goalId}-tasks`).exists()).toBe(true);
    // The select-all is a native checkbox named after its group.
    const all = group(wrapper, `goal:${goalId}`).get('input[data-group-all]');
    expect(all.attributes('type')).toBe('checkbox');
    expect(all.attributes('aria-label')).toBe('논문 초안 작업 모두 선택');
    expect(wrapper.get('[data-scope-summary]').text()).toBe('아직 고른 작업이 없어요');
    wrapper.unmount();
  });

  it('selects a whole plan with one click, then clears it; one task makes it indeterminate', async () => {
    const steps = seedTasks(makeTask('하나'), makeTask('둘'), makeTask('셋'));
    const goalId = seedWizardGoal('이사 준비', '2026-11-12T09:00:00.000Z', steps);
    const { wrapper } = await mountPicker();
    await waitForGroups(wrapper, 2);
    const key = `goal:${goalId}`;

    await click(groupAll(wrapper, key));
    expect(steps.every((task) => taskBox(wrapper, task.id).checked)).toBe(true);
    expect(groupAll(wrapper, key).checked).toBe(true);
    expect(groupAll(wrapper, key).indeterminate).toBe(false);
    expect(wrapper.text()).toContain('작업 3개 선택 (계획 1개)');

    await click(groupAll(wrapper, key));
    expect(steps.some((task) => taskBox(wrapper, task.id).checked)).toBe(false);
    expect(groupAll(wrapper, key).checked).toBe(false);
    expect(groupAll(wrapper, key).indeterminate).toBe(false);
    expect(wrapper.get('[data-scope-summary]').text()).toBe('아직 고른 작업이 없어요');

    await click(taskBox(wrapper, steps[1]!.id));
    expect(groupAll(wrapper, key).checked).toBe(false);
    expect(groupAll(wrapper, key).indeterminate).toBe(true);
    expect(group(wrapper, key).text()).toContain('1개 선택됨');

    // Clicking the indeterminate box selects the rest of the plan.
    await click(groupAll(wrapper, key));
    expect(groupAll(wrapper, key).checked).toBe(true);
    expect(groupAll(wrapper, key).indeterminate).toBe(false);
    expect(steps.every((task) => taskBox(wrapper, task.id).checked)).toBe(true);

    // Negative: the other group was never touched.
    expect(groupAll(wrapper, 'other').checked).toBe(false);
    expect(groupAll(wrapper, 'other').indeterminate).toBe(false);
    wrapper.unmount();
  });

  it('select-all skips done tasks, and generate() sends exactly the selected open task ids', async () => {
    const [open1, done, open2] = seedTasks(makeTask('열린 1'), makeTask('끝난 일', { status: 'done' }), makeTask('열린 2'));
    const goalId = seedWizardGoal('발표 준비', '2026-11-12T09:00:00.000Z', [open1!, done!, open2!]);
    const [loose] = seedTasks(makeTask('따로 할 일'));
    let sent: unknown;
    server.use(
      http.post('*/api/v1/plans', async ({ request }) => {
        sent = await request.clone().json();
        // No response: fall through to the mock's real handler.
      }),
    );
    const { wrapper, router } = await mountPicker();
    await waitForGroups(wrapper, 2);
    const key = `goal:${goalId}`;

    expect(group(wrapper, key).text()).toContain('작업 2개');
    expect(wrapper.find(`input[value="${done!.id}"]`).exists()).toBe(false);
    await click(groupAll(wrapper, key));
    await click(taskBox(wrapper, loose!.id));
    expect(wrapper.text()).toContain('작업 3개 선택 (계획 1개 · 기타 작업 포함)');

    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    const scope = (sent as { scope?: { taskIds?: string[]; goalId?: string } }).scope;
    expect(scope?.goalId).toBeUndefined();
    expect(scope?.taskIds).toEqual([open1!.id, open2!.id, loose!.id]);
    // Negative: the done task of the same plan is never sent.
    expect(scope?.taskIds).not.toContain(done!.id);
    wrapper.unmount();
  });

  it('negative: with nothing selected the generate button stays disabled and no plan is created', async () => {
    const { wrapper } = await mountPicker();
    await waitForGroups(wrapper, 1);
    const generate = buttonByText(wrapper, '일정안 만들기');
    expect(generate.attributes('disabled')).toBeDefined();
    // The button says why it cannot be pressed.
    expect(wrapper.get('[data-plan-blocker]').text()).toBe('배치할 작업을 골라 주세요.');
    expect(generate.attributes('aria-describedby')).toBe('plan-create-why');
    await generate.trigger('click');
    await wrapper.get('form').trigger('submit');
    await settle();
    expect(mockDb.plans.size).toBe(0);
    wrapper.unmount();
  });

  it('expands every group when there are at most three; with more, only the newest, and headers toggle', async () => {
    const goals = [1, 2, 3, 4].map((day) => {
      const [task] = seedTasks(makeTask(`계획 ${day} 작업`));
      return seedWizardGoal(`계획 ${day}`, `2026-11-1${day}T09:00:00.000Z`, [task!]);
    });
    const { wrapper } = await mountPicker();
    await waitForGroups(wrapper, 5);
    const toggles = wrapper.findAll('button.picker-group-toggle');
    // Newest (계획 4) first and open; the rest start collapsed.
    expect(toggles[0]?.text()).toContain('계획 4');
    expect(toggles.map((toggle) => toggle.attributes('aria-expanded'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    const second = `picker-group-${goals[2]}-tasks`;
    expect((wrapper.get(`#${second}`).element as HTMLElement).style.display).toBe('none');
    await toggles[1]?.trigger('click');
    expect(toggles[1]?.attributes('aria-expanded')).toBe('true');
    expect((wrapper.get(`#${second}`).element as HTMLElement).style.display).toBe('');
    await toggles[0]?.trigger('click');
    expect(toggles[0]?.attributes('aria-expanded')).toBe('false');
    wrapper.unmount();
  });

  it('negative: with three groups or fewer nothing starts collapsed', async () => {
    const [task] = seedTasks(makeTask('작업'));
    seedWizardGoal('계획', '2026-11-12T09:00:00.000Z', [task!]);
    const { wrapper } = await mountPicker();
    await waitForGroups(wrapper, 2);
    expect(wrapper.findAll('button.picker-group-toggle').map((toggle) => toggle.attributes('aria-expanded'))).toEqual([
      'true',
      'true',
    ]);
    wrapper.unmount();
  });

  it('merges every task and goal page before grouping, without a cap notice', async () => {
    const [first, second, third] = [makeTask('1쪽 작업'), makeTask('2쪽 작업'), makeTask('3쪽 작업')];
    const older = makeGoal('예전 계획', '2026-11-10T00:00:00.000Z', [third!.id]);
    const newer = makeGoal('새 계획', '2026-11-12T00:00:00.000Z', [first!.id, second!.id]);
    const taskCalls: URL[] = [];
    const goalCalls: URL[] = [];
    server.use(
      http.get('*/api/v1/tasks', ({ request }) => {
        const url = new URL(request.url);
        taskCalls.push(url);
        const cursor = url.searchParams.get('cursor');
        if (cursor === null) return HttpResponse.json({ items: [first], nextCursor: 't2' });
        if (cursor === 't2') return HttpResponse.json({ items: [second], nextCursor: 't3' });
        return HttpResponse.json({ items: [third], nextCursor: null });
      }),
      http.get('*/api/v1/goals', ({ request }) => {
        const url = new URL(request.url);
        goalCalls.push(url);
        return url.searchParams.get('cursor') === null
          ? HttpResponse.json({ items: [newer], nextCursor: 'g2' })
          : HttpResponse.json({ items: [older], nextCursor: null });
      }),
    );
    const { wrapper } = await mountPicker();
    await waitForGroups(wrapper, 2);
    expect(taskCalls.map((url) => url.searchParams.get('cursor'))).toEqual([null, 't2', 't3']);
    expect(taskCalls.every((url) => url.searchParams.get('limit') === String(PICKER_PAGE_SIZE))).toBe(true);
    expect(goalCalls.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'g2']);
    // The newest goal's group holds tasks from pages 1 and 2: never partial.
    expect(group(wrapper, `goal:${newer.id}`).findAll('.task-picker li').map((row) => row.text())).toEqual([
      '1쪽 작업',
      '2쪽 작업',
    ]);
    expect(group(wrapper, `goal:${older.id}`).text()).toContain('3쪽 작업');
    expect(wrapper.find('[data-testid="picker-tasks-capped"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="picker-goals-capped"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('stops at the page bound and says the task and goal lists are partial', async () => {
    let taskCalls = 0;
    let goalCalls = 0;
    server.use(
      http.get('*/api/v1/tasks', () => {
        taskCalls += 1;
        return HttpResponse.json({ items: [makeTask(`작업 ${taskCalls}`)], nextCursor: `t${taskCalls}` });
      }),
      http.get('*/api/v1/goals', () => {
        goalCalls += 1;
        return HttpResponse.json({ items: [], nextCursor: `g${goalCalls}` });
      }),
    );
    const { wrapper } = await mountPicker();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="picker-tasks-capped"]').exists()).toBe(true));
    expect(taskCalls).toBe(PICKER_TASK_PAGES);
    expect(goalCalls).toBe(PICKER_GOAL_PAGES);
    expect(wrapper.get('[data-testid="picker-tasks-capped"]').text()).toContain('처음 1,000개까지만');
    expect(wrapper.get('[data-testid="picker-goals-capped"]').text()).toContain('최근 500개까지만');
    expect(group(wrapper, 'other').findAll('.task-picker li')).toHaveLength(PICKER_TASK_PAGES);
    wrapper.unmount();
  });

  it('negative: a failed goal list still offers every task, in "기타 작업", with a notice', async () => {
    const steps = seedTasks(makeTask('묶이지 않은 작업'));
    seedWizardGoal('계획', '2026-11-12T09:00:00.000Z', steps);
    server.use(http.get('*/api/v1/goals', () => HttpResponse.json({ code: 'internal', title: 'x' }, { status: 500 })));
    const { wrapper } = await mountPicker();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="picker-goals-error"]').exists()).toBe(true), {
      timeout: 10_000,
    });
    expect(wrapper.findAll('.picker-group').map((entry) => entry.attributes('data-group-key'))).toEqual(['other']);
    expect(group(wrapper, 'other').findAll('.task-picker li')).toHaveLength(SEEDED_OPEN + 1);
    wrapper.unmount();
  });

  it('?goalId (the wizard link) keeps its one-click scope, named after the plan, listing its open tasks', async () => {
    const [one, finished, two] = seedTasks(makeTask('첫 단계'), makeTask('끝난 단계', { status: 'done' }), makeTask('둘째 단계'));
    const goalId = seedWizardGoal('여행 계획', '2026-11-12T09:00:00.000Z', [one!, finished!, two!]);
    let sent: unknown;
    server.use(
      http.post('*/api/v1/plans', async ({ request }) => {
        sent = await request.clone().json();
      }),
    );
    const { wrapper, router } = await mountPicker(`/plan/schedule?goalId=${goalId}`);
    await vi.waitFor(() => expect(wrapper.get('[data-scope-summary]').text()).toBe('계획 「여행 계획」 · 작업 2개'));
    expect(wrapper.findAll('.scope-list li').map((row) => row.text())).toEqual(['첫 단계', '둘째 단계']);
    expect(wrapper.find('.picker-group').exists()).toBe(false);
    // The plan's name is the page's title.
    expect(wrapper.get('h1').text()).toBe('여행 계획');
    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    expect((sent as { scope?: unknown }).scope).toEqual({ goalId });
    wrapper.unmount();
  });

  it('negative: an unknown ?goalId shows a plain summary, not an error page', async () => {
    const unknown = nextId();
    const { wrapper } = await mountPicker(`/plan/schedule?goalId=${unknown}`);
    await vi.waitFor(() => expect(wrapper.get('[data-scope-summary]').text()).toBe('고른 계획의 작업'));
    // No id is shown to a person.
    expect(wrapper.text()).not.toContain(unknown);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.findAll('.scope-list li')).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('what came before arrives picked (FLOW §2)', () => {
  beforeEach(() => {
    sequence = 0;
    localStorage.clear();
  });

  it('?taskIds lists the given tasks by name; “다른 작업 고르기” opens the picker with them already picked', async () => {
    const [one, two, other] = seedTasks(makeTask('골라 온 일 1'), makeTask('골라 온 일 2'), makeTask('고르지 않은 일'));
    let sent: unknown;
    server.use(
      http.post('*/api/v1/plans', async ({ request }) => {
        sent = await request.clone().json();
      }),
    );
    const { wrapper, router } = await mountPicker(`/plan/schedule?taskIds=${one!.id},${two!.id}`);
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li').map((row) => row.text())).toEqual(['골라 온 일 1', '골라 온 일 2']));
    expect(wrapper.get('[data-scope-summary]').text()).toBe('작업 2개');
    expect(wrapper.find('.picker-group').exists()).toBe(false);

    await wrapper.get('[data-scope-change]').trigger('click');
    await waitForGroups(wrapper, 1);
    expect(taskBox(wrapper, one!.id).checked).toBe(true);
    expect(taskBox(wrapper, two!.id).checked).toBe(true);
    expect(taskBox(wrapper, other!.id).checked).toBe(false);
    await click(taskBox(wrapper, other!.id));
    await click(taskBox(wrapper, one!.id));
    expect(wrapper.get('[data-scope-summary]').text()).toBe('작업 2개 선택 (기타 작업)');

    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    expect((sent as { scope?: { taskIds?: string[] } }).scope?.taskIds).toEqual([two!.id, other!.id]);
    wrapper.unmount();
  });

  it('negative: an untouched ?taskIds scope is sent exactly as it came', async () => {
    const [one] = seedTasks(makeTask('하나만'));
    let sent: unknown;
    server.use(
      http.post('*/api/v1/plans', async ({ request }) => {
        sent = await request.clone().json();
      }),
    );
    const { wrapper, router } = await mountPicker(`/plan/schedule?taskIds=${one!.id}&session=${nextId()}`);
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li')).toHaveLength(1));
    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    expect((sent as { scope?: unknown }).scope).toEqual({ taskIds: [one!.id] });
    // The session it came from travels on, and the new plan is remembered as unfinished.
    expect(router.currentRoute.value.query['session']).toBeDefined();
    expect(readPlanFlows(mockDb.user.id)).toMatchObject([
      { kind: 'plan', id: router.currentRoute.value.params['id'], sessionId: router.currentRoute.value.query['session'] },
    ]);
    wrapper.unmount();
  });

  it('an empty list leads back to the stage before: capture something, or start from a goal (never a dead end)', async () => {
    server.use(http.get('*/api/v1/tasks', () => HttpResponse.json({ items: [], nextCursor: null })));
    const { wrapper } = await mountPicker();
    await vi.waitFor(() => expect(wrapper.find('[data-scope-empty]').exists()).toBe(true));
    const empty = wrapper.get('[data-scope-empty]');
    expect(empty.text()).toContain('배치할 작업이 아직 없어요');
    expect(empty.findAll('a').map((link) => [link.text(), link.attributes('href')])).toEqual([
      ['할 일 담기', '/inbox'],
      ['목표로 시작하기', '/plan'],
    ]);
    wrapper.unmount();
  });
});

describe('기간과 방식', () => {
  beforeEach(() => {
    sequence = 0;
    localStorage.clear();
  });

  it('starts with a fortnight and all three ways, said in one line; the fields are folded away', async () => {
    const [task] = seedTasks(makeTask('기간 확인'));
    let sent: { horizon?: { start: string; end: string }; policies?: string[] } = {};
    server.use(
      http.post('*/api/v1/plans', async ({ request }) => {
        sent = (await request.clone().json()) as typeof sent;
      }),
    );
    const { wrapper, router } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li')).toHaveLength(1));
    expect(wrapper.get('[data-plan-how]').findAll('span').map((part) => part.text())).toEqual([
      expect.stringMatching(/^\d{1,2}월 \d{1,2}일 \(.\) ~ \d{1,2}월 \d{1,2}일 \(.\)$/),
      '방식 3가지',
    ]);
    expect((wrapper.get('[data-plan-options-toggle]').element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['일정안 만들기']);

    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    expect(sent.policies).toEqual(['front_loaded', 'balanced', 'focus_blocked']);
    const days = (Date.parse(sent.horizon?.end ?? '') - Date.parse(sent.horizon?.start ?? '')) / 86_400_000;
    expect(days).toBe(14);
    wrapper.unmount();
  });

  it('reaches at least to the day the latest task is due', async () => {
    const due = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const [task] = seedTasks({ ...makeTask('마감이 먼 일'), dueAt: due });
    let sent: { horizon?: { start: string; end: string } } = {};
    server.use(
      http.post('*/api/v1/plans', async ({ request }) => {
        sent = (await request.clone().json()) as typeof sent;
      }),
    );
    const { wrapper, router } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li')).toHaveLength(1));
    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    expect(Date.parse(sent.horizon?.end ?? '')).toBeGreaterThanOrEqual(Date.parse(due));
    wrapper.unmount();
  });

  it('a way can be left out; with none left the button is held and says why (negative)', async () => {
    const [task] = seedTasks(makeTask('방식 고르기'));
    let sent: { policies?: string[] } = {};
    server.use(
      http.post('*/api/v1/plans', async ({ request }) => {
        sent = (await request.clone().json()) as typeof sent;
      }),
    );
    const { wrapper, router } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li')).toHaveLength(1));
    for (const policy of ['front_loaded', 'balanced', 'focus_blocked']) {
      await wrapper.get(`input[data-policy="${policy}"]`).setValue(false);
    }
    expect(buttonByText(wrapper, '일정안 만들기').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-plan-blocker]').text()).toContain('하나는 골라 주세요');
    await wrapper.get('form').trigger('submit');
    await settle();
    expect(mockDb.plans.size).toBe(0);

    await wrapper.get('input[data-policy="balanced"]').setValue(true);
    expect(wrapper.get('[data-plan-how]').text()).toContain('방식 1가지');
    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    expect(sent.policies).toEqual(['balanced']);
    wrapper.unmount();
  });

  it('offline nothing is made (negative)', async () => {
    const [task] = seedTasks(makeTask('오프라인'));
    const router = testRouter();
    await router.push(`/plan/schedule?taskIds=${task!.id}`);
    await router.isReady();
    const pinia = createPinia();
    useOfflineStore(pinia).setOnline(false);
    const spy = vi.spyOn(plannerClient, 'createPlan');
    const wrapper = mountWithPlugins(PlanScopeView, { router, pinia });
    await settle();
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li')).toHaveLength(1));
    expect(buttonByText(wrapper, '일정안 만들기').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('오프라인이라 지금은 일정안을 만들 수 없어요.');
    await wrapper.get('form').trigger('submit');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('언제 일할 수 있나요? — asked right here when no hours are set (FLOW §2)', () => {
  beforeEach(() => {
    sequence = 0;
    localStorage.clear();
  });

  it('presets paint and clear their hours on the weekly rules, and know when they are on (pure)', () => {
    const evening = AVAILABILITY_PRESETS[0]!;
    const weekend = AVAILABILITY_PRESETS[1]!;
    const rules = applyPreset([], evening);
    expect(rules).toEqual([1, 2, 3, 4, 5].map((weekday) => ({ weekday, startLocal: '19:00', endLocal: '22:00', kind: 'work' })));
    expect(presetActive(rules, evening)).toBe(true);
    expect(presetActive(rules, weekend)).toBe(false);
    // Hours that only cover part of a preset are not "on" (negative).
    expect(presetActive([{ weekday: 1, startLocal: '19:00', endLocal: '22:00', kind: 'work' }], evening)).toBe(false);
    expect(presetActive(applyPreset([], AVAILABILITY_PRESETS[2]!), evening)).toBe(false);
    // Two presets on the same days merge; taking one back leaves the other.
    const both = applyPreset(applyPreset([], AVAILABILITY_PRESETS[2]!), evening);
    expect(presetActive(both, evening) && presetActive(both, AVAILABILITY_PRESETS[2]!)).toBe(true);
    const back = removePreset(both, evening);
    expect(presetActive(back, evening)).toBe(false);
    expect(presetActive(back, AVAILABILITY_PRESETS[2]!)).toBe(true);
    expect(removePreset(rules, evening)).toEqual([]);
  });

  it('with hours already set nothing is asked (negative)', async () => {
    const [task] = seedTasks(makeTask('가용 시간 있음'));
    const { wrapper } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li')).toHaveLength(1));
    await settle();
    expect(wrapper.find('[data-plan-hours]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('asks in place, holds the button until hours are picked, then saves them (If-Match + Idempotency-Key) and makes the plan with one press', async () => {
    mockDb.availability = { ...mockDb.availability, rules: [] };
    const [task] = seedTasks(makeTask('가용 시간 없음'));
    const puts: { ifMatch: string | null; key: string | null; body: { rules: unknown[] } }[] = [];
    const order: string[] = [];
    server.use(
      http.put('*/api/v1/availability', async ({ request }) => {
        order.push('availability');
        puts.push({
          ifMatch: request.headers.get('If-Match'),
          key: request.headers.get('Idempotency-Key'),
          body: (await request.clone().json()) as { rules: unknown[] },
        });
      }),
      http.post('*/api/v1/plans', () => {
        order.push('plan');
      }),
    );
    const { wrapper, router } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.find('[data-plan-hours]').exists()).toBe(true));
    const hours = wrapper.get('[data-plan-hours]');
    expect(hours.get('h2').text()).toBe('언제 일할 수 있나요?');
    expect(hours.get('[data-plan-hours-total]').text()).toBe('아직 고른 시간이 없어요');
    // No link sends the owner to a settings screen to get ready.
    expect(hours.findAll('a')).toHaveLength(0);
    expect(buttonByText(wrapper, '일정안 만들기').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-plan-blocker]').text()).toBe('일할 수 있는 시간을 먼저 알려 주세요.');

    await hours.get('input[data-preset="weekdayEvening"]').setValue(true);
    expect(hours.get('[data-plan-hours-total]').text()).toBe('일주일에 15시간');
    await hours.get('input[data-preset="weekendAfternoon"]').setValue(true);
    expect(hours.get('[data-plan-hours-total]').text()).toBe('일주일에 25시간');
    expect(wrapper.find('[data-plan-blocker]').exists()).toBe(false);
    // Nothing is saved by picking: only the press that makes the plan saves.
    expect(puts).toHaveLength(0);

    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    expect(order).toEqual(['availability', 'plan']);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.ifMatch).toBe('W/"availability:1"');
    expect(puts[0]?.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(puts[0]?.body.rules).toHaveLength(7);
    expect(mockDb.availability.rules).toHaveLength(7);
    // The plan was made against the hours just saved.
    expect([...mockDb.plans.values()][0]?.availabilityVersion).toBe(mockDb.availabilityVersion);
    wrapper.unmount();
  });

  it('a 412 on the hours (changed elsewhere) makes no plan, re-reads them and says so (negative)', async () => {
    mockDb.availability = { ...mockDb.availability, rules: [] };
    const [task] = seedTasks(makeTask('가용 시간 충돌'));
    const createSpy = vi.spyOn(plannerClient, 'createPlan');
    const { wrapper } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.find('[data-plan-hours]').exists()).toBe(true));
    await wrapper.get('input[data-preset="weekdayDay"]').setValue(true);
    // Another device moves the availability version meanwhile.
    mockDb.availabilityVersion += 1;
    mockDb.availability = { ...mockDb.availability, version: mockDb.availabilityVersion };

    await pressCreate(wrapper);
    await vi.waitFor(() => expect(wrapper.find('[data-plan-hours-error]').exists()).toBe(true), { timeout: 5_000 });
    expect(wrapper.get('[data-plan-hours-error]').text()).toContain('다른 곳에서 가용 시간이 바뀌었어요');
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockDb.plans.size).toBe(0);
    expect(mockDb.availability.rules).toEqual([]);
    wrapper.unmount();
  });
});

describe('고정된 일정이 있나요? — offered, never required (FLOW §2)', () => {
  beforeEach(() => {
    sequence = 0;
    localStorage.clear();
  });

  it('with a 약속 in the coming weeks nothing is offered (negative)', async () => {
    const [task] = seedTasks(makeTask('약속 있음'));
    const { wrapper } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.findAll('.scope-list li')).toHaveLength(1));
    await settle();
    expect(mockDb.commitments.size).toBeGreaterThan(0);
    expect(wrapper.find('[data-plan-commitments]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('without any 약속 it offers the planner’s own dialog, and the plan can be made without answering', async () => {
    mockDb.commitments.clear();
    const [task] = seedTasks(makeTask('약속 없음'));
    const { wrapper, router } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.find('[data-plan-commitments]').exists()).toBe(true));
    const offer = wrapper.get('[data-plan-commitments]');
    expect(offer.get('h2').text()).toBe('고정된 일정이 있나요?');
    // Not connected to Google in this state ("not configured"): no link is offered that leads nowhere.
    expect(offer.find('[data-plan-google]').exists()).toBe(false);
    // Offering is not asking: the one filled button is still the next step, and it is pressable.
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['일정안 만들기']);
    expect(buttonByText(wrapper, '일정안 만들기').attributes('disabled')).toBeUndefined();

    await offer.get('[data-plan-commitment-add]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('[data-planner-add-dialog]')).not.toBeNull());
    (document.querySelector('[data-planner-add-dialog] button[aria-label="닫기"]') as HTMLButtonElement).click();
    await settle();

    await pressCreate(wrapper);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('plan-schedule'), { timeout: 5_000 });
    wrapper.unmount();
  });

  it('offers to connect Google Calendar only while one can be connected and is not', async () => {
    const { seedGoogle } = await import('../src/mocks/google');
    mockDb.commitments.clear();
    seedGoogle(mockDb, 'disconnected');
    const [task] = seedTasks(makeTask('구글 연결'));
    const { wrapper } = await mountPicker(`/plan/schedule?taskIds=${task!.id}`);
    await vi.waitFor(() => expect(wrapper.find('[data-plan-google]').exists()).toBe(true));
    expect(wrapper.get('[data-plan-google]').attributes('href')).toBe('/settings/calendar');
    wrapper.unmount();
  });
});
