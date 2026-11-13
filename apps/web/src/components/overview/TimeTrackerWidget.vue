<script setup lang="ts">
import { computed } from 'vue';
import type { WorkSession } from '../../api';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import { useTaskDirectory, useWeekSessions } from '../../composables/useOverview';
import {
  clockParts,
  daysBefore,
  minutesOfSeconds,
  recentTaskSessions,
  sessionFocusedSec,
  weekRange,
} from '../../domain/overview';
import { localDateOf, startOfWeek } from '../../domain/time';
import { t } from '../../i18n';
import { formatCivilDate, formatDuration, formatTime } from '../../i18n/format';
import OverviewCard from './OverviewCard.vue';

/**
 * 타임 트래커: the running focus session as a live timer ("대기 중 00:00:00"
 * when there is none) and, under it, the last few tasks worked on, each of
 * which can be started again.
 */
const RECENT_TASKS = 3;

const props = defineProps<{
  /** The running or paused session, if any. */
  running: WorkSession | null;
  /** Its task's title, when known. */
  runningTitle: string | null;
  /** The next block of today (what "집중 시작" starts), if any. */
  nextTitle: string | null;
  today: string;
  timeZone: string;
  ready: boolean;
  /** Ticks every second while a session runs. */
  nowMs: number;
  /** False while offline or while a start is under way. */
  canStart: boolean;
  startingTaskId: string | null;
}>();

const emit = defineEmits<{ start: []; resume: []; restart: [taskId: string] }>();

const range = computed(() => (props.ready ? weekRange(startOfWeek(props.today), props.timeZone) : null));
const sessionsQuery = useWeekSessions(range);
const directory = useTaskDirectory();

const status = computed(() => {
  if (props.running === null) return 'idle' as const;
  return props.running.state === 'paused' ? ('paused' as const) : ('active' as const);
});
const clock = computed(() =>
  clockParts(props.running === null ? 0 : sessionFocusedSec(props.running, props.nowMs)),
);
const clockText = computed(() => `${clock.value.hours}:${clock.value.minutes}:${clock.value.seconds}`);

function titleOf(taskId: string): string {
  return directory.data.value?.tasks.get(taskId)?.title ?? t('overview.tracker.untitled');
}

function whenText(session: WorkSession): string {
  const date = localDateOf(session.startedAt, props.timeZone);
  const gap = daysBefore(date, props.today);
  const day =
    gap === 0 ? t('overview.tracker.today') : gap === 1 ? t('overview.tracker.yesterday') : formatCivilDate(date);
  return t('overview.tracker.when', { day, time: formatTime(session.startedAt, props.timeZone) });
}

const recent = computed(() =>
  recentTaskSessions(sessionsQuery.data.value?.recent ?? [], RECENT_TASKS).map((session) => ({
    id: session.id,
    taskId: session.taskId,
    title: titleOf(session.taskId),
    focused: formatDuration(minutesOfSeconds(sessionFocusedSec(session, props.nowMs))),
    when: whenText(session),
    known: directory.data.value?.tasks.has(session.taskId) === true,
  })),
);

const state = computed(() => {
  if (!props.ready || sessionsQuery.isLoading.value || directory.isLoading.value) return 'loading' as const;
  if (sessionsQuery.isError.value || directory.isError.value) return 'error' as const;
  return 'ready' as const;
});

function retry(): void {
  if (sessionsQuery.isError.value) void sessionsQuery.refetch();
  if (directory.isError.value) void directory.refetch();
}
</script>

<template>
  <OverviewCard
    widget="tracker"
    icon="timer"
    :title="t('overview.tracker.title')"
    to="/tracker"
    :open-label="t('overview.tracker.open')"
    :state="state"
    @retry="retry"
  >
    <template #skeleton>
      <span class="skeleton skeleton--block overview-skeleton-well"></span>
      <span class="skeleton skeleton--text overview-skeleton-caption"></span>
      <span v-for="row in 3" :key="row" class="skeleton skeleton--text overview-skeleton-row"></span>
    </template>

    <div class="tracker-well" :data-status="status">
      <p class="tracker-status">{{ t(`overview.tracker.${status}`) }}</p>
      <p class="tracker-clock" role="timer" :aria-label="t('overview.tracker.timer')" data-timer>
        <span class="visually-hidden">{{ clockText }}</span>
        <span aria-hidden="true" class="tracker-clock-digits">
          <span>{{ clock.hours }}:{{ clock.minutes }}</span><span class="tracker-clock-seconds">:{{ clock.seconds }}</span>
        </span>
      </p>
      <p v-if="running && runningTitle" class="tracker-task">{{ runningTitle }}</p>
      <p v-else-if="!running && nextTitle" class="tracker-task">{{ t('overview.tracker.nextUp', { title: nextTitle }) }}</p>
      <UiButton v-if="running" size="sm" icon="play" data-tracker-resume @click="emit('resume')">
        {{ t('overview.resume') }}
      </UiButton>
      <UiButton
        v-else-if="nextTitle"
        size="sm"
        icon="play"
        :disabled="!canStart"
        data-tracker-start
        @click="emit('start')"
      >
        {{ t('overview.startFocus') }}
      </UiButton>
    </div>

    <section class="tracker-recent" aria-labelledby="overview-tracker-recent">
      <h3 id="overview-tracker-recent" class="overview-subtitle">{{ t('overview.tracker.recentTitle') }}</h3>
      <ul v-if="recent.length > 0" class="tracker-recent-list" data-recent>
        <li v-for="item in recent" :key="item.id" class="tracker-recent-item">
          <div class="tracker-recent-text">
            <p class="tracker-recent-title">{{ item.title }}</p>
            <p class="tracker-recent-meta">
              <span class="tabular">{{ item.focused }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ item.when }}</span>
            </p>
          </div>
          <UiButton
            v-if="item.known"
            variant="ghost"
            size="sm"
            icon="play"
            :disabled="!canStart"
            :busy="startingTaskId === item.taskId"
            :aria-label="t('overview.tracker.restartAria', { title: item.title })"
            data-restart
            @click="emit('restart', item.taskId)"
          >
            {{ t('overview.tracker.restart') }}
          </UiButton>
        </li>
      </ul>
      <UiEmptyState v-else :icon="null" compact :title="t('overview.tracker.recentEmpty')" data-empty>
        {{ t('overview.tracker.recentEmptyBody') }}
      </UiEmptyState>
    </section>
  </OverviewCard>
</template>
