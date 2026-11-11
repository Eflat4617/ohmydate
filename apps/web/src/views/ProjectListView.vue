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

const { data, isLoading, isError, refetch } = useQuery({
  queryKey: ['projects'],
  queryFn: () => plannerClient.listProjects(),
});

const projects = computed<Project[]>(() => data.value?.items ?? []);
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div class="page-heading">
        <h1>Projects</h1>
        <p class="page-lede">Work grouped by outcome.</p>
      </div>
    </header>

    <div v-if="isLoading">
      <p class="visually-hidden" role="status">Loading projects…</p>
      <UiSkeleton variant="card" :count="2" :lines="1" />
    </div>
    <UiBanner v-else-if="isError" tone="error" class="error-panel">
      <p class="error-text" role="alert">Could not load projects.</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="refetch()">Retry</UiButton>
      </template>
    </UiBanner>
    <ul v-else-if="projects.length > 0" class="project-list">
      <li v-for="project in projects" :key="project.id" class="project-item">
        <RouterLink :to="{ name: 'project', params: { id: project.id } }" class="project-link">
          <span class="project-icon" aria-hidden="true">
            <UiIcon :name="project.kind === 'inbox' ? 'inbox' : 'projects'" />
          </span>
          <span class="project-title">{{ project.title }}</span>
          <UiIcon name="chevron-right" class="project-chevron" />
        </RouterLink>
        <UiBadge v-if="project.archived" class="task-status">Archived</UiBadge>
      </li>
    </ul>
    <UiEmptyState v-else icon="projects" title="No projects yet." />
  </section>
</template>
