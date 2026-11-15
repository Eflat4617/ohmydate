<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PlannerHeader from '../components/planner/PlannerHeader.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiDeadlineFlag from '../components/ui/UiDeadlineFlag.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import { usePlannerRange, useOwnerTimeZone } from '../composables/usePlannerRange';
import { usePlannerQueryFix } from '../composables/usePlannerQueryFix';
import { useCalendarDayEvents } from '../composables/useGoogleCalendar';
import {
  MONTH_CELL_LINES,
  buildMonthGrid,
  cellOverflow,
  dateAfterKey,
  firstDateOfMonth,
  isMonthGridKey,
  monthGridRange,
  monthOfDate,
  monthWeeks,
  shiftMonth,
  type MonthDay,
  type MonthDayLabel,
  type MonthItem,
  type MonthKey,
} from '../domain/monthGrid';
import { plannerLocation, plannerMonthOf } from '../domain/plannerRoute';
import { todayInZone } from '../domain/time';
import { t, tp } from '../i18n';
import {
  formatCivilDate,
  formatCivilDateRange,
  formatCivilMonthDay,
  formatCivilWeekday,
  formatCivilWeekdayLong,
  formatCivilYearMonth,
  formatClock,
  formatTime,
  formatTimeRange,
} from '../i18n/format';
import { useLayoutNow } from '../layout/now';
import { useOfflineStore } from '../stores/offline';

/**
 * CAL-01 — 한달: a month page of the planner. One row per week that touches
 * the month, and in each day its approved blocks, 약속 and deadlines, in time
 * order. The month is in the URL (`/month?m=2026-11`; plain `/month` is the
 * current month in the owner's zone). The screen only reads.
 *
 * HOLO-02: it is the 월 view of 플래너 (also at `/planner?view=month`), under
 * the head the three views share; 약속 추가 there is its one primary button.
 */
const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const now = useLayoutNow();
const { timeZone, ready } = useOwnerTimeZone();

const today = computed(() => todayInZone(timeZone.value, now.value));
const currentMonth = computed(() => monthOfDate(today.value));
const month = computed<MonthKey>(() => plannerMonthOf(route.query, today.value));
const isCurrentMonth = computed(() => month.value === currentMonth.value);
/** The legend's sample of the today mark is today's own date. */
const todayNumber = computed(() => Number(today.value.slice(8, 10)));

// A month the URL cannot mean is dropped from it (the page shows this month).
usePlannerQueryFix();

const range = computed(() => (ready.value ? monthGridRange(month.value, timeZone.value) : null));
const query = usePlannerRange(range);
const data = computed(() => query.data.value ?? null);

// CAL-04: all-day events imported from Google, read on their own. They are
// labels only; when they cannot be read the month shows without them.
const dayRange = computed(() => {
  const weeks = monthWeeks(month.value);
  const first = weeks[0]?.[0];
  const lastWeek = weeks[weeks.length - 1];
  const last = lastWeek?.[lastWeek.length - 1];
  return first === undefined || last === undefined ? null : { from: first, to: last };
});
const dayEventsQuery = useCalendarDayEvents(dayRange);
const dayEventsFailed = computed(() => dayEventsQuery.isError.value && dayEventsQuery.data.value === undefined);

const grid = computed(() =>
  buildMonthGrid({
    month: month.value,
    timeZone: timeZone.value,
    today: today.value,
    blocks: data.value?.blocks ?? [],
    commitments: data.value?.commitments ?? [],
    tasks: data.value?.tasks ?? [],
    dayEvents: dayEventsQuery.data.value ?? [],
  }),
);
const hasDayLabels = computed(() => days.value.some((day) => day.labels.length > 0));
/** The legend's sample of the mark is the first labelled day of the month's own days. */
const firstLabelledDay = computed(
  () => (days.value.find((day) => day.inMonth && day.labels.length > 0) ?? days.value.find((day) => day.labels.length > 0))?.day ?? 1,
);
const days = computed(() => grid.value.weeks.flat());
const dayByDate = computed(() => new Map(days.value.map((day) => [day.date, day])));
const weekdayHeads = computed(() =>
  (grid.value.weeks[0] ?? []).map((day) => ({
    date: day.date,
    short: formatCivilWeekday(day.date),
    long: formatCivilWeekdayLong(day.date),
  })),
);

