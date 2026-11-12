<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  Availability,
  AvailabilityException,
  CommitmentOccurrence,
  PlanBlock,
} from '../api';
import {
  formatZoneOffset,
  localParts,
  weekDates,
  weekdayOfDate,
} from '../domain/time';
import { exceptionTimeText } from '../domain/availabilityExceptions';
import { t } from '../i18n';
import {
  formatCivilDate,
  formatCivilMonthDay,
  formatCivilWeekday,
  formatDateTimeRange,
  formatHour,
  formatTimeRange,
} from '../i18n/format';

const props = withDefaults(
  defineProps<{
    blocks: PlanBlock[];
    timeZone: string;
    weekStart: string;
    availability?: Availability | null;
    commitmentOccurrences?: CommitmentOccurrence[];
    commitmentNames?: Record<string, string>;
    taskNames?: Record<string, string>;
    editable?: boolean;
    selectedIndex?: number | null;
    errorIndexes?: number[];
    /** Id of a note on every block, e.g. why the blocks cannot be edited right now. */
    blockDescribedBy?: string | undefined;
  }>(),
  {
    availability: null,
    commitmentOccurrences: () => [],
    commitmentNames: () => ({}),
    taskNames: () => ({}),
    editable: false,
    selectedIndex: null,
    errorIndexes: () => [],
  },
);

const emit = defineEmits<{
  select: [index: number];
  'update:blocks': [blocks: PlanBlock[]];
  /**
   * An edit was tried while `editable` is false (a press on a block, an
   * arrow key on it, or a drag still under way): nothing changed. The screen
   * decides whether to say why (FU-86F: a lock request is out).
   */
  'edit-blocked': [index: number];
}>();

const MINUTE_PX = 1;
const GRID_MINUTES = 5;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface WindowBand {
  start: number;
  end: number;
  kind: string;
}

/** A date exception "쉼", drawn as its own labelled band (FU-97). */
interface OffBand {
  start: number;
  end: number;
  time: string;
}

interface PositionedBlock {
  block: PlanBlock;
  index: number;
  date: string;
  top: number;
  height: number;
  label: string;
  time: string;
  error: boolean;
}

interface PositionedCommitment {
  startAt: string;
  endAt: string;
  date: string;
  top: number;
  height: number;
  title: string;
}

const dates = computed(() => weekDates(props.weekStart));

function clockMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function subtractWindow(windows: WindowBand[], start: number, end: number): WindowBand[] {
  const next: WindowBand[] = [];
  for (const window of windows) {
    if (end <= window.start || start >= window.end) {
      next.push(window);
      continue;
    }
    if (start > window.start) next.push({ ...window, end: start });
    if (end < window.end) next.push({ ...window, start: end });
  }
  return next;
}

function applyException(windows: WindowBand[], exception: AvailabilityException): WindowBand[] {
  const hasStart = exception.startLocal !== undefined && exception.startLocal.length > 0;
  const hasEnd = exception.endLocal !== undefined && exception.endLocal.length > 0;
  if (!hasStart && !hasEnd) {
    return exception.kind === 'off' ? [] : windows;
  }
  const start = hasStart ? clockMinutes(exception.startLocal ?? '00:00') : 0;
  const end = hasEnd ? clockMinutes(exception.endLocal ?? '24:00') : 24 * 60;
  if (exception.kind === 'off') return subtractWindow(windows, start, end);
  return [...windows, { start, end, kind: 'extra' }].sort((left, right) => left.start - right.start);
}

function windowsForDate(date: string): WindowBand[] {
  const availability = props.availability;
  if (availability === null) return [];
  const weekday = weekdayOfDate(date);
  let windows: WindowBand[] = availability.rules
    .filter((rule) => rule.weekday === weekday)
    .map((rule) => ({
      start: clockMinutes(rule.startLocal),
      end: clockMinutes(rule.endLocal),
      kind: rule.kind,
    }));
  for (const exception of availability.exceptions) {
    if (exception.date === date) windows = applyException(windows, exception);
  }
  return windows
    .map((window) => ({ ...window, start: Math.max(0, window.start), end: Math.min(1440, window.end) }))
    .filter((window) => window.end > window.start);
}

