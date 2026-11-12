<script setup lang="ts">
import { t } from '../i18n';
import UiBadge from './ui/UiBadge.vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';

/**
 * Lock toggle of one approved block (FU-71, 06 §7). A native button, so Enter
 * and Space work; `aria-pressed` is the locked state and the name says what a
 * press does ("블록 고정" / "고정 해제"). `readOnly` renders only a locked
 * badge (nothing for an unlocked block) — the replan proposal and started
 * blocks cannot change it.
 * Presentational: the screen owns the request (composables/useBlockLock.ts).
 */
const props = withDefaults(
  defineProps<{
    locked: boolean;
    pending?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
  }>(),
  { pending: false, disabled: false, readOnly: false },
);
const emit = defineEmits<{ toggle: [] }>();

function press(): void {
  if (props.readOnly || props.disabled || props.pending) return;
  emit('toggle');
}
</script>

<template>
  <UiBadge v-if="readOnly && locked" tone="outline" class="block-lock-badge" data-block-lock="locked">
    <UiIcon name="lock" :size="14" />{{ t('blockLock.locked') }}
  </UiBadge>
  <UiButton
    v-else-if="!readOnly"
    size="sm"
    :variant="locked ? 'secondary' : 'ghost'"
    :icon="locked ? 'lock' : 'lock-open'"
    class="block-lock-toggle"
    :class="{ 'block-lock-toggle--on': locked }"
    :aria-pressed="locked ? 'true' : 'false'"
    :busy="pending"
    :disabled="disabled || pending"
    :data-block-lock="locked ? 'locked' : 'unlocked'"
    @click="press"
  >
    {{ locked ? t('blockLock.unlock') : t('blockLock.lock') }}
  </UiButton>
</template>

