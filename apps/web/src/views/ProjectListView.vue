<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient, type Project } from '../api';

const { data, isLoading, isError, refetch } = useQuery({
  queryKey: ['projects'],
  queryFn: () => plannerClient.listProjects(),
});

const projects = computed<Project[]>(() => data.value?.items ?? []);
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>Projects</h1>
        <p class="muted">Work grouped by outcome.</p>
      </div>
    </header>

    <p v-if="isLoading" class="muted">Loading projects…</p>
    <div v-else-if="isError" class="error-panel">
      <p class="error-text" role="alert">Could not load projects.</p>
      <button type="button" @click="refetch()">Retry</button>
    </div>
    <ul v-else-if="projects.length > 0" class="project-list">
      <li v-for="project in projects" :key="project.id">
        <RouterLink :to="{ name: 'project', params: { id: project.id } }">
          {{ project.title }}
        </RouterLink>
        <span v-if="project.archived" class="task-status">Archived</span>
      </li>
    </ul>
    <p v-else class="muted empty-state">No projects yet.</p>
  </section>
</template>
