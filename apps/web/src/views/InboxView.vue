<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ActionStore, plannerClient, type Task } from '../api';
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

const projectsQuery = useQuery({
  queryKey: ['projects'],
  queryFn: () => plannerClient.listProjects(),
});

const inboxProjectId = computed(() => {
  const project = projectsQuery.data.value?.items.find(
    (item) => item.title.trim().toLowerCase() === 'inbox',
  );
  return project?.id;
});

const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', 'inbox', inboxProjectId.value ?? null]),
  queryFn: () =>
    plannerClient.listTasks(
      inboxProjectId.value === undefined ? {} : { projectId: inboxProjectId.value },
    ),
  enabled: computed(() => inboxProjectId.value !== undefined),
});

const tasks = computed<Task[]>(() => tasksQuery.data.value?.items ?? []);
const isLoading = computed(
  () =>
    projectsQuery.isLoading.value ||
    (inboxProjectId.value !== undefined && tasksQuery.isLoading.value),
);
const isError = computed(() => projectsQuery.isError.value || tasksQuery.isError.value);

async function refetchAll(): Promise<void> {
  await Promise.all([projectsQuery.refetch(), tasksQuery.refetch()]);
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

    <QuickAddForm
      ref="quickAdd"
      :disabled="!offline.mutationsEnabled || createBusy"
      @submit="addTask"
    />
    <p v-if="createError" class="error-text" role="alert">{{ createError }}</p>

    <p v-if="!offline.mutationsEnabled" class="offline-note" role="status">
      Read-only while offline.
    </p>

    <p v-if="isLoading" class="muted">Loading tasks…</p>
    <div v-else-if="isError" class="error-panel">
      <p class="error-text" role="alert">Could not load tasks.</p>
      <button type="button" @click="refetchAll()">Retry</button>
    </div>
    <TaskList v-else :tasks="tasks" :disabled="!offline.mutationsEnabled" @refresh="refresh" />
  </section>
</template>
