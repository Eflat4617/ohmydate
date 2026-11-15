<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  isStoredFinalResult,
  plannerClient,
  type EstimationProfile,
  type EstimationProfileGroup,
  type EstimationProfileItem,
  type EstimationReset,
} from '../api';
import BarWeekChart from '../components/charts/BarWeekChart.vue';
import RatioBar from '../components/charts/RatioBar.vue';
import RingChart, { type RingSegment } from '../components/charts/RingChart.vue';
import TrendChart from '../components/charts/TrendChart.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { useEstimationProfile, useTaskDirectory, useWeekSessions } from '../composables/useOverview';
import { readScheduleBlocks, retryTransient } from '../composables/usePlannerRange';
import {
  HOUR_BUCKET,
  TREND_MIN_POINTS,
  estimateLean,
  estimateSeries,
  focusByHour,
  focusByWeek,
  focusByWeekday,
  peakIndex,
  planKeeping,
  recentWeekStarts,
  recordWeight,
} from '../domain/insights';
import { dayRange, minutesOfSeconds, personalEstimate, weekRange } from '../domain/overview';
import { addDaysToDate, startOfWeek, todayInZone, weekDates } from '../domain/time';
import { t, tp } from '../i18n';
import I18nT from '../i18n/I18nT';
import {
  browserTimeZone,
  formatCivilMonthDay,
  formatCivilWeekday,
  formatCivilWeekdayLong,
  formatDate,
  formatDuration,
  formatHour,
  formatHoursAndMinutes,
  formatNumber,
  formatPercent,
} from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { confidenceText, ratioText, stepKindLabel } from '../i18n/replan';
import { useLayoutNow } from '../layout/now';
import { ownerFenced, runOwnerBound, useOwnerKey, type OwnerSteps } from '../session/ownerBound';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';

/**
 * AI 분석 (HOLO-03A; was 내 패턴 — 07 §3.5 Review, 05 §6/§10): what the app has
 * learned about how the owner works, as charts of the owner's own records.
 *
 *   예상과 실제     session reviews (the estimation profile): actual ÷ estimated,
 *                   as one number and record by record over time;
 *   종류별          the same per template and per kind of step, with what the
 *                   estimator applies;
 *   주간 · 요일별 · 시간대별 집중   work sessions of the last eight weeks;
 *   지킨 계획       confirmed blocks of the last four weeks whose time has come;
 *   기록            every review record, which can be taken out of the statistics
 *                   or put back, and the reset;
 *   AI가 이 기록으로 하는 일   in plain words.
 *
 * Nothing is invented: a chart with too few records says "아직 기록이 부족해요"
 * and leads back to where records are made. Only minutes and ratios are
 * shown — never a review note.
 */
const PAGE_SIZE = 20;
/** How many records the trend draws. */
const TREND_POINTS = 30;
const WEEKS = 8;
const KEEPING_DAYS = 28;

const auth = useAuthStore();
const offline = useOfflineStore();
const queryClient = useQueryClient();
const actions = new ActionStore();
const now = useLayoutNow();
const owner = useOwnerKey();

const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
const today = computed(() => todayInZone(timeZone.value, now.value));
const readOnly = computed(() => !offline.mutationsEnabled);

// ── What was learned from reviews ──────────────────────────────────────
const profileQuery = useEstimationProfile();
const profile = computed<EstimationProfile | null>(() => profileQuery.data.value ?? null);
const items = computed(() => profile.value?.items ?? []);

const templatesQuery = useQuery({
  queryKey: computed(() => ['templates', 'insights', owner.value]),
  queryFn: ({ queryKey }) =>
    ownerFenced(String(queryKey[2]), () => plannerClient.listTaskTemplates({ limit: 100 })),
  retry: retryTransient,
});
const directory = useTaskDirectory();
const templateNames = computed(
  () => new Map((templatesQuery.data.value?.items ?? []).map((template) => [template.id, template.name])),
);

