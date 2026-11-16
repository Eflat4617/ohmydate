import type { VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { defineComponent, h, onUnmounted } from 'vue';
import {
  newActionId,
  plannerClient,
  type IntakeSession,
  type Plan,
  type Task,
  type User,
  type WorkSession,
} from '../../src/api';
import LlmConsentDialog from '../../src/components/LlmConsentDialog.vue';
import CaptureBar from '../../src/components/capture/CaptureBar.vue';
import FirstRunGuide from '../../src/components/FirstRunGuide.vue';
import { useFirstRun } from '../../src/composables/firstRun';
import { seedNewOwner } from '../../src/mocks/first-run-seed';
import NotificationsPanel from '../../src/components/NotificationsPanel.vue';
import WizardNotesPanel from '../../src/components/notes/WizardNotesPanel.vue';
import { setTopLevelNavigator } from '../../src/composables/useGoogleCalendar';
import { setLayoutClock } from '../../src/layout/clock';
import {
  SEED_COMMITMENT_ID,
  SEED_TASK_TITLE,
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  mockDb,
  seedTodayRisk,
} from '../../src/mocks/db';
import { useUiStore } from '../../src/stores/ui';
import { seedGoogle } from '../../src/mocks/google';
import { NOTE_MEETING_ID } from '../../src/mocks/notes-seed';
import { REPLAN_PENDING_ID, seedReplanScenario } from '../../src/mocks/replan';
import { FEEDBACK_IDS } from '../../src/mocks/replan-seed';
import { server } from '../../src/mocks/server';
import { currentOwnerId } from '../../src/session/ownerEpoch';
import { useAuthStore } from '../../src/stores/auth';
import { useLlmConsentStore } from '../../src/stores/llmConsent';
import { useSessionStore } from '../../src/stores/session';
import { buttonInElement, dialogByTitle, setValue } from '../m6-03-notes-utils';
import { IN_REVIEW_WINDOW, startedSession, useTestClock } from '../m6-layout-utils';
import {
  OWNER_B,
  sweepOwnerSwitch,
  until,
  type HeldResponses,
  type OwnerSwitchCase,
  type OwnerSwitchStage,
} from './ownerSwitch';

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

export function buttonByText(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label) || item.attributes('aria-label')?.includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

/** The consent dialog exactly as AppShell hosts it (FU-91). */
const ConsentHost = defineComponent({
  setup() {
    const consent = useLlmConsentStore();
    onUnmounted(consent.attachHost());
    return () => h(LlmConsentDialog, { open: consent.open, onClose: () => consent.closed() });
  },
});

/** The start guide as AppShell hosts it (HOLO-04): open, for an owner who still has everything to do. */
const FirstRunHost = defineComponent({
  setup() {
    const guide = useFirstRun();
    const ui = useUiStore();
    ui.setFirstRun(true);
    return () => (ui.firstRunOpen ? h(FirstRunGuide, { guide }) : null);
  },
});

/** A brand-new owner, signed in: no hours, no 약속, the AI question unanswered. */
async function seedFirstRun(stage: OwnerSwitchStage): Promise<void> {
  seedGoogle(mockDb, 'disconnected');
  seedNewOwner(mockDb);
  await useAuthStore(stage.pinia).loadCurrent();
}

/** Where the connect case's page would have gone, and who was signed in then (the top-level navigation seam). */
const googleNavigations: { readonly url: string; readonly owner: string | null }[] = [];

/** 플래너 · 약속: the list is read, and 고치기 of the first own row opens the planner's dialog on it. */
async function openCommitmentEditor(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.find('[data-planner-list] [data-commitment-edit]').exists()).toBe(true));
  await until(() => expect(wrapper.get('[data-commitment-edit]').attributes('disabled')).toBeUndefined());
  await wrapper.get('[data-commitment-edit]').trigger('click');
  await until(() => expect(wrapper.find('[data-planner-edit] #planner-commitment-title').exists()).toBe(true));
}

/** The capture bar as the phone's sheet holds it: its line and its panel are on screen. */
function mountCaptureBar(stage: OwnerSwitchStage): VueWrapper {
  return stage.mount(CaptureBar, { props: { variant: 'sheet' } });
}

async function captureReady(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.find('[data-capture-input]').exists()).toBe(true));
  await until(() => expect(wrapper.find('[data-capture-panel]').exists()).toBe(true));
}

/** 플래너: 약속 추가 opens the dialog whose top half is 말로 적기. */
async function openCommitmentAdd(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.find('[data-planner-add]').exists()).toBe(true));
  await until(() => expect(wrapper.get('[data-planner-add]').attributes('disabled')).toBeUndefined());
  await wrapper.get('[data-planner-add]').trigger('click');
  await until(() => expect(wrapper.find('#commitment-note').exists()).toBe(true));
}

