<script setup lang="ts">
import { computed, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDeadlineFlag from '../ui/UiDeadlineFlag.vue';
import { useCalendarDayEvents } from '../../composables/useGoogleCalendar';
import { useTaskDirectory } from '../../composables/useOverview';
import { usePlannerCard } from '../../composables/usePlannerCard';
import { usePlannerQueryFix } from '../../composables/usePlannerQueryFix';
import { useOwnerTimeZone, usePlannerRange } from '../../composables/usePlannerRange';
import { projectHue, weekRange } from '../../domain/overview';
import { plannerLocation, plannerWeekOf } from '../../domain/plannerRoute';
import { addDaysToDate, startOfWeek, todayInZone } from '../../domain/time';
import { buildWeekGrid, type WeekItem } from '../../domain/weekGrid';
import { t } from '../../i18n';
import { formatCivilDateRange } from '../../i18n/format';
import { useLayoutNow } from '../../layout/now';
import { useOfflineStore } from '../../stores/offline';
import PlannerHeader from './PlannerHeader.vue';
import PlannerItemCard from './PlannerItemCard.vue';
import WeekGrid from './WeekGrid.vue';

/**
 * 플래너 · 주 (HOLO-02): the week in the address (`/planner`, `?w=`) on the
 * week grid. The screen only reads; what can be done to an item is in its
 * detail card, and the one primary button (약속 추가) is in the head.
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
const dayEventsQuery = useCalendarDayEvents(computed(() => ({ from: weekStart.value, to: weekEnd.value })));
const dayEventsFailed = computed(() => dayEventsQuery.isError.value && dayEventsQuery.data.value === undefined);
const directory = useTaskDirectory();

const showEarly = ref(false);
const grid = computed(() =>
  buildWeekGrid({
    start: weekStart.value,
    timeZone: timeZone.value,
    today: today.value,
    nowMs: now.value,
    blocks: data.value?.blocks ?? [],
    commitments: data.value?.commitments ?? [],
    tasks: data.value?.tasks ?? [],
    dayEvents: dayEventsQuery.data.value ?? [],
    showEarly: showEarly.value,
  }),
);

const offlineWithoutData = computed(() => data.value === null && !offline.online);
const loading = computed(() => data.value === null && !query.isError.value && !offlineWithoutData.value);
const loadFailed = computed(() => data.value === null && query.isError.value);
const staleFailed = computed(() => data.value !== null && query.isError.value);
const showEmpty = computed(() => data.value !== null && grid.value.empty);

const rangeText = computed(() =>
  formatCivilDateRange(weekStart.value, weekEnd.value, {
    weekday: false,
    year: weekStart.value.slice(0, 4) !== today.value.slice(0, 4),
  }),
);

/** Each item once (a block over midnight is still one block). */
const summary = computed(() => {
  if (data.value === null || grid.value.empty) return null;
  const seen = { block: new Set<string>(), commitment: new Set<string>(), deadline: new Set<string>() };
  for (const day of grid.value.days) for (const item of day.items) seen[item.kind].add(item.key.split('@')[0] ?? item.key);
  return t('planner.week.summary', {
    blocks: seen.block.size,
    commitments: seen.commitment.size,
    deadlines: seen.deadline.size,
  });
});

const announcement = ref('');
watch(weekStart, (next, previous) => {
  if (next !== previous) announcement.value = t('planner.week.announce', { range: rangeText.value });
});

function goToWeek(start: string): void {
  void router.push(plannerLocation('week', start, today.value, route.name));
}

// ── The detail card ────────────────────────────────────────────────────
const gridView = ref<InstanceType<typeof WeekGrid> | null>(null);
const frame = computed<HTMLElement | null>(() => gridView.value?.content ?? null);
const card = usePlannerCard({ frame, visible: () => gridView.value?.visibleRect() ?? null });

const openItem = computed<WeekItem | null>(() => {
  const key = card.openKey.value;
  if (key === null) return null;
  for (const day of grid.value.days) {
    const found = day.items.find((item) => item.key === key);
    if (found !== undefined) return found;
  }
  return null;
});
// The item went away (another week, a re-read without it): so does its card.
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

function refresh(): Promise<unknown> {
  return query.refetch();
}

function retry(): void {
  void query.refetch();
  if (dayEventsQuery.isError.value) void dayEventsQuery.refetch();
}
</script>

<template>
  <section class="page page--wide planner-page planner-page--week" data-planner="week">
    <PlannerHeader
      view="week"
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
      {{ loading ? t('planner.week.loading') : announcement }}
    </p>

    <UiBanner v-if="loadFailed" tone="error" class="error-panel planner-error">
      <p class="error-text" role="alert">{{ t('planner.week.loadError') }}</p>
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
    <p v-if="offlineWithoutData" class="planner-note" role="status">{{ t('planner.week.offline') }}</p>
    <p v-if="dayEventsFailed && !offlineWithoutData" class="planner-note" role="status" data-planner-day-events-error>
      {{ t('month.dayEventsError') }}
    </p>
    <p v-if="showEmpty" class="planner-note planner-empty" data-planner-empty>
      {{ t('planner.week.empty') }}
      <RouterLink to="/plans/new">{{ t('month.emptyPlan') }}</RouterLink>
    </p>
    <p v-if="data?.truncated" class="planner-note">{{ t('month.truncated') }}</p>

    <WeekGrid
      ref="gridView"
      :grid="grid"
      :time-zone="timeZone"
      :label="t('planner.week.grid', { range: rangeText })"
      :loading="loading"
      :open-key="card.openKey.value"
      :show-early="showEarly"
      @open="(item, element) => card.toggle(item.key, element)"
      @toggle-early="showEarly = !showEarly"
    >
      <template #card>
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
      </template>
    </WeekGrid>

    <ul class="planner-legend" :aria-label="t('month.legend')">
      <li><span class="planner-swatch planner-swatch--block" aria-hidden="true"></span>{{ t('month.legendBlock') }}</li>
      <li><span class="planner-swatch planner-swatch--done" aria-hidden="true"></span>{{ t('month.legendDone') }}</li>
      <li><span class="planner-swatch planner-swatch--commitment" aria-hidden="true"></span>{{ t('month.legendCommitment') }}</li>
      <li><UiDeadlineFlag :size="13" />{{ t('month.legendDeadline') }}</li>
    </ul>
  </section>
</template>
