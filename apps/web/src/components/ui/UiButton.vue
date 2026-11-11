<script setup lang="ts">
import UiIcon from './UiIcon.vue';
import UiSpinner from './UiSpinner.vue';
import type { IconName } from './icons';

/**
 * Native <button> with the shared variants. `busy` only changes the visuals
 * (spinner + aria-busy); callers still decide `disabled`, so behaviour and
 * accessible names stay exactly what the view renders in the slot.
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
    size?: 'sm' | 'md' | 'lg';
    type?: 'button' | 'submit' | 'reset';
    busy?: boolean;
    block?: boolean;
    icon?: IconName;
    iconOnly?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', type: 'button', busy: false, block: false, iconOnly: false },
);
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[
      `btn--${variant}`,
      size === 'md' ? null : `btn--${size}`,
      { 'btn--block': block, 'btn--icon': iconOnly },
    ]"
    :aria-busy="busy ? 'true' : undefined"
  >
    <UiSpinner v-if="busy" class="btn-icon" />
    <UiIcon v-else-if="icon" :name="icon" :size="size === 'sm' ? 16 : 18" class="btn-icon" />
    <slot />
  </button>
</template>
