<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient, type Project } from '../api';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { useTaskDirectory } from '../composables/useOverview';
import { t } from '../i18n';

/**
 * 프로젝트 (HOLO-02): each project is a card — its name and how many of its
 * tasks are still open. The whole card opens the project. The counts come
 * from the task list the other screens read (composables/useOverview.ts);
 * until it answers a card shows its name only.
 */
const { data, isLoading, isError, refetch } = useQuery({
  queryKey: ['projects'],
  queryFn: () => plannerClient.listProjects(),
});

const projects = computed<Project[]>(() => data.value?.items ?? []);
const directory = useTaskDirectory();

/** Open (not done) tasks per project; null until the task list has answered. */
const openCounts = computed(() => {
  const tasks = directory.data.value?.tasks;
  if (tasks === undefined) return null;
  const counts = new Map<string, number>();
  for (const task of tasks.values()) {
    if (task.status !== 'done') counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  }
  return counts;
});

/** The system Inbox project is labelled in the UI language, not by its stored title. */
function projectTitle(project: Project): string {
  return project.kind === 'inbox' ? t('nav.inbox') : project.title;
}
</script>

<template>
  <section class="page page--wide projects-page" data-projects>
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('projects.title') }}</h1>
        <p class="page-lede">{{ t('projects.lede') }}</p>
      </div>
    </header>

    <div v-if="isLoading">
      <p class="visually-hidden" role="status">{{ t('projects.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="1" />
    </div>
    <UiBanner v-else-if="isError" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('projects.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <ul v-else-if="projects.length > 0" class="project-list">
      <li
        v-for="project in projects"
        :key="project.id"
        class="card card--interactive project-item"
        :data-project="project.id"
      >
        <RouterLink :to="{ name: 'project', params: { id: project.id } }" class="project-link">
          <span class="project-icon" aria-hidden="true">
            <UiIcon :name="project.kind === 'inbox' ? 'inbox' : 'projects'" />
          </span>
          <span class="project-title">{{ projectTitle(project) }}</span>
        </RouterLink>
        <div class="project-foot">
          <p v-if="openCounts" class="project-count" data-project-open>
            <span class="project-count-number">{{ openCounts.get(project.id) ?? 0 }}</span>
            <span>{{ t('projects.openTasks') }}</span>
          </p>
          <UiBadge v-if="project.archived" class="task-status">{{ t('projects.archived') }}</UiBadge>
        </div>
      </li>
    </ul>
    <UiEmptyState v-else icon="projects" class="card" :title="t('projects.empty')" />
  </section>
</template>
