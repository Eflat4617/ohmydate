<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Commitment } from '../../api';
import { useGoogleIntegration } from '../../composables/useGoogleCalendar';
import { usePlannerQueryFix } from '../../composables/usePlannerQueryFix';
import { useOwnerTimeZone, usePlannerRange } from '../../composables/usePlannerRange';
import { weeklyRepeatOf } from '../../domain/commitmentDraft';
import { weekRange } from '../../domain/overview';
import { plannerLocation, plannerWeekOf } from '../../domain/plannerRoute';
import { addDaysToDate, startOfWeek, todayInZone } from '../../domain/time';
import { t, tp } from '../../i18n';
import { formatCivilDate, formatCivilDateRange, formatDateTimeRange } from '../../i18n/format';
import { useLayoutNow } from '../../layout/now';
import { useOfflineStore } from '../../stores/offline';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import CommitmentAddDialog from './CommitmentAddDialog.vue';
import PlannerHeader from './PlannerHeader.vue';

/**
 * 플래너 · 약속 (HOLO-04): the week's 약속 as a list — what the 약속 screen
 * was, now a view of the planner (`/planner?view=list`, `?w=`). A row says
 * what it is, when it next happens in the week, and whether it repeats; its
 * 고치기 opens the planner's own dialog on it (change or delete).
 *
 * A 약속 that came from Google Calendar is listed like any other and says
 * where it comes from; it has no 고치기 (the API refuses edits here, and it
 * is changed in Google Calendar).
 *
 * Reading is the planner's fenced range lookup (owner-keyed); every write is
 * the dialog's, under the owner who asked.
 */
const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const now = useLayoutNow();
const { timeZone, ready } = useOwnerTimeZone();
usePlannerQueryFix();

const today = computed(() => todayInZone(timeZone.value, now.value));
const thisWeek = computed(() => startOfWeek(today.value));
const weekStart = computed(() => plannerWeekOf(route.query, today.value));
const weekEnd = computed(() => addDaysToDate(weekStart.value, 6));
const isThisWeek = computed(() => weekStart.value === thisWeek.value);
const holdsToday = computed(() => today.value >= weekStart.value && today.value <= weekEnd.value);

const range = computed(() => (ready.value ? weekRange(weekStart.value, timeZone.value) : null));
const query = usePlannerRange(range);
const data = computed(() => query.data.value ?? null);

const googleQuery = useGoogleIntegration();
const googleStatus = computed(() => googleQuery.data.value?.status ?? null);

interface Row {
  readonly commitment: Commitment;
  readonly imported: boolean;
  /** When it happens in this week: every occurrence, in order. */
  readonly times: readonly { readonly key: string; readonly text: string }[];
  readonly repeat: string | null;
}

function repeatText(commitment: Commitment): string | null {
  if (commitment.rrule === undefined || commitment.rrule === null) return null;
  const weekly = weeklyRepeatOf(commitment.rrule);
  if (weekly === null) return t('commitments.repeats');
  const days = weekly.days.map((day) => t(`commitments.day.${day}`)).join('·');
  return weekly.until === null
    ? t('commitments.parse.repeatWeekly', { days })
    : t('commitments.parse.repeatUntil', { days, date: formatCivilDate(weekly.until, { weekday: false }) });
}

function firstStart(commitment: Commitment): number {
  return Date.parse(commitment.occurrences?.[0]?.startAt ?? commitment.startAt);
}

const rows = computed<Row[]>(() =>
  [...(data.value?.commitments ?? [])]
    .sort((left, right) => firstStart(left) - firstStart(right))
    .map((commitment) => {
      const occurrences =
        (commitment.occurrences?.length ?? 0) > 0
          ? (commitment.occurrences ?? [])
          : [{ startAt: commitment.startAt, endAt: commitment.endAt }];
      return {
        commitment,
        imported: commitment.source === 'google',
        times: occurrences.map((occurrence) => ({
          key: `${occurrence.startAt}-${occurrence.endAt}`,
          text: formatDateTimeRange(occurrence.startAt, occurrence.endAt, timeZone.value),
        })),
        repeat: repeatText(commitment),
      };
    }),
);

const hasGoogleRows = computed(() => rows.value.some((row) => row.imported));
const showGoogleNote = computed(
  () => hasGoogleRows.value || googleStatus.value === 'connected' || googleStatus.value === 'needs_reauth',
);

const offlineWithoutData = computed(() => data.value === null && !offline.online);
const loading = computed(() => data.value === null && !query.isError.value && !offlineWithoutData.value);
const loadFailed = computed(() => data.value === null && query.isError.value);

const rangeText = computed(() =>
  formatCivilDateRange(weekStart.value, weekEnd.value, {
    weekday: false,
    year: weekStart.value.slice(0, 4) !== today.value.slice(0, 4),
  }),
);
const summary = computed(() => (data.value === null ? null : tp('planner.list.summary', rows.value.length)));

