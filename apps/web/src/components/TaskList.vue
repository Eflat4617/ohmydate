<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Task } from '../api';
import { useTaskActions } from '../composables/useTaskActions';
import { useToastStore } from '../stores/toast';
import ConflictDialog from './ConflictDialog.vue';
import TaskItem from './TaskItem.vue';

const props = withDefaults(
  defineProps<{ tasks: Task[]; disabled?: boolean; emptyText?: string }>(),
  { disabled: false, emptyText: 'Nothing here yet.' },
);
const emit = defineEmits<{ refresh: [] }>();

const toast = useToastStore();
const { conflict, error, busy, rename, complete, remove, overwrite, reload, dismissConflict } =
  useTaskActions();

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

async function onRename(task: Task, title: string): Promise<void> {
  try {
    const updated = await rename(task, title);
    if (updated !== null) emit('refresh');
  } catch {
    // `error` already carries a user-facing message.
  }
}

async function onComplete(task: Task): Promise<void> {
  try {
    await complete(task);
    emit('refresh');
  } catch {
    // `error` already carries a user-facing message.
  }
}

function onRemove(task: Task): void {
  if (props.disabled) return;
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

async function commitDelete(task: Task): Promise<void> {
  try {
    await remove(task);
    emit('refresh');
  } catch {
    unhide(task.id);
    toast.show('Could not delete the task. Please try again.', { tone: 'error' });
  }
}

async function onOverwrite(): Promise<void> {
  try {
    const updated = await overwrite();
    if (updated !== null) emit('refresh');
  } catch {
    // `error` already carries a user-facing message.
  }
}

async function onReload(): Promise<void> {
  try {
    const fresh = await reload();
    if (fresh !== null) emit('refresh');
  } catch {
    // `error` already carries a user-facing message.
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
        :disabled="props.disabled"
        @rename="onRename(task, $event)"
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
      @reload="onReload"
      @overwrite="onOverwrite"
      @cancel="dismissConflict"
    />
  </section>
</template>
