<script setup lang="ts">
/**
 * Placeholder blocks with a fixed footprint so content does not jump when
 * data arrives (07 §3.1). Purely decorative: pair it with a status message.
 */
withDefaults(
  defineProps<{
    variant?: 'card' | 'lines';
    count?: number;
    lines?: number;
  }>(),
  { variant: 'card', count: 2, lines: 2 },
);
</script>

<template>
  <div class="skeleton-stack" aria-hidden="true">
    <template v-if="variant === 'card'">
      <div v-for="index in count" :key="index" class="skeleton-card">
        <span class="skeleton skeleton--title"></span>
        <span
          v-for="line in lines"
          :key="line"
          class="skeleton skeleton--text"
          :style="{ width: `${88 - line * 18}%` }"
        ></span>
      </div>
    </template>
    <template v-else>
      <span
        v-for="index in count"
        :key="index"
        class="skeleton skeleton--text"
        :style="{ width: `${92 - (index % 3) * 16}%` }"
      ></span>
    </template>
  </div>
</template>
