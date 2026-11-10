<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ActionStore, plannerClient, type Task } from '../api';
import { useTaskActions } from '../composables/useTaskActions';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';
import { useUiStore } from '../stores/ui';
import ConflictDialog from './ConflictDialog.vue';
import TaskItem from './TaskItem.vue';

const props = withDefaults(
  defineProps<{ tasks: Task[]; disabled?: boolean; emptyText?: string }>(),
  { disabled: false, emptyText: 'Nothing here yet.' },
);
const emit = defineEmits<{ refresh: [] }>();

const offline = useOfflineStore();
const toast = useToastStore();
const ui = useUiStore();
const { conflict, error, busy, rename, complete, remove, overwrite, reload, dismissConflict, discard } =
  useTaskActions(plannerClient, new ActionStore(), () => offline.online && !props.disabled);

const interactiveDisabled = computed(() => props.disabled || !offline.online);

watch(
  () => conflict.value !== null,
  (open) => ui.setConflictOpen(open),
  { immediate: true },
);

onUnmounted(() => {
  ui.setConflictOpen(false);
});

const editingId = ref<string | null>(null);
const draft = ref('');
const focusNonce = ref(0);

const hidden = ref<Set<string>>(new Set());
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const UNDO_MS = 6000;

const visibleTasks = computed(() => props.tasks.filter((task) => !hidden.value.has(task.id)));

function hide(taskId: string): void {
  const next = new Set(hidden.value);
  next.add(taskId);
  hidden.value = next;
}

function unhide(taskId: string): void {
  const next = new Set(hidden.value);
  next.delete(taskId);
  hidden.value = next;
}

function startEdit(task: Task): void {
  if (interactiveDisabled.value) return;
  editingId.value = task.id;
  draft.value = task.title;
}

function updateDraft(value: string): void {
  draft.value = value;
}

function cancelEdit(): void {
  const id = editingId.value;
  if (id !== null) discard(`task:${id}:rename`);
  editingId.value = null;
  draft.value = '';
}

async function saveEdit(task: Task): Promise<void> {
  if (interactiveDisabled.value) return;
  const title = draft.value.trim();
  if (title.length === 0 || title === task.title) {
    cancelEdit();
    return;
  }
  try {
    const updated = await rename(task, title);
    if (updated !== null) {
      cancelEdit();
      emit('refresh');
    }
  } catch {
    // `error` already carries a user-facing message; keep the draft editable.
  }
}

async function onComplete(task: Task): Promise<void> {
  if (interactiveDisabled.value) return;
  try {
    const updated = await complete(task);
    if (updated !== null) emit('refresh');
  } catch {
    // `error` already carries a user-facing message.
  }
}

function onRemove(task: Task): void {
  if (interactiveDisabled.value) return;
  hide(task.id);
  toast.show(`Deleted "${task.title}"`, {
    action: { label: 'Undo', handler: () => undoDelete(task.id) },
    duration: UNDO_MS,
  });
  const timer = setTimeout(() => {
    deleteTimers.delete(task.id);
    void commitDelete(task);
  }, UNDO_MS);
  deleteTimers.set(task.id, timer);
}

function undoDelete(taskId: string): void {
  const timer = deleteTimers.get(taskId);
  if (timer !== undefined) {
    clearTimeout(timer);
    deleteTimers.delete(taskId);
  }
  unhide(taskId);
}

function cancelAllDeletes(reason: string): void {
  if (deleteTimers.size === 0) return;
  for (const [taskId, timer] of deleteTimers) {
    clearTimeout(timer);
    unhide(taskId);
  }
  deleteTimers.clear();
  toast.show(reason);
}

async function commitDelete(task: Task): Promise<void> {
  if (!offline.online || props.disabled) {
    unhide(task.id);
    toast.show('Deletion cancelled because editing is disabled.');
    return;
  }
  try {
    const deleted = await remove(task);
    if (deleted) emit('refresh');
    else unhide(task.id);
  } catch {
    unhide(task.id);
    toast.show('Could not delete the task. Please try again.', { tone: 'error' });
  }
}

watch(
  () => offline.online,
  (online) => {
    if (!online) cancelAllDeletes('Pending deletions were cancelled because you are offline.');
  },
);

async function onOverwrite(): Promise<void> {
  if (interactiveDisabled.value) return;
  const current = conflict.value;
  const currentDraft =
    current !== null && current.operation === 'rename' && editingId.value === current.taskId
      ? draft.value
      : null;
  try {
    await overwrite(currentDraft);
    if (conflict.value === null) {
      cancelEdit();
      emit('refresh');
    }
  } catch {
    // `error` already carries a user-facing message; conflict state is kept.
  }
}

async function onReload(): Promise<void> {
  try {
    await reload();
    if (conflict.value === null) {
      cancelEdit();
      emit('refresh');
    }
  } catch {
    toast.show('Could not reload the server version. Please try again.', { tone: 'error' });
  }
}

function onCancelConflict(): void {
  const current = conflict.value;
  dismissConflict();
  if (current?.operation === 'rename' && editingId.value === current.taskId) {
    focusNonce.value += 1;
  }
}
</script>

<template>
  <section class="task-list" :aria-busy="busy">
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <ul v-if="visibleTasks.length > 0" class="task-items">
      <TaskItem
        v-for="task in visibleTasks"
        :key="task.id"
        :task="task"
        :disabled="interactiveDisabled || conflict !== null"
        :pending="busy"
        :editing="editingId === task.id"
        :draft="draft"
        :focus-nonce="focusNonce"
        @start-edit="startEdit(task)"
        @update:draft="updateDraft"
        @save="saveEdit(task)"
        @cancel="cancelEdit"
        @complete="onComplete(task)"
        @remove="onRemove(task)"
      />
    </ul>
    <p v-else class="muted empty-state">{{ props.emptyText }}</p>

    <ConflictDialog
      v-if="conflict"
      :server-version="conflict.server.version"
      :server-title="conflict.server.title"
      :local-title="conflict.localTitle"
      :operation="conflict.operation"
      :disabled="interactiveDisabled"
      @reload="onReload"
      @overwrite="onOverwrite"
      @cancel="onCancelConflict"
    />
  </section>
</template>
