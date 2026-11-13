import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plannerClient } from '../src/api';
import TaskItem from '../src/components/TaskItem.vue';
import { clearFocusContexts, focusTaskTitle } from '../src/composables/focusContext';
import { setLayoutClock } from '../src/layout/clock';
import {
  INBOX_PROJECT_ID,
  MONTH_TASK_ENGLISH_ID,
  MONTH_TASK_SUMMARY_ID,
  MONTH_TASK_THESIS_ID,
  SAMPLE_PROJECT_ID,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { seedOverviewSessions } from '../src/mocks/overview-seed';
import { server } from '../src/mocks/server';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useOfflineStore } from '../src/stores/offline';
import { useUiStore } from '../src/stores/ui';
import InboxView from '../src/views/InboxView.vue';
import ProjectDetailView from '../src/views/ProjectDetailView.vue';
import ProjectListView from '../src/views/ProjectListView.vue';
import TaskDetailView from '../src/views/TaskDetailView.vue';

/**
 * HOLO-02 인박스, 프로젝트, 작업 상세 in the dashboard system: the quick add
 * as the top field with 말로 적기 folded under it, tasks as a quiet list in a
 * card, projects as cards with what is still open, and the task page in two
 * columns with its blocks and its focus record. (What the lists do — add,
 * rename, complete, delete, the 412 dialog, 말로 적기 itself — is in the
 * earlier suites, which pass unchanged.)
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/projects/:id', name: 'project', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/planner', name: 'planner', component: Stub },
      { path: '/tracker', name: 'tracker', component: Stub },
      { path: '/notes/new', name: 'notes-new', component: Stub },
      { path: '/notes/:id', name: 'notes-detail', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/settings/ai', name: 'ai-settings', component: Stub },
    ],
  });
}

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

const mounted: VueWrapper[] = [];

async function mountView(component: Component, path: string, props: Record<string, unknown> = {}): Promise<Mounted> {
  const router = testRouter();
  await router.push(path);
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(component, {
    props,
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return { wrapper, router, pinia };
}

async function mountTask(taskId: string): Promise<Mounted> {
  const result = await mountView(TaskDetailView, `/tasks/${taskId}`, { id: taskId });
  await vi.waitFor(async () => {
    await flushPromises();
    expect(result.wrapper.find('[data-task-fields]').exists()).toBe(true);
    expect(result.wrapper.find('[data-task-blocks] .skeleton').exists()).toBe(false);
  });
  return result;
}

function compact(node: { text(): string }): string {
  return node.text().replace(/\s+/g, '');
}

function forbidden(): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'no' },
    { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  clearFocusContexts();
  setLayoutClock({ now: () => NOW });
  seedMonth(mockDb);
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setLayoutClock(null);
  document.body.innerHTML = '';
});

describe('인박스 — the quick add on top, 말로 적기 folded under it', () => {
  async function mountInbox(): Promise<Mounted> {
    const result = await mountView(InboxView, '/inbox');
    await vi.waitFor(() => expect(result.wrapper.findAll('.task-item').length).toBeGreaterThan(0));
    return result;
  }

  it('puts the quick add first, in a card, with one disclosure under it that holds 말로 적기', async () => {
    const { wrapper } = await mountInbox();
    const add = wrapper.get('.inbox-add');
    expect(add.classes()).toContain('card');
    expect(add.find('#quick-add-title').exists()).toBe(true);
    const fold = add.get('details[data-task-parse-fold]');
    // Folded until it is asked for (negative: not open by itself).
    expect((fold.element as HTMLDetailsElement).open).toBe(false);
    expect(fold.get('summary').text()).toBe('말로 여러 개 적기');
    expect(wrapper.findAll('details[data-task-parse-fold]')).toHaveLength(1);
    // The existing section is inside it, whole.
    expect(fold.get('[data-testid="task-parse"] h2').text()).toBe('말로 적기');
    expect(fold.find('#task-note').exists()).toBe(true);
    // The quick add comes before the list in the page.
    const order = [...wrapper.element.querySelectorAll('.inbox-add, .task-list')].map((node) => node.className.split(' ').at(-1));
    expect(order).toEqual(['inbox-add', 'task-list']);
    // One filled button: the quick add's.
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['작업 추가']);
  });

  it('still takes the focus on the `n` shortcut’s request', async () => {
    const { wrapper, pinia } = await mountInbox();
    expect(document.activeElement?.id).not.toBe('quick-add-title');
    useUiStore(pinia).requestNewTask();
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('#quick-add-title').element);
  });

  it('lists tasks as one quiet card of rows, with the deadline and its overdue state', async () => {
    const { wrapper } = await mountInbox();
    const list = wrapper.get('ul.task-items');
    expect(list.classes()).toContain('card');
    const rows = wrapper.findAll('.task-item');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const english = rows.find((row) => row.text().includes('영어 회화 과제'));
    if (english === undefined) throw new Error('missing row');
    expect(english.classes()).toContain('task-item--overdue');
    expect(english.get('.task-due').text()).toContain('마감 11월 6일 (금) 오후 6:00');
    // Overdue is the red tag (red is only ever "overdue").
    expect(english.get('.task-due-overdue').classes()).toContain('badge--danger');
    expect(english.get('.task-due-overdue').text()).toBe('지났어요');
    // The title opens the task; the three actions are in the row, each named.
    expect(english.get('a.task-title-link').attributes('href')).toBe(`/tasks/${MONTH_TASK_ENGLISH_ID}`);
    expect(english.findAll('.task-actions button').map((button) => button.attributes('aria-label'))).toEqual([
      '영어 회화 과제 제목 수정',
      '영어 회화 과제 완료로 표시',
      '영어 회화 과제 삭제',
    ]);
    // Not overdue: no tag (negative). Done: struck through, never overdue.
    const slides = rows.find((row) => row.text().includes('세미나 발표 자료'));
    expect(slides?.find('.task-due-overdue').exists()).toBe(false);
    const done = rows.find((row) => row.text().includes('세미나 논문 요약'));
    expect(done?.classes()).toContain('task-item--done');
    expect(done?.classes()).not.toContain('task-item--overdue');
  });

  it('an overdue tag is red on a bare row too, and absent without a deadline (negative)', () => {
    const base = mockDb.tasks.get(MONTH_TASK_ENGLISH_ID);
    if (base === undefined) throw new Error('missing task');
    const past = mount(TaskItem, { props: { task: base } });
    expect(past.get('.task-due-overdue').classes()).toContain('badge--danger');
    const { dueAt: _dueAt, ...withoutDue } = base;
    void _dueAt;
    const plain = mount(TaskItem, { props: { task: withoutDue } });
    expect(plain.find('.task-due').exists()).toBe(false);
    expect(plain.classes()).not.toContain('task-item--overdue');
    past.unmount();
    plain.unmount();
  });
});

describe('프로젝트 — cards with what is still open', () => {
  it('shows each project as a card with its count of open tasks, and the whole card opens it', async () => {
    const { wrapper } = await mountView(ProjectListView, '/projects');
    await vi.waitFor(() => expect(wrapper.findAll('[data-project-open]')).toHaveLength(2));
    const cards = wrapper.findAll('.project-item');
    expect(cards.every((card) => card.classes().includes('card'))).toBe(true);
    expect(cards.map((card) => [card.get('.project-title').text(), compact(card.get('[data-project-open]'))])).toEqual([
      // 3 seeded + 3 of the month in the inbox (the finished one does not count); 2 in the project.
      ['인박스', '6열린작업'],
      ['졸업 논문', '2열린작업'],
    ]);
    expect(wrapper.get(`[data-project="${SAMPLE_PROJECT_ID}"] a.project-link`).attributes('href')).toBe(
      `/projects/${SAMPLE_PROJECT_ID}`,
    );
    expect(wrapper.get(`[data-project="${INBOX_PROJECT_ID}"] a.project-link`).attributes('href')).toBe(
      `/projects/${INBOX_PROJECT_ID}`,
    );
    expect(wrapper.find('.btn--primary').exists()).toBe(false);
  });

  it('counts only tasks that are not done, says 0 for an empty project, and marks an archived one', async () => {
    for (const task of [...mockDb.tasks.values()]) {
      if (task.projectId === SAMPLE_PROJECT_ID) mockDb.tasks.set(task.id, { ...task, status: 'done' });
    }
    const sample = mockDb.projects.get(SAMPLE_PROJECT_ID);
    if (sample === undefined) throw new Error('missing project');
    mockDb.projects.set(sample.id, { ...sample, archived: true });
    const { wrapper } = await mountView(ProjectListView, '/projects');
    await vi.waitFor(() => expect(wrapper.findAll('[data-project-open]')).toHaveLength(2));
    const card = wrapper.get(`[data-project="${SAMPLE_PROJECT_ID}"]`);
    expect(compact(card.get('[data-project-open]'))).toBe('0열린작업');
    expect(card.text()).toContain('보관됨');
    expect(wrapper.get(`[data-project="${INBOX_PROJECT_ID}"]`).text()).not.toContain('보관됨');
  });

  it('shows the names without counts when the task list cannot be read (negative)', async () => {
    server.use(http.get('*/api/v1/tasks', () => forbidden()));
    const { wrapper } = await mountView(ProjectListView, '/projects');
    await vi.waitFor(() => expect(wrapper.findAll('.project-item')).toHaveLength(2));
    await flushPromises();
    expect(wrapper.findAll('[data-project-open]')).toHaveLength(0);
    expect(wrapper.findAll('.project-title').map((title) => title.text())).toEqual(['인박스', '졸업 논문']);
  });
});

