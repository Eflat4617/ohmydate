<script setup lang="ts">
import { computed, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DayTimetable from '../DayTimetable.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDeadlineFlag from '../ui/UiDeadlineFlag.vue';
import UiIcon from '../ui/UiIcon.vue';
import { useCalendarDayEvents } from '../../composables/useGoogleCalendar';
import { useTaskDirectory } from '../../composables/useOverview';
import { usePlannerCard } from '../../composables/usePlannerCard';
import { usePlannerQueryFix } from '../../composables/usePlannerQueryFix';
import { useOwnerTimeZone, usePlannerRange } from '../../composables/usePlannerRange';
import { dayRange, projectHue } from '../../domain/overview';
import { plannerDayOf, plannerLocation } from '../../domain/plannerRoute';
import { addDaysToDate, todayInZone } from '../../domain/time';
import { buildWeekGrid, type WeekItem } from '../../domain/weekGrid';
import { t, tp } from '../../i18n';
import { formatCivilDate, formatCivilDateRange, formatTime, formatTimeRange } from '../../i18n/format';
import { useLayoutNow } from '../../layout/now';
import { useOfflineStore } from '../../stores/offline';
import PlannerHeader from './PlannerHeader.vue';
import PlannerItemCard from './PlannerItemCard.vue';

/**
 * 플래너 · 일 (HOLO-02): one day (`/planner?view=day`, `&d=`). The day's list
 * — 약속, blocks and deadlines in time order — beside the same day drawn on
 * the ten-minute timetable. An item of the list opens the same detail card
 * the week grid uses.
 */
const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const now = useLayoutNow();
const { timeZone, ready } = useOwnerTimeZone();
usePlannerQueryFix();

const today = computed(() => todayInZone(timeZone.value, now.value));
const date = computed(() => plannerDayOf(route.query, today.value));
const isToday = computed(() => date.value === today.value);

const range = computed(() => (ready.value ? dayRange(date.value, timeZone.value) : null));
const query = usePlannerRange(range);
const data = computed(() => query.data.value ?? null);
const dayEventsQuery = useCalendarDayEvents(computed(() => ({ from: date.value, to: date.value })));
const directory = useTaskDirectory();

const grid = computed(() =>
  buildWeekGrid({
    start: date.value,
    days: 1,
    timeZone: timeZone.value,
    today: today.value,
    nowMs: now.value,
    blocks: data.value?.blocks ?? [],
    commitments: data.value?.commitments ?? [],
    tasks: data.value?.tasks ?? [],
    dayEvents: dayEventsQuery.data.value ?? [],
  }),
);
const day = computed(() => grid.value.days[0] ?? null);
const items = computed(() => day.value?.items ?? []);
const labels = computed(() => day.value?.labels ?? []);

const offlineWithoutData = computed(() => data.value === null && !offline.online);
const loading = computed(() => data.value === null && !query.isError.value && !offlineWithoutData.value);
const loadFailed = computed(() => data.value === null && query.isError.value);
const staleFailed = computed(() => data.value !== null && query.isError.value);

const title = computed(() =>
  formatCivilDate(date.value, { year: date.value.slice(0, 4) !== today.value.slice(0, 4) }),
);
const summary = computed(() => {
  if (data.value === null || day.value === null || items.value.length === 0) return null;
  return t('planner.week.summary', {
    blocks: day.value.counts.block,
    commitments: day.value.counts.commitment,
    deadlines: day.value.counts.deadline,
  });
});

// ── The same day on the timetable ──────────────────────────────────────
const titles = computed(() => new Map((data.value?.tasks ?? []).map((task) => [task.id, task.title])));
const tableBlocks = computed(() =>
  (data.value?.blocks ?? [])
    .filter((block) => block.status === 'planned' || block.status === 'done')
    .map((block) => ({
      id: block.id,
      title: titles.value.get(block.taskId) ?? t('month.untitledTask'),
      startAt: block.startAt,
      endAt: block.endAt,
      status: block.status,
    })),
);
const tableCommitments = computed(() =>
  (data.value?.commitments ?? []).flatMap((commitment) =>
    (commitment.occurrences ?? []).map((occurrence) => ({
      id: `${commitment.id}:${occurrence.startAt}`,
      title: commitment.title,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
    })),
  ),
);
/** Today: the first planned block that has not ended. Another day has no "next". */
const nextBlockId = computed(() => {
  if (!isToday.value) return null;
  const next = tableBlocks.value
    .filter((block) => block.status === 'planned' && Date.parse(block.endAt) > now.value)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))[0];
  return next?.id ?? null;
});

