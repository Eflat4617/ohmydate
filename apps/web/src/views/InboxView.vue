<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ActionStore, findInboxProject, plannerClient, type Task } from '../api';
import { useTaskActions } from '../composables/useTaskActions';
import { useOfflineStore } from '../stores/offline';
import { useUiStore } from '../stores/ui';
import QuickAddForm from '../components/QuickAddForm.vue';
import TaskList from '../components/TaskList.vue';

const offline = useOfflineStore();
const ui = useUiStore();
const queryClient = useQueryClient();
const quickAdd = ref<InstanceType<typeof QuickAddForm> | null>(null);
const {
  create,
  busy: createBusy,
  error: createError,
} = useTaskActions(plannerClient, new ActionStore(), () => offline.online);

const inboxQuery = useQuery({
  queryKey: ['projects', 'inbox'],
  queryFn: () => findInboxProject(plannerClient),
});

const inboxProject = computed(() => inboxQuery.data.value ?? undefined);
const inboxProjectId = computed(() => inboxProject.value?.id);
const inboxMissing = computed(
  () => inboxQuery.isSuccess.value && inboxQuery.data.value === null,
);

const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', 'inbox', inboxProjectId.value ?? 'missing']),
  queryFn: () => {
    const projectId = inboxProjectId.value;
    if (projectId === undefined) throw new Error('Inbox project is missing');
    return plannerClient.listTasks({ projectId });
  },
  enabled: computed(() => inboxProjectId.value !== undefined),
});

const tasks = computed<Task[]>(() => tasksQuery.data.value?.items ?? []);
const isLoading = computed(
  () =>
    inboxQuery.isLoading.value ||
    (inboxProjectId.value !== undefined && tasksQuery.isLoading.value),
);
const isError = computed(() => inboxQuery.isError.value || tasksQuery.isError.value);
const quickAddDisabled = computed(
  () => !offline.mutationsEnabled || createBusy.value,
);

async function refetchAll(): Promise<void> {
  const pending: Promise<unknown>[] = [inboxQuery.refetch()];
  if (inboxProjectId.value !== undefined) pending.push(tasksQuery.refetch());
  await Promise.all(pending);
}

watch(
  () => ui.newTaskRequest,
  () => {
    void nextTick().then(() => quickAdd.value?.focus());
  },
);

async function addTask(title: string): Promise<void> {
  if (!offline.mutationsEnabled) return;
  try {
    await create(title);
    quickAdd.value?.clear();
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
  } catch {
    // `createError` carries the user-facing message and the form keeps its text.
  }
}

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>Inbox</h1>
        <p class="muted">Capture now, organise later.</p>
      </div>
    </header>

    <QuickAddForm ref="quickAdd" :disabled="quickAddDisabled" @submit="addTask" />
    <p v-if="createError" class="error-text" role="alert">{{ createError }}</p>

    <p v-if="!offline.mutationsEnabled" class="offline-note" role="status">
      Read-only while offline.
    </p>

    <p v-if="isLoading" class="muted">Loading tasks…</p>
    <div v-else-if="isError" class="error-panel">
      <p class="error-text" role="alert">Could not load tasks.</p>
      <button type="button" @click="refetchAll()">Retry</button>
    </div>
    <div v-else-if="inboxMissing" class="error-panel">
      <p class="error-text" role="alert">
        Inbox project is missing. Tasks cannot be shown until it exists.
      </p>
      <button type="button" @click="refetchAll()">Retry</button>
    </div>
    <TaskList v-else :tasks="tasks" :disabled="!offline.mutationsEnabled" @refresh="refresh" />
  </section>
</template>
