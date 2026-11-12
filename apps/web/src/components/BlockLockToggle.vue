<script setup lang="ts">
import { t } from '../i18n';
import UiBadge from './ui/UiBadge.vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';

/**
 * Lock toggle of one approved block (FU-71, 06 §7). A native button, so Enter
 * and Space work. FU-86: the name is always "블록 고정" — visible text and
 * accessible name alike (WCAG 2.5.3) — and `aria-pressed` alone carries the
 * state (with the lock / open-lock icon and the pressed style for sight).
 * `describedBy` points at the row's task title and time so a screen reader
 * tabbing through a list of toggles can tell the blocks apart.
 * `readOnly` renders only a locked badge (nothing for an unlocked block) — the
 * replan proposal and started blocks cannot change it.
 * Presentational: the screen owns the request (composables/useBlockLock.ts).
 */
const props = withDefaults(
  defineProps<{
    locked: boolean;
    pending?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    /** Space-separated ids of the elements naming the block (title, time). */
    describedBy?: string | undefined;
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
    :aria-describedby="describedBy"
    :busy="pending"
    :disabled="disabled || pending"
    :data-block-lock="locked ? 'locked' : 'unlocked'"
    @click="press"
  >
    {{ t('blockLock.toggle') }}
  </UiButton>
</template>