const announcement = ref('');
watch(weekStart, (next, previous) => {
  if (next !== previous) announcement.value = t('planner.week.announce', { range: rangeText.value });
});

function goToWeek(start: string): void {
  void router.push(plannerLocation('list', start, today.value, route.name));
}

/** The 약속 open in the dialog. A re-read replaces the rows; the dialog keeps the one it was opened with. */
const editing = ref<Commitment | null>(null);

function edit(row: Row): void {
  if (row.imported || !offline.mutationsEnabled) return;
  editing.value = row.commitment;
}
</script>

<template>
  <section class="page page--wide planner-page planner-page--list" data-planner="list">
    <PlannerHeader
      view="list"
      :title="rangeText"
      :summary="summary"
      :anchor="holdsToday ? today : weekStart"
      :today="today"
      :time-zone="timeZone"
      :is-current="isThisWeek"
      :navigation-label="t('planner.week.navigation')"
      :previous-label="t('planner.week.previous')"
      :next-label="t('planner.week.next')"
      @previous="goToWeek(addDaysToDate(weekStart, -7))"
      @next="goToWeek(addDaysToDate(weekStart, 7))"
      @current="goToWeek(thisWeek)"
    />

    <p class="visually-hidden" role="status" aria-live="polite">
      {{ loading ? t('commitments.loading') : announcement }}
    </p>

    <UiBanner
      v-if="googleStatus === 'needs_reauth'"
      tone="warn"
      inline
      class="commitments-google-stale"
      role="status"
      data-google-stale
    >
      {{ t('commitments.google.stale') }}
      <template #actions>
        <RouterLink to="/settings/calendar" class="btn btn--sm">{{ t('commitments.google.reconnect') }}</RouterLink>
      </template>
    </UiBanner>

    <div v-if="loading" class="planner-list-loading" aria-hidden="true">
      <UiSkeleton variant="card" :count="2" :lines="2" />
    </div>
    <UiBanner v-else-if="loadFailed" tone="error" class="error-panel planner-error">
      <p class="error-text" role="alert">{{ t('commitments.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" data-planner-retry @click="query.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <p v-else-if="offlineWithoutData" class="planner-note" role="status">{{ t('planner.week.offline') }}</p>
    <UiEmptyState
      v-else-if="rows.length === 0"
      icon="commitment"
      class="card planner-list-empty"
      :title="t('planner.list.empty')"
      data-planner-list-empty
    >
      <p>{{ t('planner.list.emptyBody') }}</p>
    </UiEmptyState>
    <UiCard v-else class="planner-list-card" aria-labelledby="planner-list-title">
      <h2 id="planner-list-title" class="visually-hidden">{{ t('planner.list.title') }}</h2>
      <ul class="commitment-list planner-list" data-planner-list>
        <li
          v-for="row in rows"
          :key="row.commitment.id"
          class="commitment-item planner-list-row"
          :class="{ 'commitment-item--imported': row.imported }"
          :data-source="row.commitment.source"
          :data-commitment="row.commitment.id"
        >
          <span class="commitment-swatch" aria-hidden="true"></span>
          <div class="commitment-main">
            <p class="commitment-title-row">
              <strong class="commitment-title">{{ row.commitment.title }}</strong>
              <UiBadge v-if="row.imported" tone="outline" data-commitment-source>{{ t('commitments.google.source') }}</UiBadge>
              <UiBadge v-if="row.repeat" class="badge--cyan" data-commitment-repeat>{{ row.repeat }}</UiBadge>
            </p>
            <ul class="occurrence-list planner-list-times tabular">
              <li v-for="time in row.times" :key="time.key">{{ time.text }}</li>
            </ul>
          </div>
          <p v-if="row.imported" class="commitment-readonly">{{ t('commitments.google.readOnly') }}</p>
          <UiButton
            v-else
            size="sm"
            icon="edit"
            :disabled="!offline.mutationsEnabled"
            data-commitment-edit
            @click="edit(row)"
          >
            <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: row.commitment.title }) }}</span
            >{{ t('planner.list.edit') }}
          </UiButton>
        </li>
      </ul>
    </UiCard>

    <p v-if="showGoogleNote" class="commitments-google-note" data-google-note>
      {{ t('commitments.google.note') }}
      <RouterLink to="/settings/calendar">{{ t('commitments.google.link') }}</RouterLink>
    </p>
    <p v-if="data?.truncated" class="planner-note">{{ t('month.truncated') }}</p>

    <CommitmentAddDialog
      v-if="editing"
      :time-zone="timeZone"
      :date="holdsToday ? today : weekStart"
      :commitment="editing"
      @close="editing = null"
    />
  </section>
</template>