const offlineWithoutData = computed(() => data.value === null && !offline.online);
const loading = computed(() => data.value === null && !query.isError.value && !offlineWithoutData.value);
const loadFailed = computed(() => data.value === null && query.isError.value);
const staleFailed = computed(() => data.value !== null && query.isError.value);
const showEmpty = computed(() => data.value !== null && grid.value.empty);

/** The month's own days, each item once (a block over midnight is still one block). */
const summary = computed(() => {
  const seen = { block: new Set<string>(), commitment: new Set<string>(), deadline: new Set<string>() };
  for (const day of days.value) {
    if (!day.inMonth) continue;
    for (const item of day.items) seen[item.kind].add(item.key);
  }
  return t('month.summary', {
    blocks: seen.block.size,
    commitments: seen.commitment.size,
    deadlines: seen.deadline.size,
  });
});

// ── Selection and the roving focus ─────────────────────────────────────
function defaultDate(target: MonthKey): string {
  return target === currentMonth.value ? today.value : firstDateOfMonth(target);
}

const selected = ref(defaultDate(month.value));
const active = ref(selected.value);
const cells = new Map<string, HTMLElement>();
/** Set when the keyboard moved focus to a date of another month. */
let focusAfterRender = false;

function setCell(date: string, element: unknown): void {
  if (element instanceof HTMLElement) cells.set(date, element);
  else cells.delete(date);
}

function focusActive(): void {
  cells.get(active.value)?.focus();
}

const announcement = ref('');
watch(month, (next, previous) => {
  if (next === previous) return;
  const own = (date: string) => monthOfDate(date) === next;
  if (!own(active.value)) active.value = defaultDate(next);
  if (!own(selected.value)) selected.value = active.value;
  announcement.value = formatCivilYearMonth(next);
  if (focusAfterRender) {
    focusAfterRender = false;
    void nextTick(focusActive);
  }
});
// The first answer of the owner's zone can move "this month" and so "today".
watch(today, (next, previous) => {
  if (selected.value === previous && dayByDate.value.has(next)) {
    selected.value = next;
    active.value = next;
  }
});

const selectedDay = computed<MonthDay | null>(() => dayByDate.value.get(selected.value) ?? null);

function goToMonth(target: MonthKey): void {
  void router.push(plannerLocation('month', firstDateOfMonth(target), today.value, route.name));
}

/** 오늘: this month, with today picked. */
function goToToday(): void {
  select(today.value);
  if (!isCurrentMonth.value) goToMonth(currentMonth.value);
}

function shift(delta: number): void {
  goToMonth(shiftMonth(month.value, delta));
}

function select(date: string): void {
  selected.value = date;
  active.value = date;
}

function onCellKeydown(event: KeyboardEvent, date: string): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    select(date);
    return;
  }
  if (!isMonthGridKey(event.key)) return;
  event.preventDefault();
  const target = dateAfterKey(date, event.key);
  active.value = target;
  const changesMonth = event.key === 'PageUp' || event.key === 'PageDown' || !dayByDate.value.has(target);
  if (changesMonth && monthOfDate(target) !== month.value) {
    focusAfterRender = true;
    goToMonth(monthOfDate(target));
    return;
  }
  void nextTick(focusActive);
}

// ── What a cell and the day list say ──────────────────────────────────
function itemTitle(item: MonthItem): string {
  return item.title ?? t('month.untitledTask');
}

function cellTime(item: MonthItem): string {
  if (item.continued && item.endAt !== null) return t('month.until', { time: formatClock(item.endAt, timeZone.value) });
  return formatClock(item.startAt, timeZone.value);
}

