<script setup lang="ts">
import { computed, useId } from 'vue';
import { useRoute } from 'vue-router';
import UiIcon from '../ui/UiIcon.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import { t } from '../../i18n';
import { formatDuration, formatTimeRange, minutesBetween } from '../../i18n/format';
import { layoutClock } from '../../layout/clock';
import { useTodaySnapshot } from '../../layout/useTodaySnapshot';
import { useSessionStore } from '../../stores/session';

const props = defineProps<{ count: number }>();

const route = useRoute();
const sessions = useSessionStore();
const { today, isLoading } = useTodaySnapshot();
const headingId = `layout-next-up-${useId()}`;

// The block being worked on right now is not "next".
const currentBlockId = computed(() => sessions.active?.blockId ?? null);
const upcoming = computed(() => {
  const current = today.value;
  if (current === null) return [];
  const now = layoutClock().now();
  return current.blocks
    .filter(
      (block) =>
        block.status !== 'done' &&
        block.status !== 'skipped' &&
        block.status !== 'superseded' &&
        block.id !== currentBlockId.value &&
        Date.parse(block.endAt) > now,
    )
    .slice(0, props.count);
});
const onToday = computed(() => route.name === 'today');
</script>

<template>
  <section class="layout-panel" :aria-labelledby="headingId" data-panel="next-up">
    <h2 :id="headingId" class="layout-panel-title">
      <UiIcon name="clock" :size="18" />
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
          {{ formatTimeRange(block.startAt, block.endAt, today.timeZone) }}
          · {{ formatDuration(minutesBetween(block.startAt, block.endAt)) }}
        </span>
      </li>
    </ol>
    <p v-else class="muted layout-panel-empty">{{ t('layout.nextUp.empty') }}</p>
    <RouterLink v-if="!onToday" to="/today" class="layout-panel-link">{{ t('layout.nextUp.openToday') }}</RouterLink>
  </section>
</template>