const announcement = ref('');
watch(date, (next, previous) => {
  if (next !== previous) announcement.value = title.value;
});

function goToDay(target: string): void {
  void router.push(plannerLocation('day', target, today.value, route.name));
}

// ── What a row says ────────────────────────────────────────────────────
function itemTitle(item: WeekItem): string {
  return item.title ?? t('month.untitledTask');
}

function itemTime(item: WeekItem): string {
  if (item.endAt === null) return t('month.until', { time: formatTime(item.startAt, timeZone.value) });
  return formatTimeRange(item.startAt, item.endAt, timeZone.value);
}

function itemKind(item: WeekItem): string {
  if (item.kind === 'block') return item.done ? t('month.detail.kind.blockDone') : t('month.detail.kind.block');
  if (item.kind === 'commitment') {
    return item.fromGoogle ? t('month.detail.kind.commitmentGoogle') : t('month.detail.kind.commitment');
  }
  return t('month.detail.kind.deadline');
}

function labelKind(calendarName: string | null): string {
  return calendarName === null || calendarName.length === 0
    ? t('month.detail.kind.dayEvent')
    : t('month.detail.kind.dayEventFrom', { calendar: calendarName });
}

// ── The detail card ────────────────────────────────────────────────────
const frame = ref<HTMLElement | null>(null);
const card = usePlannerCard({ frame });

const openItem = computed<WeekItem | null>(() => items.value.find((item) => item.key === card.openKey.value) ?? null);
watch(openItem, (item) => {
  if (item === null && card.openKey.value !== null) card.close();
});

const openProject = computed(() => {
  const projectId = openItem.value?.projectId ?? null;
  if (projectId === null) return null;
  const project = directory.data.value?.projects.get(projectId);
  if (project === undefined) return null;
  return { title: project.kind === 'inbox' ? t('nav.inbox') : project.title, hue: projectHue(project.id) };
});

function setCard(instance: Element | ComponentPublicInstance | null): void {
  const element: unknown = instance !== null && '$el' in instance ? instance.$el : instance;
  card.card.value = element instanceof HTMLElement ? element : null;
}

function onRowClick(event: MouseEvent, item: WeekItem): void {
  if (event.currentTarget instanceof HTMLElement) card.toggle(item.key, event.currentTarget);
}

function refresh(): Promise<unknown> {
  return query.refetch();
}

function retry(): void {
  void query.refetch();
  if (dayEventsQuery.isError.value) void dayEventsQuery.refetch();
}
</script>

