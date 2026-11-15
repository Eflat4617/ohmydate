<script setup lang="ts">
import { computed, ref } from 'vue';
import UiButton from './ui/UiButton.vue';
import UiCard from './ui/UiCard.vue';
import UiSpinner from './ui/UiSpinner.vue';
import { t } from '../i18n';
import { formatElapsed, type AiWaitKind, type AiWaitPhase } from '../composables/useAiWait';

/**
 * FU-76: calm waiting state for a long AI call in 계획 세우기.
 *
 * - The visible timer is `role="timer"` (implicitly aria-live off), so it can
 *   tick every second without being read out; the screen owns the polite live
 *   region and updates it only at milestones (useAiWait).
 * - 취소 and 직접 작성으로 계속 stay available the whole time; both land on
 *   the manual path with the user's inputs kept.
 */
const props = defineProps<{
  kind: AiWaitKind;
  elapsedMs: number;
  phase: AiWaitPhase;
  cancelling: boolean;
  connectionLost: boolean;
  /** False while offline: the cancel request could not reach the server. */
  canAct: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  manual: [];
  checkAgain: [];
}>();

const heading = ref<HTMLElement | null>(null);

const title = computed(() =>
  props.kind === 'decomposition' ? t('aiWait.decompositionTitle') : t('aiWait.typeDetectionTitle'),
);
const elapsedText = computed(() => t('aiWait.elapsed', { time: formatElapsed(props.elapsedMs) }));
const message = computed(() => {
  if (props.connectionLost) return t('aiWait.reconnecting');
  if (props.phase === 'overdue') return t('aiWait.overdue');
  if (props.phase === 'slow') return t('aiWait.slow');
  return t('aiWait.calm');
});

function focus(): void {
  heading.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <UiCard
    class="ai-wait"
    :class="`ai-wait--${phase}`"
    aria-labelledby="ai-wait-heading"
    aria-busy="true"
    data-testid="ai-wait"
  >
    <div class="ai-wait-text">
      <h2 id="ai-wait-heading" ref="heading" tabindex="-1">{{ title }}</h2>
      <p class="ai-wait-elapsed">
        <span role="timer" :aria-label="elapsedText">{{ elapsedText }}</span>
      </p>
    </div>

    <div class="ai-wait-track" aria-hidden="true">
      <span class="ai-wait-track-fill"></span>
    </div>

    <p class="ai-wait-message">{{ message }}</p>

    <p v-if="cancelling" class="ai-wait-cancelling" role="status">
      <UiSpinner /> {{ t('aiWait.cancelling') }}
    </p>

    <div class="ai-wait-actions" role="group" :aria-label="t('aiWait.actions')">
      <UiButton
        v-if="phase === 'overdue' || connectionLost"
        variant="primary"
        icon="sync"
        :disabled="cancelling"
        @click="emit('checkAgain')"
      >
        {{ t('aiWait.checkAgain') }}
      </UiButton>
      <UiButton :disabled="cancelling || !canAct" :busy="cancelling" @click="emit('cancel')">
        {{ t('aiWait.cancel') }}
      </UiButton>
      <UiButton variant="ghost" :disabled="cancelling || !canAct" @click="emit('manual')">
        {{ t('aiWait.manual') }}
      </UiButton>
    </div>
  </UiCard>
</template>
