<script setup lang="ts">
import { computed } from 'vue';
import type { EstimationFeedback } from '../../api';
import { rememberFocusBlocks } from '../../composables/focusContext';
import { useFocusStart, useRunningSession } from '../../composables/useOverview';
import { nextBlockOf } from '../../domain/overview';
import { t } from '../../i18n';
import I18nT from '../../i18n/I18nT';
import { formatDuration, formatTimeRange } from '../../i18n/format';
import { useLayoutNow } from '../../layout/now';
import { useTodaySnapshot } from '../../layout/useTodaySnapshot';
import { useSessionStore } from '../../stores/session';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 집중의 끝은 다음 걸음이다 (HOLO-04, FLOW.md §2 ④ and §5). Once the review
 * of a finished session is in, this card takes the screen's one filled button:
 *
 *   a block left today   다음 블록 시작 (a focus session on it)
 *   none left            오늘 돌아보기 (개요's recap of the day)
 *
 * and, as quiet links, 쉬었다 하기 (back to 개요) and 오늘은 여기까지 (the
 * recap, whatever is left). The estimate feedback the review earned is said
 * in the same card, in words.
 */
const props = defineProps<{
  /** The block of the session that just ended: it is not "next" even if it is not marked done yet. */
  finishedBlockId: string | null;
  feedback: EstimationFeedback;
}>();

const sessionStore = useSessionStore();
const now = useLayoutNow();
const snapshot = useTodaySnapshot();
const { refetch: refetchRunning } = useRunningSession();
const focus = useFocusStart({ onActiveExists: refetchRunning });

const today = computed(() => snapshot.today.value);
const next = computed(() => {
  const plan = today.value;
  if (plan === null) return null;
  return nextBlockOf(
    plan.blocks.filter((block) => block.id !== props.finishedBlockId),
    now.value,
  );
});
const nextLine = computed(() => {
  const block = next.value;
  const zone = today.value?.timeZone;
  if (block === null || zone === undefined) return null;
  return t('focusNext.nextLine', { title: block.title, when: formatTimeRange(block.startAt, block.endAt, zone) });
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
</script>

<template>
  <UiCard class="plan-next focus-next" aria-labelledby="focus-next-title" data-focus-next>
    <div class="plan-next-text">
      <h2 id="focus-next-title" class="plan-next-title">
        <span class="success-mark" aria-hidden="true"><UiIcon name="check" :size="18" /></span>{{ t('focusNext.title') }}
      </h2>
      <p class="plan-next-first tabular" data-focus-next-feedback>
        <I18nT keypath="review.feedback">
          <template #estimated>{{ formatDuration(feedback.estimatedP50) }}</template>
          <template #actual>{{ formatDuration(feedback.actualFocusMin) }}</template>
          <template #quality>{{ t(`review.quality.${feedback.quality}`) }}</template>
        </I18nT>
      </p>
      <p class="plan-next-note" data-focus-next-line>{{ nextLine ?? t('focusNext.lastBlock') }}</p>
    </div>
    <UiBanner v-if="focus.error.value" tone="error" inline role="alert">{{ focus.error.value }}</UiBanner>
    <div class="plan-next-actions">
      <UiButton
        v-if="next"
        variant="primary"
        icon="play"
        :disabled="!focus.canStart.value"
        :busy="starting"
        data-focus-next-primary="start"
        @click="start"
      >
        {{ starting ? t('planNext.starting') : t('focusNext.startNext') }}
      </UiButton>
      <RouterLink v-else class="btn btn--primary" to="/overview?recap=1" data-focus-next-primary="recap">
        <UiIcon name="today" :size="18" class="btn-icon" />{{ t('focusNext.recap') }}
      </RouterLink>
      <RouterLink class="plan-next-link" to="/overview" data-focus-next-rest>{{ t('focusNext.rest') }}</RouterLink>
      <RouterLink v-if="next" class="plan-next-link" to="/overview?recap=1" data-focus-next-done>{{ t('focusNext.doneForToday') }}</RouterLink>
    </div>
  </UiCard>
</template>
