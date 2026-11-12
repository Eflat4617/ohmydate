<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { AvailabilityRule } from '../api';
import {
  DEFAULT_FIRST_SLOT,
  SLOTS_PER_DAY,
  SLOT_MINUTES,
  WEEKDAYS,
  cellState,
  dayIntervals,
  dayIsOffGrid,
  dayTotals,
  earliestMinute,
  formatClock,
  intervalsToRules,
  paintSlots,
  replaceDayRules,
  strokeKind,
  weekTotals,
  type AvailabilityKind,
  type Brush,
  type CellState,
  type DayInterval,
  type Weekday,
} from '../domain/availabilityGrid';
import { intlLocale, t } from '../i18n';
import { formatHoursAndMinutes } from '../i18n/format';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';

/**
 * Weekly availability editor (FU-97): columns 월–일, rows of 30 minutes.
 *
 * The rules prop is the only state; painting emits a new rules array in
 * which only the painted weekdays are rewritten. Mouse and touch paint by
 * press and drag (the press decides paint or erase for the whole stroke);
 * the keyboard uses one roving tab stop, arrows to move, Space/Enter to
 * toggle and Shift+arrows to keep painting.
 */
const props = withDefaults(
  defineProps<{
    rules: AvailabilityRule[];
    readonly?: boolean;
  }>(),
  { readonly: false },
);

const emit = defineEmits<{ 'update:rules': [rules: AvailabilityRule[]] }>();

const BRUSHES: readonly Brush[] = ['work', 'focus', 'erase'];
const LAST_DAY = WEEKDAYS.length - 1;
const LAST_SLOT = SLOTS_PER_DAY - 1;
const DEFAULT_ACTIVE_SLOT = (9 * 60) / SLOT_MINUTES;

const brush = ref<Brush>('work');
const showEarly = ref(false);
const announcement = ref('');
const gridElement = ref<HTMLElement | null>(null);

const intervalsByDay = computed<DayInterval[][]>(() =>
  WEEKDAYS.map((weekday) => dayIntervals(props.rules, weekday)),
);

const earlyForced = computed(() => {
  const earliest = earliestMinute(props.rules);
  return earliest !== null && earliest < DEFAULT_FIRST_SLOT * SLOT_MINUTES;
});
const earlyVisible = computed(() => showEarly.value || earlyForced.value);
const firstSlot = computed(() => (earlyVisible.value ? 0 : DEFAULT_FIRST_SLOT));

function initialActiveSlot(): number {
  const earliest = earliestMinute(props.rules);
  const slot = earliest === null ? DEFAULT_ACTIVE_SLOT : Math.floor(earliest / SLOT_MINUTES);
  return Math.max(firstSlot.value, Math.min(LAST_SLOT, slot));
}

const active = ref<{ day: number; slot: number }>({ day: 0, slot: initialActiveSlot() });

watch(firstSlot, (first) => {
  if (active.value.slot < first) active.value = { day: active.value.day, slot: first };
});

function brushLabel(option: Brush): string {
  if (option === 'focus') return t('availability.grid.brushFocus');
  if (option === 'erase') return t('availability.grid.brushErase');
  return t('availability.grid.brushWork');
}

function kindLabel(kind: AvailabilityKind): string {
  return kind === 'focus' ? t('availability.kindFocus') : t('availability.kindWork');
}

function weekdayAt(day: number): Weekday {
  return WEEKDAYS[Math.max(0, Math.min(LAST_DAY, day))] as Weekday;
}

function cellLabel(weekday: Weekday, slot: number, state: CellState): string {
  const params = {
    weekday: t(`availability.weekday.${weekday}`),
    start: formatClock(slot * SLOT_MINUTES),
    end: formatClock((slot + 1) * SLOT_MINUTES),
  };
  if (state.kind === null) return t('availability.grid.cellEmpty', params);
  if (!state.full) {
    if (state.covered === SLOT_MINUTES) return t('availability.grid.cellMixed', params);
    return t('availability.grid.cellPartial', { ...params, minutes: state.covered, kind: kindLabel(state.kind) });
  }
  return state.kind === 'focus'
    ? t('availability.grid.cellFocus', params)
    : t('availability.grid.cellWork', params);
}

interface GridCell {
  day: number;
  slot: number;
  label: string;
  state: CellState;
  /** `empty`, `work`, `focus` or `partial` (also the `data-state` hook). */
  shown: 'empty' | 'work' | 'focus' | 'partial';
  /** Kind text on the first cell of a run (a non-colour cue). */
  runLabel: string | null;
  /** Covered part of a partial cell, in % of its height. */
  fill: { top: number; height: number } | null;
}