/**
 * The 쉼 exceptions of a date as bands: the exception's time range, or the
 * whole day when it has no times. Drawn whether or not a weekly rule covers
 * that day, so a day off on a rule-less weekend is still visible.
 */
function offBandsForDate(date: string): OffBand[] {
  const availability = props.availability;
  if (availability === null) return [];
  const bands: OffBand[] = [];
  for (const exception of availability.exceptions) {
    if (exception.date !== date || exception.kind !== 'off') continue;
    const hasStart = exception.startLocal !== undefined && exception.startLocal.length > 0;
    const hasEnd = exception.endLocal !== undefined && exception.endLocal.length > 0;
    const start = hasStart ? clockMinutes(exception.startLocal ?? '00:00') : 0;
    const end = hasEnd ? clockMinutes(exception.endLocal ?? '24:00') : 24 * 60;
    const from = Math.max(0, start);
    const to = Math.min(1440, end);
    if (to <= from) continue;
    bands.push({ start: from, end: to, time: exceptionTimeText(exception) });
  }
  return bands.sort((left, right) => left.start - right.start);
}

function dateLabel(date: string): string {
  return formatCivilDate(date);
}

/**
 * Accessible name of a block or commitment: `<title>, <local date> <time
 * range> (<UTC offset>)`, e.g. `논문 요약, 11월 16일 (월) 오전 9:00~10:30 (GMT+9)`.
 * The offset keeps repeated wall-clock times apart on DST fall-back days.
 */
function intervalLabel(title: string, startAt: string, endAt: string): string {
  const startOffset = formatZoneOffset(startAt, props.timeZone);
  const endOffset = formatZoneOffset(endAt, props.timeZone);
  const offset = startOffset === endOffset ? startOffset : `${startOffset}→${endOffset}`;
  return t('calendar.blockLabel', {
    task: title,
    when: formatDateTimeRange(startAt, endAt, props.timeZone),
    offset,
  });
}

function blockLabel(block: PlanBlock): string {
  return intervalLabel(props.taskNames[block.taskId] ?? block.taskId, block.startAt, block.endAt);
}

function positionFor(startAt: string, endAt: string): { date: string; top: number; height: number } | null {
  const start = localParts(startAt, props.timeZone);
  if (!dates.value.includes(start.date)) return null;
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  const duration =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 60_000 : 0;
  return {
    date: start.date,
    top: start.minutes,
    height: Math.max(GRID_MINUTES, Math.min(duration, 1440 - start.minutes)),
  };
}

function commitmentLabel(commitment: PositionedCommitment): string {
  return intervalLabel(commitment.title, commitment.startAt, commitment.endAt);
}

const positionedBlocks = computed<PositionedBlock[]>(() => {
  const list: PositionedBlock[] = [];
  props.blocks.forEach((block, index) => {
    const position = positionFor(block.startAt, block.endAt);
    if (position === null) return;
    list.push({
      block,
      index,
      date: position.date,
      top: position.top,
      height: position.height,
      label: blockLabel(block),
      time: formatTimeRange(block.startAt, block.endAt, props.timeZone),
      error: props.errorIndexes.includes(index),
    });
  });
  return list;
});

const positionedCommitments = computed<PositionedCommitment[]>(() => {
  const list: PositionedCommitment[] = [];
  for (const occurrence of props.commitmentOccurrences) {
    const position = positionFor(occurrence.startAt, occurrence.endAt);
    if (position === null) continue;
    list.push({
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      date: position.date,
      top: position.top,
      height: position.height,
      title: props.commitmentNames[occurrence.commitmentId] ?? t('calendar.commitmentFallback'),
    });
  }
  return list;
});

function blocksForDate(date: string): PositionedBlock[] {
  return positionedBlocks.value.filter((block) => block.date === date);
}

