<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ActionStore, plannerClient, type Project, type Task } from '../api';
import ConflictDialog from '../components/ConflictDialog.vue';
import TodoCanvas from '../components/canvas/TodoCanvas.vue';
import TodoListView from '../components/canvas/TodoListView.vue';
import type { CanvasActions } from '../components/canvas/types';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import {
  pruneCanvasMemory,
  readCanvasMemory,
  writeCanvasMemory,
  type CanvasMemory,
  type TasksViewChoice,
} from '../composables/canvasMemory';
import { useFolderActions, type RemovedFolder } from '../composables/useFolderActions';
import { useTaskActions } from '../composables/useTaskActions';
import { useTodoBoard } from '../composables/useTodoBoard';
import { t, tp } from '../i18n';
import { runOwnerBound } from '../session/ownerBound';
import { captureOwnerBinding, isOwnerBindingCurrent, ownerState, type OwnerBinding } from '../session/ownerEpoch';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';
import { useUiStore } from '../stores/ui';

/**
 * 할 일 (HOLO-05, FLOW.md §4): everything put down, as one place.
 *
 * - **캔버스** (the default): every open to-do floats on a wide surface; a
 *   folder is a dish on it, and a real project. Things are picked here and
 *   travel to the plan flow — the screen's one filled button is 계획에 넣기.
 * - **목록** (`?view=list`): the same to-dos as rows, with the one-line quick
 *   add. The owner's choice of view is remembered on this device.
 *
 * The canvas draws and moves; this file sends what it asks for — rename,
 * finish and delete through `useTaskActions` (with the 412 dialog and the
 * undo), filing and folders through `useFolderActions` — and says what
 * happened. The route name `tasks`, the address and the `data-tasks-place`
 * root are what other screens and the tests hold on to.
 */
const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const toast = useToastStore();
const ui = useUiStore();
const board = useTodoBoard();

// ── What this device remembers: places, folded folders, the view ────────
const memory = ref<CanvasMemory>(readCanvasMemory(ownerState.ownerId.value));
watch(
  () => ownerState.ownerId.value,
  (ownerId) => {
    memory.value = readCanvasMemory(ownerId);
  },
);

/** Written under the binding of the gesture that changed it; a stale one writes nothing. */
function store(next: CanvasMemory, binding: OwnerBinding): void {
  if (!isOwnerBindingCurrent(binding)) return;
  // Forget what is gone — once the server has said what is there.
  const kept =
    board.isLoading.value || board.isError.value
      ? next
      : pruneCanvasMemory(next, {
          tasks: new Set(board.todos.value.map((todo) => todo.task.id)),
          folders: new Set(board.folders.value.map((folder) => folder.id)),
        });
  memory.value = kept;
  writeCanvasMemory(binding, kept);
}

/** What the canvas says about places and folds; which view is on show is this file's to say. */
function remember(next: CanvasMemory, binding: OwnerBinding): void {
  store({ ...next, view: memory.value.view }, binding);
}

const view = computed<TasksViewChoice>(() => {
  const asked = route.query['view'];
  if (asked === 'list') return 'list';
  // `projects` was the old project list: folders are on the canvas now.
  if (asked === 'canvas' || asked === 'projects') return 'canvas';
  return memory.value.view;
});

const VIEWS = [
  { id: 'canvas', label: 'canvas.view.canvas', aria: 'canvas.view.toCanvas', icon: 'overview' },
  { id: 'list', label: 'canvas.view.list', aria: 'canvas.view.toList', icon: 'list' },
] as const;

function chooseView(next: TasksViewChoice): void {
  store({ ...memory.value, view: next }, captureOwnerBinding());
  void router.replace({ name: 'tasks', query: next === 'list' ? { view: 'list' } : {} });
}

// ── To-dos: rename, finish, delete ──────────────────────────────────────
const canMutate = (): boolean => offline.mutationsEnabled;
const taskActions = useTaskActions(plannerClient, new ActionStore(), canMutate);
const folderActions = useFolderActions({
  canMutate,
  inboxId: () => board.inbox.value?.id ?? null,
  onTask: (task) => board.patchTask(task),
  onProject: (project) => board.patchProject(project),
});

/** The title last asked for, per to-do: what "내 수정으로 덮어쓰기" applies again. */
const renameDrafts = new Map<string, string>();

async function rename(task: Task, title: string): Promise<boolean> {
  renameDrafts.set(task.id, title);
  const outcome = await runOwnerBound(function* (owner) {
    try {
      const updated = yield* owner.wait(taskActions.rename(task, title));
      if (updated === null) return false;
      board.patchTask(updated);
      renameDrafts.delete(task.id);
      void board.refresh();
      return true;
    } catch {
      // `taskActions.error` already carries what to say.
      return false;
    }
  });
  return outcome.status === 'done' && outcome.value;
}

