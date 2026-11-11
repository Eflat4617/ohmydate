import type { VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { newActionId, plannerClient, type Plan, type Task, type User, type WorkSession } from '../src/api';
import NotificationsPanel from '../src/components/NotificationsPanel.vue';
import { setLayoutClock } from '../src/layout/clock';
import {
  SEED_COMMITMENT_ID,
  SEED_TASK_TITLE,
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  mockDb,
  seedTodayRisk,
} from '../src/mocks/db';
import { NOTE_MEETING_ID } from '../src/mocks/notes-seed';
import { REPLAN_PENDING_ID, seedReplanScenario } from '../src/mocks/replan';
import { FEEDBACK_IDS } from '../src/mocks/replan-seed';
import { server } from '../src/mocks/server';
import { useAuthStore } from '../src/stores/auth';
import { useSessionStore } from '../src/stores/session';
import { buttonInElement, dialogByTitle, setValue } from './m6-03-notes-utils';
import { IN_REVIEW_WINDOW, startedSession, useTestClock } from './m6-layout-utils';
import {
  createOwnerSwitchStage,
  sweepOwnerSwitch,
  type HeldResponses,
  type OwnerSwitchCase,
  type OwnerSwitchStage,
} from './support/ownerSwitch';

/**
 * FU-77 — the owner-isolation regression sweep (ADR-023 guardrail).
 *
 * One scenario for every screen that writes asynchronously: owner A starts
 * the action, its response is held, another user signs in, the response is
 * released. Whatever the screen, nothing of A's action may then reach B: no
 * key in B's storage namespace, no toast, no navigation, no announcement or
 * dialog, no cache entry, no mutating request with B's credentials. Each case
 * also runs without the switch, to show the action is not a no-op.
 *
 * A new screen that talks to the API must add a case here (or an exemption
 * with a reason): the manifest test at the end fails until it does.
 */

function buttonByText(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label) || item.attributes('aria-label')?.includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

const CASES: OwnerSwitchCase[] = [
  {
    name: 'availability: save',
    covers: ['src/views/AvailabilityView.vue'],
    path: '/settings/availability',
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.find('form.settings-form').exists()).toBe(true));
    },
    hold: { method: 'PUT', path: '/availability' },
    act: async (wrapper) => {
      await wrapper.get('form.settings-form').trigger('submit');
    },
  },
  {
    name: 'commitments: create',
    covers: ['src/views/CommitmentsView.vue'],
    path: '/commitments',
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.find('#commitment-title').exists()).toBe(true));
    },
    hold: { method: 'POST', path: '/commitments' },
    act: async (wrapper) => {
      await wrapper.get('#commitment-title').setValue('A-private-commitment');
      await wrapper.get('form.commitment-editor').trigger('submit');
    },
    markers: ['A-private-commitment'],
  },
  {
    name: 'commitments: delete',
    covers: ['src/views/CommitmentsView.vue'],
    path: '/commitments',
    seed: () => {
      expect(mockDb.commitments.has(SEED_COMMITMENT_ID)).toBe(true);
    },
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.findAll('.commitment-list li').length).toBeGreaterThan(0));
    },
    hold: { method: 'DELETE', path: '/commitments/' },
    act: async (wrapper) => {
      await buttonByText(wrapper.get('.commitment-list') as unknown as VueWrapper, '삭제').trigger('click');
    },
  },
  {
    name: 'inbox: quick add',
    covers: ['src/views/InboxView.vue', 'src/composables/useTaskActions.ts'],
    path: '/inbox',
    ready: inboxReady,
    hold: { method: 'POST', path: '/tasks' },
    act: async (wrapper) => {
      await wrapper.get('.quick-add-input').setValue('A-private-task');
      await wrapper.get('form.quick-add').trigger('submit');
    },
    markers: ['A-private-task'],
  },
  {
    name: 'inbox: rename',
    covers: ['src/components/TaskList.vue', 'src/composables/useTaskActions.ts'],
    path: '/inbox',
    ready: inboxReady,
    hold: { method: 'PATCH', path: '/tasks/' },
    act: async (wrapper) => {
      await buttonByText(wrapper, `${SEED_TASK_TITLE} 제목 수정`).trigger('click');
      await wrapper.get('.inline-edit input').setValue('A-private-rename');
      await wrapper.get('form.inline-edit').trigger('submit');
    },
    markers: ['A-private-rename'],
  },
  {
    name: 'inbox: complete',
    covers: ['src/components/TaskList.vue', 'src/composables/useTaskActions.ts'],
    path: '/inbox',
    ready: inboxReady,
    hold: { method: 'POST', path: ':complete' },
    act: async (wrapper) => {
      await buttonByText(wrapper, `${SEED_TASK_TITLE} 완료로 표시`).trigger('click');
    },
  },
  {
    name: 'inbox: rename hits a version conflict',
    covers: ['src/components/TaskList.vue', 'src/composables/useTaskActions.ts'],
    path: '/inbox',
    ready: inboxReady,
    // The 412 itself is delivered; the follow-up read of the latest task is what is held.
    hold: { method: 'GET', path: /\/tasks\/[0-9a-f-]{36}$/ },
    act: async (wrapper) => {
      const task = [...mockDb.tasks.values()].find((item) => item.title === SEED_TASK_TITLE);
      if (task === undefined) throw new Error('seed task missing');
      await buttonByText(wrapper, `${SEED_TASK_TITLE} 제목 수정`).trigger('click');
      await wrapper.get('.inline-edit input').setValue('A-private-rename');
      // Another device changed the task: the rename will answer 412.
      task.version += 1;
      task.title = 'A-private-server-title';
      await wrapper.get('form.inline-edit').trigger('submit');
    },
    markers: ['A-private-server-title'],
  },
  {
    name: 'today: accept the plan',
    covers: ['src/views/TodayView.vue'],
    path: '/today',
    seed: useTodayClock,
    ready: todayReady,
    hold: { method: 'POST', path: '/today:accept' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '오늘 계획 수락').trigger('click');
    },
  },
  {
    name: 'today: start focus',
    covers: ['src/views/TodayView.vue', 'src/stores/session.ts'],
    path: '/today',
    seed: useTodayClock,
    ready: todayReady,
    hold: { method: 'POST', path: /\/sessions$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper.findAll('.today-card')[0] as unknown as VueWrapper, '집중 시작').trigger('click');
    },
  },
  {
    name: 'today: reschedule preview',
    covers: ['src/views/TodayView.vue'],
    path: '/today',
    seed: useTodayClock,
    ready: todayReady,
    hold: { method: 'POST', path: '/today:reschedule' },
    act: async (wrapper) => {
      await buttonByText(wrapper.findAll('.today-card')[0] as unknown as VueWrapper, '재배치').trigger('click');
    },
  },
  {
    name: 'today: approve a proposal',
    covers: ['src/views/TodayView.vue'],
    path: '/today',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await todayReady(wrapper);
      await buttonByText(wrapper.findAll('.today-card')[0] as unknown as VueWrapper, '재배치').trigger('click');
      await vi.waitFor(() => expect(wrapper.findAll('button').some((item) => item.text().includes('승인'))).toBe(true));
    },
    hold: { method: 'POST', path: /\/today\/proposals\/.+:approve$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper, '승인').trigger('click');
    },
  },
  {
    name: 'focus: save the session review',
    covers: ['src/views/FocusView.vue', 'src/layout/localSignals.ts'],
    path: async (stage) => `/focus/${(await finishedSession(stage)).id}`,
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.text()).toContain('이번 세션은 어땠나요?'));
      await wrapper.findAll('input[type="radio"]')[1]?.setValue(true);
    },
    hold: { method: 'POST', path: '/review' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '회고 저장').trigger('click');
    },
  },
  {
    name: 'focus: pause',
    covers: ['src/views/FocusView.vue', 'src/session/focusQueue.ts', 'src/stores/session.ts'],
    path: async (stage) => `/focus/${(await runningSession(stage)).id}`,
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
      await vi.waitFor(() => expect(buttonByText(wrapper, '일시정지').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: ':pause' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '일시정지').trigger('click');
    },
  },
  {
    name: 'focus: start from a task link',
    covers: ['src/views/FocusView.vue', 'src/session/clientId.ts'],
    path: `/focus/new?taskId=${TODAY_TASK_ONE_ID}&blockId=${TODAY_BLOCK_ONE_ID}`,
    // The view starts the session as soon as it mounts, so the hold must already be in place.
    seed: (stage) => {
      startHold = stage.hold({ method: 'POST', path: /\/sessions$/ });
    },
    ready: async () => {
      await startHold?.arrived();
    },
    act: async () => {
      startHold?.release();
    },
  },
  {
    name: 'layout: acknowledge the deadline risk (clicked after the switch)',
    covers: ['src/components/layout/DeadlineRiskPanel.vue', 'src/layout/localSignals.ts', 'src/stores/layout.ts'],
    path: '/today',
    frame: true,
    seed: () => {
      useTestClock();
      seedTodayRisk(mockDb);
    },
    ready: async () => {
      await vi.waitFor(() => expect(panelButton('deadline-risk', '확인했어요')).toBeDefined());
    },
    act: async () => {
      panelButton('deadline-risk', '확인했어요')?.click();
    },
  },
  {
    name: 'layout: skip the review prompt (clicked after the switch)',
    covers: ['src/components/layout/ReviewPromptPanel.vue', 'src/layout/localSignals.ts', 'src/stores/layout.ts'],
    path: '/today',
    frame: true,
    seed: async (stage) => {
      useTestClock(IN_REVIEW_WINDOW);
      const session = await startedSession(stage.pinia);
      const ended = new Date(IN_REVIEW_WINDOW - 60_000).toISOString();
      const done = await plannerClient.completeSession(session.id, ended, newActionId('complete'), session.version);
      useSessionStore(stage.pinia).remember({ ...done, endedAt: ended });
    },
    ready: async () => {
      await vi.waitFor(() => expect(panelButton('review-prompt', '오늘은 건너뛰기')).toBeDefined());
    },
    act: async () => {
      panelButton('review-prompt', '오늘은 건너뛰기')?.click();
    },
  },
  {
    name: 'replan: approve a proposal',
    covers: ['src/views/ReplanProposalView.vue'],
    path: `/replan/${REPLAN_PENDING_ID}`,
    seed: () => {
      seedReplanScenario(mockDb);
    },
    ready: replanReady,
    hold: { method: 'POST', path: ':approve' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '승인').trigger('click');
    },
  },
  {
    name: 'replan: reject a proposal',
    covers: ['src/views/ReplanProposalView.vue'],
    path: `/replan/${REPLAN_PENDING_ID}`,
    seed: () => {
      seedReplanScenario(mockDb);
    },
    ready: async (wrapper) => {
      await replanReady(wrapper);
      await buttonByText(wrapper, '거절').trigger('click');
      await vi.waitFor(() => expect(document.querySelector('.replan-reject-dialog')).not.toBeNull());
    },
    hold: { method: 'POST', path: ':reject' },
    act: async () => {
      [...document.querySelectorAll<HTMLButtonElement>('.replan-reject-dialog button')]
        .find((item) => item.textContent?.includes('거절하기'))
        ?.click();
    },
  },
  {
    name: 'replan: request a new proposal',
    covers: ['src/components/ReplanRequestButton.vue', 'src/composables/useReplanRequest.ts', 'src/views/ReplanListView.vue'],
    path: '/replan',
    seed: () => {
      seedReplanScenario(mockDb);
    },
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.findAll('button').some((item) => item.text().includes('재계획 요청'))).toBe(true));
      await vi.waitFor(() => expect(buttonByText(wrapper, '재계획 요청').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: '/replan-proposals:request' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '재계획 요청').trigger('click');
    },
  },
  {
    name: 'notes: save an edit',
    covers: ['src/components/notes/NoteEditor.vue', 'src/views/NotesView.vue', 'src/composables/notes.ts'],
    path: `/notes/${NOTE_MEETING_ID}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await noteReady(wrapper);
      await setValue(wrapper.get('[data-note-body]'), 'A-private-body');
    },
    hold: { method: 'PATCH', path: '/documents/' },
    act: async (wrapper) => {
      await wrapper.get('[data-note-save]').trigger('click');
    },
    markers: ['A-private-body'],
  },
  {
    name: 'notes: create',
    covers: ['src/components/notes/NoteEditor.vue', 'src/views/NotesView.vue', 'src/composables/notes.ts'],
    path: '/notes/new',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.find('[data-note-title]').exists()).toBe(true));
      await setValue(wrapper.get('[data-note-title]'), 'A-private-note');
      await setValue(wrapper.get('[data-note-body]'), 'A-private-body');
    },
    hold: { method: 'POST', path: /\/documents$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-note-save]').trigger('click');
    },
    markers: ['A-private-note', 'A-private-body'],
  },
  {
    name: 'notes: delete',
    covers: ['src/components/notes/NoteEditor.vue', 'src/views/NotesView.vue', 'src/composables/notes.ts'],
    path: `/notes/${NOTE_MEETING_ID}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await noteReady(wrapper);
      await wrapper.get('[data-note-delete]').trigger('click');
      await vi.waitFor(() => expect(() => dialogByTitle('노트를 삭제할까요?')).not.toThrow());
    },
    hold: { method: 'DELETE', path: '/documents/' },
    act: async () => {
      buttonInElement(dialogByTitle('노트를 삭제할까요?'), '삭제').click();
    },
  },
  {
    name: 'notes: link to a project',
    covers: ['src/components/notes/NoteLinks.vue', 'src/components/notes/LinkPickerDialog.vue', 'src/composables/notes.ts'],
    path: `/notes/${NOTE_MEETING_ID}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await noteReady(wrapper);
      await wrapper.get('[data-note-link-add]').trigger('click');
      await vi.waitFor(() => expect(() => dialogByTitle('연결할 대상 고르기')).not.toThrow());
      const picker = dialogByTitle('연결할 대상 고르기');
      await vi.waitFor(() => expect(picker.querySelector('[data-link-option] input:not([disabled])')).not.toBeNull());
      picker.querySelector<HTMLInputElement>('[data-link-option] input:not([disabled])')?.click();
    },
    hold: { method: 'POST', path: '/links' },
    act: async () => {
      buttonInElement(dialogByTitle('연결할 대상 고르기'), '연결').click();
    },
  },
  {
    name: 'wizard: create a planning session (AI wait)',
    covers: ['src/views/PlanningWizardView.vue', 'src/composables/useAiWait.ts'],
    path: '/plan/new',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.find('#wizard-title').exists()).toBe(true));
      await wrapper.get('#wizard-title').setValue('A-private-goal');
      await wrapper.get('#wizard-description').setValue('A-private-description');
    },
    hold: { method: 'POST', path: /\/intake-sessions$/ },
    act: async (wrapper) => {
      await wrapper.get('form').trigger('submit');
    },
    markers: ['A-private-goal', 'A-private-description'],
  },
  {
    name: 'plans: generate candidates',
    covers: ['src/views/PlanNewView.vue'],
    path: () => `/plans/new?taskIds=${seedTaskId()}`,
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.text()).toContain('작업 1개'));
    },
    hold: { method: 'POST', path: /\/plans$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper, '후보 만들기').trigger('click');
    },
  },
  {
    name: 'plans: approve a candidate',
    covers: ['src/views/PlanComparisonView.vue'],
    path: async () => `/plans/${(await createPlan()).id}`,
    ready: planReady,
    hold: { method: 'POST', path: /\/candidates\/[^/]+:approve$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    },
  },
  {
    name: 'plans: preview a keyboard edit',
    covers: ['src/views/PlanComparisonView.vue'],
    path: async () => `/plans/${(await createPlan()).id}`,
    ready: planReady,
    hold: { method: 'POST', path: ':preview-edit' },
    act: async (wrapper) => {
      await wrapper.findAll('.calendar-block')[0]?.trigger('keydown', { key: 'ArrowDown' });
    },
  },
  {
    name: 'patterns: exclude a record',
    covers: ['src/views/PatternsView.vue'],
    path: '/patterns',
    ready: patternsReady,
    hold: { method: 'PATCH', path: '/estimation/feedback/' },
    act: async (wrapper) => {
      await wrapper.get(`[data-feedback-id="${FEEDBACK_IDS.one}"] [data-include]`).trigger('change');
    },
  },
  {
    name: 'patterns: reset everything',
    covers: ['src/views/PatternsView.vue'],
    path: '/patterns',
    ready: async (wrapper) => {
      await patternsReady(wrapper);
      await wrapper.get('[data-reset-all]').trigger('click');
      await vi.waitFor(() => expect(document.querySelector('[data-reset-confirm]')).not.toBeNull());
    },
    hold: { method: 'POST', path: '/estimation:reset' },
    act: async () => {
      document.querySelector<HTMLButtonElement>('[data-reset-confirm]')?.click();
    },
  },
  {
    name: 'task: promote the description to a note',
    covers: ['src/views/TaskDetailView.vue', 'src/composables/notes.ts'],
    path: () => {
      const task = seedTask();
      task.description = '<p>A-private-description</p>';
      task.version += 1;
      return `/tasks/${task.id}`;
    },
    seed: useTodayClock,
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.find('[data-task-promote]').exists()).toBe(true));
      await vi.waitFor(() => expect(wrapper.get('[data-task-promote]').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: ':promote-description' },
    act: async (wrapper) => {
      await wrapper.get('[data-task-promote]').trigger('click');
    },
  },
  {
    name: 'notifications: a poll answered late',
    covers: ['src/notifications/useNotifications.ts', 'src/components/NotificationsPanel.vue'],
    // The panel polls as soon as it mounts, so the hold must already be in place.
    mount: (stage) => {
      startHold = stage.hold({ method: 'GET', path: '/notifications' });
      return stage.mount(NotificationsPanel, { props: { open: true } });
    },
    ready: async () => {
      await startHold?.arrived();
    },
    act: async () => {
      startHold?.release();
    },
    markers: ['곧 마감되는 작업이 있어요'],
  },
  {
    name: 'notifications: dismiss',
    covers: ['src/notifications/useNotifications.ts', 'src/components/NotificationsPanel.vue'],
    mount: (stage) => stage.mount(NotificationsPanel, { props: { open: true } }),
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.findAll('.notification-item').length).toBeGreaterThan(0));
    },
    hold: { method: 'POST', path: ':dismiss' },
    act: async (wrapper) => {
      await buttonByText(wrapper.findAll('.notification-item')[0] as unknown as VueWrapper, '지우기').trigger('click');
    },
  },
  {
    name: 'AI settings: grant consent',
    covers: ['src/views/LlmSettingsView.vue', 'src/stores/auth.ts'],
    path: '/settings/ai',
    seed: async (stage) => {
      mockDb.user = { ...mockDb.user, llmProvider: 'deepseek' };
      await useAuthStore(stage.pinia).loadCurrent();
      server.use(
        http.patch('*/api/v1/me/settings', () => {
          const next: User = {
            ...mockDb.user,
            version: mockDb.user.version + 1,
            llm: { consent: { granted: true, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } },
          };
          return HttpResponse.json(next as unknown as Record<string, unknown>, { headers: { ETag: `W/"${next.version}"` } });
        }),
      );
    },
    ready: async (wrapper) => {
      await vi.waitFor(() => expect(wrapper.findAll('button').some((item) => item.text().includes('AI 계획 도움 켜기'))).toBe(true));
    },
    hold: { method: 'PATCH', path: '/me/settings' },
    act: async (wrapper) => {
      await buttonByText(wrapper, 'AI 계획 도움 켜기').trigger('click');
    },
  },
];

function seedTask(): Task {
  const task = [...mockDb.tasks.values()].find((item) => item.title === SEED_TASK_TITLE);
  if (task === undefined) throw new Error('seed task missing');
  return task;
}

function seedTaskId(): string {
  return seedTask().id;
}

function createPlan(): Promise<Plan> {
  return plannerClient.createPlan(
    {
      scope: { taskIds: [seedTaskId()] },
      horizon: { start: '2026-11-11T00:00:00.000Z', end: '2026-11-25T00:00:00.000Z' },
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
    },
    newActionId('plan-create'),
  );
}

async function planReady(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.findAll('.candidate-card').length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(wrapper.findAll('.calendar-block').length).toBeGreaterThan(0));
}

async function patternsReady(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.find(`[data-feedback-id="${FEEDBACK_IDS.one}"]`).exists()).toBe(true));
}

async function noteReady(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.find('[data-note-links]').exists()).toBe(true));
  await vi.waitFor(() => expect((wrapper.get('[data-note-title]').element as HTMLInputElement).value).toBe('발표 준비 회의'));
}

async function replanReady(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.findAll('.replan-change').length).toBeGreaterThan(0));
}

let startHold: HeldResponses | null = null;

function panelButton(panel: string, label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>(`[data-panel="${panel}"] button`)].find((item) =>
    item.textContent?.includes(label),
  );
}

async function runningSession(stage: OwnerSwitchStage): Promise<WorkSession> {
  const session = await plannerClient.createSession(
    { taskId: TODAY_TASK_ONE_ID, blockId: TODAY_BLOCK_ONE_ID, clientStartedAt: new Date().toISOString(), clientId: 'sweep' },
    newActionId('session'),
  );
  useSessionStore(stage.pinia).remember(session);
  return session;
}

async function finishedSession(stage: OwnerSwitchStage): Promise<WorkSession> {
  const session = await runningSession(stage);
  const done = await plannerClient.completeSession(session.id, new Date().toISOString(), newActionId('complete'), session.version);
  useSessionStore(stage.pinia).remember(done);
  return done;
}

function useTodayClock(): void {
  useTestClock();
}

async function todayReady(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.findAll('.today-card').length).toBeGreaterThan(0));
}

async function inboxReady(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.text()).toContain(SEED_TASK_TITLE));
}

afterEach(() => {
  setLayoutClock(null);
  startHold = null;
});

for (const testCase of CASES) sweepOwnerSwitch(testCase);

describe('inbox: delete with undo — the timer belongs to whoever clicked', () => {
  let stage: OwnerSwitchStage | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await stage?.dispose();
    stage = null;
  });

  async function clickDelete(): Promise<OwnerSwitchStage> {
    const created = await createOwnerSwitchStage();
    const wrapper = await created.mountView('/inbox');
    await inboxReady(wrapper);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await buttonByText(wrapper, `${SEED_TASK_TITLE} 삭제`).trigger('click');
    return created;
  }

  it('control: the delete is sent when the undo window closes', async () => {
    stage = await clickDelete();
    await vi.advanceTimersByTimeAsync(6_100);
    await vi.waitFor(() => expect(stage?.requests.some((request) => request.method === 'DELETE')).toBe(true));
  });

  it('switch: another user signed in during the undo window — nothing is sent, shown or cached', async () => {
    stage = await clickDelete();
    await stage.switchOwner();
    await vi.advanceTimersByTimeAsync(6_100);
    await stage.settle();
    expect(stage.requests.filter((request) => request.method === 'DELETE')).toEqual([]);
    stage.expectNoLeak();
  });
});