export const OWNER_SWITCH_CASES: OwnerSwitchCase[] = [
  {
    name: 'availability: save',
    covers: ['src/components/settings/AvailabilitySettings.vue'],
    path: '/settings/availability',
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('form.settings-form').exists()).toBe(true));
    },
    hold: { method: 'PUT', path: '/availability' },
    act: async (wrapper) => {
      await wrapper.get('form.settings-form').trigger('submit');
    },
  },
  // HOLO-04: 약속 is the planner's. Its list view (`?view=list`) opens the
  // planner's dialog on a 약속: changing it and removing it. (Adding one is
  // the "planner: add a 약속 from the dialog" case below.)
  {
    name: 'planner: change a 약속 from its row',
    covers: ['src/components/planner/CommitmentAddDialog.vue'],
    path: '/planner?view=list',
    seed: () => {
      expect(mockDb.commitments.has(SEED_COMMITMENT_ID)).toBe(true);
    },
    ready: openCommitmentEditor,
    hold: { method: 'PATCH', path: '/commitments/' },
    act: async (wrapper) => {
      await wrapper.get('#planner-commitment-title').setValue('A-private-commitment');
      await wrapper.get('[data-planner-add-manual]').trigger('submit');
    },
    markers: ['A-private-commitment'],
  },
  {
    name: 'planner: delete a 약속 from its row',
    covers: ['src/components/planner/CommitmentAddDialog.vue'],
    path: '/planner?view=list',
    seed: () => {
      expect(mockDb.commitments.has(SEED_COMMITMENT_ID)).toBe(true);
    },
    ready: async (wrapper) => {
      await openCommitmentEditor(wrapper);
      await wrapper.get('[data-planner-delete]').trigger('click');
      await until(() => expect(wrapper.find('[data-planner-delete-confirm]').exists()).toBe(true));
    },
    hold: { method: 'DELETE', path: '/commitments/' },
    act: async (wrapper) => {
      await wrapper.get('[data-planner-delete-confirm]').trigger('click');
    },
  },
  // CAL-02 말로 적기 (in the planner's 약속 추가 dialog): the read (drafts only) and adding a read draft.
  {
    name: 'commitments: read a note (말로 적기)',
    covers: ['src/components/CommitmentParseSection.vue'],
    path: '/planner',
    ready: async (wrapper) => {
      await openCommitmentAdd(wrapper);
    },
    hold: { method: 'POST', path: /\/commitments:parse$/ },
    act: async (wrapper) => {
      await wrapper.get('#commitment-note').setValue('내일 오후 3시에 A-private-read');
      await wrapper.get('form.nl-entry-form').trigger('submit');
    },
    markers: ['A-private-read'],
  },
  {
    name: 'commitments: add a read draft',
    covers: ['src/components/CommitmentParseSection.vue'],
    path: '/planner',
    // The read is part of getting ready; the action is adding the draft it gave.
    ready: async (wrapper) => {
      await openCommitmentAdd(wrapper);
      await wrapper.get('#commitment-note').setValue('내일 오후 3시에 A-private-draft');
      await wrapper.get('form.nl-entry-form').trigger('submit');
      await until(() => expect(wrapper.findAll('[data-testid="nl-draft"]')).toHaveLength(1));
    },
    hold: { method: 'POST', path: /\/commitments$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper.get('[data-testid="nl-result"]') as unknown as VueWrapper, '추가').trigger('click');
    },
    markers: ['A-private-draft'],
  },
  {
    name: 'inbox: quick add',
    covers: ['src/views/InboxView.vue', 'src/composables/useTaskActions.ts'],
    path: '/tasks?view=list',
    ready: inboxReady,
    hold: { method: 'POST', path: '/tasks' },
    act: async (wrapper) => {
      await wrapper.get('.quick-add-input').setValue('A-private-task');
      await wrapper.get('form.quick-add').trigger('submit');
    },
    markers: ['A-private-task'],
  },
  // CAL-05 말로 적기 in the inbox: the read (drafts only) and adding a read draft.
  {
    name: 'inbox: read a to-do note (말로 적기)',
    covers: ['src/components/TaskParseSection.vue', 'src/composables/useNlDraftRead.ts'],
    path: '/tasks?view=list',
    ready: async (wrapper) => {
      await inboxReady(wrapper);
      await until(() => expect(wrapper.find('#task-note').exists()).toBe(true));
    },
    hold: { method: 'POST', path: /\/tasks:parse$/ },
    act: async (wrapper) => {
      await wrapper.get('#task-note').setValue('내일까지 A-private-todo-read');
      await wrapper.get('form.task-parse-form').trigger('submit');
    },
    markers: ['A-private-todo-read'],
  },
  {
    name: 'inbox: add a read task draft',
    covers: ['src/components/TaskParseSection.vue', 'src/composables/useNlDraftRead.ts'],
    path: '/tasks?view=list',
    // The read is part of getting ready; the action is adding the draft it gave.
    ready: async (wrapper) => {
      await inboxReady(wrapper);
      await until(() => expect(wrapper.find('#task-note').exists()).toBe(true));
      await wrapper.get('#task-note').setValue('내일까지 A-private-todo-draft');
      await wrapper.get('form.task-parse-form').trigger('submit');
      await until(() => expect(wrapper.findAll('[data-testid="task-draft"]')).toHaveLength(1));
    },
    hold: { method: 'POST', path: /\/tasks$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper.get('[data-testid="task-parse-result"]') as unknown as VueWrapper, '추가').trigger('click');
    },
    markers: ['A-private-todo-draft'],
  },
  {
    name: 'inbox: rename',
    covers: ['src/components/TaskList.vue', 'src/composables/useTaskActions.ts'],
    path: '/tasks?view=list',
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
    path: '/tasks?view=list',
    ready: inboxReady,
    hold: { method: 'POST', path: ':complete' },
    act: async (wrapper) => {
      await buttonByText(wrapper, `${SEED_TASK_TITLE} 완료로 표시`).trigger('click');
    },
  },
  {
    name: 'inbox: rename hits a version conflict',
    covers: ['src/components/TaskList.vue', 'src/composables/useTaskActions.ts'],
    path: '/tasks?view=list',
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
  // HOLO-05 할 일 as a canvas: what the place sends for the surface — a to-do
  // filed, renamed and finished from it, a folder made and removed.
  {
    name: 'canvas: file a to-do into a folder',
    covers: ['src/views/TasksView.vue', 'src/composables/useFolderActions.ts'],
    path: '/tasks',
    ready: canvasReady,
    hold: { method: 'PATCH', path: '/tasks/' },
    act: async (wrapper) => {
      await canvasKey(wrapper, 'v');
      await until(() => expect(document.body.querySelector('[data-folder-picker]')).not.toBeNull());
      const folder = [...document.body.querySelectorAll<HTMLButtonElement>('[data-folder-picker] [role="menuitem"]')].find(
        (item) => !item.disabled && item.dataset['folderPick'] !== 'new',
      );
      if (folder === undefined) throw new Error('no folder to file into');
      folder.click();
    },
  },
  {
    name: 'canvas: rename in the detail',
    covers: ['src/views/TasksView.vue', 'src/composables/useTaskActions.ts'],
    path: '/tasks',
    ready: canvasReady,
    hold: { method: 'PATCH', path: '/tasks/' },
    act: async (wrapper) => {
      await canvasKey(wrapper, 'Enter');
      await until(() => expect(wrapper.find('[data-todo-card-title]').exists()).toBe(true));
      await wrapper.get('[data-todo-card-title]').setValue('A-private-canvas-rename');
      await wrapper.get('form.pond-card-title').trigger('submit');
    },
    markers: ['A-private-canvas-rename'],
  },
  {
    name: 'canvas: finish a to-do',
    covers: ['src/views/TasksView.vue', 'src/composables/useTaskActions.ts'],
    path: '/tasks',
    ready: canvasReady,
    hold: { method: 'POST', path: ':complete' },
    act: async (wrapper) => {
      await canvasKey(wrapper, 'Enter');
      await until(() => expect(wrapper.find('[data-todo-card-complete]').exists()).toBe(true));
      await wrapper.get('[data-todo-card-complete]').trigger('click');
    },
  },
  {
    name: 'canvas: make a folder',
    covers: ['src/views/TasksView.vue', 'src/composables/useFolderActions.ts'],
    path: '/tasks',
    ready: canvasReady,
    hold: { method: 'POST', path: '/projects' },
    act: async (wrapper) => {
      await wrapper.get('[data-new-folder]').trigger('click');
      await until(() => expect(document.body.querySelector('[data-new-folder-name]')).not.toBeNull());
      const input = document.body.querySelector<HTMLInputElement>('[data-new-folder-name]');
      if (input === null) throw new Error('no folder name field');
      input.value = 'A-private-folder';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => expect(document.body.querySelector<HTMLButtonElement>('[data-new-folder-submit]')?.disabled).toBe(false));
      document.body.querySelector('[data-new-folder-dialog] form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    },
    markers: ['A-private-folder'],
  },
  {
    name: 'canvas: remove a folder (its to-dos go to the inbox first)',
    covers: ['src/views/TasksView.vue', 'src/composables/useFolderActions.ts'],
    path: '/tasks',
    ready: canvasReady,
    // The first move out of the folder is what is held: the archive must never follow for another owner.
    hold: { method: 'PATCH', path: '/tasks/' },
    seed: () => {
      // One to-do in the seeded folder, so that there is something to move.
      const task = [...mockDb.tasks.values()].find((item) => item.title === SEED_TASK_TITLE);
      const folder = [...mockDb.projects.values()].find((item) => item.kind === 'normal');
      if (task === undefined || folder === undefined) throw new Error('seed missing');
      mockDb.tasks.set(task.id, { ...task, projectId: folder.id });
    },
    act: async (wrapper) => {
      await wrapper.get('[data-folder-menu-button]').trigger('click');
      await wrapper.get('[data-folder-remove]').trigger('click');
      await until(() => expect(document.body.querySelector('[data-remove-folder-confirm]')).not.toBeNull());
      document.body.querySelector<HTMLButtonElement>('[data-remove-folder-confirm]')?.click();
    },
  },
  {
    name: 'today: accept the plan',
    covers: ['src/components/today/TodayBoard.vue'],
    path: '/overview',
    seed: useTodayClock,
    ready: todayReady,
    hold: { method: 'POST', path: '/today:accept' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '오늘 계획 수락').trigger('click');
    },
  },
  {
    name: 'today: start focus',
    covers: ['src/components/today/TodayBoard.vue', 'src/stores/session.ts'],
    path: '/overview',
    seed: useTodayClock,
    ready: todayReady,
    hold: { method: 'POST', path: /\/sessions$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper.findAll('.today-card')[0] as unknown as VueWrapper, '집중 시작').trigger('click');
    },
  },
  // HOLO-01 개요: the dashboard's cards start a session on the next block (and
  // on an earlier task with "다시 시작") through one owner-bound task. (The
  // filled 집중 시작 of 오늘 is the "today: start focus" case above.)
  {
    name: 'overview: start focus on the next block from the tracker card',
    covers: ['src/composables/useOverview.ts'],
    path: '/overview',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('.overview-grid [data-tracker-start]').exists()).toBe(true));
      await until(() => expect(wrapper.get('.overview-grid [data-tracker-start]').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: /\/sessions$/ },
    act: async (wrapper) => {
      await wrapper.get('.overview-grid [data-tracker-start]').trigger('click');
    },
  },
  // HOLO-04 담기 줄: a plain line added at once, a line sent to be read, and
  // adding what was read. The bar is mounted as the shell mounts it in the
  // phone's sheet (the same component as the one in the top bar).
  {
    name: 'capture: add a plain line',
    covers: ['src/composables/useCapture.ts'],
    mount: mountCaptureBar,
    ready: captureReady,
    hold: { method: 'POST', path: /\/tasks$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-capture-input]').setValue('A-private-capture');
      await wrapper.get('[data-capture-form]').trigger('submit');
    },
    markers: ['A-private-capture'],
  },
  {
    name: 'capture: read a line',
    covers: ['src/composables/useCapture.ts'],
    mount: mountCaptureBar,
    ready: captureReady,
    hold: { method: 'POST', path: /\/tasks:parse$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-capture-input]').setValue('내일 A-private-capture-read');
      await wrapper.get('[data-capture-form]').trigger('submit');
    },
    markers: ['A-private-capture-read'],
  },
  {
    name: 'capture: add what was read',
    covers: ['src/composables/useCapture.ts'],
    mount: mountCaptureBar,
    // The read is part of getting ready; the action is adding the drafts it gave.
    ready: async (wrapper) => {
      await captureReady(wrapper);
      await wrapper.get('[data-capture-input]').setValue('내일 A-private-capture-draft');
      await wrapper.get('[data-capture-form]').trigger('submit');
      await until(() => expect(wrapper.findAll('[data-capture-row]')).toHaveLength(1));
    },
    hold: { method: 'POST', path: /\/tasks$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-capture-submit]').trigger('click');
    },
    markers: ['A-private-capture-draft'],
  },
  // HOLO-04 시작 안내: the two things the guide saves — the hours picked in its
  // first step, and the answer to the AI question in its third.
  {
    name: 'first run: save the hours',
    covers: ['src/components/FirstRunGuide.vue', 'src/composables/firstRun.ts'],
    seed: seedFirstRun,
    mount: (stage) => stage.mount(FirstRunHost),
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-first-run-step="hours"] [data-preset]').exists()).toBe(true));
      await until(() => expect(wrapper.get('[data-preset]').attributes('disabled')).toBeUndefined());
      await wrapper.get('[data-preset]').setValue(true);
      await until(() => expect(wrapper.get('[data-first-run-next]').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'PUT', path: '/availability' },
    act: async (wrapper) => {
      await wrapper.get('[data-first-run-next]').trigger('click');
    },
  },
  {
    name: 'first run: allow AI',
    covers: ['src/components/FirstRunGuide.vue', 'src/composables/firstRun.ts'],
    seed: async (stage) => {
      await seedFirstRun(stage);
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
    mount: (stage) => stage.mount(FirstRunHost),
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-first-run]').exists()).toBe(true));
      // Past the first two steps: skipping is a local note, nothing is sent.
      await wrapper.get('[data-first-run-skip]').trigger('click');
      await wrapper.get('[data-first-run-skip]').trigger('click');
      await until(() => expect(wrapper.find('[data-first-run-step="ai"] [data-first-run-ai]').exists()).toBe(true));
    },
    hold: { method: 'PATCH', path: '/me/settings' },
    act: async (wrapper) => {
      await wrapper.get('[data-first-run-next]').trigger('click');
    },
  },
  // HOLO-02 플래너: 약속 추가 (the manual fields of the dialog) and starting
  // a session from an item's detail card.
  {
    name: 'planner: add a 약속 from the dialog',
    covers: ['src/components/planner/CommitmentAddDialog.vue'],
    path: '/planner',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.get('[data-planner-add]').attributes('disabled')).toBeUndefined());
      await wrapper.get('[data-planner-add]').trigger('click');
      await until(() => expect(wrapper.find('#planner-commitment-title').exists()).toBe(true));
    },
    hold: { method: 'POST', path: /\/commitments$/ },
    act: async (wrapper) => {
      await wrapper.get('#planner-commitment-title').setValue('A-private-planner-commitment');
      await wrapper.get('[data-planner-add-manual]').trigger('submit');
    },
    markers: ['A-private-planner-commitment'],
  },
  {
    name: 'planner: start focus from a block’s detail card',
    covers: ['src/components/planner/PlannerItemCard.vue'],
    path: '/planner',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find(`[data-item^="block:${TODAY_BLOCK_ONE_ID}@"]`).exists()).toBe(true));
      await wrapper.get(`[data-item^="block:${TODAY_BLOCK_ONE_ID}@"]`).trigger('click');
      await until(() => expect(wrapper.find('[data-planner-card-start]').exists()).toBe(true));
      await until(() => expect(wrapper.get('[data-planner-card-start]').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: /\/sessions$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-planner-card-start]').trigger('click');
    },
  },
  // HOLO-02 타임 트래커: starting on the task the picker holds.
  {
    name: 'tracker: start focus on the picked task',
    covers: ['src/views/TrackerView.vue'],
    path: '/focus',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-tracker-start]').exists()).toBe(true));
      await until(() => expect(wrapper.get('[data-tracker-start]').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: /\/sessions$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-tracker-idle]').trigger('submit');
    },
  },
  {
    name: 'today: reschedule preview',
    covers: ['src/components/today/TodayBoard.vue'],
    path: '/overview',
    seed: useTodayClock,
    ready: todayReady,
    hold: { method: 'POST', path: '/today:reschedule' },
    act: async (wrapper) => {
      await buttonByText(wrapper.findAll('.today-card')[0] as unknown as VueWrapper, '재배치').trigger('click');
    },
  },
  {
    name: 'today: approve a proposal',
    covers: ['src/components/today/TodayBoard.vue'],
    path: '/overview',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await todayReady(wrapper);
      await buttonByText(wrapper.findAll('.today-card')[0] as unknown as VueWrapper, '재배치').trigger('click');
      await until(() => expect(wrapper.findAll('button').some((item) => item.text().includes('승인'))).toBe(true));
    },
    hold: { method: 'POST', path: /\/today\/proposals\/.+:approve$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper, '승인').trigger('click');
    },
  },
  {
    name: 'today: lock a block',
    covers: ['src/components/today/TodayBoard.vue', 'src/composables/useBlockLock.ts'],
    path: '/overview',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await todayReady(wrapper);
      await until(() => expect(wrapper.findAll('.today-card')[0]?.find('[data-block-lock]').exists()).toBe(true));
    },
    hold: { method: 'POST', path: /\/schedule-blocks\/[^/]+:lock$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper.findAll('.today-card')[0] as unknown as VueWrapper, '블록 고정').trigger('click');
    },
  },
  {
    name: 'focus: save the session review',
    covers: ['src/views/FocusView.vue', 'src/layout/localSignals.ts'],
    path: async (stage) => `/focus/${(await finishedSession(stage)).id}`,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.text()).toContain('이번 세션은 어땠나요?'));
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
      await until(() => expect(wrapper.find('.focus-timer').exists()).toBe(true));
      await until(() => expect(buttonByText(wrapper, '일시정지').attributes('disabled')).toBeUndefined());
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
    path: '/overview',
    frame: true,
    seed: () => {
      useTestClock();
      seedTodayRisk(mockDb);
    },
    ready: async () => {
      await until(() => expect(panelButton('deadline-risk', '확인했어요')).toBeDefined());
    },
    act: async () => {
      panelButton('deadline-risk', '확인했어요')?.click();
    },
  },
  {
    name: 'layout: skip the review prompt (clicked after the switch)',
    covers: ['src/components/layout/ReviewPromptPanel.vue', 'src/layout/localSignals.ts', 'src/stores/layout.ts'],
    path: '/overview',
    frame: true,
    seed: async (stage) => {
      useTestClock(IN_REVIEW_WINDOW);
      const session = await startedSession(stage.pinia);
      const ended = new Date(IN_REVIEW_WINDOW - 60_000).toISOString();
      const done = await plannerClient.completeSession(session.id, ended, newActionId('complete'), session.version);
      useSessionStore(stage.pinia).remember({ ...done, endedAt: ended });
    },
    ready: async () => {
      await until(() => expect(panelButton('review-prompt', '오늘은 건너뛰기')).toBeDefined());
    },
    act: async () => {
      panelButton('review-prompt', '오늘은 건너뛰기')?.click();
    },
  },
  {
    name: 'replan: approve a proposal',
    covers: ['src/views/ReplanView.vue'],
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
    covers: ['src/views/ReplanView.vue'],
    path: `/replan/${REPLAN_PENDING_ID}`,
    seed: () => {
      seedReplanScenario(mockDb);
    },
    ready: async (wrapper) => {
      await replanReady(wrapper);
      await buttonByText(wrapper, '거절').trigger('click');
      await until(() => expect(document.querySelector('.replan-reject-dialog')).not.toBeNull());
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
    covers: ['src/components/ReplanRequestButton.vue', 'src/composables/useReplanRequest.ts', 'src/views/ReplanView.vue'],
    path: '/replan',
    // Nothing waits (the proposal ran out), so 다시 맞추기 offers to ask for a new one.
    seed: () => {
      const proposal = seedReplanScenario(mockDb);
      mockDb.replanProposals.set(proposal.id, { ...proposal, state: 'expired', version: proposal.version + 1 });
    },
    ready: async (wrapper) => {
      await until(() => expect(wrapper.findAll('button').some((item) => item.text().includes('다시 맞추기 요청'))).toBe(true));
      await until(() => expect(buttonByText(wrapper, '다시 맞추기 요청').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: '/replan-proposals:request' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '다시 맞추기 요청').trigger('click');
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
      await until(() => expect(wrapper.find('[data-note-title]').exists()).toBe(true));
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
      await until(() => expect(() => dialogByTitle('노트를 삭제할까요?')).not.toThrow());
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
      await until(() => expect(() => dialogByTitle('연결할 대상 고르기')).not.toThrow());
      const picker = dialogByTitle('연결할 대상 고르기');
      await until(() => expect(picker.querySelector('[data-link-option] input:not([disabled])')).not.toBeNull());
      picker.querySelector<HTMLInputElement>('[data-link-option] input:not([disabled])')?.click();
    },
    hold: { method: 'POST', path: '/links' },
    act: async () => {
      buttonInElement(dialogByTitle('연결할 대상 고르기'), '연결').click();
    },
  },
  // HOLO-03A: 계획 세우기 · 목표 → 질문 → 단계 (PlanView).
  {
    name: 'plan: start a planning session (AI wait)',
    covers: ['src/views/PlanView.vue', 'src/composables/useAiWait.ts', 'src/composables/planFlowMemory.ts'],
    path: '/plan',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('#plan-goal-title').exists()).toBe(true));
      await wrapper.get('#plan-goal-title').setValue('A-private-goal');
      await wrapper.get('#plan-goal-description').setValue('A-private-description');
    },
    hold: { method: 'POST', path: /\/intake-sessions$/ },
    act: async (wrapper) => {
      await wrapper.get('form[data-plan-goal]').trigger('submit');
    },
    markers: ['A-private-goal', 'A-private-description'],
  },
  {
    name: 'plan: answer AI consent in the goal card, then start',
    covers: ['src/views/PlanView.vue'],
    path: '/plan',
    seed: async (stage) => {
      useTodayClock();
      // Consent never answered: starting a plan asks right in the card.
      mockDb.user = { ...mockDb.user, llmProvider: 'deepseek' };
      await useAuthStore(stage.pinia).loadCurrent();
      server.use(
        http.patch('*/api/v1/me/settings', () => {
          const next: User = {
            ...mockDb.user,
            version: mockDb.user.version + 1,
            llm: { consent: { granted: true, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } },
          };
          mockDb.user = next;
          return HttpResponse.json(next as unknown as Record<string, unknown>, { headers: { ETag: `W/"${next.version}"` } });
        }),
      );
    },
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('#plan-goal-title').exists()).toBe(true));
      await wrapper.get('#plan-goal-title').setValue('A-private-goal');
      await wrapper.get('form[data-plan-goal]').trigger('submit');
      await until(() => expect(wrapper.find('[data-plan-consent-allow]').exists()).toBe(true));
    },
    hold: { method: 'PATCH', path: '/me/settings' },
    act: async (wrapper) => {
      await wrapper.get('[data-plan-consent-allow]').trigger('click');
    },
    markers: ['A-private-goal'],
  },
  // HOLO-03A: 계획 세우기 · 일정안 만들기 and 일정안 (one flow, two screens).
  {
    name: 'plans: make the schedules',
    covers: ['src/views/PlanScopeView.vue', 'src/composables/usePlanCreate.ts', 'src/composables/planFlowMemory.ts'],
    path: () => `/plan/schedule?taskIds=${seedTaskId()}`,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.text()).toContain('작업 1개'));
      await until(() => expect(buttonByText(wrapper, '일정안 만들기').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: /\/plans$/ },
    act: async (wrapper) => {
      await wrapper.get('form.plan-scope-grid').trigger('submit');
    },
  },
  {
    name: 'plans: save the hours asked in place, then make the schedules',
    covers: ['src/views/PlanScopeView.vue', 'src/composables/usePlanCreate.ts', 'src/composables/planFlowMemory.ts'],
    path: () => `/plan/schedule?taskIds=${seedTaskId()}`,
    seed: () => {
      mockDb.availability = { ...mockDb.availability, rules: [] };
    },
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('input[data-preset="weekdayEvening"]').exists()).toBe(true));
      await wrapper.get('input[data-preset="weekdayEvening"]').setValue(true);
      await until(() => expect(buttonByText(wrapper, '일정안 만들기').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'PUT', path: '/availability' },
    act: async (wrapper) => {
      await wrapper.get('form.plan-scope-grid').trigger('submit');
    },
  },
  {
    name: 'plans: confirm a schedule',
    covers: ['src/views/PlanScheduleView.vue', 'src/composables/planFlowMemory.ts'],
    path: async () => `/plan/schedule/${(await createPlan()).id}`,
    ready: planReady,
    hold: { method: 'POST', path: /\/candidates\/[^/]+:approve$/ },
    act: async (wrapper) => {
      await buttonByText(wrapper, '이 일정으로 확정').trigger('click');
    },
  },
  {
    name: 'plans: preview a keyboard edit',
    covers: ['src/views/PlanScheduleView.vue'],
    path: async () => `/plan/schedule/${(await createPlan()).id}`,
    ready: planReady,
    hold: { method: 'POST', path: ':preview-edit' },
    act: async (wrapper) => {
      await wrapper.findAll('[data-kind="proposal"]')[0]?.trigger('keydown', { key: 'ArrowDown', altKey: true });
    },
  },
  {
    name: 'plans: make the schedules again',
    covers: ['src/views/PlanScheduleView.vue'],
    path: async () => `/plan/schedule/${(await createPlan()).id}`,
    ready: planReady,
    hold: { method: 'POST', path: ':regenerate' },
    act: async (wrapper) => {
      await wrapper.get('[data-plan-regenerate]').trigger('click');
    },
  },
  {
    name: 'plans: lock a confirmed block from its card',
    covers: ['src/views/PlanScheduleView.vue', 'src/composables/useBlockLock.ts'],
    path: async () => `/plan/schedule/${(await createPlan()).id}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await planReady(wrapper);
      await until(() => expect(wrapper.find(`[data-item^="block:${TODAY_BLOCK_ONE_ID}@"]`).exists()).toBe(true));
      await wrapper.get(`[data-item^="block:${TODAY_BLOCK_ONE_ID}@"]`).trigger('click');
      await until(() => expect(wrapper.find('[data-planner-card="block"] [data-block-lock]').exists()).toBe(true));
    },
    hold: { method: 'POST', path: /\/schedule-blocks\/[^/]+:lock$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-planner-card="block"] [data-block-lock]').trigger('click');
    },
  },
  {
    name: 'insights: exclude a record',
    covers: ['src/views/InsightsView.vue'],
    path: '/insights',
    ready: patternsReady,
    hold: { method: 'PATCH', path: '/estimation/feedback/' },
    act: async (wrapper) => {
      await wrapper.get(`[data-feedback-id="${FEEDBACK_IDS.one}"] [data-include]`).trigger('change');
    },
  },
  {
    name: 'insights: reset everything',
    covers: ['src/views/InsightsView.vue'],
    path: '/insights',
    ready: async (wrapper) => {
      await patternsReady(wrapper);
      await wrapper.get('[data-reset-all]').trigger('click');
      await until(() => expect(document.querySelector('[data-reset-confirm]')).not.toBeNull());
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
      await until(() => expect(wrapper.find('[data-task-promote]').exists()).toBe(true));
      await until(() => expect(wrapper.get('[data-task-promote]').attributes('disabled')).toBeUndefined());
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
      await until(() => expect(wrapper.findAll('.notification-item').length).toBeGreaterThan(0));
    },
    hold: { method: 'POST', path: ':dismiss' },
    act: async (wrapper) => {
      await buttonByText(wrapper.findAll('.notification-item')[0] as unknown as VueWrapper, '지우기').trigger('click');
    },
  },
  {
    // Not only network waits: the permission prompt, the service worker and
    // the push manager are awaited one after the other before anything is
    // sent. The bound-point sweep changes the owner at each of them.
    name: 'notifications: enable push (permission prompt, service worker, subscription)',
    covers: ['src/components/NotificationsPanel.vue'],
    mount: (stage) => {
      installPushApis();
      return stage.mount(NotificationsPanel, { props: { open: true } });
    },
    ready: async (wrapper) => {
      await until(() => expect(buttonByText(wrapper, '푸시 알림 켜기').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: '/push-subscriptions' },
    act: async (wrapper) => {
      await buttonByText(wrapper, '푸시 알림 켜기').trigger('click');
    },
  },
  {
    name: 'AI settings: grant consent',
    covers: ['src/components/settings/AiSettings.vue', 'src/stores/auth.ts'],
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
      await until(() => expect(wrapper.findAll('button').some((item) => item.text().includes('AI 계획 도움 켜기'))).toBe(true));
    },
    hold: { method: 'PATCH', path: '/me/settings' },
    act: async (wrapper) => {
      await buttonByText(wrapper, 'AI 계획 도움 켜기').trigger('click');
    },
  },
  {
    // FU-91: the consent dialog as AppShell hosts it. Its answer closes the
    // dialog and records the session-scoped dismissal marker; neither may
    // land for the next user.
    name: 'AI consent dialog: answer 직접 작성 (session dismissal marker)',
    covers: ['src/stores/llmConsent.ts', 'src/components/LlmConsentDialog.vue'],
    seed: async (stage) => {
      mockDb.user = { ...mockDb.user, llmProvider: 'deepseek' };
      await useAuthStore(stage.pinia).loadCurrent();
      server.use(
        http.patch('*/api/v1/me/settings', () => {
          const next: User = {
            ...mockDb.user,
            version: mockDb.user.version + 1,
            llm: { consent: { granted: false, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } },
          };
          return HttpResponse.json(next as unknown as Record<string, unknown>, { headers: { ETag: `W/"${next.version}"` } });
        }),
      );
    },
    mount: (stage) => stage.mount(ConsentHost),
    ready: async () => {
      await until(() => expect(dialogByTitle('AI 계획 도움을 쓸까요?')).toBeDefined());
    },
    hold: { method: 'PATCH', path: '/me/settings' },
    act: async () => {
      buttonInElement(dialogByTitle('AI 계획 도움을 쓸까요?'), '직접 작성 모드로 쓰기').click();
    },
  },
  {
    name: 'plan: send the answers of a round',
    covers: ['src/views/PlanView.vue'],
    path: async () =>
      `/plan/${(await plannerClient.createIntakeSession({ title: '논문 요약', dueAt: '2026-11-30T18:00:00.000Z' }, newActionId('create'))).id}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('#answer-deliverable').exists()).toBe(true));
      await wrapper.get('#answer-deliverable').setValue('A-private-answer');
    },
    hold: { method: 'POST', path: /\/answers$/ },
    act: async (wrapper) => {
      await wrapper.get('form[data-plan-questions]').trigger('submit');
    },
    markers: ['A-private-answer'],
  },
  {
    name: 'plan: save the edited steps',
    covers: ['src/views/PlanView.vue'],
    path: async () => `/plan/${(await draftSession()).id}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));
      await wrapper.get('#step-title-s1').setValue('A-private-step');
    },
    hold: { method: 'PATCH', path: '/draft' },
    act: async (wrapper) => {
      await wrapper.get('[data-plan-save]').trigger('click');
    },
    markers: ['A-private-step'],
  },
  {
    name: 'plan: confirm the steps',
    covers: ['src/views/PlanView.vue'],
    path: async () => `/plan/${(await draftSession()).id}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));
    },
    hold: { method: 'POST', path: '/draft:approve' },
    act: async (wrapper) => {
      await wrapper.get('[data-plan-approve-steps]').trigger('click');
    },
  },
  {
    // The second request of the same press: the steps are confirmed, the schedules are being made.
    name: 'plan: confirm the steps, then make the schedules',
    covers: ['src/views/PlanView.vue', 'src/composables/usePlanCreate.ts', 'src/composables/planFlowMemory.ts'],
    path: async () => `/plan/${(await draftSession()).id}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('#step-title-s1').exists()).toBe(true));
    },
    hold: { method: 'POST', path: /\/plans$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-plan-approve-steps]').trigger('click');
    },
  },
  {
    name: 'plan: go on without the AI',
    covers: ['src/views/PlanView.vue'],
    path: async () =>
      `/plan/${(await plannerClient.createIntakeSession({ title: '논문 요약', dueAt: '2026-11-30T18:00:00.000Z' }, newActionId('create'))).id}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-plan-manual]').exists()).toBe(true));
    },
    hold: { method: 'POST', path: ':manual' },
    act: async (wrapper) => {
      await wrapper.get('[data-plan-manual]').trigger('click');
    },
  },
  {
    name: 'plan: give a planning session up',
    covers: ['src/views/PlanView.vue', 'src/composables/planFlowMemory.ts'],
    path: async () =>
      `/plan/${(await plannerClient.createIntakeSession({ title: '논문 요약', dueAt: '2026-11-30T18:00:00.000Z' }, newActionId('create'))).id}`,
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-plan-stop]').exists()).toBe(true));
      await until(() => expect(wrapper.get('[data-plan-stop]').attributes('disabled')).toBeUndefined());
    },
    hold: { method: 'POST', path: ':cancel' },
    act: async (wrapper) => {
      await wrapper.get('[data-plan-stop]').trigger('click');
    },
  },
  {
    name: 'wizard notes: link a note to the plan goal',
    covers: ['src/components/notes/WizardNotesPanel.vue', 'src/composables/notes.ts'],
    seed: useTodayClock,
    mount: async (stage) => {
      // The goal a note is linked to must exist: it comes from a planning session.
      const planning = await plannerClient.createIntakeSession({ title: '졸업 논문 실험 계획' }, newActionId('intake'));
      return stage.mount(WizardNotesPanel, { props: { goalId: String(planning.goalId) } });
    },
    ready: async (wrapper) => {
      await wrapper.get('[data-wizard-notes-add]').trigger('click');
      await until(() => expect(() => dialogByTitle('참고할 노트 고르기')).not.toThrow());
      const picker = dialogByTitle('참고할 노트 고르기');
      await until(() => expect(picker.querySelector(`[data-wizard-candidate="${NOTE_MEETING_ID}"]`)).not.toBeNull());
    },
    hold: { method: 'POST', path: '/links' },
    act: async () => {
      buttonInElement(dialogByTitle('참고할 노트 고르기'), '“발표 준비 회의” 이 계획에 연결').click();
    },
  },
  {
    name: 'layout settings: turn automatic switching off (clicked after the switch)',
    covers: ['src/components/settings/DisplaySettings.vue', 'src/stores/layout.ts', 'src/layout/prefs.ts'],
    path: '/settings/layout',
    seed: useTodayClock,
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-layout-auto]').exists()).toBe(true));
    },
    act: async (wrapper) => {
      await wrapper.get('[data-layout-auto]').setValue(false);
    },
  },
  // CAL-04 캘린더 연동: save the settings, sync now, connect (a top-level
  // navigation to Google) and disconnect.
  {
    name: 'calendar settings: save what is sent to the phone',
    covers: ['src/components/settings/CalendarSettings.vue'],
    path: '/settings/calendar',
    seed: () => seedGoogle(mockDb, 'connected'),
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-google-setting="dailySummary"]').exists()).toBe(true));
      await wrapper.get('[data-google-setting="dailySummary"]').setValue(false);
    },
    hold: { method: 'PUT', path: '/integrations/google/settings' },
    act: async (wrapper) => {
      await wrapper.get('form.google-settings-form').trigger('submit');
    },
  },
  {
    name: 'calendar settings: sync now',
    covers: ['src/components/settings/CalendarSettings.vue'],
    path: '/settings/calendar',
    seed: () => seedGoogle(mockDb, 'connected'),
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-google-sync-now]').exists()).toBe(true));
    },
    hold: { method: 'POST', path: /\/integrations\/google:sync$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-google-sync-now]').trigger('click');
    },
  },
  {
    name: 'calendar settings: connect (the page would leave for Google)',
    covers: ['src/components/settings/CalendarSettings.vue'],
    path: '/settings/calendar',
    seed: () => {
      seedGoogle(mockDb, 'disconnected');
      googleNavigations.length = 0;
      setTopLevelNavigator((url) => {
        googleNavigations.push({ url, owner: currentOwnerId() });
      });
    },
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-google-connect]').exists()).toBe(true));
    },
    hold: { method: 'POST', path: /\/integrations\/google:connect$/ },
    act: async (wrapper) => {
      await wrapper.get('[data-google-connect]').trigger('click');
    },
    afterwards: async (stage) => {
      // A consent started by A never sends B's page to Google: any navigation
      // happened while A was still signed in.
      if (stage.switched) expect(googleNavigations.filter((navigation) => navigation.owner === OWNER_B)).toEqual([]);
      else await until(() => expect(googleNavigations).toHaveLength(1));
      expect(googleNavigations.length).toBeLessThanOrEqual(1);
    },
  },
  {
    name: 'calendar settings: disconnect',
    covers: ['src/components/settings/CalendarSettings.vue'],
    path: '/settings/calendar',
    seed: () => seedGoogle(mockDb, 'connected'),
    ready: async (wrapper) => {
      await until(() => expect(wrapper.find('[data-google-disconnect]').exists()).toBe(true));
      await wrapper.get('[data-google-disconnect]').trigger('click');
      await until(() => expect(() => dialogByTitle('구글 연결을 끊을까요?')).not.toThrow());
    },
    hold: { method: 'DELETE', path: '/integrations/google' },
    act: async () => {
      buttonInElement(dialogByTitle('구글 연결을 끊을까요?'), '연결 끊기').click();
    },
  },
];