async function complete(task: Task): Promise<boolean> {
  const outcome = await runOwnerBound(function* (owner) {
    try {
      const updated = yield* owner.wait(taskActions.complete(task));
      if (updated === null) return false;
      board.patchTask(updated);
      void board.refresh();
      return true;
    } catch {
      return false;
    }
  });
  return outcome.status === 'done' && outcome.value;
}

// Delete with undo: hidden at once, sent when the undo window closes — by whoever clicked.
const UNDO_MS = 6000;
const hidden = ref<Set<string>>(new Set());
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setHidden(taskId: string, on: boolean): void {
  const next = new Set(hidden.value);
  if (on) next.add(taskId);
  else next.delete(taskId);
  hidden.value = next;
}

function remove(task: Task): void {
  if (!canMutate() || deleteTimers.has(task.id)) return;
  setHidden(task.id, true);
  toast.show(t('taskList.deleted', { title: task.title }), {
    action: { label: t('taskList.undo'), handler: () => undoDelete(task.id) },
    duration: UNDO_MS,
  });
  const binding = captureOwnerBinding();
  deleteTimers.set(
    task.id,
    setTimeout(() => {
      deleteTimers.delete(task.id);
      void commitDelete(task, binding);
    }, UNDO_MS),
  );
}

function undoDelete(taskId: string): void {
  const timer = deleteTimers.get(taskId);
  if (timer !== undefined) clearTimeout(timer);
  deleteTimers.delete(taskId);
  setHidden(taskId, false);
}

async function commitDelete(task: Task, binding: OwnerBinding): Promise<void> {
  await runOwnerBound(
    function* (owner) {
      if (!canMutate()) {
        setHidden(task.id, false);
        toast.show(t('taskList.deleteCancelledDisabled'));
        return;
      }
      try {
        const deleted = yield* owner.wait(taskActions.remove(task));
        if (deleted) {
          board.dropTask(task.id);
          void board.refresh();
        }
        setHidden(task.id, false);
      } catch {
        setHidden(task.id, false);
        toast.show(t('taskList.deleteFailed'), { tone: 'error' });
      }
    },
    { binding },
  );
}

watch(
  () => offline.online,
  (online) => {
    if (online || deleteTimers.size === 0) return;
    for (const [taskId, timer] of deleteTimers) {
      clearTimeout(timer);
      setHidden(taskId, false);
    }
    deleteTimers.clear();
    toast.show(t('taskList.deletesCancelledOffline'));
  },
);

// ── The 412 dialog (the same one the rows use) ──────────────────────────
let conflictRegistered = false;
watch(
  () => taskActions.conflict.value !== null,
  (open) => {
    if (open === conflictRegistered) return;
    conflictRegistered = open;
    if (open) ui.openConflict();
    else ui.closeConflict();
  },
  { immediate: true },
);

async function onOverwrite(): Promise<void> {
  const current = taskActions.conflict.value;
  if (current === null || !canMutate() || taskActions.busy.value) return;
  const draft = current.operation === 'rename' ? (renameDrafts.get(current.taskId) ?? null) : null;
  await runOwnerBound(function* (owner) {
    try {
      const updated = yield* owner.wait(taskActions.overwrite(draft));
      if (taskActions.conflict.value !== null) return;
      renameDrafts.delete(current.taskId);
      if (updated !== null) board.patchTask(updated);
      else if (current.operation === 'delete') board.dropTask(current.taskId);
      void board.refresh();
    } catch {
      // The dialog stays; `taskActions.error` says why.
    }
  });
}

async function onReload(): Promise<void> {
  if (taskActions.busy.value) return;
  const current = taskActions.conflict.value;
  await runOwnerBound(function* (owner) {
    try {
      const fresh = yield* owner.wait(taskActions.reload());
      if (current !== null) renameDrafts.delete(current.taskId);
      if (fresh !== null) board.patchTask(fresh);
      void board.refresh();
    } catch {
      toast.show(t('taskList.reloadFailed'), { tone: 'error' });
    }
  });
}

function onCancelConflict(): void {
  const current = taskActions.conflict.value;
  taskActions.dismissConflict(current?.operation === 'rename' ? { keepAction: true } : {});
}

