<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import AiWidget from '../components/overview/AiWidget.vue';
import DaySummaryWidget from '../components/overview/DaySummaryWidget.vue';
import ProgressWidget from '../components/overview/ProgressWidget.vue';
import SessionLogWidget from '../components/overview/SessionLogWidget.vue';
import TimeTrackerWidget from '../components/overview/TimeTrackerWidget.vue';
import PlanResumeList from '../components/plan/PlanResumeList.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import { focusContextFor, rememberFocusBlocks } from '../composables/focusContext';
import { useFocusStart, useRunningSession, useSecondTick, useTaskDirectory } from '../composables/useOverview';
import { useOwnerTimeZone } from '../composables/usePlannerRange';
import { displayNameOf } from '../domain/displayName';
import { greetingPeriod, nextBlockOf, plannedMinutes } from '../domain/overview';
import { addDaysToDate, localParts, startOfWeek, todayInZone } from '../domain/time';
import { t } from '../i18n';
import { formatCivilDateRange, formatTime } from '../i18n/format';
import { useLayoutNow } from '../layout/now';
import { useTodaySnapshot } from '../layout/useTodaySnapshot';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';

/**
 * 개요 (HOLO-01): the dashboard the user opens first. Its job is PRODUCT.md's:
 * say what today holds and get the user to start. The greeting names the next
 * action, the one primary button does it, and five cards show the week, the
 * running session, today by kind, what the AI layer knows, and the session
 * log — all computed from the user's own data (domain/overview.ts).
 */
const router = useRouter();
const queryClient = useQueryClient();
const auth = useAuthStore();
const offline = useOfflineStore();
const sessionStore = useSessionStore();

const now = useLayoutNow();
const { timeZone, ready } = useOwnerTimeZone();
const today = computed(() => todayInZone(timeZone.value, now.value));
const thisWeekStart = computed(() => startOfWeek(today.value));

// The week the 진행 card shows: 0 is this week, -1 the one before, and so on.
const weekOffset = ref(0);
const shownWeekStart = computed(() => addDaysToDate(thisWeekStart.value, weekOffset.value * 7));
const shownWeekText = computed(() =>
  formatCivilDateRange(shownWeekStart.value, addDaysToDate(shownWeekStart.value, 6)),
);

const snapshot = useTodaySnapshot();
const plan = computed(() => snapshot.today.value);
const planReady = computed(() => !snapshot.isLoading.value && !snapshot.isError.value);

function retryPlan(): void {
  void queryClient.invalidateQueries({ queryKey: ['today'] });
}

const { running, refetch: refetchRunning } = useRunningSession();
const directory = useTaskDirectory();
const focus = useFocusStart({ onActiveExists: refetchRunning });

// One clock for every live figure: each second while a session runs, else the
// shared 30-second layout clock.
const isRunning = computed(() => running.value?.state === 'active');
const second = useSecondTick(isRunning);
const liveNow = computed(() => (isRunning.value ? second.value : now.value));

const nextBlock = computed(() => (plan.value === null ? null : nextBlockOf(plan.value.blocks, now.value)));
const plannedTodayMin = computed(() => (plan.value === null ? null : plannedMinutes(plan.value.blocks)));

const runningTitle = computed(() => {
  const session = running.value;
  if (session === null) return null;
  const block = plan.value?.blocks.find((item) => item.id === session.blockId || item.taskId === session.taskId);
  return (
    block?.title ??
    directory.data.value?.tasks.get(session.taskId)?.title ??
    focusContextFor(sessionStore.ownerId, session.blockId ?? null, session.taskId)?.title ??
    null
  );
});

const name = computed(() => displayNameOf(auth.user?.email));
const period = computed(() => greetingPeriod(localParts(new Date(now.value).toISOString(), timeZone.value).hour));
const greeting = computed(() =>
  name.value.length > 0
    ? t(`overview.greeting.${period.value}`, { name: name.value })
    : t(`overview.greetingNoName.${period.value}`),
);

/** One sentence naming the next action. */
const nextSentence = computed(() => {
  const session = running.value;
  if (session !== null) {
    const title = runningTitle.value;
    if (session.state === 'paused') {
      return title === null ? t('overview.next.pausedUntitled') : t('overview.next.paused', { title });
    }
    return title === null ? t('overview.next.runningUntitled') : t('overview.next.running', { title });
  }
  if (snapshot.isLoading.value) return t('overview.next.loading');
  if (snapshot.isError.value || plan.value === null) return t('overview.next.error');
  const block = nextBlock.value;
  if (block !== null) {
    const zone = plan.value.timeZone;
    return Date.parse(block.startAt) <= now.value
      ? t('overview.next.blockNow', { title: block.title, time: formatTime(block.endAt, zone) })
      : t('overview.next.block', { title: block.title, time: formatTime(block.startAt, zone) });
  }
  return plan.value.blocks.length > 0 ? t('overview.next.allDone') : t('overview.next.empty');
});