interface GridRow {
  slot: number;
  time: string;
  hour: boolean;
  cells: GridCell[];
}

function partialFill(intervals: readonly DayInterval[], slot: number): { top: number; height: number } | null {
  const start = slot * SLOT_MINUTES;
  const end = start + SLOT_MINUTES;
  let from = end;
  let to = start;
  for (const interval of intervals) {
    if (interval.end <= start || interval.start >= end) continue;
    from = Math.min(from, Math.max(start, interval.start));
    to = Math.max(to, Math.min(end, interval.end));
  }
  if (to <= from) return null;
  return { top: ((from - start) / SLOT_MINUTES) * 100, height: ((to - from) / SLOT_MINUTES) * 100 };
}

function buildCell(day: number, slot: number): GridCell {
  const intervals = intervalsByDay.value[day] ?? [];
  const state = cellState(intervals, slot);
  let shown: GridCell['shown'] = 'empty';
  if (state.kind !== null) shown = state.full ? state.kind : 'partial';
  let runLabel: string | null = null;
  if (state.full && state.kind !== null) {
    const previous = slot === firstSlot.value ? null : cellState(intervals, slot - 1);
    if (previous === null || !previous.full || previous.kind !== state.kind) runLabel = kindLabel(state.kind);
  }
  return {
    day,
    slot,
    label: cellLabel(weekdayAt(day), slot, state),
    state,
    shown,
    runLabel,
    fill: shown === 'partial' ? partialFill(intervals, slot) : null,
  };
}

const rows = computed<GridRow[]>(() => {
  const list: GridRow[] = [];
  for (let slot = firstSlot.value; slot < SLOTS_PER_DAY; slot += 1) {
    list.push({
      slot,
      time: formatClock(slot * SLOT_MINUTES),
      hour: slot % 2 === 0,
      cells: WEEKDAYS.map((_, day) => buildCell(day, slot)),
    });
  }
  return list;
});

const columns = computed(() =>
  WEEKDAYS.map((weekday, day) => {
    const duration = formatHoursAndMinutes(dayTotals(props.rules, weekday).total);
    return {
      day,
      short: t(`availability.weekdayShort.${weekday}`),
      duration,
      label: t('availability.grid.dayTotal', { weekday: t(`availability.weekday.${weekday}`), duration }),
    };
  }),
);

const weekTotal = computed(() => {
  const totals = weekTotals(props.rules);
  return t('availability.grid.weekTotal', {
    total: formatHoursAndMinutes(totals.total),
    work: formatHoursAndMinutes(totals.work),
    focus: formatHoursAndMinutes(totals.focus),
  });
});

const offGridDays = computed(() => {
  const names = WEEKDAYS.filter((weekday) => dayIsOffGrid(props.rules, weekday)).map((weekday) =>
    t(`availability.weekday.${weekday}`),
  );
  if (names.length === 0) return null;
  return new Intl.ListFormat(intlLocale(), { style: 'long', type: 'conjunction' }).format(names);
});

function sameIntervals(left: readonly DayInterval[], right: readonly DayInterval[]): boolean {
  return (
    left.length === right.length &&
    left.every((interval, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        other.start === interval.start &&
        other.end === interval.end &&
        other.kind === interval.kind
      );
    })
  );
}

/**
 * Paints the rectangle of days × slots on `base`. A day whose intervals do
 * not change keeps its original rules (an erase over empty cells does not
 * rewrite an off-grid day).
 */
function paintRect(
  base: readonly AvailabilityRule[],
  fromDay: number,
  toDay: number,
  fromSlot: number,
  toSlot: number,
  kind: AvailabilityKind | null,
): { rules: AvailabilityRule[]; changed: boolean } {
  let next = [...base];
  let changed = false;
  for (let day = Math.min(fromDay, toDay); day <= Math.max(fromDay, toDay); day += 1) {
    const weekday = weekdayAt(day);
    const before = dayIntervals(base, weekday);
    const after = paintSlots(before, fromSlot, toSlot, kind);
    if (sameIntervals(before, after)) continue;
    next = replaceDayRules(next, weekday, intervalsToRules(weekday, after));
    changed = true;
  }
  return { rules: next, changed };
}

function commit(result: { rules: AvailabilityRule[]; changed: boolean }): void {
  if (result.changed) emit('update:rules', result.rules);
}

function cellAt(day: number, slot: number): CellState {
  return cellState(intervalsByDay.value[day] ?? [], slot);
}