// ── Filing and folders ──────────────────────────────────────────────────
async function setDue(task: Task, dueAt: string | null): Promise<boolean> {
  const outcome = await runOwnerBound(function* (owner) {
    const updated = yield* owner.wait(folderActions.setDue(task, dueAt));
    if (updated !== null) void board.refresh();
    return updated !== null;
  });
  return outcome.status === 'done' && outcome.value;
}

async function file(tasks: readonly Task[], folderId: string | null): Promise<string[]> {
  const target = folderId ?? board.inbox.value?.id ?? null;
  if (target === null) return [];
  const outcome = await runOwnerBound(function* (owner) {
    const result = yield* owner.wait(folderActions.file(tasks, target));
    if (result.moved.length > 0) void board.refresh();
    return result.moved.map((task) => task.id);
  });
  return outcome.status === 'done' ? outcome.value : [];
}

async function renameFolder(folder: Project, title: string): Promise<boolean> {
  const outcome = await runOwnerBound(function* (owner) {
    const updated = yield* owner.wait(folderActions.rename(folder, title));
    if (updated === null) {
      toast.show(t('canvas.folder.renameFailed'), { tone: 'error' });
      return false;
    }
    void board.refresh();
    return true;
  });
  return outcome.status === 'done' && outcome.value;
}

// 폴더 만들기: one field in a small dialog; what was picked can go straight into it.
const creating = ref<{ thenFile: readonly Task[] } | null>(null);
const newFolderName = ref('');
const createBusy = ref(false);

function newFolder(thenFile: readonly Task[] = []): void {
  if (!canMutate()) return;
  newFolderName.value = '';
  creating.value = { thenFile };
}

async function submitNewFolder(): Promise<void> {
  const request = creating.value;
  const title = newFolderName.value.trim();
  if (request === null || title.length === 0 || createBusy.value) return;
  createBusy.value = true;
  await runOwnerBound(
    function* (owner) {
      const project = yield* owner.wait(folderActions.create(title));
      if (project === null) {
        toast.show(t('canvas.folder.createFailed'), { tone: 'error' });
        return;
      }
      creating.value = null;
      toast.show(t('canvas.folder.created', { title: project.title }));
      if (request.thenFile.length > 0) {
        const filed = yield* owner.wait(folderActions.file(request.thenFile, project.id));
        // What went into the folder is no longer picked: the selection ends with what it was for.
        const gone = new Set(filed.moved.map((task) => task.id));
        selected.value = selected.value.filter((id) => !gone.has(id));
      }
      void board.refresh();
    },
    {
      onSettled: () => {
        createBusy.value = false;
      },
    },
  );
}

// 폴더 없애기: asked first, then emptied into the inbox, then archived — and undone the other way round.
const removing = ref<Project | null>(null);
const removeBusy = ref(false);

function removeFolder(folder: Project): void {
  if (!canMutate()) return;
  removing.value = folder;
}

async function confirmRemoveFolder(): Promise<void> {
  const folder = removing.value;
  if (folder === null || removeBusy.value) return;
  removeBusy.value = true;
  await runOwnerBound(
    function* (owner) {
      const outcome = yield* owner.wait(folderActions.remove(folder));
      removing.value = null;
      void board.refresh();
      if (outcome.status === 'removed') {
        const removed = outcome.removed;
        const binding = captureOwnerBinding();
        toast.show(t('canvas.folder.removed', { title: folder.title }), {
          action: { label: t('canvas.folder.undo'), handler: () => void undoRemoveFolder(removed, folder.title, binding) },
          duration: 10_000,
        });
      } else if (outcome.status === 'partial') {
        toast.show(t('canvas.folder.removePartial', { title: folder.title }), { tone: 'error', duration: 10_000 });
      } else {
        toast.show(t('canvas.folder.removeFailed'), { tone: 'error' });
      }
    },
    {
      onSettled: () => {
        removeBusy.value = false;
      },
    },
  );
}

async function undoRemoveFolder(removed: RemovedFolder, title: string, binding: OwnerBinding): Promise<void> {
  await runOwnerBound(
    function* (owner) {
      const result = yield* owner.wait(folderActions.restore(removed));
      void board.refresh();
      if (!result.restored) toast.show(t('canvas.folder.restoreFailed'), { tone: 'error' });
      else if (result.failed > 0) toast.show(tp('canvas.folder.restoredPartial', result.failed), { tone: 'error' });
      else toast.show(t('canvas.folder.restored', { title }));
    },
    { binding },
  );
}

const actions: CanvasActions = { rename, complete, remove, setDue, file, renameFolder, removeFolder, newFolder };

