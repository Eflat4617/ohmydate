<script setup lang="ts">
import { useOfflineStore } from '../stores/offline';

const offline = useOfflineStore();
</script>

<template>
  <div v-if="!offline.online" class="offline-banner" role="status" aria-live="polite">
    You are offline. Viewing cached data; editing is disabled until the connection returns.
  </div>
</template>
