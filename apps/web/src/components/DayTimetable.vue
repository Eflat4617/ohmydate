<script setup lang="ts">
import { computed } from 'vue';
import { dayTimetable, timetableNow, type TimetableBlock } from '../domain/dayTimetable';
import { t, tp } from '../i18n';
import { formatHour } from '../i18n/format';

/**
 * Today's blocks drawn on a planner's time table: one row per hour, six
 * ten-minute cells, each block highlighted over the cells it covers. It is a
 * picture of the list beside it, so assistive tech gets one sentence, not a
 * second copy of every block.
 */
const props = defineProps<{
  blocks: readonly (TimetableBlock & { readonly title: string })[];
  /** `YYYY-MM-DD`, the day being shown. */
  date: string;
  timeZone: string;
  nextBlockId: string | null;
  nowMs: number;
}>();

const TEN_MINUTE_MARKS = [10, 20, 30, 40, 50, 60] as const;

const rows = computed(() => dayTimetable(props.blocks, props.date, props.timeZone, props.nextBlockId));
const firstHour = computed(() => rows.value[0]?.hour ?? 0);
const now = computed(() => timetableNow(props.nowMs, props.date, props.timeZone, firstHour.value));

/** Hours before both now and the first block: left out where the table is stacked under the list. */
const compactFrom = computed(() => {
  const firstRun = rows.value.find((row) => row.runs.length > 0)?.hour;
  const candidates = [firstRun, now.value?.hour].filter((hour): hour is number => hour !== undefined);
  return candidates.length > 0 ? Math.min(...candidates) : null;
});

const legend = computed(() => {
  const seriesOf = new Map<string, number>();
  for (const row of rows.value) for (const run of row.runs) seriesOf.set(run.blockId, run.series);
  return props.blocks
    .filter((block) => seriesOf.has(block.id))
    .map((block) => ({ id: block.id, title: block.title, series: seriesOf.get(block.id) ?? 1 }));
});
</script>

<template>
  <section class="day-timetable" aria-labelledby="day-timetable-title">
    <header class="day-timetable-head">
      <h2 id="day-timetable-title">{{ t('today.timetable') }}</h2>
      <p class="day-timetable-unit">{{ t('today.timetableUnit') }}</p>
    </header>
    <div class="tt" role="img" :aria-label="tp('today.timetableLabel', legend.length)">
      <div class="tt-row tt-row--head" aria-hidden="true">
        <span class="tt-hour"></span>
        <span class="tt-marks">
          <span v-for="mark in TEN_MINUTE_MARKS" :key="mark" class="tt-mark tabular">{{ mark }}</span>
        </span>
      </div>
      <div
        v-for="row in rows"
        :key="row.hour"
        class="tt-row"
        :class="{
          'tt-row--before': compactFrom !== null && row.hour < compactFrom,
          'tt-row--past': now !== null && row.hour < now.hour,
          'tt-row--now': now !== null && row.hour === now.hour,
        }"
        aria-hidden="true"
      >
        <span class="tt-hour tabular"><span class="tt-hour-label">{{ formatHour(row.hour) }}</span></span>
        <span class="tt-cells">
          <span v-if="now && now.hour === row.hour" class="tt-elapsed" :style="{ '--at': now.at }"></span>
          <span
            v-for="run in row.runs"
            :key="run.blockId"
            class="tt-run"
            :class="`tt-series--${run.series}`"
            :style="{ '--from': run.from, '--to': run.to }"
          ></span>
          <span v-if="now && now.hour === row.hour" class="tt-now" :style="{ '--at': now.at }"></span>
        </span>
      </div>
    </div>
    <ul v-if="legend.length > 0" class="tt-legend" aria-hidden="true">
      <li v-for="item in legend" :key="item.id">
        <span class="tt-swatch" :class="`tt-series--${item.series}`"></span>
        <span class="tt-legend-title">{{ item.title }}</span>
      </li>
    </ul>
  </section>
</template>