<template>
  <section class="page page--wide planner-page planner-page--day" data-planner="day">
    <PlannerHeader
      view="day"
      :title="title"
      :summary="summary"
      :anchor="date"
      :today="today"
      :time-zone="timeZone"
      :is-current="isToday"
      :navigation-label="t('planner.day.navigation')"
      :previous-label="t('planner.day.previous')"
      :next-label="t('planner.day.next')"
      @previous="goToDay(addDaysToDate(date, -1))"
      @next="goToDay(addDaysToDate(date, 1))"
      @current="goToDay(today)"
    />

    <p class="visually-hidden" role="status" aria-live="polite">
      {{ loading ? t('planner.day.loading') : announcement }}
    </p>

    <UiBanner v-if="loadFailed" tone="error" class="error-panel planner-error">
      <p class="error-text" role="alert">{{ t('planner.day.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" data-planner-retry @click="retry">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <UiBanner v-else-if="staleFailed" tone="error" inline class="planner-error planner-error--stale">
      <span role="status">{{ t('month.staleError') }}</span>
      <template #actions>
        <UiButton size="sm" icon="sync" data-planner-retry @click="retry">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <p v-if="offlineWithoutData" class="planner-note" role="status">{{ t('planner.day.offline') }}</p>

    <div class="planner-day">
      <section ref="frame" class="card planner-day-list" aria-labelledby="planner-day-list-title" data-planner-day-list>
        <header class="card-header">
          <h2 id="planner-day-list-title" class="card-title">
            <UiIcon name="list" :size="18" />
            {{ isToday ? t('planner.day.listToday') : t('planner.day.list') }}
          </h2>
          <RouterLink v-if="isToday" to="/today" class="icon-link" :aria-label="t('planner.day.openToday')" data-planner-open-today>
            <UiIcon name="open" :size="16" />
          </RouterLink>
        </header>

        <ul
          v-if="labels.length > 0"
          class="planner-agenda planner-agenda--labels"
          :aria-label="t('month.detail.dayEvents', { date: formatCivilDate(date) })"
          data-planner-day-labels
        >
          <li v-for="label in labels" :key="label.key" class="planner-agenda-label">
            <span class="planner-agenda-time tabular">
              {{ label.multiDay ? formatCivilDateRange(label.firstDate, label.lastDate) : labelKind(label.calendarName) }}
            </span>
            <span class="planner-agenda-title">{{ label.title }}</span>
          </li>
        </ul>

        <div v-if="loading" class="planner-agenda-skeleton" aria-hidden="true">
          <span v-for="row in 4" :key="row" class="skeleton skeleton--text"></span>
        </div>
        <ul
          v-else-if="items.length > 0"
          class="planner-agenda"
          :aria-label="t('month.detail.list', { date: formatCivilDate(date) })"
        >
          <li v-for="item in items" :key="item.key">
            <button
              type="button"
              class="planner-agenda-item"
              :class="[`planner-agenda-item--${item.kind}`, { 'planner-agenda-item--done': item.done }]"
              aria-haspopup="dialog"
              :aria-expanded="item.key === card.openKey.value ? 'true' : 'false'"
              :data-item="item.key"
              :data-kind="item.kind"
              @click="onRowClick($event, item)"
            >
              <span class="planner-agenda-mark" aria-hidden="true">
                <UiDeadlineFlag v-if="item.kind === 'deadline'" :size="13" />
                <UiIcon v-else-if="item.done" name="check" :size="14" />
                <span v-else class="planner-swatch" :class="`planner-swatch--${item.kind}`"></span>
              </span>
              <span class="planner-agenda-text">
                <span class="planner-agenda-meta">
                  <span class="planner-agenda-time tabular">{{ itemTime(item) }}</span>
                  <span class="planner-agenda-kind">{{ itemKind(item) }}</span>
                </span>
                <span class="planner-agenda-title">{{ itemTitle(item) }}</span>
              </span>
              <UiIcon name="chevron-right" :size="16" class="planner-agenda-more" />
            </button>
          </li>
        </ul>
        <p v-else-if="data && labels.length === 0" class="planner-day-empty" data-planner-empty>
          {{ t('month.detail.empty') }}
        </p>
        <p v-if="data && items.length > 0" class="visually-hidden">{{ tp('planner.day.count', items.length) }}</p>

        <PlannerItemCard
          v-if="openItem"
          :ref="setCard"
          :key="openItem.key"
          :item="openItem"
          :time-zone="timeZone"
          :now-ms="now"
          :project="openProject"
          :refresh="refresh"
          :side="card.side.value"
          :style="card.style.value"
          @close="(restoreFocus) => card.close({ restoreFocus })"
        />
      </section>

      <DayTimetable
        v-if="data"
        class="card planner-day-timetable"
        :blocks="tableBlocks"
        :date="date"
        :time-zone="timeZone"
        :next-block-id="nextBlockId"
        :now-ms="now"
        :commitments="tableCommitments"
        :scope="isToday ? 'today' : 'day'"
      />
    </div>
  </section>
</template>
