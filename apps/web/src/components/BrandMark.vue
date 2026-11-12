<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<template>
  <!-- Six ten-minute cells of a planner page, four of them highlighted. -->
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 7h24v9H4zM4 16h8v9H4z" class="brand-mark-fill" />
    <path d="M4 16h24M12 7v18M20 7v18" class="brand-mark-line" />
    <rect x="4" y="7" width="24" height="18" rx="1.5" class="brand-mark-box" />
  </svg>
</template>
