<script setup lang="ts">
/**
 * CAL-01: the mark of a deadline (마감) — a pennant on a pole. The cloth is
 * the caution highlighter, the pole and the edge are ink, so the shape says
 * "deadline" without its colour. Always decorative; the words that go with
 * it (a list, a legend, an accessible name) carry the meaning.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 12 });
</script>

<template>
  <svg
    class="deadline-flag"
    viewBox="0 0 12 12"
    :width="size"
    :height="size"
    aria-hidden="true"
    focusable="false"
  >
    <path class="deadline-flag-cloth" d="M2.75 1.25h8l-2.1 2.6 2.1 2.6h-8z" />
    <path class="deadline-flag-pole" d="M2.75 0.75v10.75" />
  </svg>
</template>
