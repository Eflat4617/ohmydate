<script setup lang="ts">
import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { plannerClient, type Project, type Task } from '../api';
import { useOfflineStore } from '../stores/offline';
import TaskList from '../components/TaskList.vue';

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
      <div>
        <p class="breadcrumb">
          <RouterLink to="/projects">Projects</RouterLink>
        </p>
        <h1>{{ project?.title ?? 'Project' }}</h1>
      </div>
    </header>

    <p v-if="tasksQuery.isLoading.value" class="muted">Loading tasks…</p>
    <div v-else-if="tasksQuery.isError.value" class="error-panel">
      <p class="error-text" role="alert">Could not load project tasks.</p>
      <button type="button" @click="tasksQuery.refetch()">Retry</button>
    </div>
    <TaskList
      v-else
      :tasks="tasks"
      :disabled="!offline.mutationsEnabled"
      empty-text="No tasks in this project yet."
      @refresh="refresh"
    />
  </section>
</template>
