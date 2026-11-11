<script setup lang="ts">
withDefaults(
  defineProps<{
    as?: string;
    variant?: 'default' | 'flat' | 'sunken';
    compact?: boolean;
    interactive?: boolean;
  }>(),
  { as: 'section', variant: 'default', compact: false, interactive: false },
);
</script>

<template>
  <component
    :is="as"
    class="card"
    :class="{
      'card--flat': variant === 'flat',
      'card--sunken': variant === 'sunken',
      'card--compact': compact,
      'card--interactive': interactive,
    }"
  >
    <slot />
  </component>
</template>