/** A planning session that already has a step draft (every question answered "모름"). */
async function draftSession(): Promise<IntakeSession> {
  let current = await plannerClient.createIntakeSession(
    { title: '논문 요약', dueAt: '2026-11-30T18:00:00.000Z' },
    newActionId('create'),
  );
  for (let round = 0; round < 5 && (current.questions ?? []).length > 0; round += 1) {
    current = await plannerClient.answerIntakeQuestions(
      current.id,
      (current.questions ?? []).map((question) => ({ questionKey: question.field, action: 'idk' as const })),
      newActionId('answers'),
      current.version,
    );
  }
  return current;
}

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
  await until(() => expect(wrapper.findAll('.plan-option').length).toBeGreaterThan(0));
  await until(() => expect(wrapper.findAll('[data-kind="proposal"]').length).toBeGreaterThan(0));
}

async function patternsReady(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.find(`[data-feedback-id="${FEEDBACK_IDS.one}"]`).exists()).toBe(true));
}

async function noteReady(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.find('[data-note-links]').exists()).toBe(true));
  await until(() => expect((wrapper.get('[data-note-title]').element as HTMLInputElement).value).toBe('발표 준비 회의'));
}

async function replanReady(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.findAll('.replan-change').length).toBeGreaterThan(0));
}

