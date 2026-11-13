<script setup lang="ts">
import { computed } from 'vue';
import { dayTimetable, timetableNow, type TimetableBlock } from '../domain/dayTimetable';
import { t, tp } from '../i18n';
import { formatHour } from '../i18n/format';
import UiIcon from './ui/UiIcon.vue';

/**
 * Today's blocks drawn on a planner's time table: one row per hour, six
 * ten-minute cells, each block highlighted over the cells it covers. It is a
 * picture of the list beside it, so assistive tech gets one sentence, not a
 * second copy of every block.
 */
const props = withDefaults(
  defineProps<{
    blocks: readonly (TimetableBlock & { readonly title: string })[];
    /** `YYYY-MM-DD`, the day being shown. */
    date: string;
    timeZone: string;
    nextBlockId: string | null;
    nowMs: number;
    /** CAL-01: the day's 약속, drawn as taken time (cyan), not as planned work. */
    commitments?: readonly (TimetableBlock & { readonly title: string })[];
    /** HOLO-02: `day` names the table for a day that is not today (플래너 · 일). */
    scope?: 'today' | 'day';
  }>(),
  { commitments: () => [], scope: 'today' },
);

const TEN_MINUTE_MARKS = [10, 20, 30, 40, 50, 60] as const;

const rows = computed(() =>
  dayTimetable(props.blocks, props.date, props.timeZone, props.nextBlockId, props.commitments),
);
const firstHour = computed(() => rows.value[0]?.hour ?? 0);
const now = computed(() => timetableNow(props.nowMs, props.date, props.timeZone, firstHour.value));

/** Hours before both now and the first block: left out where the table is stacked under the list. */
const compactFrom = computed(() => {
  const firstRun = rows.value.find((row) => row.runs.length > 0 || row.taken.length > 0)?.hour;
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

/** 약속 that are on the page, once each, in the order given. */
const takenLegend = computed(() => {
  const shown = new Set<string>();
  for (const row of rows.value) for (const run of row.taken) shown.add(run.id);
  return props.commitments.filter((commitment) => shown.has(commitment.id));
});

const tableLabel = computed(() => {
  if (props.scope === 'day') {
    return takenLegend.value.length === 0
      ? tp('planner.day.timetableLabel', legend.value.length)
      : tp('planner.day.timetableLabelWithCommitments', legend.value.length, { commitments: takenLegend.value.length });
  }
  return takenLegend.value.length === 0
    ? tp('today.timetableLabel', legend.value.length)
    : tp('today.timetableLabelWithCommitments', legend.value.length, { commitments: takenLegend.value.length });
});

/** Finished blocks carry a tick in the legend: done is not said by colour alone. */
const doneIds = computed(() => new Set(props.blocks.filter((block) => block.status === 'done').map((block) => block.id)));
</script>

<template>
  <section class="day-timetable" aria-labelledby="day-timetable-title">
    <header class="day-timetable-head">
      <h2 id="day-timetable-title" class="card-title">
        <UiIcon name="clock" :size="18" />
        {{ t('today.timetable') }}
      </h2>
      <p class="day-timetable-unit">{{ t('today.timetableUnit') }}</p>
    </header>
    <div class="tt" role="img" :aria-label="tableLabel">
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
            v-for="mark in row.taken"
            :key="`taken-${mark.id}`"
            class="tt-taken"
            data-timetable-commitment
            :style="{ '--from': mark.from, '--to': mark.to }"
          ></span>
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
    <ul v-if="legend.length > 0 || takenLegend.length > 0" class="tt-legend" aria-hidden="true">
      <li v-for="item in legend" :key="item.id" :class="{ 'tt-legend-done': doneIds.has(item.id) }">
        <span class="tt-swatch" :class="`tt-series--${item.series}`">
          <UiIcon v-if="doneIds.has(item.id)" name="check" :size="10" />
        </span>
        <span class="tt-legend-title">{{ item.title }}</span>
      </li>
      <li v-for="item in takenLegend" :key="`taken-${item.id}`" class="tt-legend-taken">
        <span class="tt-swatch tt-swatch--taken"></span>
        <span class="tt-legend-title">{{ t('today.timetableCommitment', { title: item.title }) }}</span>
      </li>
    </ul>
  </section>
</template>
