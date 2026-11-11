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
import { t, tp } from '../i18n';

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

const heading = computed(() => {
  const current = project.value;
  if (current === undefined) return t('projects.fallbackTitle');
  return current.kind === 'inbox' ? t('nav.inbox') : current.title;
});

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div class="page-heading">
        <p class="breadcrumb">
          <RouterLink to="/projects"><UiIcon name="arrow-left" :size="16" />{{ t('projects.back') }}</RouterLink>
        </p>
        <h1>{{ heading }}</h1>
        <p v-if="tasksQuery.data.value" class="page-lede">{{ tp('projects.taskCount', tasks.length) }}</p>
      </div>
    </header>

    <div v-if="tasksQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('projects.tasksLoading') }}</p>
      <UiSkeleton variant="card" :count="3" :lines="1" />
    </div>
    <UiBanner v-else-if="tasksQuery.isError.value" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('projects.tasksLoadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="tasksQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <TaskList
      v-else
      :tasks="tasks"
      :disabled="!offline.mutationsEnabled"
      :empty-text="t('projects.tasksEmpty')"
      @refresh="refresh"
    />
  </section>
</template>
