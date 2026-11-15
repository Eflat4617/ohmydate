<script setup lang="ts">
import { computed } from 'vue';
import { barGeometry, slotCenter, type ChartValue } from './geometry';

/**
 * A strip of small bars, one per day, on a scale the caller gives (HOLO-03A):
 * the shape of a schedule at a glance — heavy early, even, or a few long
 * days. Strips drawn with the same `max` can be compared with each other.
 *
 * It is one image: `summary` is its text alternative. A day with nothing is
 * an empty track; `marks` can underline single bars (the day a deadline is).
 */
const props = withDefaults(
  defineProps<{
    values: readonly ChartValue[];
    /** The value that fills the height; the tallest value when left out. */
    max?: number | null;
    /** What the picture says, in words. */
    summary: string;
    /** Indexes of bars that carry a mark under them. */
    marks?: readonly number[];
  }>(),
  { max: null, marks: () => [] },
);

const PLOT = 40;
const FOOT = 6;

const count = computed(() => props.values.length);
/** Bars stay apart however many days there are. */
const width = computed(() => (count.value > 16 ? 4 : 6));
const bars = computed(() => {
  const top = props.max !== null && Number.isFinite(props.max) && props.max > 0 ? props.max : null;
  // A shared scale: an extra value sets the top and is dropped again.
  const scaled = top === null ? [...props.values] : [...props.values, top];
  return barGeometry(scaled, PLOT, 4).slice(0, props.values.length);
});
</script>

<template>
  <svg class="load-strip" width="100%" :height="PLOT + FOOT" role="img" :aria-label="summary" focusable="false" data-chart="strip">
    <svg v-for="(bar, index) in bars" :key="index" :x="`${slotCenter(index, count)}%`" y="0" overflow="visible" :data-bar="index">
      <rect class="load-strip-track" :x="-width / 2" y="0" :width="width" :height="PLOT" :rx="width / 2" />
      <rect
        v-if="bar.height > 0"
        class="load-strip-bar"
        :x="-width / 2"
        :y="bar.y"
        :width="width"
        :height="bar.height"
        :rx="width / 2"
      />
      <rect
        v-if="marks.includes(index)"
        class="load-strip-mark"
        :x="-width / 2"
        :y="PLOT + 3"
        :width="width"
        height="2"
        rx="1"
        :data-mark="index"
      />
    </svg>
  </svg>
</template>
