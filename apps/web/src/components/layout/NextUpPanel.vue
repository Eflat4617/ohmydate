<script setup lang="ts">
import { computed, useId } from 'vue';
import { useRoute } from 'vue-router';
import UiSkeleton from '../ui/UiSkeleton.vue';
import { t } from '../../i18n';
import { formatDuration, formatTimeRange, minutesBetween } from '../../i18n/format';
import { useLayoutNow } from '../../layout/now';
import { useTodaySnapshot } from '../../layout/useTodaySnapshot';
import { useSessionStore } from '../../stores/session';

const props = defineProps<{ count: number }>();

const route = useRoute();
const sessions = useSessionStore();
const { today, isLoading } = useTodaySnapshot();
// Reactive: a block drops out once the shared clock passes its end.
const now = useLayoutNow();
const headingId = `layout-next-up-${useId()}`;

// The block being worked on right now is not "next".
const currentBlockId = computed(() => sessions.active?.blockId ?? null);
const upcoming = computed(() => {
  const current = today.value;
  if (current === null) return [];
  const at = now.value;
  return current.blocks
    .filter(
      (block) =>
        block.status !== 'done' &&
        block.status !== 'skipped' &&
        block.status !== 'superseded' &&
        block.id !== currentBlockId.value &&
        Date.parse(block.endAt) > at,
    )
    .slice(0, props.count);
});
const onToday = computed(() => route.name === 'today');
</script>

<template>
  <section class="layout-panel" :aria-labelledby="headingId" data-panel="next-up">
    <h2 :id="headingId" class="layout-panel-title">
      <span>{{ t('layout.nextUp.title') }}</span>
    </h2>
    <template v-if="isLoading && today === null">
      <p class="visually-hidden" role="status">{{ t('layout.nextUp.loading') }}</p>
      <UiSkeleton variant="lines" :lines="2" />
    </template>
    <ol v-else-if="upcoming.length > 0 && today" class="layout-next-list">
      <li v-for="block in upcoming" :key="block.id" class="layout-next-item">
        <span class="layout-next-title">{{ block.title }}</span>
        <span class="layout-next-time tabular">
          <span>{{ formatTimeRange(block.startAt, block.endAt, today.timeZone) }}</span>
          <span>{{ formatDuration(minutesBetween(block.startAt, block.endAt)) }}</span>
        </span>
      </li>
    </ol>
    <p v-else class="muted layout-panel-empty">{{ t('layout.nextUp.empty') }}</p>
    <RouterLink v-if="!onToday" to="/today" class="layout-panel-link">{{ t('layout.nextUp.openToday') }}</RouterLink>
  </section>
</template>