// ── What is on screen ───────────────────────────────────────────────────
const todos = computed(() => board.todos.value.filter((todo) => !hidden.value.has(todo.task.id)));
const selected = ref<string[]>([]);
const actionError = computed(() => taskActions.error.value ?? folderActions.error.value);

/** FLOW §5: what is picked travels to the plan flow, picked there. */
const planTo = computed(() =>
  selected.value.length > 0 && view.value === 'canvas'
    ? { path: '/plan/schedule', query: { taskIds: selected.value.join(',') } }
    : { path: '/plan/schedule' },
);
const planLabel = computed(() =>
  selected.value.length > 0 && view.value === 'canvas' ? tp('canvas.toPlanPicked', selected.value.length) : t('canvas.toPlan'),
);

/**
 * 폴더 만들기 while to-dos are picked on the canvas (HOLO-07): the new folder
 * takes them — the button says so — and the selection ends.
 */
const pickedForFolder = computed<Task[]>(() => {
  if (view.value !== 'canvas' || selected.value.length === 0) return [];
  const byId = new Map(todos.value.map((todo) => [todo.task.id, todo.task]));
  return selected.value.flatMap((id) => {
    const task = byId.get(id);
    return task === undefined ? [] : [task];
  });
});
const newFolderLabel = computed(() =>
  pickedForFolder.value.length > 0 ? tp('canvas.newFolderPicked', pickedForFolder.value.length) : t('canvas.newFolder'),
);

function openCapture(): void {
  ui.openCapture('capture');
}

onUnmounted(() => {
  if (conflictRegistered) ui.closeConflict();
  conflictRegistered = false;
  // A delete still waiting for its undo window is not sent by a screen that is gone.
  for (const timer of deleteTimers.values()) clearTimeout(timer);
  deleteTimers.clear();
});
</script>

