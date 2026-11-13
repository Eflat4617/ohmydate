<script setup lang="ts">
import { computed } from 'vue';
import { barGeometry, slotCenter, type ChartValue } from './geometry';

/**
 * A set of vertical bars on one scale (a week of days): one bar may be
 * highlighted (today) and carry a value callout and a comparison chip. Pure
 * SVG marks; the numbers are also given as a visually hidden table, so the
 * picture itself is hidden from assistive technology.
 */
const props = withDefaults(
  defineProps<{
    /** Caption of the text alternative. */
    title: string;
    /** One slot per bar: the short label under it and its full name for the table. */
    slots: readonly { readonly label: string; readonly name: string }[];
    /** One value per slot; null / undefined / NaN is "no data". */
    values: readonly ChartValue[];
    /** How a value reads in words. */
    format: (value: number) => string;
    /** Index of the highlighted bar. */
    highlight?: number | null;
    /** Shown over the highlighted bar. */
    callout?: { readonly value: string; readonly note?: string } | null;
    /** A short comparison shown with the callout ("계획보다 +20분"). */
    chip?: string | null;
    slotHeader: string;
    valueHeader: string;
    /** What the table says for a slot without data. */
    missingText: string;
  }>(),
  { highlight: null, callout: null, chip: null },
);

const PLOT = 128;
const BAR = 10;
const FOOT = 22;

const bars = computed(() => barGeometry(props.values, PLOT));
const count = computed(() => props.slots.length);
const highlighted = computed(() =>
  props.highlight !== null && props.highlight >= 0 && props.highlight < count.value ? props.highlight : null,
);

function valueText(index: number): string {
  const value = props.values[index];
  return typeof value === 'number' && Number.isFinite(value) ? props.format(value) : props.missingText;
}
</script>

<template>
  <figure class="bar-set" data-chart="bars">
    <div class="bar-set-plot" aria-hidden="true">
      <div
        v-if="highlighted !== null && (callout || chip)"
        class="bar-set-callout"
        :style="{ '--x': `${slotCenter(highlighted, count)}%` }"
        data-callout
      >
        <span v-if="callout" class="bar-set-callout-box">
          <span class="bar-set-callout-value">{{ callout.value }}</span>
          <span v-if="callout.note" class="bar-set-callout-note">{{ callout.note }}</span>
        </span>
        <span v-if="chip" class="badge badge--accent bar-set-chip" data-chip>{{ chip }}</span>
      </div>
      <svg class="bar-set-svg" width="100%" :height="PLOT + FOOT" focusable="false">
        <svg
          v-for="(bar, index) in bars"
          :key="index"
          class="bar-set-col"
          :class="{ 'bar-set-col--highlight': index === highlighted, 'bar-set-col--missing': bar.missing }"
          :x="`${slotCenter(index, count)}%`"
          y="0"
          overflow="visible"
          :data-bar="index"
        >
          <rect class="bar-set-track" :x="-BAR / 2" y="0" :width="BAR" :height="PLOT" :rx="BAR / 2" />
          <rect
            v-if="bar.height > 0"
            class="bar-set-bar"
            :x="-BAR / 2"
            :y="bar.y"
            :width="BAR"
            :height="bar.height"
            :rx="BAR / 2"
          />
          <circle class="bar-set-dot" cx="0" :cy="PLOT + 13" r="3" />
        </svg>
      </svg>
      <ol class="bar-set-labels">
        <li
          v-for="(slot, index) in slots"
          :key="index"
          class="bar-set-label"
          :class="{ 'bar-set-label--highlight': index === highlighted }"
        >
          {{ slot.label }}
        </li>
      </ol>
    </div>
    <table class="visually-hidden" data-chart-table>
      <caption>{{ title }}</caption>
      <thead>
        <tr>
          <th scope="col">{{ slotHeader }}</th>
          <th scope="col">{{ valueHeader }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(slot, index) in slots" :key="index">
          <th scope="row">{{ slot.name }}</th>
          <td>
            {{ valueText(index) }}<template v-if="index === highlighted && chip"> ({{ chip }})</template>
          </td>
        </tr>
      </tbody>
    </table>
  </figure>
</template>
