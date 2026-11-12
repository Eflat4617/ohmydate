<script setup lang="ts">
import { computed, useId } from 'vue';
import { focusContextFor } from '../../composables/focusContext';
import { t } from '../../i18n';
import { useSessionStore } from '../../stores/session';

const props = defineProps<{ sessionId: string }>();

const sessions = useSessionStore();
const headingId = `layout-active-session-${useId()}`;
const title = computed(() => {
  const current = sessions.get(props.sessionId);
  if (current === null) return t('layout.currentTask.fallback');
  return focusContextFor(sessions.ownerId, current.blockId, current.taskId)?.title ?? t('layout.currentTask.fallback');
});
</script>

<template>
  <section class="layout-panel layout-panel--accent" :aria-labelledby="headingId" data-panel="active-session">
    <h2 :id="headingId" class="layout-panel-title">
      <span>{{ t('layout.activeSession.title') }}</span>
    </h2>
    <p class="layout-current-title">{{ title }}</p>
    <RouterLink :to="`/focus/${sessionId}`" class="btn btn--primary btn--sm layout-panel-action">
      {{ t('layout.activeSession.back') }}
    </RouterLink>
  </section>
</template>
