<script setup lang="ts">
import { computed } from 'vue';
import { ICONS, type IconName, type IconShape } from './icons';

const props = withDefaults(defineProps<{ name: IconName; size?: number | string }>(), { size: 20 });

const shape = computed<IconShape>(() => ICONS[props.name]);
const dimension = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
</script>

<template>
  <svg
    class="icon"
    viewBox="0 0 24 24"
    :width="dimension"
    :height="dimension"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in shape.paths" :key="`p${index}`" :d="d" />
    <circle
      v-for="(circle, index) in shape.circles ?? []"
      :key="`c${index}`"
      :cx="circle[0]"
      :cy="circle[1]"
      :r="circle[2]"
    />
    <circle
      v-for="(dot, index) in shape.dots ?? []"
      :key="`d${index}`"
      :cx="dot[0]"
      :cy="dot[1]"
      r="1.1"
      fill="currentColor"
      stroke="none"
    />
  </svg>
</template>
