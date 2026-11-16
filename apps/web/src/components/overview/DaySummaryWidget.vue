<script setup lang="ts">
import { anyNotReady } from '../../platform/notReady';
import { computed } from 'vue';
import type { Today } from '../../api';
import RingChart, { type RingSegment } from '../charts/RingChart.vue';
import UiDeadlineFlag from '../ui/UiDeadlineFlag.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import { useWeekSessions } from '../../composables/useOverview';
import { useDayAgenda } from '../../composables/usePlannerRange';
import {
  dayRange,
  daySegments,
  focusByDay,
  minutesOfSeconds,
  minutesWithin,
  remainingPlannedMinutes,
  weekRange,
  type DayKind,
} from '../../domain/overview';
import { localParts, startOfWeek, weekDates } from '../../domain/time';
import { t, tp } from '../../i18n';
import { formatDuration, formatPercent } from '../../i18n/format';
import OverviewCard from './OverviewCard.vue';

/**
 * 오늘 요약: today's time by kind as a ring — focus blocks still to do, 약속,
 * and focus already done — with each kind's duration in the legend, and the
 * number of tasks due today under it.
 */
const props = defineProps<{
  /** Today's plan; null while it loads or after it failed. */
  plan: Today | null;
  planLoading: boolean;
  planError: boolean;
  /** Desktop: the core does not serve today's plan yet. */
  planNotReady?: boolean;
  today: string;
  timeZone: string;
  ready: boolean;
  nowMs: number;
}>();

const emit = defineEmits<{ 'retry-plan': [] }>();

const day = computed(() => (props.ready ? dayRange(props.today, props.timeZone) : null));
const week = computed(() => (props.ready ? weekRange(startOfWeek(props.today), props.timeZone) : null));
const agenda = useDayAgenda(day);
const sessions = useWeekSessions(week);

const commitmentMinutes = computed(() => {
  const range = day.value;
  if (range === null) return 0;
  const occurrences = (agenda.data.value?.commitments ?? []).flatMap((commitment) => commitment.occurrences ?? []);
  return minutesWithin(occurrences, range.from, range.to);
});

const focusedMinutes = computed(() => {
  const weekStart = startOfWeek(props.today);
  const index = weekDates(weekStart).indexOf(props.today);
  const buckets = focusByDay(sessions.data.value?.sessions ?? [], weekStart, props.timeZone, props.nowMs);
  return minutesOfSeconds(buckets[index] ?? 0);
});

const SERIES: Record<DayKind, 1 | 2 | 3> = { planned: 1, commitment: 2, focused: 3 };

const segments = computed<RingSegment[]>(() =>
  daySegments({
    remainingPlannedMin: remainingPlannedMinutes(props.plan?.blocks ?? []),
    commitmentMin: commitmentMinutes.value,
    focusedMin: focusedMinutes.value,
  }).map((segment) => ({
    label: t(`overview.summary.${segment.kind}`),
    value: segment.minutes,
    display: formatDuration(segment.minutes),
    series: SERIES[segment.kind],
  })),
);
const totalMinutes = computed(() => segments.value.reduce((sum, segment) => sum + segment.value, 0));

const dueCount = computed(
  () =>
    (agenda.data.value?.tasks ?? []).filter(
      (task) =>
        task.status !== 'done' &&
        task.dueAt !== undefined &&
        Number.isFinite(Date.parse(task.dueAt)) &&
        localParts(task.dueAt, props.timeZone).date === props.today,
    ).length,
);

const state = computed(() => {
  if (!props.ready || props.planLoading || agenda.isLoading.value || sessions.isLoading.value) return 'loading' as const;
  if (props.planNotReady === true || anyNotReady(agenda.error.value, sessions.error.value)) return 'not-ready' as const;
  if (props.planError || agenda.isError.value || sessions.isError.value) return 'error' as const;
  return 'ready' as const;
});

function retry(): void {
  if (props.planError) emit('retry-plan');
  if (agenda.isError.value) void agenda.refetch();
  if (sessions.isError.value) void sessions.refetch();
}

function share(value: number): string {
  return formatPercent(value, 0);
}
</script>

<template>
  <OverviewCard
    widget="summary"
    icon="ring"
    :title="t('overview.summary.title')"
    to="/planner?view=day"
    :open-label="t('overview.summary.open')"
    :state="state"
    @retry="retry"
  >
    <template #skeleton>
      <span class="skeleton skeleton--circle overview-skeleton-ring"></span>
      <span v-for="row in 3" :key="row" class="skeleton skeleton--text overview-skeleton-row"></span>
    </template>

    <RingChart
      v-if="segments.length > 0"
      :title="t('overview.summary.legend')"
      :segments="segments"
      :total="formatDuration(totalMinutes)"
      :total-label="t('overview.summary.total')"
      :format-share="share"
    />
    <UiEmptyState v-else icon="ring" compact :title="t('overview.summary.empty')" data-empty>
      {{ t('overview.summary.emptyBody') }}
    </UiEmptyState>
    <p class="summary-due" :data-due="dueCount">
      <UiDeadlineFlag :size="13" />
      <span>{{ dueCount > 0 ? tp('overview.summary.due', dueCount) : t('overview.summary.dueNone') }}</span>
    </p>
  </OverviewCard>
</template>
