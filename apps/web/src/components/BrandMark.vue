<script setup lang="ts">
import { useId } from 'vue';

withDefaults(defineProps<{ size?: number }>(), { size: 32 });

// Each mark carries its own gradient, so two on one page do not share an id.
const gradientId = `brand-mark-${useId()}`;
</script>

<template>
  <!-- OhMyDate's own mark: a day drawn as an open ring (the O) with the date,
       "now", set as a dot in its opening, on a lime-to-cyan tile. -->
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient :id="gradientId" x1="3" y1="4" x2="29" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0" class="brand-mark-stop-a" />
        <stop offset="1" class="brand-mark-stop-b" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="30" height="30" rx="9" :fill="`url(#${gradientId})`" />
    <path d="M16 8.75a7.25 7.25 0 1 0 7.25 7.25" class="brand-mark-ring" />
    <circle cx="21.4" cy="10.6" r="2.15" class="brand-mark-dot" />
  </svg>
</template>