const estimate = computed(() => personalEstimate(items.value));
const series = computed(() => estimateSeries(items.value, TREND_POINTS));
const lean = computed(() => (estimate.value === null ? 'even' : estimateLean(estimate.value.ratio)));
const leanText = computed(() => {
  const value = estimate.value;
  if (value === null) return '';
  if (lean.value === 'even') return t('insights.estimate.even');
  return t(`insights.estimate.${lean.value}`, { percent: formatPercent(Math.abs(value.ratio - 1), 0) });
});
const trendSummary = computed(() => {
  const first = series.value[0];
  const last = series.value[series.value.length - 1];
  if (first === undefined || last === undefined) return '';
  return t('insights.estimate.chart', {
    from: formatDate(first.at, timeZone.value),
    to: formatDate(last.at, timeZone.value),
    first: ratioText(first.ratio),
    last: ratioText(last.ratio),
  });
});
const trendEnds = computed(() => {
  const first = series.value[0];
  const last = series.value[series.value.length - 1];
  return first === undefined || last === undefined
    ? null
    : { from: formatDate(first.at, timeZone.value), to: formatDate(last.at, timeZone.value) };
});
const countedCount = computed(() => series.value.length);

/** How much of the owner's own record the estimator uses now: n ÷ (n + k). */
const weightText = computed(() => {
  const value = profile.value;
  if (value === null || value.sampleCount <= 0) return null;
  return formatPercent(recordWeight(value.sampleCount, value.shrinkageK), 0);
});

// ── By template and by kind ────────────────────────────────────────────
const groups = computed(() => {
  const list = [...(profile.value?.groups ?? [])];
  return list.sort((left, right) =>
    left.dimension === right.dimension ? right.sampleCount - left.sampleCount : left.dimension === 'template' ? -1 : 1,
  );
});
/** One scale for every bar of the list: at least up to 2배. */
const ratioMax = computed(() =>
  Math.max(2, ...groups.value.map((group) => Math.ceil(group.stats.p50Ratio * 10) / 10).filter(Number.isFinite)),
);

function templateName(templateId: string | undefined): string {
  if (templateId === undefined) return t('insights.groups.templateFallback');
  return templateNames.value.get(templateId) ?? t('insights.groups.templateFallback');
}

function groupTitle(group: EstimationProfileGroup): string {
  if (group.dimension === 'template') return t('insights.groups.template', { name: templateName(group.templateId) });
  return t('insights.groups.kind', {
    kind: group.taskKind === undefined ? t('insights.groups.dimension.kind') : stepKindLabel(group.taskKind),
  });
}

// ── When the owner works: sessions of the last eight weeks ─────────────
const weekStarts = computed(() => recentWeekStarts(today.value, WEEKS));
const sessionRange = computed(() => {
  const first = weekStarts.value[0];
  const last = weekStarts.value[weekStarts.value.length - 1];
  if (first === undefined || last === undefined) return null;
  return { from: weekRange(first, timeZone.value).from, to: weekRange(last, timeZone.value).to };
});
const sessionsQuery = useWeekSessions(sessionRange);
const sessions = computed(() => sessionsQuery.data.value?.sessions ?? []);

const weekMinutes = computed(() =>
  focusByWeek(sessions.value, weekStarts.value, timeZone.value, now.value).map(minutesOfSeconds),
);
const weekdayMinutes = computed(() => focusByWeekday(sessions.value, timeZone.value, now.value).map(minutesOfSeconds));
const hourMinutes = computed(() => focusByHour(sessions.value, timeZone.value, now.value).map(minutesOfSeconds));
const hasFocus = computed(() => weekMinutes.value.some((value) => value > 0));

const weekSlots = computed(() =>
  weekStarts.value.map((start) => ({
    label: `${Number(start.slice(5, 7))}/${Number(start.slice(8, 10))}`,
    name: t('insights.weeks.weekName', { date: formatCivilMonthDay(start) }),
  })),
);
const thisWeekMinutes = computed(() => weekMinutes.value[weekMinutes.value.length - 1] ?? 0);

