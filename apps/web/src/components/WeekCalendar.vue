<script setup lang="ts">
import { computed, onUnmounted } from 'vue';
import type {
  Availability,
  AvailabilityException,
  CommitmentOccurrence,
  PlanBlock,
} from '../api';
import {
  localParts,
  weekDates,
  weekdayOfDate,
} from '../domain/time';

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
}>();

const MINUTE_PX = 1;
const GRID_MINUTES = 5;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAY_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

interface WindowBand {
  start: number;
  end: number;
  kind: string;
}

interface PositionedBlock {
  block: PlanBlock;
  index: number;
  date: string;
  top: number;
  height: number;
  label: string;
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

function dateLabel(date: string): string {
  return DAY_FORMATTER.format(new Date(`${date}T12:00:00Z`));
}

function blockLabel(block: PlanBlock): string {
  const start = localParts(block.startAt, props.timeZone);
  const end = localParts(block.endAt, props.timeZone);
  const task = props.taskNames[block.taskId] ?? block.taskId;
  return `${task}, ${start.date} ${pad(start.hour)}:${pad(start.minute)} to ${end.date === start.date ? `${pad(end.hour)}:${pad(end.minute)}` : `${end.date} ${pad(end.hour)}:${pad(end.minute)}`}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function positionFor(startAt: string, endAt: string): { date: string; top: number; height: number } | null {
  const start = localParts(startAt, props.timeZone);
  const end = localParts(endAt, props.timeZone);
  if (!dates.value.includes(start.date)) return null;
  let duration: number;
  if (end.date === start.date) {
    duration = end.minutes - start.minutes;
  } else {
    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);
    duration = Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 60_000 : 0;
    duration = Math.min(duration, 1440 - start.minutes);
  }
  return {
    date: start.date,
    top: start.minutes,
    height: Math.max(GRID_MINUTES, Math.min(duration, 1440 - start.minutes)),
  };
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
      title: props.commitmentNames[occurrence.commitmentId] ?? 'Commitment',
    });
  }
  return list;
});

function blocksForDate(date: string): PositionedBlock[] {
  return positionedBlocks.value.filter((block) => block.date === date);
}

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
  if (!props.editable) return;
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
  if (!props.editable) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
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
  <section class="week-calendar" aria-label="Week calendar">
    <div class="calendar-scroll">
      <div class="calendar-week">
        <div class="calendar-corner" aria-hidden="true"></div>
        <div
          v-for="date in dates"
          :key="`head-${date}`"
          class="calendar-day-head"
          :data-date="date"
        >
          <span class="calendar-weekday">{{ dateLabel(date).split(',')[0] }}</span>
          <span class="calendar-date">{{ date }}</span>
        </div>

        <div class="calendar-hour-rail" aria-hidden="true">
          <span
            v-for="hour in HOURS"
            :key="`hour-${hour}`"
            class="calendar-hour-label"
            :style="{ top: `${hour * 60}px` }"
          >
            {{ String(hour).padStart(2, '0') }}:00
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
            v-for="(commitment, commitmentIndex) in commitmentsForDate(date)"
            :key="`commitment-${commitment.startAt}-${commitmentIndex}`"
            class="calendar-commitment"
            :style="{ top: `${commitment.top}px`, height: `${commitment.height}px` }"
            :title="commitment.title"
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
            @click="select(positioned.index)"
            @keydown="onBlockKeydown($event, positioned.index)"
            @pointerdown="pointerDown($event, positioned.index, 'move')"
          >
            <span class="calendar-block-time">{{ positioned.label.split(', ')[1] ?? '' }}</span>
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
