<script setup lang="ts">
import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { plannerClient, type Project, type Task } from '../api';
import { useOfflineStore } from '../stores/offline';
import TaskList from '../components/TaskList.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';

const props = defineProps<{ id: string }>();

const offline = useOfflineStore();
const queryClient = useQueryClient();

const projectsQuery = useQuery({
  queryKey: ['projects'],
  queryFn: () => plannerClient.listProjects(),
});

const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', 'project', props.id]),
  queryFn: () => plannerClient.listTasks({ projectId: props.id }),
});

const project = computed<Project | undefined>(() =>
  projectsQuery.data.value?.items.find((item) => item.id === props.id),
);
const tasks = computed<Task[]>(() => tasksQuery.data.value?.items ?? []);

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div class="page-heading">
        <p class="breadcrumb">
          <RouterLink to="/projects"><UiIcon name="arrow-left" :size="16" />Projects</RouterLink>
        </p>
        <h1>{{ project?.title ?? 'Project' }}</h1>
        <p v-if="tasksQuery.data.value" class="page-lede">
          {{ tasks.length }} task{{ tasks.length === 1 ? '' : 's' }}
        </p>
      </div>
    </header>

    <div v-if="tasksQuery.isLoading.value">
      <p class="visually-hidden" role="status">Loading tasks…</p>
      <UiSkeleton variant="card" :count="3" :lines="1" />
    </div>
    <UiBanner v-else-if="tasksQuery.isError.value" tone="error" class="error-panel">
      <p class="error-text" role="alert">Could not load project tasks.</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="tasksQuery.refetch()">Retry</UiButton>
      </template>
    </UiBanner>
    <TaskList
      v-else
      :tasks="tasks"
      :disabled="!offline.mutationsEnabled"
      empty-text="No tasks in this project yet."
      @refresh="refresh"
    />
  </section>
</template>
