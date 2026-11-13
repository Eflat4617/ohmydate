<script setup lang="ts">
import { computed } from 'vue';
import { ringArcs, ringStrokes } from './geometry';

/**
 * A ring of up to four parts of a whole, clockwise from the top in the order
 * given, with its legend. The legend is the text alternative (label, value
 * and share of each part, in the ring's order), so the SVG is hidden from
 * assistive technology. With no part above zero only the empty track is drawn.
 */
export interface RingSegment {
  readonly label: string;
  readonly value: number;
  /** The value in words ("1시간 30분"). */
  readonly display: string;
  /** Which data series colour it takes. */
  readonly series: 1 | 2 | 3 | 4;
}

const props = withDefaults(
  defineProps<{
    /** Name of the legend list. */
    title: string;
    segments: readonly RingSegment[];
    /** Set in the middle of the ring. */
    total?: string | null;
    totalLabel?: string | null;
    /** How a share reads ("42%"). */
    formatShare: (share: number) => string;
  }>(),
  { total: null, totalLabel: null },
);

const SIZE = 132;
const STROKE = 13;
const RADIUS = (SIZE - STROKE) / 2;

const shown = computed(() => props.segments.slice(0, 4));
const sum = computed(() => shown.value.reduce((total, segment) => total + Math.max(0, segment.value || 0), 0));
const strokes = computed(() =>
  ringStrokes(
    ringArcs(shown.value.map((segment) => segment.value)),
    RADIUS,
    STROKE,
  ),
);

function share(segment: RingSegment): string {
  return props.formatShare(sum.value > 0 ? Math.max(0, segment.value || 0) / sum.value : 0);
}
</script>

<template>
  <figure class="ring" data-chart="ring">
    <div class="ring-plot">
      <svg class="ring-svg" :viewBox="`0 0 ${SIZE} ${SIZE}`" aria-hidden="true" focusable="false">
        <circle class="ring-track" :cx="SIZE / 2" :cy="SIZE / 2" :r="RADIUS" :stroke-width="STROKE" />
        <template v-for="stroke in strokes" :key="stroke.index">
          <!-- A hairline around the arc in the series' edge colour: on a white
               card the fill alone would not reach 3:1. -->
          <circle
            class="ring-edge"
            :class="`ring-edge--${shown[stroke.index]?.series ?? 1}`"
            :cx="SIZE / 2"
            :cy="SIZE / 2"
            :r="RADIUS"
            :stroke-width="STROKE + 2"
            :stroke-dasharray="`${stroke.dash} ${stroke.rest}`"
            :transform="`rotate(${stroke.rotate} ${SIZE / 2} ${SIZE / 2})`"
          />
          <circle
            class="ring-arc"
            :class="`ring-arc--${shown[stroke.index]?.series ?? 1}`"
            :cx="SIZE / 2"
            :cy="SIZE / 2"
            :r="RADIUS"
            :stroke-width="STROKE"
            :stroke-dasharray="`${stroke.dash} ${stroke.rest}`"
            :transform="`rotate(${stroke.rotate} ${SIZE / 2} ${SIZE / 2})`"
            :data-arc="stroke.index"
          />
        </template>
      </svg>
      <p v-if="total" class="ring-total">
        <span class="ring-total-value">{{ total }}</span>
        <span v-if="totalLabel" class="ring-total-label">{{ totalLabel }}</span>
      </p>
    </div>
    <ul class="legend" :aria-label="title" data-chart-legend>
      <li v-for="(segment, index) in shown" :key="index" class="legend-row">
        <span class="legend-dot" :class="`legend-dot--${segment.series}`" aria-hidden="true"></span>
        <span class="legend-label">{{ segment.label }}</span>
        <span class="legend-leader" aria-hidden="true"></span>
        <span class="legend-value">
          {{ segment.display }}<span class="visually-hidden"> · {{ share(segment) }}</span>
        </span>
      </li>
    </ul>
  </figure>
</template>
