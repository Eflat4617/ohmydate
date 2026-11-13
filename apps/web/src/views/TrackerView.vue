<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import TaskPicker from '../components/tracker/TaskPicker.vue';
import DurationNumeral from '../components/overview/DurationNumeral.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import { focusContextFor, rememberFocusBlocks } from '../composables/focusContext';
import {
  useFocusStart,
  useRunningSession,
  useSecondTick,
  useTaskDirectory,
  useWeekSessions,
} from '../composables/useOverview';
import { useOwnerTimeZone } from '../composables/usePlannerRange';
import { clockParts, minutesOfSeconds, nextBlockOf, projectHue, sessionFocusedSec, weekRange } from '../domain/overview';
import { addDaysToDate, startOfWeek, todayInZone } from '../domain/time';
import {
  NO_FILTER,
  SESSION_STATES,
  defaultPickerTask,
  filterRows,
  focusedTotal,
  groupByDay,
  isFiltered,
  projectsOf,
  trackerRows,
  type SessionState,
  type TrackerRow,
  type TrackerTask,
} from '../domain/tracker';
import { t, tp } from '../i18n';
import { formatCivilDate, formatCivilDateRange, formatDuration, formatTime, formatTimeRange } from '../i18n/format';
import { useLayoutNow } from '../layout/now';
import { useTodaySnapshot } from '../layout/useTodaySnapshot';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';

/**
 * 타임 트래커 (HOLO-02): the timer and the record of it.
 *
 * Top: the timer card — the running session live, or 대기 중 with
 * "무엇을 하고 있나요?": pick a task (the next planned block's is picked
 * already) and 집중 시작. Starting opens the Focus screen for the session;
 * there is one timer engine, and it is Focus's.
 *
 * Under it: 기록 — the focus sessions of a week as a table, by day with a
 * subtotal each and the week's total, filtered by project and by state, each
 * with "다시 시작".
 *
 * Nothing here is a new API: sessions, tasks, projects and today's plan come
 * from the routes the other screens use (composables/useOverview.ts). The
 * session list takes no date range, so a week is read by following its pages
 * back until one reaches past the week's start, up to 20 pages of 100; past
 * that the totals are partial and the screen says so.
 */
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const sessionStore = useSessionStore();

const now = useLayoutNow();
const { timeZone, ready } = useOwnerTimeZone();
const today = computed(() => todayInZone(timeZone.value, now.value));
const thisWeekStart = computed(() => startOfWeek(today.value));

// ── The timer card ─────────────────────────────────────────────────────
const snapshot = useTodaySnapshot();
const plan = computed(() => snapshot.today.value);
const directory = useTaskDirectory();
const { running, refetch: refetchRunning } = useRunningSession();
const focus = useFocusStart({ onActiveExists: refetchRunning });

const isRunning = computed(() => running.value?.state === 'active');
const second = useSecondTick(isRunning);
const liveNow = computed(() => (isRunning.value ? second.value : now.value));

const status = computed(() => {
  if (running.value === null) return 'idle' as const;
  return running.value.state === 'paused' ? ('paused' as const) : ('active' as const);
});
const clock = computed(() => clockParts(running.value === null ? 0 : sessionFocusedSec(running.value, liveNow.value)));
const clockText = computed(() => `${clock.value.hours}:${clock.value.minutes}:${clock.value.seconds}`);

const tasks = computed<ReadonlyMap<string, TrackerTask>>(() => directory.data.value?.tasks ?? new Map());
const taskList = computed(() => [...tasks.value.values()]);
const projectTags = computed(
  () =>
    new Map(
      [...(directory.data.value?.projects.values() ?? [])].map((project) => [
        project.id,
        { title: project.kind === 'inbox' ? t('nav.inbox') : project.title, hue: projectHue(project.id) },
      ]),
    ),
);

const runningTitle = computed(() => {
  const session = running.value;
  if (session === null) return null;
  return (
    tasks.value.get(session.taskId)?.title ??
    plan.value?.blocks.find((block) => block.id === session.blockId || block.taskId === session.taskId)?.title ??
    focusContextFor(sessionStore.ownerId, session.blockId ?? null, session.taskId)?.title ??
    null
  );
});