function cellName(day: MonthDay): string {
  const parts = [`${formatCivilMonthDay(day.date)} ${formatCivilWeekdayLong(day.date)}`];
  if (day.today) parts.push(t('month.cell.today'));
  for (const label of day.labels) parts.push(t('month.cell.dayEvent', { title: label.title }));
  if (day.counts.block > 0) parts.push(tp('month.cell.blocks', day.counts.block));
  if (day.counts.commitment > 0) parts.push(tp('month.cell.commitments', day.counts.commitment));
  if (day.counts.deadline > 0) parts.push(tp('month.cell.deadlines', day.counts.deadline));
  if (day.items.length === 0 && day.labels.length === 0) parts.push(t('month.cell.nothing'));
  return parts.join(', ');
}

function cellLines(day: MonthDay) {
  return cellOverflow(day.items, MONTH_CELL_LINES);
}

function allBlocksDone(day: MonthDay): boolean {
  const blocks = day.items.filter((item) => item.kind === 'block');
  return blocks.length > 0 && blocks.every((item) => item.done);
}

function agendaTime(item: MonthItem): string {
  if (item.kind === 'deadline') return t('month.until', { time: formatTime(item.startAt, timeZone.value) });
  return formatTimeRange(item.startAt, item.endAt ?? item.startAt, timeZone.value);
}

function agendaKind(item: MonthItem): string {
  if (item.kind === 'block') return item.done ? t('month.detail.kind.blockDone') : t('month.detail.kind.block');
  if (item.kind === 'commitment') {
    return item.fromGoogle ? t('month.detail.kind.commitmentGoogle') : t('month.detail.kind.commitment');
  }
  return t('month.detail.kind.deadline');
}

function labelKind(label: MonthDayLabel): string {
  return label.calendarName === null || label.calendarName.length === 0
    ? t('month.detail.kind.dayEvent')
    : t('month.detail.kind.dayEventFrom', { calendar: label.calendarName });
}

function labelDates(label: MonthDayLabel): string {
  return label.multiDay ? formatCivilDateRange(label.firstDate, label.lastDate) : formatCivilDate(label.firstDate);
}

function agendaLink(item: MonthItem): string {
  if (item.kind === 'commitment' || item.taskId === null) return '/planner?view=list';
  return `/tasks/${item.taskId}`;
}

function retry(): void {
  void query.refetch();
  if (dayEventsQuery.isError.value) void dayEventsQuery.refetch();
}
</script>

