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
import { t } from '../i18n';

const { data, isLoading, isError, refetch } = useQuery({
  queryKey: ['projects'],
  queryFn: () => plannerClient.listProjects(),
});

const projects = computed<Project[]>(() => data.value?.items ?? []);

/** The system Inbox project is labelled in the UI language, not by its stored title. */
function projectTitle(project: Project): string {
  return project.kind === 'inbox' ? t('nav.inbox') : project.title;
}
</script>

<template>
  <section class="page">
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
      <li v-for="project in projects" :key="project.id" class="project-item">
        <RouterLink :to="{ name: 'project', params: { id: project.id } }" class="project-link">
          <span class="project-icon" aria-hidden="true">
            <UiIcon :name="project.kind === 'inbox' ? 'inbox' : 'projects'" />
          </span>
          <span class="project-title">{{ projectTitle(project) }}</span>
          <UiIcon name="chevron-right" class="project-chevron" />
        </RouterLink>
        <UiBadge v-if="project.archived" class="task-status">{{ t('projects.archived') }}</UiBadge>
      </li>
    </ul>
    <UiEmptyState v-else icon="projects" :title="t('projects.empty')" />
  </section>
</template>