/** Monday to Sunday, named from the dates of this week. */
const weekdaySlots = computed(() =>
  weekDates(startOfWeek(today.value)).map((date) => ({ label: formatCivilWeekday(date), name: formatCivilWeekdayLong(date) })),
);
const weekdayPeak = computed(() => peakIndex(weekdayMinutes.value));

function hourRange(index: number): string {
  const from = index * HOUR_BUCKET;
  // The app's one way of writing a span of time.
  return t('format.timeRange', { start: formatHour(from), end: formatHour((from + HOUR_BUCKET) % 24) });
}
const hourSlots = computed(() =>
  hourMinutes.value.map((_, index) => ({
    label: t('insights.hours.label', { hour: index * HOUR_BUCKET }),
    name: hourRange(index),
  })),
);
const hourPeak = computed(() => peakIndex(hourMinutes.value));

// ── Plans kept: confirmed blocks of the last four weeks ────────────────
const blockRange = computed(() => ({
  from: dayRange(addDaysToDate(today.value, -KEEPING_DAYS), timeZone.value).from,
  to: dayRange(today.value, timeZone.value).to,
}));
const blocksQuery = useQuery({
  queryKey: computed(() => ['insights-blocks', owner.value, blockRange.value.from, blockRange.value.to]),
  queryFn: ({ queryKey }) =>
    ownerFenced(String(queryKey[1]), (binding) =>
      readScheduleBlocks(binding, { from: String(queryKey[2]), to: String(queryKey[3]) }),
    ),
  retry: retryTransient,
});
const keeping = computed(() => planKeeping(blocksQuery.data.value?.items ?? [], now.value));
const keepingSegments = computed<RingSegment[]>(() => [
  { label: t('insights.kept.done'), value: keeping.value.done, display: tp('insights.kept.count', keeping.value.done), series: 1 },
  { label: t('insights.kept.moved'), value: keeping.value.moved, display: tp('insights.kept.count', keeping.value.moved), series: 2 },
  {
    label: t('insights.kept.skipped'),
    value: keeping.value.skipped,
    display: tp('insights.kept.count', keeping.value.skipped),
    series: 3,
  },
  { label: t('insights.kept.passed'), value: keeping.value.passed, display: tp('insights.kept.count', keeping.value.passed), series: 4 },
]);

// ── The records ────────────────────────────────────────────────────────
const visibleCount = ref(PAGE_SIZE);
const visibleItems = computed(() => items.value.slice(0, visibleCount.value));

function itemTitle(item: EstimationProfileItem): string {
  const title = directory.data.value?.tasks.get(item.taskId)?.title;
  if (title !== undefined) return title;
  if (item.taskKind !== undefined) return t('insights.records.taskFallback', { kind: stepKindLabel(item.taskKind) });
  return t('insights.records.taskUnknown');
}

function itemDate(item: EstimationProfileItem): string {
  return formatDate(item.createdAt, timeZone.value);
}

function qualityKey(item: EstimationProfileItem): 'ok' | 'outlier' | 'excluded' {
  if (item.excluded) return 'excluded';
  return item.quality === 'outlier' ? 'outlier' : 'ok';
}

const QUALITY_TONES = { ok: 'success', outlier: 'warn', excluded: 'neutral' } as const;

const announcement = ref('');
const errorText = ref<string | null>(null);
const busyId = ref<string | null>(null);
const resetTarget = ref<EstimationReset | null>(null);
const resetBusy = ref(false);
const resetError = ref<string | null>(null);
const estimateHeading = ref<HTMLElement | null>(null);