function focusCell(day: number, slot: number): void {
  active.value = { day, slot };
  void nextTick(() => {
    gridElement.value?.querySelector<HTMLElement>(`[data-day="${day}"][data-slot="${slot}"]`)?.focus();
  });
}

function announceCell(rules: readonly AvailabilityRule[], day: number, slot: number): void {
  const weekday = weekdayAt(day);
  announcement.value = cellLabel(weekday, slot, cellState(dayIntervals(rules, weekday), slot));
}

// ── Pointer (mouse, pen, touch) ───────────────────────────────────────
interface Stroke {
  pointerId: number | undefined;
  day: number;
  slot: number;
  kind: AvailabilityKind | null;
  base: AvailabilityRule[];
}

let stroke: Stroke | null = null;
/** The press already painted; the click that follows it must not toggle again. */
let pressHandled = false;

function endStroke(): void {
  stroke = null;
  window.removeEventListener('pointerup', endStroke);
  window.removeEventListener('pointercancel', endStroke);
}

function onPointerDown(event: PointerEvent, day: number, slot: number): void {
  if (event.pointerType === 'mouse' && event.button > 0) return;
  pressHandled = true;
  // The default would focus the cell only after mousedown; take focus here
  // (the roving stop follows the pointer) and keep text from being selected.
  event.preventDefault();
  active.value = { day, slot };
  (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
  if (props.readonly) return;
  // Touch captures the pointer to the first cell; release it so the cells the
  // finger crosses get their pointerenter.
  const target = event.currentTarget as HTMLElement | null;
  if (target !== null && typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }
  stroke = {
    pointerId: event.pointerId,
    day,
    slot,
    kind: strokeKind(brush.value, cellAt(day, slot)),
    base: [...props.rules],
  };
  commit(paintRect(stroke.base, day, day, slot, slot, stroke.kind));
  window.addEventListener('pointerup', endStroke);
  window.addEventListener('pointercancel', endStroke);
}

function onPointerEnter(event: PointerEvent, day: number, slot: number): void {
  if (stroke === null || event.pointerId !== stroke.pointerId) return;
  if (props.readonly) {
    endStroke();
    return;
  }
  commit(paintRect(stroke.base, stroke.day, day, stroke.slot, slot, stroke.kind));
}

/** A click without a press first (assistive tech activation) toggles the cell. */
function onClick(day: number, slot: number): void {
  if (pressHandled) {
    pressHandled = false;
    return;
  }
  toggle(day, slot);
}

// ── Keyboard ──────────────────────────────────────────────────────────
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

let keyStroke: { kind: AvailabilityKind | null } | null = null;

function toggle(day: number, slot: number): void {
  if (props.readonly) return;
  const result = paintRect(props.rules, day, day, slot, slot, strokeKind(brush.value, cellAt(day, slot)));
  commit(result);
  announceCell(result.rules, day, slot);
}

function onKeydown(event: KeyboardEvent, day: number, slot: number): void {
  const delta = ARROWS[event.key];
  if (delta !== undefined) {
    event.preventDefault();
    const nextDay = Math.max(0, Math.min(LAST_DAY, day + delta[0]));
    const nextSlot = Math.max(firstSlot.value, Math.min(LAST_SLOT, slot + delta[1]));
    if (event.shiftKey && !props.readonly) {
      let rules: readonly AvailabilityRule[] = props.rules;
      if (keyStroke === null) {
        keyStroke = { kind: strokeKind(brush.value, cellAt(day, slot)) };
        const first = paintRect(rules, day, day, slot, slot, keyStroke.kind);
        rules = first.rules;
        commit(first);
      }
      const result = paintRect(rules, nextDay, nextDay, nextSlot, nextSlot, keyStroke.kind);
      if (result.changed) emit('update:rules', result.rules);
      announceCell(result.rules, nextDay, nextSlot);
    } else {
      keyStroke = null;
    }
    focusCell(nextDay, nextSlot);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    keyStroke = null;
    focusCell(event.ctrlKey ? (event.key === 'Home' ? 0 : LAST_DAY) : day, event.key === 'Home' ? firstSlot.value : LAST_SLOT);
    return;
  }
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    keyStroke = null;
    toggle(day, slot);
  }
}

function onKeyup(event: KeyboardEvent): void {
  if (event.key === 'Shift') keyStroke = null;
}

function onFocus(day: number, slot: number): void {
  active.value = { day, slot };
}

function isActive(cell: GridCell): boolean {
  return cell.day === active.value.day && cell.slot === active.value.slot;
}