// Presentational: open the scroller at the working part of the day (first
// block, else first availability window, else 07:00) instead of midnight.
const scroller = ref<HTMLElement | null>(null);
const firstOffsetPx = computed(() => {
  const blockTops = positionedBlocks.value.map((item) => item.top);
  if (blockTops.length > 0) return Math.min(...blockTops);
  const windowTops = dates.value.flatMap((date) => windowsForDate(date).map((band) => band.start));
  return windowTops.length > 0 ? Math.min(...windowTops) : 7 * 60 * MINUTE_PX;
});

function scrollToWorkingHours(): void {
  const element = scroller.value;
  if (element === null) return;
  element.scrollTop = Math.max(0, firstOffsetPx.value - 60 * MINUTE_PX);
}

onMounted(() => {
  void nextTick(scrollToWorkingHours);
});

watch(
  () => props.weekStart,
  () => {
    void nextTick(scrollToWorkingHours);
  },
);

function commitmentsForDate(date: string): PositionedCommitment[] {
  return positionedCommitments.value.filter((commitment) => commitment.date === date);
}

function select(index: number): void {
  emit('select', index);
}

interface DragState {
  mode: 'move' | 'resize';
  index: number;
  startY: number;
  startMs: number;
  endMs: number;
}

let drag: DragState | null = null;

function commitDrag(event: PointerEvent): void {
  if (drag === null) return;
  // Editing was turned off while the drag was under way: the blocks stay as
  // they are (later moves apply again once editing is back).
  if (!props.editable) {
    emit('edit-blocked', drag.index);
    return;
  }
  const delta = Math.round((event.clientY - drag.startY) / MINUTE_PX / GRID_MINUTES) * GRID_MINUTES;
  if (delta === 0) return;
  const block = props.blocks[drag.index];
  if (block === undefined) return;
  const next = props.blocks.map((item) => ({ ...item }));
  const target = next[drag.index];
  if (target === undefined) return;
  if (drag.mode === 'move') {
    target.startAt = new Date(drag.startMs + delta * 60_000).toISOString();
    target.endAt = new Date(drag.endMs + delta * 60_000).toISOString();
  } else {
    const endMs = Math.max(drag.startMs + GRID_MINUTES * 60_000, drag.endMs + delta * 60_000);
    target.endAt = new Date(endMs).toISOString();
  }
  emit('update:blocks', next);
}

function pointerMove(event: PointerEvent): void {
  commitDrag(event);
}

function pointerUp(): void {
  drag = null;
  window.removeEventListener('pointermove', pointerMove);
  window.removeEventListener('pointerup', pointerUp);
}

function pointerDown(event: PointerEvent, index: number, mode: 'move' | 'resize'): void {
  if (!props.editable) {
    emit('edit-blocked', index);
    return;
  }
  const block = props.blocks[index];
  if (block === undefined) return;
  event.preventDefault();
  drag = {
    mode,
    index,
    startY: event.clientY,
    startMs: Date.parse(block.startAt),
    endMs: Date.parse(block.endAt),
  };
  window.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);
  emit('select', index);
}

function onBlockKeydown(event: KeyboardEvent, index: number): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (!props.editable) {
    emit('edit-blocked', index);
    return;
  }
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const delta = direction * GRID_MINUTES * 60_000;
  const block = props.blocks[index];
  if (block === undefined) return;
  event.preventDefault();
  const startMs = Date.parse(block.startAt);
  const endMs = Date.parse(block.endAt);
  const next = props.blocks.map((item) => ({ ...item }));
  const target = next[index];
  if (target === undefined) return;
  if (event.shiftKey) {
    target.endAt = new Date(Math.max(startMs + GRID_MINUTES * 60_000, endMs + delta)).toISOString();
  } else {
    target.startAt = new Date(startMs + delta).toISOString();
    target.endAt = new Date(endMs + delta).toISOString();
  }
  emit('update:blocks', next);
  emit('select', index);
}