/** Announce politely. A generator: its own wait is fenced like the task's (delegate with `yield*`). */
function* announce(message: string): OwnerSteps<void> {
  announcement.value = '';
  yield nextTick();
  announcement.value = message;
}

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Owner isolation (ADR-023): toggle and reset run under the owner who started
// them (runOwnerBound). After a user switch nothing is cached or announced.
async function toggle(item: EstimationProfileItem, include: boolean): Promise<void> {
  if (readOnly.value || busyId.value !== null) return;
  const excluded = !include;
  if (item.excluded === excluded) return;
  busyId.value = item.feedbackId;
  errorText.value = null;
  const scope = `feedback:${item.feedbackId}`;
  const action = actions.begin(scope, { excluded }, samePayload, item.version);
  await runOwnerBound(
    function* (bound) {
      try {
        yield* bound.wait(
          plannerClient.patchEstimationFeedback(item.feedbackId, excluded, action.key, item.version, bound.signal),
        );
        actions.settle(scope, action);
        yield* bound.wait(profileQuery.refetch());
        yield* announce(excluded ? t('insights.records.excludedDone') : t('insights.records.includedDone'));
      } catch (cause) {
        // M5-03R-1 M1: keep the key unless the server stored a final result.
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 412) {
          yield* bound.wait(profileQuery.refetch());
          errorText.value = t('insights.records.toggleConflict');
        } else {
          errorText.value = errorMessage(cause, t('insights.records.toggleError'));
        }
      }
    },
    {
      onSettled: () => {
        busyId.value = null;
      },
    },
  );
}

function onToggle(item: EstimationProfileItem, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  // The switch mirrors the server state; it only flips once the PATCH lands.
  target.checked = !item.excluded;
  // Currently excluded → include it again, and vice versa.
  void toggle(item, item.excluded);
}

function openReset(target: EstimationReset): void {
  if (readOnly.value) return;
  resetError.value = null;
  resetTarget.value = target;
}

const resetCount = computed(() => {
  const target = resetTarget.value;
  if (target === null) return 0;
  if (target.scope === 'all') return items.value.length;
  return items.value.filter((item) => item.templateId === target.templateId).length;
});

async function confirmReset(): Promise<void> {
  const target = resetTarget.value;
  if (target === null || readOnly.value || resetBusy.value) return;
  resetBusy.value = true;
  resetError.value = null;
  const scope = `estimation:reset:${target.scope}:${target.templateId ?? ''}`;
  const action = actions.begin(scope, target, samePayload);
  // The cache entry of the owner who asked: named now, before any wait.
  const profileKey = ['estimation-profile', owner.value];
  await runOwnerBound(
    function* (bound) {
      try {
        const refreshed = yield* bound.wait(plannerClient.resetEstimation(action.payload, action.key, bound.signal));
        actions.settle(scope, action);
        queryClient.setQueryData(profileKey, refreshed);
        resetTarget.value = null;
        visibleCount.value = PAGE_SIZE;
        yield* announce(t('insights.reset.done'));
        yield* bound.wait(nextTick());
        estimateHeading.value?.focus();
      } catch (cause) {
        // M5-03R-1 M1: keep the key unless the server stored a final result.
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        resetError.value = errorMessage(cause, t('insights.reset.error'));
      }
    },
    {
      onSettled: () => {
        resetBusy.value = false;
      },
    },
  );
}
</script>