let startHold: HeldResponses | null = null;

let restorePushApis: (() => void) | null = null;

/** A browser that supports push: permission is granted, the service worker is ready, subscribing works. */
function installPushApis(): void {
  const serviceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  vi.stubGlobal('Notification', { requestPermission: async () => 'granted' });
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => null,
          subscribe: async () => ({
            endpoint: 'https://push.example.test/A-private-endpoint',
            toJSON: () => ({ keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
          }),
        },
      }),
    },
  });
  restorePushApis = () => {
    vi.unstubAllGlobals();
    if (serviceWorker === undefined) Reflect.deleteProperty(navigator, 'serviceWorker');
    else Object.defineProperty(navigator, 'serviceWorker', serviceWorker);
  };
}

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
  await until(() => expect(wrapper.findAll('.today-card').length).toBeGreaterThan(0));
}

export async function inboxReady(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.text()).toContain(SEED_TASK_TITLE));
}

/** 할 일 as a canvas (HOLO-05): the surface is drawn and the seeded to-do floats on it. */
async function canvasReady(wrapper: VueWrapper): Promise<void> {
  await until(() => expect(wrapper.find('[data-todo-canvas]').exists()).toBe(true));
  await until(() => expect(wrapper.find('[data-todo-canvas]').text()).toContain(SEED_TASK_TITLE));
}

/** A key on the seeded to-do's capsule, the way the keyboard drives the canvas. */
async function canvasKey(wrapper: VueWrapper, key: string): Promise<void> {
  const capsule = wrapper.findAll('[data-todo]').find((item) => item.text().includes(SEED_TASK_TITLE));
  if (capsule === undefined) throw new Error('the seeded to-do is not on the canvas');
  (capsule.element as HTMLElement).focus();
  await capsule.trigger('keydown', { key });
}

/**
 * Registers the sweep for one slice of the cases. The sweep is split over
 * several spec files (owner-switch-sweep.shard-N.spec.ts) only so that they run
 * in parallel; every case is in exactly one of them.
 */
export function sweepShard(shard: number, shards: number): void {
  afterEach(() => {
    setLayoutClock(null);
    startHold = null;
    restorePushApis?.();
    restorePushApis = null;
  });
  OWNER_SWITCH_CASES.forEach((testCase, index) => {
    if (index % shards === shard) sweepOwnerSwitch(testCase);
  });
}

/** How many spec files the sweep is split over. */
export const OWNER_SWITCH_SHARDS = 6;
