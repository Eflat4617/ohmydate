<script setup lang="ts">
import { useId } from 'vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIcon from '../ui/UiIcon.vue';
import { t } from '../../i18n';

/**
 * Placeholder region for notes linked to the current work. M6-03 fills it
 * from the notes API; until then it always shows the empty state.
 */
defineProps<{ limit: number }>();

const headingId = `layout-related-notes-${useId()}`;
</script>

<template>
  <section class="layout-panel" :aria-labelledby="headingId" data-panel="related-notes">
    <h2 :id="headingId" class="layout-panel-title">
      <UiIcon name="leaf" :size="18" />
      <span>{{ t('layout.relatedNotes.title') }}</span>
    </h2>
    <UiEmptyState compact :icon="null" :title="t('layout.relatedNotes.emptyTitle')">
      <p>{{ t('layout.relatedNotes.emptyBody', { limit }) }}</p>
    </UiEmptyState>
  </section>
</template>