/** What the screen's single primary button does. */
const primary = computed(() => {
  if (running.value !== null) return 'resume' as const;
  if (nextBlock.value !== null) return 'start' as const;
  return 'plan' as const;
});

function startNext(): void {
  const block = nextBlock.value;
  const current = plan.value;
  if (block === null || current === null) return;
  // Presentational only: lets Focus show the block's title and planned length.
  rememberFocusBlocks(sessionStore.ownerId, current.blocks, current.timeZone);
  void focus.start({ taskId: block.taskId, blockId: block.id });
}

function restart(taskId: string): void {
  void focus.start({ taskId });
}

function resume(): void {
  const session = running.value;
  if (session !== null) void router.push(`/focus/${session.id}`);
}

// One session at a time: while one runs, the way on is "이어서 보기", so nothing
// offers a start the server would refuse.
const canStart = computed(() => focus.canStart.value && running.value === null);
const startingNext = computed(() => nextBlock.value !== null && focus.startingTaskId.value === nextBlock.value.taskId);
</script>

<template>
  <section class="page page--wide overview-page" data-overview>
    <header class="overview-head">
      <div class="page-heading overview-greeting">
        <h1 data-greeting>{{ greeting }}</h1>
        <p class="overview-next" data-next>{{ nextSentence }}</p>
      </div>
      <div class="overview-head-actions">
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
        <div class="week-switch" role="group" :aria-label="t('overview.week.label')">
          <button
            type="button"
            class="btn btn--icon btn--sm"
            :aria-label="t('overview.week.previous')"
            data-week-previous
            @click="weekOffset -= 1"
          >
            <UiIcon name="chevron-left" :size="16" />
          </button>
          <p class="week-switch-label" aria-live="polite" data-week>
            <UiIcon name="month" :size="16" />
            <span class="tabular">{{ shownWeekText }}</span>
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
        <UiButton v-if="primary === 'resume'" variant="primary" icon="play" data-primary="resume" @click="resume">
          {{ t('overview.resume') }}
        </UiButton>
        <UiButton
          v-else-if="primary === 'start'"
          variant="primary"
          icon="play"
          :disabled="!canStart"
          :busy="startingNext"
          data-primary="start"
          @click="startNext"
        >
          {{ startingNext ? t('overview.starting') : t('overview.startFocus') }}
        </UiButton>
        <RouterLink v-else class="btn btn--primary" to="/plan" data-primary="plan">
          <UiIcon name="plan" :size="18" class="btn-icon" />
          {{ t('overview.makePlan') }}
        </RouterLink>
      </div>
    </header>

    <UiBanner v-if="focus.error.value" tone="error" role="alert" class="overview-start-error">
      {{ focus.error.value }}
      <template v-if="focus.activeExists.value && running" #actions>
        <UiButton size="sm" @click="resume">{{ t('overview.resume') }}</UiButton>
      </template>
    </UiBanner>
    <p v-if="!offline.mutationsEnabled" class="visually-hidden" role="status">{{ t('overview.startOffline') }}</p>

    <!-- HOLO-03A (FLOW §5 되돌아오기): a plan that was started and not finished, with the way back in. -->
    <PlanResumeList :limit="1" compact />

    <div class="overview-grid">
      <ProgressWidget
        :week-start="shownWeekStart"
        :today="today"
        :time-zone="timeZone"
        :ready="ready"
        :now-ms="liveNow"
        :planned-today-min="plannedTodayMin"
      />
      <TimeTrackerWidget
        :running="running"
        :running-title="runningTitle"
        :next-title="planReady ? (nextBlock?.title ?? null) : null"
        :today="today"
        :time-zone="timeZone"
        :ready="ready"
        :now-ms="liveNow"
        :can-start="canStart"
        :starting-task-id="focus.startingTaskId.value"
        @start="startNext"
        @resume="resume"
        @restart="restart"
      />
      <DaySummaryWidget
        :plan="plan"
        :plan-loading="snapshot.isLoading.value"
        :plan-error="snapshot.isError.value"
        :today="today"
        :time-zone="timeZone"
        :ready="ready"
        :now-ms="liveNow"
        @retry-plan="retryPlan"
      />
      <AiWidget :plan="plan" />
      <SessionLogWidget
        :today="today"
        :time-zone="timeZone"
        :ready="ready"
        :now-ms="liveNow"
        :can-start="canStart"
        :starting-task-id="focus.startingTaskId.value"
        @restart="restart"
      />
    </div>
  </section>
</template>