<template>
  <section class="page page--wide insights-page" data-insights>
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('insights.title') }}</h1>
        <p class="page-lede">{{ t('insights.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="readOnly" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </div>
    </header>

    <p class="status-region status-note" role="status" aria-live="polite">{{ announcement }}</p>

    <div v-if="profileQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('insights.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="3" />
    </div>
    <UiBanner v-else-if="profileQuery.isError.value || profile === null" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('insights.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="profileQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <template v-else>
      <UiBanner v-if="readOnly" tone="offline">{{ t('insights.offline') }}</UiBanner>
      <UiBanner v-if="errorText" tone="error" role="alert">{{ errorText }}</UiBanner>

      <div class="insights-grid">
        <!-- 예상과 실제 -->
        <UiCard class="insights-card insights-estimate" aria-labelledby="insights-estimate-title" data-insight="estimate">
          <header class="insights-card-head">
            <h2 id="insights-estimate-title" ref="estimateHeading" class="card-title" tabindex="-1">
              <UiIcon name="pattern" :size="18" />{{ t('insights.estimate.title') }}
            </h2>
            <dl class="insights-facts">
              <div class="insights-fact">
                <dt>{{ t('insights.samples') }}</dt>
                <dd class="tabular" data-summary="samples">{{ tp('insights.samplesValue', profile.sampleCount) }}</dd>
              </div>
              <div class="insights-fact">
                <dt>{{ t('insights.confidence') }}</dt>
                <dd class="tabular" data-summary="confidence">{{ confidenceText(profile.confidence) }}</dd>
              </div>
            </dl>
          </header>

          <div v-if="estimate && countedCount >= TREND_MIN_POINTS" class="insights-estimate-body">
            <div class="insights-estimate-figure">
              <p class="insights-estimate-number" data-estimate-ratio>
                <span class="numeral">{{ formatNumber(estimate.ratio, 2) }}</span
                ><span class="numeral-unit insights-estimate-unit">{{ t('insights.estimate.unit') }}</span>
              </p>
              <p class="insights-estimate-lean" :data-lean="lean">{{ leanText }}</p>
              <p class="insights-note">{{ tp('insights.estimate.basis', estimate.samples) }}</p>
            </div>
            <figure class="insights-trend" data-estimate-trend>
              <figcaption class="insights-trend-caption">
                <span>{{ t('insights.estimate.chartTitle') }}</span>
                <span class="insights-trend-guide"><span class="insights-guide-mark" aria-hidden="true"></span>{{ t('insights.estimate.guide') }}</span>
              </figcaption>
              <TrendChart :values="series.map((point) => point.ratio)" :summary="trendSummary" :reference="1" />
              <p v-if="trendEnds" class="insights-trend-axis tabular" aria-hidden="true">
                <span>{{ trendEnds.from }}</span>
                <span>{{ trendEnds.to }}</span>
              </p>
            </figure>
          </div>
          <div v-else class="insights-empty" data-insights-empty="estimate" :data-cold-start="items.length === 0 ? '' : undefined">
            <p class="insights-empty-title">{{ t('insights.notEnough') }}</p>
            <p>{{ t('insights.estimate.emptyBody', { min: TREND_MIN_POINTS, count: countedCount }) }}</p>
            <p class="insights-note">{{ t('insights.estimate.coldBody') }}</p>
            <RouterLink class="btn btn--secondary btn--sm" to="/today">{{ t('insights.toToday') }}</RouterLink>
          </div>
        </UiCard>

        <!-- AI가 이 기록으로 하는 일 -->
        <UiCard class="insights-card insights-uses" aria-labelledby="insights-uses-title" data-insight="uses">
          <h2 id="insights-uses-title" class="card-title"><UiIcon name="ai" :size="18" />{{ t('insights.uses.title') }}</h2>
          <ul class="insights-uses-list">
            <li>{{ t('insights.uses.adjust') }}</li>
            <li data-uses-weight>
              {{ weightText === null ? t('insights.uses.weightNone') : t('insights.uses.weight', { percent: weightText }) }}
            </li>
            <li>{{ t('insights.uses.outlier') }}</li>
            <li>{{ t('insights.uses.fallback') }}</li>
            <li>{{ t('insights.uses.privacy') }}</li>
          </ul>
        </UiCard>

        <!-- 주간 집중 시간 -->
        <UiCard class="insights-card insights-weeks" aria-labelledby="insights-weeks-title" data-insight="weeks">
          <header class="insights-card-head">
            <h2 id="insights-weeks-title" class="card-title"><UiIcon name="clock" :size="18" />{{ t('insights.weeks.title') }}</h2>
            <p class="insights-period">{{ t('insights.weeks.period', { count: WEEKS }) }}</p>
          </header>
          <UiSkeleton v-if="sessionsQuery.isLoading.value" variant="lines" :count="3" />
          <div v-else-if="sessionsQuery.isError.value" class="insights-part-error" data-insights-error="sessions">
            <p role="alert">{{ t('insights.partError') }}</p>
            <UiButton size="sm" icon="sync" @click="sessionsQuery.refetch()">{{ t('common.retry') }}</UiButton>
          </div>
          <template v-else-if="hasFocus">
            <BarWeekChart
              :title="t('insights.weeks.title')"
              :slots="weekSlots"
              :values="weekMinutes"
              :format="formatHoursAndMinutes"
              :highlight="weekSlots.length - 1"
              :callout="{ value: formatHoursAndMinutes(thisWeekMinutes), note: t('insights.weeks.thisWeek') }"
              :slot-header="t('insights.weeks.slot')"
              :value-header="t('insights.weeks.value')"
              :missing-text="t('insights.weeks.missing')"
            />
            <p v-if="sessionsQuery.data.value?.truncated" class="insights-note" data-insights-partial>{{ t('insights.partial') }}</p>
          </template>
          <div v-else class="insights-empty" data-insights-empty="weeks">
            <p class="insights-empty-title">{{ t('insights.notEnough') }}</p>
            <p>{{ t('insights.weeks.empty', { count: WEEKS }) }}</p>
            <RouterLink class="btn btn--secondary btn--sm" to="/today">{{ t('insights.toToday') }}</RouterLink>
          </div>
        </UiCard>

        <!-- 요일별 집중 -->
        <UiCard class="insights-card insights-weekday" aria-labelledby="insights-weekday-title" data-insight="weekday">
          <header class="insights-card-head">
            <h2 id="insights-weekday-title" class="card-title">{{ t('insights.weekday.title') }}</h2>
            <p class="insights-period">{{ t('insights.weeks.period', { count: WEEKS }) }}</p>
          </header>
          <UiSkeleton v-if="sessionsQuery.isLoading.value" variant="lines" :count="3" />
          <p v-else-if="sessionsQuery.isError.value" class="insights-empty-line" role="status">{{ t('insights.partError') }}</p>
          <template v-else-if="weekdayPeak !== null">
            <p class="insights-peak" data-insights-peak="weekday">
              {{ t('insights.weekday.peak', { day: weekdaySlots[weekdayPeak]?.name ?? '' }) }}
            </p>
            <BarWeekChart
              :title="t('insights.weekday.title')"
              :slots="weekdaySlots"
              :values="weekdayMinutes"
              :format="formatHoursAndMinutes"
              :highlight="weekdayPeak"
              :slot-header="t('insights.weekday.slot')"
              :value-header="t('insights.weeks.value')"
              :missing-text="t('insights.weeks.missing')"
            />
          </template>
          <p v-else class="insights-empty-line" data-insights-empty="weekday">{{ t('insights.weekday.empty') }}</p>
        </UiCard>

        <!-- 시간대별 집중 -->
        <UiCard class="insights-card insights-hours" aria-labelledby="insights-hours-title" data-insight="hours">
          <header class="insights-card-head">
            <h2 id="insights-hours-title" class="card-title">{{ t('insights.hours.title') }}</h2>
            <p class="insights-period">{{ t('insights.weeks.period', { count: WEEKS }) }}</p>
          </header>
          <UiSkeleton v-if="sessionsQuery.isLoading.value" variant="lines" :count="3" />
          <p v-else-if="sessionsQuery.isError.value" class="insights-empty-line" role="status">{{ t('insights.partError') }}</p>
          <template v-else-if="hourPeak !== null">
            <p class="insights-peak" data-insights-peak="hours">{{ t('insights.hours.peak', { range: hourRange(hourPeak) }) }}</p>
            <BarWeekChart
              :title="t('insights.hours.title')"
              :slots="hourSlots"
              :values="hourMinutes"
              :format="formatHoursAndMinutes"
              :highlight="hourPeak"
              :slot-header="t('insights.hours.slot')"
              :value-header="t('insights.weeks.value')"
              :missing-text="t('insights.weeks.missing')"
            />
          </template>
          <p v-else class="insights-empty-line" data-insights-empty="hours">{{ t('insights.hours.empty') }}</p>
        </UiCard>

        <!-- 지킨 계획 -->
        <UiCard class="insights-card insights-kept" aria-labelledby="insights-kept-title" data-insight="kept">
          <header class="insights-card-head">
            <h2 id="insights-kept-title" class="card-title"><UiIcon name="check-circle" :size="18" />{{ t('insights.kept.title') }}</h2>
            <p class="insights-period">{{ t('insights.kept.period', { count: KEEPING_DAYS }) }}</p>
          </header>
          <UiSkeleton v-if="blocksQuery.isLoading.value" variant="lines" :count="3" />
          <div v-else-if="blocksQuery.isError.value" class="insights-part-error" data-insights-error="blocks">
            <p role="alert">{{ t('insights.partError') }}</p>
            <UiButton size="sm" icon="sync" @click="blocksQuery.refetch()">{{ t('common.retry') }}</UiButton>
          </div>
          <template v-else-if="keeping.keptShare !== null">
            <RingChart
              :title="t('insights.kept.legend')"
              :segments="keepingSegments"
              :total="formatPercent(keeping.keptShare, 0)"
              :total-label="t('insights.kept.total')"
              :format-share="(share: number) => formatPercent(share, 0)"
            />
            <p v-if="blocksQuery.data.value?.truncated" class="insights-note" data-insights-partial>{{ t('insights.partial') }}</p>
          </template>
          <div v-else class="insights-empty" data-insights-empty="kept">
            <p class="insights-empty-title">{{ t('insights.notEnough') }}</p>
            <p>{{ t('insights.kept.empty') }}</p>
            <RouterLink class="btn btn--secondary btn--sm" to="/plan">{{ t('insights.toPlan') }}</RouterLink>
          </div>
        </UiCard>

        <!-- 종류별 -->
        <UiCard class="insights-card insights-groups" aria-labelledby="insights-groups-title" data-insight="groups">
          <header class="insights-card-head">
            <h2 id="insights-groups-title" class="card-title"><UiIcon name="list" :size="18" />{{ t('insights.groups.title') }}</h2>
          </header>
          <template v-if="groups.length > 0">
            <p class="insights-note">{{ t('insights.groups.lede') }}</p>
            <ul class="insights-group-list">
              <li v-for="group in groups" :key="group.key" class="insights-group" :data-group="group.key">
                <div class="insights-group-head">
                  <h3 class="insights-group-title">{{ groupTitle(group) }}</h3>
                  <p class="insights-group-value">
                    <span class="visually-hidden">{{ t('insights.groups.applied') }} </span>
                    <span class="tabular" data-ratio="applied">{{ ratioText(group.stats.p50Ratio) }}</span>
                  </p>
                </div>
                <RatioBar :ratio="group.stats.p50Ratio" :max="ratioMax" />
                <p class="insights-group-meta tabular">
                  {{
                    t('insights.groups.meta', {
                      samples: tp('insights.groups.sampleCount', group.sampleCount),
                      confidence: confidenceText(group.confidence),
                    })
                  }}
                </p>
                <p class="insights-group-meta tabular">
                  <I18nT keypath="insights.groups.detail">
                    <template #personal>
                      <span data-ratio="personal">{{ ratioText(Math.exp(group.stats.logRatioMean)) }}</span>
                    </template>
                    <template #roomy>
                      <span data-ratio="roomy">{{ ratioText(group.stats.p90Ratio) }}</span>
                    </template>
                  </I18nT>
                </p>
                <UiButton
                  v-if="group.dimension === 'template' && group.templateId"
                  size="sm"
                  variant="danger-ghost"
                  icon="trash"
                  class="insights-group-reset"
                  :disabled="readOnly"
                  @click="openReset({ scope: 'template', templateId: group.templateId })"
                >
                  {{ t('insights.groups.resetTemplate') }}
                </UiButton>
              </li>
            </ul>
          </template>
          <p v-else class="insights-empty-line" data-insights-empty="groups">{{ t('insights.groups.empty') }}</p>
        </UiCard>

        <!-- 기록 -->
        <UiCard class="insights-card insights-records" aria-labelledby="insights-records-title" data-insight="records">
          <header class="insights-card-head">
            <h2 id="insights-records-title" class="card-title"><UiIcon name="note" :size="18" />{{ t('insights.records.title') }}</h2>
          </header>
          <p class="insights-note">{{ t('insights.records.lede') }}</p>
          <ul v-if="visibleItems.length > 0" class="insights-record-list" :aria-label="t('insights.records.list')">
            <li
              v-for="item in visibleItems"
              :key="item.feedbackId"
              class="insights-record"
              :class="{ 'insights-record--off': qualityKey(item) !== 'ok' }"
              :data-feedback-id="item.feedbackId"
            >
              <div class="insights-record-main">
                <p class="insights-record-title">{{ itemTitle(item) }}</p>
                <p class="insights-record-meta">
                  <span>{{ itemDate(item) }}</span>
                  <span class="tabular">
                    {{
                      t('insights.records.item', {
                        estimated: formatDuration(item.estimatedP50),
                        actual: formatDuration(item.actualFocusMin),
                      })
                    }}
                  </span>
                  <span class="tabular insights-record-ratio">{{ ratioText(item.ratio) }}</span>
                </p>
              </div>
              <UiBadge :tone="QUALITY_TONES[qualityKey(item)]" dot data-quality>
                {{ t(`insights.records.quality.${qualityKey(item)}`) }}
              </UiBadge>
              <label class="insights-switch">
                <input
                  type="checkbox"
                  role="switch"
                  class="switch"
                  :checked="!item.excluded"
                  :disabled="readOnly || busyId !== null"
                  :aria-label="t('insights.records.includeAria', { title: itemTitle(item), date: itemDate(item) })"
                  :aria-busy="busyId === item.feedbackId ? 'true' : undefined"
                  data-include
                  @change="onToggle(item, $event)"
                />
                <span class="insights-switch-label">{{ t('insights.records.include') }}</span>
              </label>
            </li>
          </ul>
          <p v-else class="insights-empty-line" data-insights-empty="records">{{ t('insights.records.empty') }}</p>
          <div class="insights-record-actions">
            <UiButton v-if="items.length > visibleCount" size="sm" data-records-more @click="visibleCount += PAGE_SIZE">
              {{ t('insights.records.showMore') }}
            </UiButton>
            <UiButton
              variant="danger-ghost"
              icon="trash"
              :disabled="readOnly || items.length === 0"
              data-reset-all
              @click="openReset({ scope: 'all' })"
            >
              {{ t('insights.reset.all') }}
            </UiButton>
          </div>
        </UiCard>
      </div>
    </template>

    <UiDialog
      v-if="resetTarget"
      role="alertdialog"
      labelledby="insights-reset-title"
      describedby="insights-reset-body"
      size="sm"
      as="section"
      class="insights-reset-dialog"
      :dismissible="!resetBusy"
      @close="resetTarget = null"
    >
      <header class="dialog-header dialog-header--start">
        <span class="dialog-icon dialog-icon--warn"><UiIcon name="trash" :size="22" /></span>
        <div class="dialog-heading">
          <h2 id="insights-reset-title" class="dialog-title">
            {{
              resetTarget.scope === 'all'
                ? t('insights.reset.titleAll')
                : t('insights.reset.titleTemplate', { name: templateName(resetTarget.templateId) })
            }}
          </h2>
          <div id="insights-reset-body" class="muted">
            <p>
              {{
                resetTarget.scope === 'all'
                  ? tp('insights.reset.bodyAll', resetCount)
                  : tp('insights.reset.bodyTemplate', resetCount)
              }}
            </p>
            <p class="danger">{{ t('insights.reset.irreversible') }}</p>
          </div>
        </div>
      </header>
      <UiBanner v-if="resetError" tone="error" role="alert">{{ resetError }}</UiBanner>
      <div class="dialog-actions">
        <UiButton variant="ghost" :disabled="resetBusy" data-autofocus @click="resetTarget = null">
          {{ t('common.cancel') }}
        </UiButton>
        <UiButton variant="danger" :disabled="resetBusy" :busy="resetBusy" data-reset-confirm @click="confirmReset">
          {{
            resetBusy
              ? t('insights.reset.busy')
              : resetTarget.scope === 'all'
                ? t('insights.reset.confirmAll')
                : t('insights.reset.confirmTemplate')
          }}
        </UiButton>
      </div>
    </UiDialog>
  </section>
</template>