<template>
  <section class="page page--wide todo-place" data-tasks-place :data-tasks-view="view">
    <header class="page-header todo-place-head">
      <div class="page-heading">
        <h1>{{ t('canvas.title') }}</h1>
        <p v-if="!board.isLoading.value && !board.isError.value" class="todo-place-summary" data-tasks-summary>
          <span>{{ tp('canvas.openCount', todos.length) }}</span>
          <span v-if="board.folders.value.length > 0">{{ tp('canvas.folderCount', board.folders.value.length) }}</span>
        </p>
        <p v-else class="page-lede">{{ t('canvas.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="offline-note" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
        <UiButton icon="projects" :disabled="!offline.mutationsEnabled" data-new-folder @click="newFolder(pickedForFolder)">
          {{ newFolderLabel }}
        </UiButton>
        <nav class="segmented glass glass--still glass--flat tasks-views" :aria-label="t('canvas.view.label')">
          <a
            v-for="item in VIEWS"
            :key="item.id"
            :href="item.id === 'list' ? '/tasks?view=list' : '/tasks'"
            class="btn segmented-item"
            :aria-current="view === item.id ? 'page' : undefined"
            :aria-label="t(item.aria)"
            :data-tasks-view-link="item.id"
            @click.prevent="chooseView(item.id)"
          >
            <UiIcon :name="item.icon" :size="16" />
            {{ t(item.label) }}
          </a>
        </nav>
        <!-- ① → ②: the screen's one filled button (FLOW §5). With nothing put down it is the empty surface's 할 일 담기 instead. -->
        <RouterLink
          v-if="todos.length > 0"
          class="btn todo-place-plan"
          :class="{ 'btn--primary': view === 'canvas' }"
          :to="planTo"
          data-tasks-to-plan
        >
          <UiIcon name="plan" :size="18" class="btn-icon" />{{ planLabel }}
        </RouterLink>
      </div>
    </header>

    <UiBanner v-if="actionError" tone="error" role="alert" data-tasks-error>{{ actionError }}</UiBanner>

    <template v-if="view === 'canvas'">
      <div v-if="board.isLoading.value">
        <p class="visually-hidden" role="status">{{ t('canvas.loading') }}</p>
        <div class="skeleton pond-loading" aria-hidden="true"></div>
      </div>
      <UiBanner v-else-if="board.isError.value" tone="error" class="error-panel">
        <p class="error-text" role="alert">{{ t('canvas.loadError') }}</p>
        <template #actions>
          <UiButton size="sm" icon="sync" @click="board.refetch()">{{ t('common.retry') }}</UiButton>
        </template>
      </UiBanner>
      <UiBanner v-else-if="board.inboxMissing.value" tone="warn" class="error-panel">
        <p class="error-text" role="alert">{{ t('inbox.missing') }}</p>
        <template #actions>
          <UiButton size="sm" icon="sync" @click="board.refetch()">{{ t('common.retry') }}</UiButton>
        </template>
      </UiBanner>
      <template v-else>
        <!-- Under a finger the surface's gestures cannot be found by pointing at things: they are said (shown on a coarse pointer only). -->
        <p v-if="todos.length > 0" class="pond-touch-hint" data-canvas-touch-hint>{{ t('canvas.touchHint') }}</p>
        <TodoCanvas
          v-model:selected="selected"
          :todos="todos"
          :folders="board.folders.value"
          :memory="memory"
          :time-zone="board.timeZone.value"
          :disabled="!offline.mutationsEnabled"
          :actions="actions"
          @remember="remember"
          @capture="openCapture"
        />
        <p v-if="board.truncated.value" class="field-help" data-tasks-truncated>{{ t('canvas.truncated') }}</p>
        <p class="pond-hints" aria-hidden="true" data-canvas-hints>
          <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd>{{ t('canvas.hint.move') }}</span>
          <span><kbd>Enter</kbd>{{ t('canvas.hint.open') }}</span>
          <span><kbd>Space</kbd>{{ t('canvas.hint.pick') }}</span>
          <span><kbd>v</kbd>{{ t('canvas.hint.file') }}</span>
          <span><kbd>Alt</kbd><kbd>←</kbd>{{ t('canvas.hint.nudge') }}</span>
        </p>
      </template>
    </template>
    <TodoListView v-else :tasks="board.tasks.value" :folders="board.folders.value" :disabled="!offline.mutationsEnabled" @refresh="board.refresh()" />

    <ConflictDialog
      v-if="taskActions.conflict.value"
      :server-version="taskActions.conflict.value.server.version"
      :server-title="taskActions.conflict.value.server.title"
      :local-title="taskActions.conflict.value.localTitle"
      :operation="taskActions.conflict.value.operation"
      :disabled="!offline.mutationsEnabled"
      :busy="taskActions.busy.value"
      @reload="onReload"
      @overwrite="onOverwrite"
      @cancel="onCancelConflict"
    />

    <UiDialog v-if="creating" labelledby="new-folder-title" describedby="new-folder-help" size="sm" data-new-folder-dialog @close="creating = null">
      <form class="dialog-form" @submit.prevent="submitNewFolder">
        <header class="dialog-header">
          <h2 id="new-folder-title" class="dialog-title">{{ t('canvas.folder.createTitle') }}</h2>
        </header>
        <p id="new-folder-help" class="muted" data-new-folder-help>
          {{ creating.thenFile.length > 0 ? tp('canvas.folder.createHelpPicked', creating.thenFile.length) : t('canvas.folder.createHelp') }}
        </p>
        <div class="field">
          <label for="new-folder-name" class="field-label">{{ t('canvas.folder.name') }}</label>
          <input
            id="new-folder-name"
            v-model="newFolderName"
            type="text"
            maxlength="200"
            autocomplete="off"
            :placeholder="t('canvas.folder.namePlaceholder')"
            :disabled="createBusy"
            data-autofocus
            data-new-folder-name
          />
        </div>
        <footer class="dialog-actions">
          <UiButton variant="ghost" :disabled="createBusy" @click="creating = null">{{ t('common.cancel') }}</UiButton>
          <UiButton type="submit" variant="primary" :busy="createBusy" :disabled="createBusy || newFolderName.trim().length === 0" data-new-folder-submit>
            {{ t('canvas.folder.create') }}
          </UiButton>
        </footer>
      </form>
    </UiDialog>

    <UiDialog
      v-if="removing"
      role="alertdialog"
      labelledby="remove-folder-title"
      describedby="remove-folder-body"
      size="sm"
      :dismissible="!removeBusy"
      data-remove-folder-dialog
      @close="removing = null"
    >
      <header class="dialog-header">
        <h2 id="remove-folder-title" class="dialog-title">{{ t('canvas.folder.removeTitle', { title: removing.title }) }}</h2>
      </header>
      <p id="remove-folder-body" class="muted">{{ removeBusy ? t('canvas.folder.removing') : t('canvas.folder.removeBody') }}</p>
      <footer class="dialog-actions">
        <UiButton variant="ghost" :disabled="removeBusy" data-autofocus @click="removing = null">{{ t('common.cancel') }}</UiButton>
        <UiButton variant="danger" :busy="removeBusy" :disabled="removeBusy" data-remove-folder-confirm @click="confirmRemoveFolder">
          {{ t('canvas.folder.removeConfirm') }}
        </UiButton>
      </footer>
    </UiDialog>
  </section>
</template>
