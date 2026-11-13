<script setup lang="ts">
import { computed } from 'vue';
import { areaPath, linePath, referenceY, trendPoints, type ChartValue } from './geometry';

/**
 * A small area / line trend, oldest value at the left. `summary` is its text
 * alternative (the SVG is an image with that name). An optional reference
 * value draws a dashed line on the same scale (1 = "as estimated"). No values:
 * nothing is drawn; one value: a single point.
 */
const props = withDefaults(
  defineProps<{
    values: readonly ChartValue[];
    /** What the picture says, in words. */
    summary: string;
    reference?: number | null;
  }>(),
  { reference: null },
);

const WIDTH = 240;
const HEIGHT = 64;

const points = computed(() => trendPoints(props.values, WIDTH, HEIGHT, { reference: props.reference }));
const line = computed(() => (points.value.length > 1 ? linePath(points.value) : ''));
const area = computed(() => areaPath(points.value, HEIGHT));
const last = computed(() => points.value[points.value.length - 1] ?? null);
const guide = computed(() =>
  props.reference === null ? null : referenceY(props.values, props.reference, HEIGHT),
);
</script>

<template>
  <div class="trend" data-chart="trend" :data-points="points.length">
    <svg
      class="trend-svg"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="summary"
      focusable="false"
    >
      <line v-if="guide !== null" class="trend-guide" x1="0" :x2="WIDTH" :y1="guide" :y2="guide" />
      <path v-if="area" class="trend-area" :d="area" />
      <path v-if="line" class="trend-line" :d="line" />
    </svg>
    <!-- The newest value: a dot that keeps its shape while the plot stretches. -->
    <span
      v-if="last"
      class="trend-dot"
      aria-hidden="true"
      :style="{ left: `${(last.x / WIDTH) * 100}%`, top: `${(last.y / HEIGHT) * 100}%` }"
    ></span>
  </div>
</template>
