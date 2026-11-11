<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ActionStore, findInboxProject, plannerClient, type Task } from '../api';
import { useTaskActions } from '../composables/useTaskActions';
import { useOfflineStore } from '../stores/offline';
import { useUiStore } from '../stores/ui';
import QuickAddForm from '../components/QuickAddForm.vue';
import TaskList from '../components/TaskList.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';

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
const openCount = computed(() => tasks.value.filter((task) => task.status !== 'done').length);
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
      <div class="page-heading">
        <h1>Inbox</h1>
        <p class="page-lede">Capture now, organise later.</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="offline-note" role="status">
          Read-only while offline.
        </UiBadge>
        <UiBadge v-else-if="openCount > 0" tone="outline">{{ openCount }} open</UiBadge>
      </div>
    </header>

    <QuickAddForm ref="quickAdd" :disabled="quickAddDisabled" @submit="addTask" />
    <UiBanner v-if="createError" tone="error" role="alert">{{ createError }}</UiBanner>

    <div v-if="isLoading" class="list-loading">
      <p class="visually-hidden" role="status">Loading tasks…</p>
      <UiSkeleton variant="card" :count="3" :lines="1" />
    </div>
    <UiBanner v-else-if="isError" tone="error" class="error-panel">
      <p class="error-text" role="alert">Could not load tasks.</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="refetchAll()">Retry</UiButton>
      </template>
    </UiBanner>
    <UiBanner v-else-if="inboxMissing" tone="warn" class="error-panel">
      <p class="error-text" role="alert">
        Inbox project is missing. Tasks cannot be shown until it exists.
      </p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="refetchAll()">Retry</UiButton>
      </template>
    </UiBanner>
    <TaskList
      v-else
      :tasks="tasks"
      :disabled="!offline.mutationsEnabled"
      empty-text="Inbox zero. Add the next thing on your mind above."
      @refresh="refresh"
    />
  </section>
</template>
