<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';

const route = useRoute();
const blank = computed(() => route.meta.layout === 'blank');
</script>

<template>
  <RouterView v-if="blank" />
  <AppShell v-else>
    <RouterView />
  </AppShell>
</template>
