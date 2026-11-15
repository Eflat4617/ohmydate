<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { rememberFocusBlocks } from '../../composables/focusContext';
import { useGoogleIntegration } from '../../composables/useGoogleCalendar';
import { useFocusStart, useRunningSession } from '../../composables/useOverview';
import { nextBlockOf } from '../../domain/overview';
import { plannerLocation } from '../../domain/plannerRoute';
import { localDateOf, todayInZone } from '../../domain/time';
import { t, tp } from '../../i18n';
import { formatDateTime, formatTimeRange } from '../../i18n/format';
import { useLayoutNow } from '../../layout/now';
import { useTodaySnapshot } from '../../layout/useTodaySnapshot';
import { useSessionStore } from '../../stores/session';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 계획 세우기's last stage is a hand-off, not a close (HOLO-03A, FLOW §2 and
 * §5): once a schedule is confirmed this card says what today now holds and
 * offers the next step of the loop as the screen's one filled button —
 *
 *   a block left today      첫 블록 시작 (a focus session on it), 오늘 보기 beside it
 *   a session already runs  세션 이어가기
 *   nothing today           오늘 보기, with when the first block is
 *
 * "폰의 구글 캘린더에도 보냈어요" is said only when the integration reports
 * a connection that can export and blocks are set to be sent — never assumed.
 */
const props = defineProps<{
  /** Blocks of the confirmed schedule. */
  blockCount: number;
  /** The first block of the confirmed schedule, when it is known. */
  first: { readonly title: string | null; readonly startAt: string } | null;
  timeZone: string;
}>();

const router = useRouter();
const sessionStore = useSessionStore();
const now = useLayoutNow();
const snapshot = useTodaySnapshot();
const { running, refetch: refetchRunning } = useRunningSession();
const focus = useFocusStart({ onActiveExists: refetchRunning });
const google = useGoogleIntegration();

const today = computed(() => snapshot.today.value);
const remaining = computed(() =>
  today.value === null
    ? []
    : today.value.blocks.filter((block) => block.status === 'planned' && Date.parse(block.endAt) > now.value),
);
const next = computed(() => (today.value === null ? null : nextBlockOf(today.value.blocks, now.value)));
const exported = computed(() => {
  const integration = google.data.value;
  return (
    integration !== undefined &&
    integration.status === 'connected' &&
    integration.exportAvailable &&
    integration.settings.exportBlocks
  );
});

const firstLine = computed(() => {
  const block = next.value;
  const zone = today.value?.timeZone ?? props.timeZone;
  if (block !== null) {
    return t('planNext.firstTitled', { title: block.title, when: formatTimeRange(block.startAt, block.endAt, zone) });
  }
  if (props.first === null) return null;
  const when = formatDateTime(props.first.startAt, props.timeZone);
  return props.first.title === null ? t('planNext.first', { when }) : t('planNext.firstTitled', { title: props.first.title, when });
});

/** The week the first block is on, in 플래너. */
const plannerTo = computed(() => {
  const todayDate = todayInZone(props.timeZone, now.value);
  const date = props.first === null ? todayDate : localDateOf(props.first.startAt, props.timeZone);
  return plannerLocation('week', date, todayDate, 'planner');
});

const starting = computed(() => focus.startingTaskId.value !== null);

function start(): void {
  const block = next.value;
  const plan = today.value;
  if (block === null || plan === null) return;
  // Presentational only: lets Focus show the block's title and planned length.
  rememberFocusBlocks(sessionStore.ownerId, plan.blocks, plan.timeZone);
  void focus.start({ taskId: block.taskId, blockId: block.id });
}

function resume(): void {
  const session = running.value;
  if (session !== null) void router.push(`/focus/${session.id}`);
}
</script>

<template>
  <UiCard class="plan-next" aria-labelledby="plan-next-title" data-plan-next>
    <div class="plan-next-text">
      <h2 id="plan-next-title" class="plan-next-title">
        <span class="success-mark" aria-hidden="true"><UiIcon name="check" :size="18" /></span>{{ t('planNext.title') }}
      </h2>
      <p class="plan-next-today" data-plan-next-today>
        {{ remaining.length > 0 ? tp('planNext.today', remaining.length) : t('planNext.todayNone') }}
      </p>
      <p v-if="firstLine" class="plan-next-first tabular" data-plan-next-first>{{ firstLine }}</p>
      <p class="plan-next-note">
        {{ tp('planNext.blocks', blockCount) }}
        <span v-if="exported" data-plan-next-google>{{ t('planNext.google') }}</span>
      </p>
    </div>
    <UiBanner v-if="focus.error.value" tone="error" inline role="alert">{{ focus.error.value }}</UiBanner>
    <div class="plan-next-actions">
      <UiButton v-if="running" variant="primary" icon="play" data-plan-next-primary="resume" @click="resume">
        {{ t('planNext.resume') }}
      </UiButton>
      <UiButton
        v-else-if="next"
        variant="primary"
        icon="play"
        :disabled="!focus.canStart.value"
        :busy="starting"
        data-plan-next-primary="start"
        @click="start"
      >
        {{ starting ? t('planNext.starting') : t('planNext.startFirst') }}
      </UiButton>
      <RouterLink v-else class="btn btn--primary" to="/overview" data-plan-next-primary="today">
        <UiIcon name="today" :size="18" class="btn-icon" />{{ t('planNext.openToday') }}
      </RouterLink>
      <RouterLink v-if="running || next" class="plan-next-link" to="/overview" data-plan-next-today-link>
        {{ t('planNext.openToday') }}
      </RouterLink>
      <RouterLink class="plan-next-link" :to="plannerTo" data-plan-next-planner>{{ t('planNext.openPlanner') }}</RouterLink>
    </div>
  </UiCard>
</template>
