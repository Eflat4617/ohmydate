<script setup lang="ts">
import { computed, useId } from 'vue';
import { focusContextFor } from '../../composables/focusContext';
import { t } from '../../i18n';
import { formatDuration, formatTimeRange, minutesBetween } from '../../i18n/format';
import { useSessionStore } from '../../stores/session';

const props = defineProps<{ sessionId: string }>();

const sessions = useSessionStore();
const headingId = `layout-current-task-${useId()}`;
const session = computed(() => sessions.get(props.sessionId));
const context = computed(() => {
  const current = session.value;
  return current === null ? null : focusContextFor(sessions.ownerId, current.blockId, current.taskId);
});
</script>

<template>
  <section class="layout-panel" :aria-labelledby="headingId" data-panel="current-task">
    <h2 :id="headingId" class="layout-panel-title">
      <span>{{ t('layout.currentTask.title') }}</span>
    </h2>
    <template v-if="context">
      <p class="layout-current-title">{{ context.title }}</p>
      <p class="layout-current-meta tabular">
        {{
          t('focus.planned', {
            range: formatTimeRange(context.startAt, context.endAt, context.timeZone),
            duration: formatDuration(minutesBetween(context.startAt, context.endAt)),
          })
        }}
      </p>
    </template>
    <template v-else>
      <p class="layout-current-title">{{ t('layout.currentTask.fallback') }}</p>
      <p class="muted layout-current-meta">{{ t('layout.currentTask.unknown') }}</p>
    </template>
  </section>
</template>