describe('프로젝트 상세 — its two views are the system’s segmented control', () => {
  it('switches 작업 and 노트 with one picked at a time, by click and by arrow key', async () => {
    const { wrapper, router } = await mountView(ProjectDetailView, `/projects/${SAMPLE_PROJECT_ID}`, { id: SAMPLE_PROJECT_ID });
    await vi.waitFor(() => expect(wrapper.findAll('.task-item').length).toBe(2));
    const tabs = wrapper.get('[data-project-tabs]');
    expect(tabs.classes()).toContain('segmented');
    expect(tabs.attributes('role')).toBe('tablist');
    const picked = () => tabs.findAll('[role="tab"]').map((tab) => [tab.text(), tab.attributes('aria-selected'), tab.attributes('tabindex')]);
    expect(picked()).toEqual([
      ['작업', 'true', '0'],
      ['노트', 'false', '-1'],
    ]);
    // The paper system's highlighted tab is gone (negative).
    expect(wrapper.find('.tab--active').exists()).toBe(false);
    // The tasks are one card of rows.
    expect(wrapper.get('#project-panel-tasks ul.task-items').classes()).toContain('card');

    await tabs.get('[data-project-tab="notes"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.query['tab']).toBe('notes'));
    await vi.waitFor(() => expect(wrapper.find('#project-panel-notes').exists()).toBe(true));
    expect(picked()).toEqual([
      ['작업', 'false', '-1'],
      ['노트', 'true', '0'],
    ]);
    expect(wrapper.get('#project-panel-notes').classes()).toContain('card');
    expect(wrapper.find('#project-panel-tasks').exists()).toBe(false);

    await tabs.get('[data-project-tab="notes"]').trigger('keydown', { key: 'ArrowLeft' });
    await vi.waitFor(() => expect(router.currentRoute.value.query['tab']).toBeUndefined());
    await vi.waitFor(() => expect(wrapper.find('#project-panel-tasks').exists()).toBe(true));
  });
});

describe('작업 상세 — the task at the left, what belongs to it at the right', () => {
  it('shows the fields in one card: state, deadline and project, and no id or version', async () => {
    seedOverviewSessions(mockDb);
    const { wrapper } = await mountTask(MONTH_TASK_THESIS_ID);
    expect(wrapper.get('h1').text()).toBe('졸업 논문 3장 초고');
    const fields = wrapper.get('[data-task-fields]');
    expect(fields.classes()).toContain('card');
    expect(fields.findAll('dt').map((term) => term.text())).toEqual(['상태', '마감', '프로젝트']);
    expect(fields.text()).toContain('진행 중');
    expect(fields.get('[data-task-due]').text()).toBe('11월 27일 (금) 오후 6:00');
    await vi.waitFor(() => expect(fields.get('[data-task-project]').text()).toBe('졸업 논문'));
    expect(fields.get('[data-task-project]').attributes('href')).toBe(`/projects/${SAMPLE_PROJECT_ID}`);
    // Developer-facing detail is not on the page at all.
    const text = wrapper.text();
    expect(text).not.toContain(MONTH_TASK_THESIS_ID);
    expect(text).not.toContain(SAMPLE_PROJECT_ID);
    expect(text).not.toMatch(/버전|version/i);
    // Two columns: the task, and its three related cards.
    expect(wrapper.findAll('.task-page-side > .card')).toHaveLength(3);
    expect(wrapper.findAll('.task-page-side h2').map((heading) => heading.text())).toEqual(['일정', '집중 기록', '연결된 노트']);
  });

  it('lists the blocks to come, counts the rest and the ones finished', async () => {
    const { wrapper } = await mountTask(MONTH_TASK_THESIS_ID);
    const blocks = wrapper.get('[data-task-blocks]');
    const rows = blocks.findAll('[data-task-block]');
    expect(rows.map((row) => row.get('.task-related-when').text())).toEqual([
      '11월 15일 (일) 오후 2:00~4:00',
      '11월 18일 (수) 오후 7:00~8:00',
      '11월 19일 (목) 오후 8:30~10:00',
      '11월 20일 (금) 오후 7:00~8:00',
    ]);
    expect(rows[0]?.text()).toContain('2시간');
    expect(blocks.text()).toContain('그 뒤로 7개 더 있어요');
    expect(blocks.get('[data-task-blocks-done]').text()).toBe('지난 2주 동안 끝낸 블록 4개');
    expect(blocks.get('a.icon-link').attributes('href')).toBe('/planner');
    expect(blocks.get('a.icon-link').attributes('aria-label')).toBe('플래너 열기');
  });

  it('adds up the focus record of the last four weeks and lists the newest sessions', async () => {
    seedOverviewSessions(mockDb);
    const { wrapper } = await mountTask(MONTH_TASK_THESIS_ID);
    const sessions = wrapper.get('[data-task-sessions]');
    // 80 + 75 + 110 + 85 + 62 minutes.
    expect(compact(sessions.get('.duration-numeral'))).toBe('6시간52분');
    expect(sessions.text()).toContain('최근 4주 집중 시간 · 세션 5개');
    const rows = sessions.findAll('[data-task-session]');
    expect(rows).toHaveLength(5);
    expect(rows[0]?.text()).toContain('11월 14일 (토)');
    expect(rows[0]?.text()).toContain('오전 10:05~11:12');
    expect(rows[0]?.text()).toContain('1시간 2분');
    expect(rows[0]?.text()).toContain('완료');
    expect(sessions.get('a.icon-link').attributes('href')).toBe('/tracker');
  });

  it('says so when the task has no blocks to come and no focus record (negative)', async () => {
    const { wrapper } = await mountTask(MONTH_TASK_ENGLISH_ID);
    expect(wrapper.get('[data-task-blocks-empty]').text()).toContain('앞으로 잡힌 블록이 없어요.');
    expect(wrapper.findAll('[data-task-block]')).toHaveLength(0);
    // Its two finished blocks (11-03, 11-05) are still counted.
    expect(wrapper.get('[data-task-blocks-done]').text()).toBe('지난 2주 동안 끝낸 블록 2개');
    expect(wrapper.get('[data-task-sessions-empty]').text()).toContain('최근 4주 동안 집중한 기록이 없어요.');
    expect(wrapper.find('[data-task-session]').exists()).toBe(false);
    // Overdue and still open: the red tag beside its deadline.
    expect(wrapper.get('[data-task-due]').text()).toContain('지났어요');
  });

  it('starts a focus session on the task’s next block with the page’s one filled button', async () => {
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountTask(MONTH_TASK_THESIS_ID);
    const primaries = wrapper.findAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.text()).toBe('집중 시작');
    await wrapper.get('[data-task-start]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    const nextBlock = mockDb.extraScheduleBlocks.find(
      (block) => block.taskId === MONTH_TASK_THESIS_ID && block.startAt === '2026-11-15T05:00:00.000Z',
    );
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: MONTH_TASK_THESIS_ID, blockId: nextBlock?.id });
    // Focus is given the task's name, not asked to show an id.
    expect(focusTaskTitle(mockDb.user.id, MONTH_TASK_THESIS_ID)).toBe('졸업 논문 3장 초고');
  });

  it('starts without a block when the task has none to come', async () => {
    const create = vi.spyOn(plannerClient, 'createSession');
    const { wrapper, router } = await mountTask(MONTH_TASK_ENGLISH_ID);
    await wrapper.get('[data-task-start]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('focus'));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ taskId: MONTH_TASK_ENGLISH_ID });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('blockId');
  });

  it('offers no start for a finished task, a way back while a session runs, and nothing to start offline (negative)', async () => {
    const done = await mountTask(MONTH_TASK_SUMMARY_ID);
    expect(done.wrapper.find('[data-task-start]').exists()).toBe(false);
    expect(done.wrapper.findAll('.btn--primary')).toHaveLength(0);
    done.wrapper.unmount();
    mounted.splice(mounted.indexOf(done.wrapper), 1);

    const offline = await mountTask(MONTH_TASK_THESIS_ID);
    useOfflineStore(offline.pinia).setOnline(false);
    await nextTick();
    expect(offline.wrapper.get('[data-task-start]').attributes('disabled')).toBeDefined();
    offline.wrapper.unmount();
    mounted.splice(mounted.indexOf(offline.wrapper), 1);

    seedOverviewSessions(mockDb, { running: true });
    const running = await mountTask(MONTH_TASK_THESIS_ID);
    await vi.waitFor(() => expect(running.wrapper.find('[data-task-resume]').exists()).toBe(true));
    expect(running.wrapper.find('[data-task-start]').exists()).toBe(false);
    expect(running.wrapper.get('[data-task-resume]').text()).toBe('이어서 보기');
  });

  it('keeps the task on the page when its blocks and sessions cannot be read, and reads them on retry', async () => {
    let failing = true;
    server.use(
      http.get(/\/api\/v1\/schedule-blocks(\?.*)?$/, () => (failing ? forbidden() : HttpResponse.json({ items: [], nextCursor: null }))),
    );
    const { wrapper } = await mountTask(MONTH_TASK_THESIS_ID);
    expect(wrapper.get('h1').text()).toBe('졸업 논문 3장 초고');
    await vi.waitFor(() => expect(wrapper.get('[data-task-blocks] [role="alert"]').text()).toContain('일정과 집중 기록을 불러오지 못했어요.'));
    expect(wrapper.find('[data-task-blocks-empty]').exists()).toBe(false);
    failing = false;
    await wrapper.get('[data-task-related-retry]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-task-blocks-empty]').exists()).toBe(true));
  });
});