onUnmounted(pointerUp);

defineExpose({ dates, positionedBlocks });
</script>

<template>
  <!-- The section is the horizontal scroller; keep it keyboard-reachable even for an empty week (axe scrollable-region-focusable). -->
  <section ref="scroller" class="week-calendar" role="region" :aria-label="t('calendar.region')" tabindex="0">
    <div class="calendar-scroll">
      <div class="calendar-week">
        <div class="calendar-corner" aria-hidden="true"></div>
        <div
          v-for="date in dates"
          :key="`head-${date}`"
          class="calendar-day-head"
          :data-date="date"
        >
          <span class="calendar-weekday">{{ formatCivilWeekday(date) }}</span>
          <span class="calendar-date">{{ formatCivilMonthDay(date) }}</span>
          <span v-if="offBandsForDate(date).length > 0" class="calendar-day-off" data-day-off>
            {{ t('calendar.off') }}
          </span>
        </div>

        <div class="calendar-hour-rail" aria-hidden="true">
          <span
            v-for="hour in HOURS"
            :key="`hour-${hour}`"
            class="calendar-hour-label"
            :style="{ top: `${hour * 60}px` }"
          >
            {{ formatHour(hour) }}
          </span>
        </div>

        <div
          v-for="date in dates"
          :key="`day-${date}`"
          class="calendar-day"
          :data-date="date"
          role="group"
          :aria-label="dateLabel(date)"
        >
          <div
            v-for="hour in HOURS"
            :key="`line-${date}-${hour}`"
            class="calendar-hour-line"
            :style="{ top: `${hour * 60}px` }"
            aria-hidden="true"
          ></div>
          <div
            v-for="(window, windowIndex) in windowsForDate(date)"
            :key="`window-${date}-${windowIndex}`"
            class="calendar-availability"
            :class="`calendar-availability--${window.kind}`"
            :style="{ top: `${window.start}px`, height: `${window.end - window.start}px` }"
            aria-hidden="true"
          ></div>
          <div
            v-for="(band, bandIndex) in offBandsForDate(date)"
            :key="`off-${date}-${bandIndex}`"
            class="calendar-off"
            :style="{ top: `${band.start}px`, height: `${band.end - band.start}px` }"
            data-off-band
          >
            <span class="calendar-off-label">
              <strong>{{ t('calendar.off') }}</strong> {{ band.time }}
            </span>
          </div>
          <div
            v-for="(commitment, commitmentIndex) in commitmentsForDate(date)"
            :key="`commitment-${commitment.startAt}-${commitmentIndex}`"
            class="calendar-commitment"
            :style="{ top: `${commitment.top}px`, height: `${commitment.height}px` }"
            :title="commitment.title"
            :aria-label="commitmentLabel(commitment)"
          >
            <span>{{ commitment.title }}</span>
          </div>
          <button
            v-for="positioned in blocksForDate(date)"
            :key="`block-${positioned.index}`"
            type="button"
            class="calendar-block"
            :class="{
              'calendar-block--selected': selectedIndex === positioned.index,
              'calendar-block--error': positioned.error,
            }"
            :style="{ top: `${positioned.top}px`, height: `${positioned.height}px` }"
            :aria-pressed="selectedIndex === positioned.index"
            :aria-invalid="positioned.error"
            :aria-label="positioned.label"
            :aria-describedby="blockDescribedBy"
            @click="select(positioned.index)"
            @keydown="onBlockKeydown($event, positioned.index)"
            @pointerdown="pointerDown($event, positioned.index, 'move')"
          >
            <span class="calendar-block-time">{{ positioned.time }}</span>
            <span class="calendar-block-title">
              {{ taskNames[positioned.block.taskId] ?? positioned.block.taskId }}
            </span>
            <span
              v-if="editable"
              class="calendar-resize"
              aria-hidden="true"
              @pointerdown.stop="pointerDown($event, positioned.index, 'resize')"
            ></span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
