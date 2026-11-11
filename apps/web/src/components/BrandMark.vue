<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<template>
  <!-- A calm sunrise over the day's horizon: "one next action, easy to find". -->
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    aria-hidden="true"
    focusable="false"
  >
    <rect width="32" height="32" rx="9" class="brand-mark-bg" />
    <path d="M9.5 20.5a6.5 6.5 0 0 1 13 0" class="brand-mark-sun" />
    <path d="M7 20.5h18" class="brand-mark-line" />
    <path d="M10.5 24.5h11" class="brand-mark-line brand-mark-line--soft" />
    <path d="M16 8.5v3M9.6 11.1l1.8 1.8M22.4 11.1l-1.8 1.8" class="brand-mark-line" />
  </svg>
</template>
