<script setup lang="ts">
withDefaults(
  defineProps<{
    as?: string;
    tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'offline' | 'outline';
    dot?: boolean;
    size?: 'md' | 'lg';
    wrap?: boolean;
  }>(),
  { as: 'span', tone: 'neutral', dot: false, size: 'md', wrap: false },
);
</script>

<template>
  <component
    :is="as"
    class="badge"
    :class="[
      tone === 'neutral' ? null : `badge--${tone}`,
      { 'badge--lg': size === 'lg', 'badge--wrap': wrap },
    ]"
  >
    <span v-if="dot" class="badge-dot" aria-hidden="true"></span>
    <slot />
  </component>
</template>
