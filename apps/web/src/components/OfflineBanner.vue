<script setup lang="ts">
import { useOfflineStore } from '../stores/offline';
import UiBanner from './ui/UiBanner.vue';
import { t } from '../i18n';

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
    {{ t('offline.banner') }}
  </UiBanner>
</template>
