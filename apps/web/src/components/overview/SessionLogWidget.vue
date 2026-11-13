<script setup lang="ts">
import { computed } from 'vue';
import type { WorkSession } from '../../api';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIcon from '../ui/UiIcon.vue';
import { useTaskDirectory, useWeekSessions } from '../../composables/useOverview';
import { minutesOfSeconds, newestFirst, projectHue, sessionFocusedSec, weekRange } from '../../domain/overview';
import { startOfWeek } from '../../domain/time';
import { t, tp } from '../../i18n';
import { formatDate, formatDuration, formatTime, formatTimeRange } from '../../i18n/format';
import OverviewCard from './OverviewCard.vue';

/**
 * 작업 기록: the most recent focus sessions of this week — task, project,
 * when, how long and how it ended — each with "다시 시작" and a link to its
 * task.
 */
const ROWS = 6;

const props = defineProps<{
  today: string;
  timeZone: string;
  ready: boolean;
  nowMs: number;
  canStart: boolean;
  startingTaskId: string | null;
}>();

const emit = defineEmits<{ restart: [taskId: string] }>();

const range = computed(() => (props.ready ? weekRange(startOfWeek(props.today), props.timeZone) : null));
const sessions = useWeekSessions(range);
const directory = useTaskDirectory();

const STATE_TONES = { active: 'accent', paused: 'warn', completed: 'success', abandoned: 'neutral' } as const;

function timeText(session: WorkSession): string {
  const day = formatDate(session.startedAt, props.timeZone);
  const span =
    session.endedAt === undefined
      ? t('overview.log.untilNow', { start: formatTime(session.startedAt, props.timeZone) })
      : formatTimeRange(session.startedAt, session.endedAt, props.timeZone);
  return `${day} ${span}`;
}

const all = computed(() => newestFirst(sessions.data.value?.sessions ?? []));
const rows = computed(() =>
  all.value.slice(0, ROWS).map((session) => {
    const task = directory.data.value?.tasks.get(session.taskId);
    const project = task === undefined ? undefined : directory.data.value?.projects.get(task.projectId);
    return {
      id: session.id,
      taskId: session.taskId,
      known: task !== undefined,
      title: task?.title ?? t('overview.tracker.untitled'),
      project:
        project === undefined
          ? null
          : { title: project.kind === 'inbox' ? t('nav.inbox') : project.title, hue: projectHue(project.id) },
      time: timeText(session),
      focused: formatDuration(minutesOfSeconds(sessionFocusedSec(session, props.nowMs))),
      state: session.state,
    };
  }),
);

const state = computed(() => {
  if (!props.ready || sessions.isLoading.value || directory.isLoading.value) return 'loading' as const;
  if (sessions.isError.value || directory.isError.value) return 'error' as const;
  return 'ready' as const;
});

function retry(): void {
  if (sessions.isError.value) void sessions.refetch();
  if (directory.isError.value) void directory.refetch();
}
</script>

<template>
  <OverviewCard widget="log" icon="list" :title="t('overview.log.title')" :state="state" @retry="retry">
    <template #skeleton>
      <span v-for="row in 5" :key="row" class="skeleton skeleton--text overview-skeleton-row"></span>
    </template>

    <div v-if="rows.length > 0" class="log-scroll">
      <table class="data-table log-table" data-log>
        <caption class="visually-hidden">{{ t('overview.log.caption') }}</caption>
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
        <tbody>
          <tr v-for="row in rows" :key="row.id" :data-session="row.state">
            <th scope="row" class="log-task">{{ row.title }}</th>
            <td>
              <UiBadge v-if="row.project" :class="`badge--${row.project.hue}`">{{ row.project.title }}</UiBadge>
            </td>
            <td class="log-time">{{ row.time }}</td>
            <td class="num">{{ row.focused }}</td>
            <td>
              <UiBadge :tone="STATE_TONES[row.state]">{{ t(`overview.log.state.${row.state}`) }}</UiBadge>
            </td>
            <td class="log-actions">
              <template v-if="row.known">
                <UiButton
                  variant="ghost"
                  size="sm"
                  icon="play"
                  :disabled="!canStart"
                  :busy="startingTaskId === row.taskId"
                  :aria-label="t('overview.tracker.restartAria', { title: row.title })"
                  data-restart
                  @click="emit('restart', row.taskId)"
                >
                  {{ t('overview.tracker.restart') }}
                </UiButton>
                <RouterLink
                  :to="`/tasks/${row.taskId}`"
                  class="icon-link"
                  :aria-label="t('overview.log.openTask', { title: row.title })"
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
    <UiEmptyState v-else icon="list" compact :title="t('overview.log.empty')" data-empty>
      {{ t('overview.log.emptyBody') }}
    </UiEmptyState>
    <p v-if="all.length > rows.length" class="overview-note">{{ tp('overview.log.more', all.length) }}</p>
  </OverviewCard>
</template>
