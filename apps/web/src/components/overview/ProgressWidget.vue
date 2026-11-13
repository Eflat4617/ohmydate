<script setup lang="ts">
import { computed } from 'vue';
import BarWeekChart from '../charts/BarWeekChart.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import { useWeekSessions } from '../../composables/useOverview';
import { focusByDay, minutesOfSeconds, planDeltaMinutes, totalSeconds, weekRange } from '../../domain/overview';
import { addDaysToDate, weekDates } from '../../domain/time';
import { t } from '../../i18n';
import {
  formatCivilDate,
  formatCivilDateRange,
  formatCivilWeekday,
  formatDuration,
  formatSignedDuration,
} from '../../i18n/format';
import DurationNumeral from './DurationNumeral.vue';
import OverviewCard from './OverviewCard.vue';

/**
 * 진행: focused time per day of the shown week (Monday to Sunday), from the
 * user's work sessions by the local day each one started in the owner's zone.
 * Today's bar is the lime one; it carries today's focused time and, when both
 * exist, how that compares with what was planned for today.
 */
const props = defineProps<{
  /** Monday of the week on show. */
  weekStart: string;
  /** Today in the owner's zone. */
  today: string;
  timeZone: string;
  /** False until the owner's zone is known: nothing is read before that. */
  ready: boolean;
  nowMs: number;
  /** Minutes planned for today, or null while Today has not loaded. */
  plannedTodayMin: number | null;
}>();

const range = computed(() => (props.ready ? weekRange(props.weekStart, props.timeZone) : null));
const query = useWeekSessions(range);

const days = computed(() => weekDates(props.weekStart));
const isThisWeek = computed(() => days.value.includes(props.today));
const todayIndex = computed(() => {
  const index = days.value.indexOf(props.today);
  return index === -1 ? null : index;
});

const seconds = computed(() =>
  focusByDay(query.data.value?.sessions ?? [], props.weekStart, props.timeZone, props.nowMs),
);
/** Minutes per day; a day that has not come yet has no value (not a zero). */
const values = computed(() =>
  seconds.value.map((value, index) => ((days.value[index] ?? '') > props.today ? null : minutesOfSeconds(value))),
);
const totalMinutes = computed(() => minutesOfSeconds(totalSeconds(seconds.value)));
const rangeText = computed(() => formatCivilDateRange(props.weekStart, addDaysToDate(props.weekStart, 6)));

const slots = computed(() =>
  days.value.map((date) => ({ label: formatCivilWeekday(date), name: formatCivilDate(date) })),
);

const todaySeconds = computed(() => (todayIndex.value === null ? 0 : (seconds.value[todayIndex.value] ?? 0)));
const callout = computed(() =>
  todayIndex.value === null
    ? null
    : { value: formatDuration(minutesOfSeconds(todaySeconds.value)), note: formatCivilDate(props.today) },
);
const chip = computed(() => {
  if (todayIndex.value === null || props.plannedTodayMin === null) return null;
  const delta = planDeltaMinutes(todaySeconds.value, props.plannedTodayMin);
  if (delta === null) return null;
  return delta === 0 ? t('overview.progress.onPlan') : t('overview.progress.vsPlan', { delta: formatSignedDuration(delta) });
});

const state = computed(() => {
  if (!props.ready || query.isLoading.value) return 'loading' as const;
  if (query.isError.value) return 'error' as const;
  return 'ready' as const;
});
</script>

<template>
  <OverviewCard
    widget="progress"
    icon="bolt"
    :title="t('overview.progress.title')"
    to="/patterns"
    :open-label="t('overview.progress.open')"
    :state="state"
    @retry="query.refetch()"
  >
    <template #skeleton>
      <span class="skeleton overview-skeleton-number"></span>
      <span class="skeleton skeleton--text overview-skeleton-caption"></span>
      <div class="overview-skeleton-bars">
        <span v-for="bar in 7" :key="bar" class="skeleton" :style="{ height: `${28 + ((bar * 37) % 60)}%` }"></span>
      </div>
    </template>

    <div class="overview-figure">
      <DurationNumeral :minutes="totalMinutes" data-week-total />
      <p class="overview-figure-label">
        {{ isThisWeek ? t('overview.progress.totalThisWeek') : t('overview.progress.totalWeek') }}
        <span class="overview-figure-range">{{ rangeText }}</span>
      </p>
    </div>
    <UiEmptyState v-if="totalMinutes === 0" icon="bolt" compact :title="t('overview.progress.empty')" data-empty>
      {{ t('overview.progress.emptyBody') }}
    </UiEmptyState>
    <BarWeekChart
      v-else
      class="overview-progress-chart"
      :title="t('overview.progress.chartTitle', { range: rangeText })"
      :slots="slots"
      :values="values"
      :format="formatDuration"
      :highlight="todayIndex"
      :callout="callout"
      :chip="chip"
      :slot-header="t('overview.progress.dayHeader')"
      :value-header="t('overview.progress.valueHeader')"
      :missing-text="t('overview.progress.future')"
    />
    <p v-if="query.data.value?.truncated" class="overview-note" role="status">{{ t('overview.progress.truncated') }}</p>
  </OverviewCard>
</template>