<template>
  <section class="page page--wide month-page planner-page planner-page--month" data-planner="month">
    <PlannerHeader
      view="month"
      hooks="month"
      :title="formatCivilYearMonth(month)"
      :summary="data && !grid.empty ? summary : null"
      :anchor="selected"
      :today="today"
      :time-zone="timeZone"
      :is-current="isCurrentMonth && selected === today"
      :navigation-label="t('month.navigation')"
      :previous-label="t('month.previous')"
      :next-label="t('month.next')"
      @previous="shift(-1)"
      @next="shift(1)"
      @current="goToToday"
    />

    <p class="visually-hidden" role="status" aria-live="polite">
      {{ loading ? t('month.loading') : announcement }}
    </p>

    <UiBanner v-if="loadFailed" tone="error" class="error-panel month-error">
      <p class="error-text" role="alert">{{ t('month.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" data-month-retry @click="retry">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <UiBanner v-else-if="staleFailed" tone="error" inline class="month-error month-error--stale">
      <span role="status">{{ t('month.staleError') }}</span>
      <template #actions>
        <UiButton size="sm" icon="sync" data-month-retry @click="retry">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <p v-if="offlineWithoutData" class="month-note" role="status">{{ t('month.offline') }}</p>
    <p v-if="dayEventsFailed && !offlineWithoutData" class="month-note" role="status" data-month-day-events-error>
      {{ t('month.dayEventsError') }}
    </p>

    <div class="month-layout">
      <div class="month-main">
        <p v-if="showEmpty" class="month-empty" data-month-empty>
          {{ t('month.empty') }}
          <RouterLink to="/plan/schedule">{{ t('month.emptyPlan') }}</RouterLink>
          <span aria-hidden="true">·</span>
          <RouterLink to="/planner?view=list">{{ t('month.emptyCommitments') }}</RouterLink>
        </p>
        <p v-if="data?.truncated" class="month-note">{{ t('month.truncated') }}</p>

        <div
          class="month-grid"
          :class="{ 'month-grid--loading': loading }"
          role="grid"
          :aria-label="t('month.grid', { month: formatCivilYearMonth(month) })"
          aria-describedby="month-grid-hint"
          aria-readonly="true"
          :aria-busy="loading ? 'true' : undefined"
          :aria-rowcount="grid.weeks.length + 1"
          aria-colcount="7"
          :data-weeks="grid.weeks.length"
        >
          <div class="month-row month-row--head" role="row" aria-rowindex="1">
            <div
              v-for="(head, index) in weekdayHeads"
              :key="head.date"
              class="month-weekday"
              role="columnheader"
              :aria-colindex="index + 1"
              :aria-label="head.long"
            >
              <span aria-hidden="true">{{ head.short }}</span>
            </div>
          </div>
          <div
            v-for="(week, weekIndex) in grid.weeks"
            :key="week[0]?.date ?? weekIndex"
            class="month-row"
            role="row"
            :aria-rowindex="weekIndex + 2"
          >
            <div
              v-for="(day, dayIndex) in week"
              :key="day.date"
              :ref="(element) => setCell(day.date, element)"
              class="month-cell"
              :class="{
                'month-cell--other': !day.inMonth,
                'month-cell--past': day.past,
                'month-cell--today': day.today,
                'month-cell--selected': day.date === selected,
              }"
              role="gridcell"
              :aria-colindex="dayIndex + 1"
              :aria-label="cellName(day)"
              :aria-selected="day.date === selected ? 'true' : 'false'"
              :tabindex="day.date === active ? 0 : -1"
              :data-date="day.date"
              @click="select(day.date)"
              @focus="active = day.date"
              @keydown="onCellKeydown($event, day.date)"
            >
              <span class="month-cell-head" aria-hidden="true">
                <span class="month-day tabular" :class="{ 'month-day--labelled': day.labels.length > 0 }">{{ day.day }}</span>
                <span v-if="day.today" class="month-today-word">{{ t('month.cell.today') }}</span>
                <span v-if="day.labels.length > 0" class="month-day-labels" data-month-day-labels>
                  <span v-for="label in day.labels" :key="label.key" class="month-day-label">{{ label.title }}</span>
                </span>
              </span>
              <span v-if="loading && day.inMonth" class="month-cell-skeleton" aria-hidden="true">
                <span class="skeleton skeleton--text" :style="{ width: `${48 + ((day.day * 17) % 40)}%` }"></span>
                <span v-if="day.day % 3 !== 0" class="skeleton skeleton--text" :style="{ width: `${36 + ((day.day * 29) % 44)}%` }"></span>
              </span>
              <template v-else-if="day.items.length > 0">
                <ul class="month-items" aria-hidden="true">
                  <li
                    v-for="item in cellLines(day).shown"
                    :key="item.key"
                    class="month-item"
                    :class="[`month-item--${item.kind}`, { 'month-item--done': item.done }]"
                    :data-kind="item.kind"
                  >
                    <span class="month-item-ink">
                      <span v-if="item.kind === 'commitment'" class="month-mark month-mark--commitment"></span>
                      <UiDeadlineFlag v-else-if="item.kind === 'deadline'" class="month-mark month-mark--deadline" />
                      <UiIcon v-else-if="item.done" name="check" :size="11" class="month-item-check" />
                      <span v-else class="month-mark month-mark--block"></span>
                      <span class="month-item-time tabular">{{ cellTime(item) }}</span>
                      <span class="month-item-title">{{ itemTitle(item) }}</span>
                    </span>
                  </li>
                  <li v-if="cellLines(day).hidden > 0" class="month-more tabular">
                    {{ tp('month.more', cellLines(day).hidden) }}
                  </li>
                </ul>
                <span class="month-marks" aria-hidden="true">
                  <span
                    v-if="day.counts.block > 0"
                    class="month-mark month-mark--block"
                    :class="{ 'month-mark--done': allBlocksDone(day) }"
                  ></span>
                  <span v-if="day.counts.commitment > 0" class="month-mark month-mark--commitment"></span>
                  <UiDeadlineFlag v-if="day.counts.deadline > 0" class="month-mark month-mark--deadline" :size="13" />
                </span>
              </template>
            </div>
          </div>
        </div>
        <p id="month-grid-hint" class="visually-hidden">{{ t('month.gridHint') }}</p>

        <ul class="month-legend" :aria-label="t('month.legend')">
          <li><span class="month-legend-run" aria-hidden="true"></span>{{ t('month.legendBlock') }}</li>
          <li><span class="month-legend-run month-legend-run--done" aria-hidden="true"></span>{{ t('month.legendDone') }}</li>
          <li><span class="month-mark month-mark--commitment" aria-hidden="true"></span>{{ t('month.legendCommitment') }}</li>
          <li><UiDeadlineFlag class="month-mark month-mark--deadline" />{{ t('month.legendDeadline') }}</li>
          <li><span class="month-legend-today tabular" aria-hidden="true">{{ todayNumber }}</span>{{ t('month.legendToday') }}</li>
          <li v-if="hasDayLabels" data-month-legend-day-event>
            <span class="month-legend-daylabel tabular" aria-hidden="true">{{ firstLabelledDay }}</span>{{ t('month.legendDayEvent') }}
          </li>
        </ul>
      </div>

      <section v-if="selectedDay" class="card month-detail" aria-labelledby="month-detail-title" data-month-detail>
        <header class="month-detail-head">
          <h2 id="month-detail-title">
            {{ formatCivilDate(selectedDay.date) }}
            <span v-if="selectedDay.today" class="month-detail-today">{{ t('month.cell.today') }}</span>
          </h2>
          <RouterLink v-if="selectedDay.today" to="/overview" class="btn btn--sm month-detail-open-today">
            {{ t('month.detail.openToday') }}
          </RouterLink>
        </header>
        <ul
          v-if="selectedDay.labels.length > 0"
          class="month-agenda month-agenda--labels"
          :aria-label="t('month.detail.dayEvents', { date: formatCivilDate(selectedDay.date) })"
          data-month-detail-labels
        >
          <li v-for="label in selectedDay.labels" :key="label.key" class="month-agenda-item month-agenda-item--label" data-kind="day-event">
            <span class="month-agenda-daymark" aria-hidden="true"></span>
            <span class="month-agenda-body">
              <span class="month-agenda-meta">
                <span class="month-agenda-time tabular">{{ labelDates(label) }}</span>
                <span class="month-agenda-kind">{{ labelKind(label) }}</span>
              </span>
              <span class="month-agenda-label">{{ label.title }}</span>
            </span>
          </li>
        </ul>
        <div v-if="loading" class="month-detail-skeleton" aria-hidden="true">
          <span class="skeleton skeleton--text"></span>
          <span class="skeleton skeleton--text"></span>
        </div>
        <ul
          v-else-if="selectedDay.items.length > 0"
          class="month-agenda"
          :aria-label="t('month.detail.list', { date: formatCivilDate(selectedDay.date) })"
        >
          <li
            v-for="item in selectedDay.items"
            :key="item.key"
            class="month-agenda-item"
            :class="[`month-agenda-item--${item.kind}`, { 'month-agenda-item--done': item.done }]"
            :data-kind="item.kind"
            :data-source="item.fromGoogle ? 'google' : undefined"
          >
            <span
              v-if="item.kind === 'block'"
              class="month-legend-run"
              :class="{ 'month-legend-run--done': item.done }"
              aria-hidden="true"
            ></span>
            <span v-else-if="item.kind === 'commitment'" class="month-mark month-mark--commitment" aria-hidden="true"></span>
            <UiDeadlineFlag v-else class="month-mark month-mark--deadline" :size="13" />
            <span class="month-agenda-body">
              <span class="month-agenda-meta">
                <span class="month-agenda-time tabular">{{ agendaTime(item) }}</span>
                <span class="month-agenda-kind">{{ agendaKind(item) }}</span>
              </span>
              <RouterLink :to="agendaLink(item)" class="month-agenda-title">{{ itemTitle(item) }}</RouterLink>
            </span>
          </li>
        </ul>
        <p v-else-if="data && selectedDay.labels.length === 0" class="month-detail-empty">{{ t('month.detail.empty') }}</p>
      </section>
    </div>
  </section>
</template>
