<script setup lang="ts">
import { computed, ref } from 'vue';
import UiButton from './ui/UiButton.vue';
import UiCard from './ui/UiCard.vue';
import UiSpinner from './ui/UiSpinner.vue';
import { t } from '../i18n';
import { formatElapsed, type AiWaitKind, type AiWaitPhase } from '../composables/useAiWait';

/**
 * FU-76: calm waiting state for a long AI call in the planning wizard.
 *
 * - The visible timer is `role="timer"` (implicitly aria-live off), so it can
 *   tick every second without being read out; the wizard owns the polite live
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
    class="wizard-card ai-wait"
    :class="`ai-wait--${phase}`"
    aria-labelledby="ai-wait-heading"
    aria-busy="true"
    data-testid="ai-wait"
  >
    <div class="ai-wait-head">
      <span class="ai-wait-mark" aria-hidden="true">
        <span class="ai-wait-dot"></span>
      </span>
      <div class="ai-wait-text">
        <h2 id="ai-wait-heading" ref="heading" tabindex="-1">{{ title }}</h2>
        <p class="ai-wait-elapsed">
          <span role="timer" :aria-label="elapsedText">{{ elapsedText }}</span>
        </p>
      </div>
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

<style scoped>
.ai-wait {
  gap: var(--space-4);
}

.ai-wait-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.ai-wait-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.ai-wait-text h2 {
  font-size: var(--text-lg);
  line-height: 1.4;
}

.ai-wait-text h2:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 4px;
  border-radius: var(--radius-xs);
}

.ai-wait-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft);
}

.ai-wait-dot {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  animation: ai-wait-breathe 2.4s var(--ease-standard) infinite;
}

.ai-wait-elapsed {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.ai-wait-track {
  position: relative;
  height: 0.375rem;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--color-surface-sunken);
}

.ai-wait-track-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 35%;
  border-radius: inherit;
  background: color-mix(in srgb, var(--color-accent) 55%, transparent);
  animation: ai-wait-slide 2.8s var(--ease-standard) infinite;
}

.ai-wait--slow .ai-wait-track-fill,
.ai-wait--overdue .ai-wait-track-fill {
  background: color-mix(in srgb, var(--color-warn) 45%, transparent);
}

.ai-wait-message {
  margin: 0;
  color: var(--color-text-muted);
}

.ai-wait-cancelling {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.ai-wait-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

@keyframes ai-wait-breathe {
  0%,
  100% {
    transform: scale(0.85);
    opacity: 0.7;
  }

  50% {
    transform: scale(1.1);
    opacity: 1;
  }
}

@keyframes ai-wait-slide {
  0% {
    transform: translateX(-100%);
  }

  100% {
    transform: translateX(290%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-wait-dot,
  .ai-wait-track-fill {
    animation: none;
  }

  .ai-wait-track-fill {
    width: 100%;
    opacity: 0.35;
  }
}
</style>
