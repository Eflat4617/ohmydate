<script setup lang="ts">
import { useOfflineStore } from '../stores/offline';
import UiBanner from './ui/UiBanner.vue';

const offline = useOfflineStore();
</script>

<template>
  <UiBanner
    v-if="!offline.online"
    tone="offline"
    class="offline-banner"
    role="status"
    aria-live="polite"
  >
    You are offline. Viewing cached data; editing is disabled until the connection returns.
  </UiBanner>
</template>
