<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';
import AdaptiveFrame from './components/layout/AdaptiveFrame.vue';
import { routeKindOf } from './layout/routes';

const route = useRoute();
const blank = computed(() => route.meta.layout === 'blank');
// Today, Focus, planning and notes screens are laid out by the adaptive
// layout (M6-02); every other screen renders as before.
const adaptive = computed(() => routeKindOf(route) !== 'other');
const viewKey = computed(() => {
  if (route.name === 'plan-session') {
    return `plan-session:${String(route.params['sessionId'] ?? '')}`;
  }
  if (route.name === 'plan-new') return 'plan-new';
  // List, new note and open note are one notes workspace (no remount).
  if (typeof route.name === 'string' && (route.name === 'notes' || route.name.startsWith('notes-'))) return 'notes';
  return typeof route.name === 'string' ? route.name : route.fullPath;
});
</script>

<template>
  <RouterView v-if="blank" :key="viewKey" />
  <AppShell v-else>
    <AdaptiveFrame v-if="adaptive">
      <RouterView :key="viewKey" />
    </AdaptiveFrame>
    <RouterView v-else :key="viewKey" />
  </AppShell>
</template>