onUnmounted(endStroke);
</script>

<template>
  <div class="avail-editor">
    <div class="avail-editor-toolbar">
      <fieldset class="choice-group avail-brush" :disabled="readonly">
        <legend>{{ t('availability.grid.brush') }}</legend>
        <label v-for="option in BRUSHES" :key="option" class="choice-chip">
          <input v-model="brush" type="radio" name="availability-brush" :value="option" :data-brush="option" />
          <span class="avail-swatch" :class="`avail-swatch--${option}`" aria-hidden="true"></span>
          {{ brushLabel(option) }}
        </label>
      </fieldset>
      <div class="avail-range">
        <UiButton
          size="sm"
          variant="ghost"
          data-early-toggle
          :aria-pressed="earlyVisible ? 'true' : 'false'"
          :disabled="earlyForced"
          @click="showEarly = !showEarly"
        >
          {{ t('availability.grid.showEarly') }}
        </UiButton>
        <span v-if="earlyForced" class="muted avail-range-note">{{ t('availability.grid.earlyForced') }}</span>
      </div>
    </div>

    <p id="availability-grid-hint" class="muted avail-hint">
      {{ t('availability.grid.keyboardHint') }}
      <span class="avail-hint-touch">{{ t('availability.grid.touchHint') }}</span>
    </p>

    <UiBanner v-if="offGridDays" tone="info" inline class="avail-offgrid" data-offgrid-note>
      {{ t('availability.grid.offGridNote', { days: offGridDays }) }}
    </UiBanner>

    <div class="avail-scroller">
      <div
        ref="gridElement"
        class="avail-grid"
        :class="{ 'avail-grid--readonly': readonly }"
        role="grid"
        :aria-label="t('availability.grid.label')"
        aria-describedby="availability-grid-hint"
        :aria-readonly="readonly ? 'true' : undefined"
        :aria-rowcount="rows.length + 1"
        aria-colcount="8"
      >
        <div class="avail-row avail-row--head" role="row" aria-rowindex="1">
          <div class="avail-corner" role="columnheader" aria-colindex="1">
            <span class="visually-hidden">{{ t('availability.grid.timeHeader') }}</span>
          </div>
          <div
            v-for="column in columns"
            :key="`head-${column.day}`"
            class="avail-dayhead"
            role="columnheader"
            :aria-colindex="column.day + 2"
            :aria-label="column.label"
            :data-day-total="column.day"
          >
            <span class="avail-dayhead-name" aria-hidden="true">{{ column.short }}</span>
            <span class="avail-dayhead-total" aria-hidden="true">{{ column.duration }}</span>
          </div>
        </div>
        <div
          v-for="(row, rowIndex) in rows"
          :key="`row-${row.slot}`"
          class="avail-row"
          :class="{ 'avail-row--hour': row.hour }"
          role="row"
          :aria-rowindex="rowIndex + 2"
        >
          <div class="avail-time" role="rowheader" aria-colindex="1">
            <span :class="{ 'visually-hidden': !row.hour }">{{ row.time }}</span>
          </div>
          <div
            v-for="cell in row.cells"
            :key="`cell-${cell.day}-${row.slot}`"
            class="avail-cell"
            :class="`avail-cell--${cell.shown}`"
            role="gridcell"
            :aria-colindex="cell.day + 2"
            :aria-label="cell.label"
            :tabindex="isActive(cell) ? 0 : -1"
            :data-day="cell.day"
            :data-slot="cell.slot"
            :data-state="cell.shown"
            @pointerdown="onPointerDown($event, cell.day, cell.slot)"
            @pointerenter="onPointerEnter($event, cell.day, cell.slot)"
            @click="onClick(cell.day, cell.slot)"
            @keydown="onKeydown($event, cell.day, cell.slot)"
            @keyup="onKeyup"
            @focus="onFocus(cell.day, cell.slot)"
          >
            <span
              v-if="cell.fill && cell.state.kind"
              class="avail-cell-fill"
              :class="`avail-cell-fill--${cell.state.kind}`"
              :style="{ top: `${cell.fill.top}%`, height: `${cell.fill.height}%` }"
              aria-hidden="true"
            ></span>
            <span v-if="cell.runLabel" class="avail-cell-label" aria-hidden="true">{{ cell.runLabel }}</span>
          </div>
        </div>
      </div>
    </div>

    <p class="avail-week-total" data-week-total>{{ weekTotal }}</p>
    <p class="visually-hidden" role="status" aria-live="polite">{{ announcement }}</p>
  </div>
</template>