const nextBlock = computed(() => (plan.value === null ? null : nextBlockOf(plan.value.blocks, now.value)));
const nextTaskId = computed(() => defaultPickerTask(nextBlock.value?.taskId ?? null, tasks.value));

/** The task picked to start on. Until the person picks one it follows the next block. */
const picked = ref<string | null>(null);
let pickedByHand = false;
watch(
  nextTaskId,
  (taskId) => {
    if (!pickedByHand) picked.value = taskId;
  },
  { immediate: true },
);

function pick(taskId: string | null): void {
  pickedByHand = true;
  picked.value = taskId;
}

const pickedTask = computed(() => (picked.value === null ? null : (tasks.value.get(picked.value) ?? null)));
const pickedIsNext = computed(() => picked.value !== null && picked.value === nextBlock.value?.taskId);
const pickedHint = computed(() => {
  const block = nextBlock.value;
  if (!pickedIsNext.value || block === null || plan.value === null) return null;
  return t('tracker.timer.nextBlock', { time: formatTimeRange(block.startAt, block.endAt, plan.value.timeZone) });
});

// One session at a time: while one runs the way on is "이어서 보기".
const canStart = computed(() => focus.canStart.value && running.value === null);
const starting = computed(() => focus.startingTaskId.value !== null);

function start(): void {
  const task = pickedTask.value;
  if (task === null) return;
  const block = pickedIsNext.value ? nextBlock.value : null;
  const current = plan.value;
  // Presentational only: lets Focus show the block's title and planned length.
  if (block !== null && current !== null) rememberFocusBlocks(sessionStore.ownerId, current.blocks, current.timeZone);
  void focus.start(block === null ? { taskId: task.id } : { taskId: task.id, blockId: block.id });
}

function restart(taskId: string): void {
  void focus.start({ taskId });
}

function resume(): void {
  const session = running.value;
  if (session !== null) void router.push(`/focus/${session.id}`);
}

// ── 기록 ───────────────────────────────────────────────────────────────
/** The week on show: 0 is this week, -1 the one before, and so on. */
const weekOffset = ref(0);
const weekStart = computed(() => addDaysToDate(thisWeekStart.value, weekOffset.value * 7));
const weekText = computed(() => formatCivilDateRange(weekStart.value, addDaysToDate(weekStart.value, 6)));
const range = computed(() => (ready.value ? weekRange(weekStart.value, timeZone.value) : null));
const sessions = useWeekSessions(range);

const filterProject = ref('all');
const filterState = ref<SessionState | 'all'>('all');
const filter = computed(() => ({ project: filterProject.value, state: filterState.value }));

const allRows = computed(() => trackerRows(sessions.data.value?.sessions ?? [], tasks.value, timeZone.value, liveNow.value));
const rows = computed(() => filterRows(allRows.value, filter.value));
const days = computed(() => groupByDay(rows.value));
const totalMin = computed(() => minutesOfSeconds(focusedTotal(rows.value)));

/** Projects that have a session this week (and the one picked, so its option never vanishes). */
const projectOptions = computed(() => {
  const order = [...(directory.data.value?.projects.keys() ?? [])];
  const ids = projectsOf(allRows.value, order);
  if (filterProject.value !== 'all' && !ids.includes(filterProject.value)) ids.push(filterProject.value);
  return ids.flatMap((id) => {
    const tag = projectTags.value.get(id);
    return tag === undefined ? [] : [{ id, title: tag.title }];
  });
});

function clearFilters(): void {
  filterProject.value = NO_FILTER.project;
  filterState.value = NO_FILTER.state;
}

const logState = computed(() => {
  if (sessions.data.value === undefined || directory.data.value === undefined) {
    if (sessions.isError.value || directory.isError.value) return 'error' as const;
    if (!offline.online) return 'offline' as const;
    return 'loading' as const;
  }
  return 'ready' as const;
});
const logStale = computed(() => logState.value === 'ready' && (sessions.isError.value || directory.isError.value));

