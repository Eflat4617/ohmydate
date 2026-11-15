<script setup lang="ts">
import { computed } from 'vue';
import type { Today } from '../../api';
import { useWeekSessions } from '../../composables/useOverview';
import { dayRecap } from '../../domain/recap';
import { weekRange } from '../../domain/overview';
import { addDaysToDate, startOfWeek } from '../../domain/time';
import { t, tp } from '../../i18n';
import { formatDuration } from '../../i18n/format';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 오늘 정리 (HOLO-04, FLOW.md §2 ⑤): what 개요 says when the day's blocks are
 * over, or when the owner said "오늘은 여기까지". The day against its plan —
 * blocks finished, time focused — in one card, and the next step as the
 * page's one filled button: 내일 미리 보기 (tomorrow in the planner).
 *
 * Every figure is the owner's own record (domain/recap.ts). With no record of
 * focus today it says so and draws nothing.
 */
const props = defineProps<{
  plan: Today;
  /** Today in the owner's zone. */
  today: string;
  timeZone: string;
  ready: boolean;
  nowMs: number;
}>();

const range = computed(() => (props.ready ? weekRange(startOfWeek(props.today), props.timeZone) : null));
// The same lookup (and cache entry) the 진행 card reads for this week.
const sessions = useWeekSessions(range);

const recap = computed(() =>
  dayRecap({
    blocks: props.plan.blocks,
    sessions: sessions.data.value?.sessions ?? [],
    date: props.today,
    timeZone: props.timeZone,
    nowMs: props.nowMs,
  }),
);
const loaded = computed(() => sessions.data.value !== undefined);

const lesson = computed(() => {
  const value = recap.value;
  if (value.focusedMin === 0) return null;
  if (value.deltaMin === null) return null;
  if (Math.abs(value.deltaMin) < 5) return t('recap.lesson.even');
  return value.deltaMin > 0
    ? t('recap.lesson.more', { duration: formatDuration(value.deltaMin) })
    : t('recap.lesson.less', { duration: formatDuration(-value.deltaMin) });
});

const tomorrow = computed(() => addDaysToDate(props.today, 1));
</script>

<template>
  <UiCard class="plan-next day-recap" aria-labelledby="day-recap-title" data-day-recap>
    <div class="plan-next-text">
      <h2 id="day-recap-title" class="plan-next-title">
        <UiIcon name="ring" :size="18" />{{ t('recap.title') }}
      </h2>
      <p class="plan-next-today" data-recap-blocks>
        {{ recap.blockCount > 0 ? t('recap.blocks', { done: recap.doneCount, total: recap.blockCount }) : t('recap.noBlocks') }}
      </p>
      <!-- Not enough of a record: say so, and draw nothing (FLOW §2 ⑤). -->
      <p v-if="loaded && recap.focusedMin === 0" class="plan-next-first" data-recap-empty>{{ t('recap.noFocus') }}</p>
      <template v-else-if="loaded">
        <p class="plan-next-first tabular" data-recap-focus>
          {{
            recap.plannedMin > 0
              ? t('recap.focusOfPlan', { focused: formatDuration(recap.focusedMin), planned: formatDuration(recap.plannedMin) })
              : t('recap.focus', { focused: formatDuration(recap.focusedMin) })
          }}
          <span class="day-recap-sessions">· {{ tp('recap.sessions', recap.sessionCount) }}</span>
        </p>
        <p v-if="lesson" class="plan-next-note" data-recap-lesson>{{ lesson }}</p>
      </template>
    </div>
    <div class="plan-next-actions">
      <RouterLink class="btn btn--primary" :to="`/planner?view=day&d=${tomorrow}`" data-primary="tomorrow" data-recap-tomorrow>
        <UiIcon name="month" :size="18" class="btn-icon" />{{ t('recap.tomorrow') }}
      </RouterLink>
      <RouterLink class="plan-next-link" to="/insights" data-recap-insights>{{ t('recap.insights') }}</RouterLink>
    </div>
  </UiCard>
</template>
