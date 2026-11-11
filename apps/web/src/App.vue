<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';

const route = useRoute();
const blank = computed(() => route.meta.layout === 'blank');
const viewKey = computed(() => {
  if (route.name === 'plan-session') {
    return `plan-session:${String(route.params['sessionId'] ?? '')}`;
  }
  if (route.name === 'plan-new') return 'plan-new';
  return typeof route.name === 'string' ? route.name : route.fullPath;
});
</script>

<template>
  <RouterView v-if="blank" :key="viewKey" />
  <AppShell v-else>
    <RouterView :key="viewKey" />
  </AppShell>
</template>