function retryLog(): void {
  if (sessions.isError.value) void sessions.refetch();
  if (directory.isError.value) void directory.refetch();
}

function retryPlan(): void {
  void queryClient.invalidateQueries({ queryKey: ['today'] });
}

const STATE_TONES = { active: 'accent', paused: 'warn', completed: 'success', abandoned: 'neutral' } as const;

function rowTitle(row: TrackerRow): string {
  return row.title ?? t('overview.tracker.untitled');
}

function rowTime(row: TrackerRow): string {
  return row.endedAt === null
    ? t('overview.log.untilNow', { start: formatTime(row.startedAt, timeZone.value) })
    : formatTimeRange(row.startedAt, row.endedAt, timeZone.value);
}

function rowFocused(row: TrackerRow): string {
  return formatDuration(minutesOfSeconds(row.focusedSec));
}

const announcement = ref('');
watch(weekStart, (next, previous) => {
  if (next !== previous) announcement.value = t('tracker.log.weekAnnounce', { range: weekText.value });
});
</script>

<template>
  <section class="page page--wide tracker-page" data-tracker>
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('tracker.title') }}</h1>
        <p class="page-lede">{{ t('tracker.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </div>
    </header>

    <UiBanner v-if="focus.error.value" tone="error" role="alert" data-tracker-error>
      {{ focus.error.value }}
      <template v-if="focus.activeExists.value && running" #actions>
        <UiButton size="sm" @click="resume">{{ t('overview.resume') }}</UiButton>
      </template>
    </UiBanner>

    <!-- The timer card -->
    <section class="card tracker-timer" aria-labelledby="tracker-timer-title" :data-status="status" data-tracker-timer>
      <div class="tracker-timer-clock">
        <h2 id="tracker-timer-title" class="card-title">
          <UiIcon name="timer" :size="18" />
          {{ t('tracker.timer.title') }}
        </h2>
        <p class="tracker-timer-status" data-tracker-status>{{ t(`overview.tracker.${status}`) }}</p>
        <p class="tracker-timer-digits" role="timer" :aria-label="t('overview.tracker.timer')" data-timer>
          <span class="visually-hidden">{{ clockText }}</span>
          <span aria-hidden="true">
            <span>{{ clock.hours }}:{{ clock.minutes }}</span><span class="tracker-timer-seconds">:{{ clock.seconds }}</span>
          </span>
        </p>
      </div>

      <div v-if="running" class="tracker-timer-now" data-tracker-running>
        <p class="tracker-timer-question">
          {{ status === 'paused' ? t('tracker.timer.pausedOn') : t('tracker.timer.runningOn') }}
        </p>
        <p class="tracker-timer-task">{{ runningTitle ?? t('focus.fallbackTitle') }}</p>
        <div class="tracker-timer-actions">
          <UiButton variant="primary" icon="play" data-tracker-resume @click="resume">{{ t('overview.resume') }}</UiButton>
        </div>
      </div>
      <form v-else class="tracker-timer-now" data-tracker-idle @submit.prevent="start">
        <TaskPicker
          id="tracker-task"
          :model-value="picked"
          :tasks="taskList"
          :projects="projectTags"
          :next-task-id="nextTaskId"
          :label="t('tracker.timer.question')"
          :placeholder="directory.isLoading.value ? t('tracker.picker.loading') : t('tracker.picker.placeholder')"
          :disabled="directory.data.value === undefined"
          @update:model-value="pick"
        />
        <p v-if="!offline.mutationsEnabled" class="tracker-timer-hint" data-tracker-offline-hint>
          {{ t('overview.startOffline') }}
        </p>
        <p v-else-if="pickedHint" class="tracker-timer-hint" data-tracker-hint>{{ pickedHint }}</p>
        <p v-else-if="directory.isError.value && directory.data.value === undefined" class="tracker-timer-hint" role="alert">
          {{ t('tracker.picker.loadError') }}
          <button type="button" class="btn btn--ghost btn--sm" @click="directory.refetch()">{{ t('common.retry') }}</button>
        </p>
        <p v-else-if="snapshot.isError.value" class="tracker-timer-hint">
          {{ t('tracker.timer.planError') }}
          <button type="button" class="btn btn--ghost btn--sm" data-tracker-plan-retry @click="retryPlan">{{ t('common.retry') }}</button>
        </p>
        <p v-else-if="pickedTask === null" class="tracker-timer-hint">{{ t('tracker.timer.pickFirst') }}</p>
        <div class="tracker-timer-actions">
          <UiButton
            type="submit"
            variant="primary"
            icon="play"
            :disabled="!canStart || pickedTask === null"
            :busy="starting"
            data-tracker-start
          >
            {{ starting ? t('overview.starting') : t('overview.startFocus') }}
          </UiButton>
        </div>
      </form>
    </section>

    <!-- 기록 -->
    <section
      class="card tracker-log"
      aria-labelledby="tracker-log-title"
      :aria-busy="logState === 'loading' ? 'true' : undefined"
      :data-state="logState"
      data-tracker-log
    >
      <header class="card-header tracker-log-head">
        <h2 id="tracker-log-title" class="card-title">
          <UiIcon name="list" :size="18" />
          {{ t('tracker.log.title') }}
        </h2>
        <div class="tracker-log-controls">
          <div class="week-switch" role="group" :aria-label="t('tracker.log.week')">
            <button
              type="button"
              class="btn btn--icon btn--sm"
              :aria-label="t('overview.week.previous')"
              data-week-previous
              @click="weekOffset -= 1"
            >
              <UiIcon name="chevron-left" :size="16" />
            </button>
            <p class="week-switch-label" data-week>
              <UiIcon name="month" :size="16" />
              <span class="tabular">{{ weekText }}</span>
            </p>
            <button
              type="button"
              class="btn btn--icon btn--sm"
              :aria-label="t('overview.week.next')"
              :disabled="weekOffset >= 0"
              data-week-next
              @click="weekOffset += 1"
            >
              <UiIcon name="chevron-right" :size="16" />
            </button>
          </div>
          <label class="tracker-filter">
            <span class="visually-hidden">{{ t('tracker.log.filterProject') }}</span>
            <select v-model="filterProject" data-filter-project>
              <option value="all">{{ t('tracker.log.allProjects') }}</option>
              <option v-for="project in projectOptions" :key="project.id" :value="project.id">{{ project.title }}</option>
            </select>
          </label>
          <label class="tracker-filter">
            <span class="visually-hidden">{{ t('tracker.log.filterState') }}</span>
            <select v-model="filterState" data-filter-state>
              <option value="all">{{ t('tracker.log.allStates') }}</option>
              <option v-for="state in SESSION_STATES" :key="state" :value="state">{{ t(`overview.log.state.${state}`) }}</option>
            </select>
          </label>
        </div>
      </header>
      <p class="visually-hidden" role="status" aria-live="polite">
        {{ logState === 'loading' ? t('tracker.log.loading') : announcement }}
      </p>

      <div v-if="logState === 'loading'" class="tracker-log-skeleton" aria-hidden="true">
        <span class="skeleton skeleton--block tracker-skeleton-number"></span>
        <span v-for="row in 5" :key="row" class="skeleton skeleton--text tracker-skeleton-row"></span>
      </div>
      <div v-else-if="logState === 'error'" class="tracker-log-error" role="alert">
        <p>{{ t('tracker.log.loadError') }}</p>
        <UiButton size="sm" icon="sync" data-retry @click="retryLog">{{ t('common.retry') }}</UiButton>
      </div>
      <p v-else-if="logState === 'offline'" class="tracker-note" role="status" data-tracker-offline>
        {{ t('tracker.log.offline') }}
      </p>
      <template v-else>
        <UiBanner v-if="logStale" tone="error" inline class="tracker-log-stale">
          <span role="status">{{ t('tracker.log.staleError') }}</span>
          <template #actions>
            <UiButton size="sm" icon="sync" data-retry @click="retryLog">{{ t('common.retry') }}</UiButton>
          </template>
        </UiBanner>

        <div class="tracker-total" data-tracker-total>
          <DurationNumeral :minutes="totalMin" />
          <p class="tracker-total-label">
            <span>{{ weekOffset === 0 ? t('overview.progress.totalThisWeek') : t('overview.progress.totalWeek') }}</span>
            <span v-if="rows.length > 0" class="tabular">{{ tp('tracker.log.count', rows.length) }}</span>
            <span v-if="isFiltered(filter)">{{ t('tracker.log.filtered') }}</span>
          </p>
        </div>

        <div v-if="days.length > 0" class="log-scroll tracker-log-scroll">
          <table class="data-table tracker-table" data-tracker-table>
            <caption class="visually-hidden">{{ t('tracker.log.caption', { range: weekText }) }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ t('overview.log.colTask') }}</th>
                <th scope="col">{{ t('overview.log.colProject') }}</th>
                <th scope="col">{{ t('overview.log.colTime') }}</th>
                <th scope="col" class="num">{{ t('overview.log.colFocus') }}</th>
                <th scope="col">{{ t('overview.log.colState') }}</th>
                <th scope="col"><span class="visually-hidden">{{ t('overview.log.colActions') }}</span></th>
              </tr>
            </thead>
            <tbody v-for="day in days" :key="day.date" :data-day="day.date">
              <tr class="tracker-day-row">
                <th colspan="3" scope="rowgroup" class="tracker-day-date">
                  {{ formatCivilDate(day.date) }}
                  <span v-if="day.date === today" class="tracker-day-today">{{ t('month.cell.today') }}</span>
                </th>
                <td class="num tracker-day-total" data-day-total>
                  <span class="visually-hidden">{{ t('tracker.log.subtotal') }}</span>
                  {{ formatDuration(minutesOfSeconds(day.focusedSec)) }}
                </td>
                <td colspan="2"></td>
              </tr>
              <tr v-for="row in day.rows" :key="row.id" :data-session="row.state">
                <th scope="row" class="log-task">{{ rowTitle(row) }}</th>
                <td>
                  <UiBadge
                    v-if="row.projectId && projectTags.get(row.projectId)"
                    :class="`badge--${projectTags.get(row.projectId)?.hue}`"
                  >
                    {{ projectTags.get(row.projectId)?.title }}
                  </UiBadge>
                </td>
                <td class="log-time">{{ rowTime(row) }}</td>
                <td class="num">{{ rowFocused(row) }}</td>
                <td>
                  <UiBadge :tone="STATE_TONES[row.state]">{{ t(`overview.log.state.${row.state}`) }}</UiBadge>
                </td>
                <td class="log-actions">
                  <template v-if="row.title !== null">
                    <UiButton
                      variant="ghost"
                      size="sm"
                      icon="play"
                      :disabled="!canStart"
                      :busy="focus.startingTaskId.value === row.taskId"
                      :aria-label="t('overview.tracker.restartAria', { title: rowTitle(row) })"
                      data-restart
                      @click="restart(row.taskId)"
                    >
                      {{ t('overview.tracker.restart') }}
                    </UiButton>
                    <RouterLink
                      :to="`/tasks/${row.taskId}`"
                      class="icon-link"
                      :aria-label="t('overview.log.openTask', { title: rowTitle(row) })"
                      data-open-task
                    >
                      <UiIcon name="open" :size="16" />
                    </RouterLink>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <UiEmptyState
          v-else-if="allRows.length > 0"
          :icon="null"
          compact
          :title="t('tracker.log.noMatch')"
          data-tracker-no-match
        >
          <template #actions>
            <UiButton size="sm" data-filter-clear @click="clearFilters">{{ t('tracker.log.clearFilters') }}</UiButton>
          </template>
        </UiEmptyState>
        <UiEmptyState v-else icon="timer" compact :title="t('tracker.log.empty')" data-empty>
          {{ t('tracker.log.emptyBody') }}
        </UiEmptyState>
        <p v-if="sessions.data.value?.truncated" class="tracker-note" data-tracker-truncated>{{ t('tracker.log.truncated') }}</p>
      </template>
    </section>
  </section>
</template>
