<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { focusContextFor, focusTaskTitle, rememberFocusBlocks } from '../composables/focusContext';
import { useFocusStart, useRunningSession, useSecondTick } from '../composables/useOverview';
import { nextBlockOf } from '../domain/overview';
import { t } from '../i18n';
import { formatDuration, formatTime, formatTimer, minutesBetween } from '../i18n/format';
import { useLayoutNow } from '../layout/now';
import { useTodaySnapshot } from '../layout/useTodaySnapshot';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import UiIcon from './ui/UiIcon.vue';

/**
 * 지금 알약 (HOLO-04, FLOW.md §4): where "what am I doing now" lives on every
 * screen. While a focus session runs it shows the task and the time left of
 * its block (the time spent, when the session has no block); otherwise the
 * next block of today with a start button. One press goes from wherever the
 * owner is to ③ 오늘 → ④ 집중. With nothing running and nothing next it is
 * not there.
 *
 * It reads what 개요 reads (the same cached lookups) and starts a session the
 * same way (one idempotent, owner-bound `POST /sessions`). It is never a
 * filled button: the page keeps its one lime thing.
 */
const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const now = useLayoutNow();
const snapshot = useTodaySnapshot();
const { running, refetch } = useRunningSession();
const focus = useFocusStart({ onActiveExists: refetch });

const active = computed(() => running.value?.state === 'active');
const second = useSecondTick(active);
const plan = computed(() => snapshot.today.value);
const nextBlock = computed(() => (plan.value === null || running.value !== null ? null : nextBlockOf(plan.value.blocks, now.value)));

const context = computed(() => {
  const session = running.value;
  return session === null ? null : focusContextFor(sessionStore.ownerId, session.blockId ?? null, session.taskId);
});
const runningTitle = computed(() => {
  const session = running.value;
  if (session === null) return null;
  return (
    context.value?.title ??
    plan.value?.blocks.find((block) => block.id === session.blockId || block.taskId === session.taskId)?.title ??
    focusTaskTitle(sessionStore.ownerId, session.taskId) ??
    null
  );
});

const focusedSeconds = computed(() => {
  const session = running.value;
  if (session === null) return 0;
  if (session.state !== 'active') return session.focusedSec;
  const cursor = Date.parse(session.startedAt) + (session.focusedSec + session.pausedSec) * 1000;
  return session.focusedSec + Math.max(0, Math.floor((second.value - cursor) / 1000));
});

/** The time left of the block's planned length, in whole minutes; null without a block or once it is used up. */
const minutesLeft = computed(() => {
  const planned = context.value === null ? null : minutesBetween(context.value.startAt, context.value.endAt);
  if (planned === null || planned <= 0) return null;
  const left = planned - Math.floor(focusedSeconds.value / 60);
  return left > 0 ? left : null;
});

const runningTime = computed(() =>
  minutesLeft.value === null ? formatTimer(focusedSeconds.value) : t('now.left', { duration: formatDuration(minutesLeft.value) }),
);
const runningLabel = computed(() => {
  const title = runningTitle.value ?? t('now.untitled');
  const state = running.value?.state === 'paused' ? t('now.paused') : t('now.running');
  return t('now.runningAria', { state, title, time: runningTime.value });
});

const nextTime = computed(() => {
  const block = nextBlock.value;
  const zone = plan.value?.timeZone;
  if (block === null || zone === undefined) return '';
  return Date.parse(block.startAt) <= now.value ? t('now.nowBlock') : formatTime(block.startAt, zone);
});

// On the timer itself the timer says all of this.
const shown = computed(() => route.name !== 'focus' && route.name !== 'login' && (running.value !== null || nextBlock.value !== null));
const starting = computed(() => focus.startingTaskId.value !== null);
const canStart = computed(() => offline.mutationsEnabled && focus.canStart.value);

function open(): void {
  const session = running.value;
  if (session !== null) void router.push(`/focus/${session.id}`);
}

function start(): void {
  const block = nextBlock.value;
  const current = plan.value;
  if (block === null || current === null) return;
  // Presentational only: lets Focus show the block's title and planned length.
  rememberFocusBlocks(sessionStore.ownerId, current.blocks, current.timeZone);
  void focus.start({ taskId: block.taskId, blockId: block.id });
}
</script>

<template>
  <div v-if="shown" class="now-pill" :data-now="running ? running.state : 'next'" data-now-pill>
    <button v-if="running" type="button" class="now-pill-main" :aria-label="runningLabel" data-now-open @click="open">
      <span class="now-pill-dot" :class="{ 'now-pill-dot--paused': running.state === 'paused' }" aria-hidden="true"></span>
      <span class="now-pill-title" aria-hidden="true">{{ runningTitle ?? t('now.untitled') }}</span>
      <span class="now-pill-time tabular" aria-hidden="true" data-now-time>{{ runningTime }}</span>
    </button>
    <template v-else-if="nextBlock">
      <RouterLink
        to="/overview"
        class="now-pill-main"
        :aria-label="t('now.nextAria', { time: nextTime, title: nextBlock.title })"
        data-now-next
      >
        <span class="now-pill-time tabular" aria-hidden="true" data-now-time>{{ nextTime }}</span>
        <span class="now-pill-title" aria-hidden="true">{{ nextBlock.title }}</span>
      </RouterLink>
      <button
        type="button"
        class="now-pill-start"
        :aria-label="t('now.start', { title: nextBlock.title })"
        :title="t('now.startShort')"
        :disabled="!canStart"
        :aria-busy="starting ? 'true' : undefined"
        data-now-start
        @click="start"
      >
        <UiIcon name="play" :size="16" />
      </button>
    </template>
    <p v-if="focus.error.value" class="visually-hidden" role="alert">{{ focus.error.value }}</p>
  </div>
</template>
