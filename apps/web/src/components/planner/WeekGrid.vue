<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { EDIT_GRID_MINUTES, dragMinutes, movedInterval, resizedInterval, type BlockInterval } from '../../domain/planDraft';
import {
  initialItemKey,
  isWeekGridKey,
  itemAfterKey,
  type Rect,
  type WeekBand,
  type WeekDay,
  type WeekGrid,
  type WeekItem,
} from '../../domain/weekGrid';
import { t, tp } from '../../i18n';
import {
  formatCivilMonthDay,
  formatCivilWeekday,
  formatCivilWeekdayLong,
  formatClock,
  formatDateTimeRange,
  formatDate,
  formatHour,
  formatTime,
} from '../../i18n/format';
import UiDeadlineFlag from '../ui/UiDeadlineFlag.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * The week grid (HOLO-02), the product's one calendar: Monday to Sunday over
 * one time axis. Approved blocks are lime, 약속 cyan, a deadline an orange
 * flag at its time; a finished block is quieter and ticked; today's column
 * and the now line are marked. What overlaps sits side by side
 * (domain/weekGrid.ts did the placing).
 *
 * The planning screens (HOLO-03A) draw on the same grid what is not real
 * yet: a proposal is a dashed outline over the faintest tint, never a fill —
 * an approved block and a proposed one cannot be mistaken for each other —
 * and a ghost is where a block stood before a 다시 맞추기. Behind the items a day
 * can carry its available hours, focus windows and 쉼.
 *
 * `editable`: a proposal can be moved and made longer or shorter in steps of
 * five minutes — by dragging it (its lower edge resizes), or with Alt and the
 * up / down arrows (Shift as well: its length). The grid only says what the
 * block would become (`edit`); the screen owns the list. While `editable` is
 * off a try says so (`edit-blocked`) and changes nothing.
 *
 * The grid is one tab stop. Inside it the arrows move: up and down through a
 * day's items, left and right to the nearest day that holds anything; Home
 * and End go to the day's first and last. Enter or Space on an item asks the
 * screen to open its detail card (`open`); the card itself is the screen's,
 * slotted into the grid's scrolling content so it moves with its item.
 *
 * Narrow (the page's own container under 40rem): three days are on show and
 * the strip scrolls sideways inside its frame; the page never does.
 */
const props = withDefaults(
  defineProps<{
    grid: WeekGrid;
    timeZone: string;
    /** The accessible name of the whole grid ("11월 9일 ~ 11월 15일 주간 일정"). */
    label: string;
    loading?: boolean;
    /** The item whose detail card is open, if any. */
    openKey?: string | null;
    /** The hours before 06:00 are on show because they were asked for. */
    showEarly?: boolean;
    /** Proposals can be moved and resized. */
    editable?: boolean;
    /** Id of a note that describes every proposal (why it cannot be edited right now). */
    proposalDescribedBy?: string | undefined;
    /** Where the hours open: an hour before now, or at the first proposal (a schedule being compared). */
    openAt?: 'now' | 'proposal';
    /** When this changes (another candidate, another proposal) the hours open again. */
    scrollKey?: string | null;
  }>(),
  { loading: false, openKey: null, showEarly: false, editable: false, openAt: 'now', scrollKey: null },
);
const emit = defineEmits<{
  open: [item: WeekItem, element: HTMLElement];
  'toggle-early': [];
  /** What a proposal would become; the screen applies it. */
  edit: [item: WeekItem, next: BlockInterval];
  /** An edit was tried while `editable` is off: nothing changed. */
  'edit-blocked': [item: WeekItem];
}>();

const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const items = new Map<string, HTMLElement>();

const hours = computed(() =>
  Array.from({ length: props.grid.endHour - props.grid.startHour }, (_, index) => props.grid.startHour + index),
);
const startMin = computed(() => props.grid.startHour * 60);

/** The early hours can be folded away only when nothing is drawn in them. */
const canToggleEarly = computed(() => props.showEarly || props.grid.startHour > 0);

// ── The one tab stop ───────────────────────────────────────────────────
const activeKey = ref<string | null>(initialItemKey(props.grid));
const known = computed(() => new Set(props.grid.days.flatMap((day) => day.items.map((item) => item.key))));
watch(
  known,
  (keys) => {
    if (activeKey.value === null || !keys.has(activeKey.value)) activeKey.value = initialItemKey(props.grid);
  },
  { immediate: true },
);

function setItem(key: string, element: unknown): void {
  if (element instanceof HTMLElement) items.set(key, element);
  else items.delete(key);
}

function focusItem(key: string): void {
  activeKey.value = key;
  void nextTick(() => items.get(key)?.focus());
}

function onItemKeydown(event: KeyboardEvent, item: WeekItem): void {
  if (event.ctrlKey || event.metaKey) return;
  if (event.altKey) {
    onEditKey(event, item);
    return;
  }
  if (!isWeekGridKey(event.key)) return;
  event.preventDefault();
  const next = itemAfterKey(props.grid.days, item.key, event.key);
  if (next !== null) focusItem(next);
}

function onItemClick(event: MouseEvent, item: WeekItem): void {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  // The press was a drag: it moved the block, it does not open its card.
  if (dragged) {
    dragged = false;
    return;
  }
  activeKey.value = item.key;
  emit('open', item, event.currentTarget);
}

// ── Editing a proposal ─────────────────────────────────────────────────
function intervalOf(item: WeekItem): BlockInterval | null {
  return item.kind === 'proposal' && item.endAt !== null ? { startAt: item.startAt, endAt: item.endAt } : null;
}

/** Alt + up / down moves a proposal five minutes; with Shift its end moves instead. */
function onEditKey(event: KeyboardEvent, item: WeekItem): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const interval = intervalOf(item);
  if (interval === null) return;
  event.preventDefault();
  if (!props.editable) {
    emit('edit-blocked', item);
    return;
  }
  const delta = event.key === 'ArrowDown' ? EDIT_GRID_MINUTES : -EDIT_GRID_MINUTES;
  emit('edit', item, event.shiftKey ? resizedInterval(interval, delta) : movedInterval(interval, delta));
}

interface Drag {
  readonly mode: 'move' | 'resize';
  readonly key: string;
  readonly startY: number;
  /** Px of one hour of the axis when the drag began. */
  readonly hourPx: number;
  readonly from: BlockInterval;
}

let drag: Drag | null = null;
/** The press that is ending moved its block (so its click is not an "open"). */
let dragged = false;

function dragItem(): WeekItem | null {
  const key = drag?.key;
  if (key === undefined) return null;
  for (const day of props.grid.days) {
    const found = day.items.find((item) => item.kind === 'proposal' && item.key.split('@')[0] === key);
    if (found !== undefined) return found;
  }
  return null;
}

function onDragMove(event: PointerEvent): void {
  if (drag === null) return;
  const delta = dragMinutes(event.clientY - drag.startY, drag.hourPx);
  if (delta === 0 && !dragged) return;
  const item = dragItem();
  if (item === null) return;
  dragged = true;
  // Editing was turned off while the drag was under way: the block stays as
  // it is (later moves apply again once editing is back).
  if (!props.editable) {
    emit('edit-blocked', item);
    return;
  }
  emit('edit', item, drag.mode === 'move' ? movedInterval(drag.from, delta) : resizedInterval(drag.from, delta));
}

function endDrag(): void {
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);
}

/**
 * HOLO-07: on a phone a finger on a block is a scroll or a tap, never a drag.
 * (A swipe that began on a block moved the block and the page stood still.)
 * The block's card, one tap away, moves and resizes it in steps. A touch
 * screen whose first pointer is a mouse keeps the finger drag it had.
 */
function fingerOnPhone(event: PointerEvent): boolean {
  return (
    event.pointerType === 'touch' &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

function onItemPointerDown(event: PointerEvent, item: WeekItem, mode: 'move' | 'resize'): void {
  const interval = intervalOf(item);
  if (interval === null || event.button !== 0) return;
  dragged = false;
  if (fingerOnPhone(event)) return;
  if (!props.editable) {
    emit('edit-blocked', item);
    return;
  }
  const area = body.value;
  if (area === null || hours.value.length === 0) return;
  drag = {
    mode,
    key: item.key.split('@')[0] ?? item.key,
    startY: event.clientY,
    hourPx: area.clientHeight / hours.value.length,
    from: interval,
  };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}

onUnmounted(endDrag);

// ── What an item and a day say ─────────────────────────────────────────
function itemTitle(item: WeekItem): string {
  return item.title ?? t('month.untitledTask');
}

/**
 * `19:00` and `~20:30` (a narrow column keeps only the first); a piece that
 * began the day before says only when it ends, one that runs on only when it starts.
 */
function itemTime(item: WeekItem): { lead: string; rest: string } {
  if (item.endAt === null) return { lead: formatClock(item.startAt, props.timeZone), rest: '' };
  if (item.continued) return { lead: t('month.until', { time: formatClock(item.endAt, props.timeZone) }), rest: '' };
  if (item.continues) return { lead: t('planner.week.from', { time: formatClock(item.startAt, props.timeZone) }), rest: '' };
  const start = formatClock(item.startAt, props.timeZone);
  const range = t('format.timeRange', { start, end: formatClock(item.endAt, props.timeZone) });
  return { lead: start, rest: range.slice(start.length) };
}

function itemKind(item: WeekItem): string {
  if (item.kind === 'proposal') return item.invalid ? t('planner.week.kind.proposalInvalid') : t('planner.week.kind.proposal');
  if (item.kind === 'ghost') return t('planner.week.kind.ghost');
  if (item.kind === 'block') {
    if (item.done) return t('month.detail.kind.blockDone');
    return item.block?.locked === true ? t('planner.week.kind.blockLocked') : t('month.detail.kind.block');
  }
  if (item.kind === 'commitment') {
    return item.fromGoogle ? t('month.detail.kind.commitmentGoogle') : t('month.detail.kind.commitment');
  }
  return t('month.detail.kind.deadline');
}

/** What it is and when: `블록, 연구 노트 요약, 11월 14일 (토) 오후 7:00~8:30`. */
function itemName(item: WeekItem): string {
  const when =
    item.endAt === null
      ? t('planner.week.dueName', {
          date: formatDate(item.startAt, props.timeZone),
          time: formatTime(item.startAt, props.timeZone),
        })
      : formatDateTimeRange(item.startAt, item.endAt, props.timeZone);
  return [itemKind(item), itemTitle(item), when].join(', ');
}

function dayName(day: WeekDay): string {
  const parts = [`${formatCivilMonthDay(day.date)} ${formatCivilWeekdayLong(day.date)}`];
  if (day.today) parts.push(t('month.cell.today'));
  for (const label of day.labels) parts.push(t('month.cell.dayEvent', { title: label.title }));
  if (day.off) parts.push(t('calendar.off'));
  if (day.counts.proposal > 0) parts.push(tp('planner.week.proposals', day.counts.proposal));
  if (day.counts.block > 0) parts.push(tp('month.cell.blocks', day.counts.block));
  if (day.counts.commitment > 0) parts.push(tp('month.cell.commitments', day.counts.commitment));
  if (day.counts.deadline > 0) parts.push(tp('month.cell.deadlines', day.counts.deadline));
  if (day.items.length === 0 && day.labels.length === 0) parts.push(t('month.cell.nothing'));
  return parts.join(', ');
}

function itemStyle(item: WeekItem): Record<string, string> {
  return {
    '--top': String((item.top - startMin.value) / 60),
    '--height': String((item.bottom - item.top) / 60),
    '--lane': String(item.lane),
    '--lanes': String(item.lanes),
    '--span': String(item.span),
  };
}

function nowStyle(minutes: number): Record<string, string> {
  return { '--top': String((minutes - startMin.value) / 60) };
}

/** The part of a band that is on the page (the early hours may be folded away). */
function bandStyle(band: WeekBand): Record<string, string> | null {
  const top = Math.max(band.startMin, startMin.value);
  if (band.endMin <= top) return null;
  return { '--top': String((top - startMin.value) / 60), '--height': String((band.endMin - top) / 60) };
}

function bandsOf(day: WeekDay): { band: WeekBand; style: Record<string, string> }[] {
  return day.bands.flatMap((band) => {
    const style = bandStyle(band);
    return style === null ? [] : [{ band, style }];
  });
}

/** `쉼 하루 종일`, `쉼 10:00~18:00`. */
function offLabel(band: WeekBand): string {
  if (band.allDay) return t('availability.exceptionAllDay');
  const clock = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return t('format.timeRange', { start: clock(band.startMin), end: clock(band.endMin) });
}

// ── Where the page opens ───────────────────────────────────────────────
/** An hour before now when today is on show, else half an hour before the first item, else 08:00. */
const openAtMin = computed(() => {
  if (props.openAt === 'proposal') {
    const proposals = props.grid.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'proposal').map((item) => item.top),
    );
    if (proposals.length > 0) return Math.min(...proposals) - 60;
  } else if (props.grid.now !== null) {
    return props.grid.now.minutes - 60;
  }
  const tops = props.grid.days.flatMap((day) => day.items.map((item) => item.top));
  return tops.length > 0 ? Math.min(...tops) - 30 : 8 * 60;
});

function scrollToOpening(): void {
  const frame = scroller.value;
  const area = body.value;
  if (frame === null || area === null || hours.value.length === 0) return;
  const hour = area.clientHeight / hours.value.length;
  frame.scrollTop = Math.max(0, ((openAtMin.value - startMin.value) / 60) * hour);
  // A strip of three days opens with today at its start (when today is on show).
  const todayIndex = props.grid.days.findIndex((day) => day.today);
  const first = area.querySelector<HTMLElement>('.wg-day');
  if (first !== null && frame.scrollWidth > frame.clientWidth) {
    frame.scrollLeft = Math.max(0, todayIndex) * first.offsetWidth;
  }
}

onMounted(() => void nextTick(scrollToOpening));
// Reopen when other days are on show, and when they first get their items.
// Moving or resizing a proposal changes none of these, so an edit never moves the page.
watch([() => props.grid.days[0]?.date, () => props.grid.empty, () => props.grid.startHour, () => props.scrollKey], () => {
  void nextTick(scrollToOpening);
});

/** The part of the scrolling content that can be seen (for placing the detail card). */
function visibleRect(): Rect | null {
  const frame = scroller.value;
  if (frame === null) return null;
  return { left: frame.scrollLeft, top: frame.scrollTop, width: frame.clientWidth, height: frame.clientHeight };
}

defineExpose({ content, focusItem, visibleRect });
</script>

<template>
  <div
    class="wg"
    :class="{ 'wg--loading': loading }"
    :style="{ '--wg-hours': hours.length, '--wg-days': grid.days.length }"
    :aria-busy="loading ? 'true' : undefined"
    data-week-grid
  >
    <div ref="scroller" class="wg-scroll">
      <div ref="content" class="wg-content">
        <div class="wg-head">
          <div class="wg-corner">
            <button
              v-if="canToggleEarly"
              type="button"
              class="btn btn--ghost btn--icon btn--sm wg-early"
              :aria-pressed="showEarly ? 'true' : 'false'"
              :aria-label="t('planner.week.early')"
              :title="t('planner.week.early')"
              data-week-early
              @click="emit('toggle-early')"
            >
              <UiIcon name="chevron-down" :size="16" class="wg-early-icon" />
            </button>
          </div>
          <div
            v-for="day in grid.days"
            :key="`head-${day.date}`"
            class="wg-day-head"
            :class="{ 'wg-day-head--today': day.today, 'wg-day-head--past': day.past }"
            :data-date="day.date"
            aria-hidden="true"
          >
            <span class="wg-weekday">{{ formatCivilWeekday(day.date) }}</span>
            <span class="wg-daynum tabular">{{ day.day }}</span>
            <span v-if="day.off" class="wg-day-off" data-day-off>{{ t('calendar.off') }}</span>
            <span v-if="day.labels.length > 0" class="wg-allday" data-week-labels>
              <span v-for="dayLabel in day.labels" :key="dayLabel.key" class="wg-allday-label">{{ dayLabel.title }}</span>
            </span>
          </div>
        </div>

        <div
          ref="body"
          class="wg-body"
          role="group"
          :aria-label="label"
          aria-describedby="week-grid-hint"
          :tabindex="known.size === 0 ? 0 : undefined"
          data-week-body
        >
          <div class="wg-rail" aria-hidden="true">
            <span v-for="hour in hours" :key="hour" class="wg-hour tabular">
              <span class="wg-hour-label">{{ formatHour(hour) }}</span>
            </span>
          </div>
          <div
            v-for="day in grid.days"
            :key="day.date"
            class="wg-day"
            :class="{ 'wg-day--today': day.today, 'wg-day--past': day.past }"
            role="group"
            :aria-label="dayName(day)"
            :data-date="day.date"
          >
            <span
              v-for="(entry, bandIndex) in bandsOf(day)"
              :key="`band-${bandIndex}`"
              class="wg-band"
              :class="`wg-band--${entry.band.kind}`"
              :style="entry.style"
              aria-hidden="true"
              :data-band="entry.band.kind"
            >
              <span v-if="entry.band.kind === 'off'" class="wg-band-label">
                <strong>{{ t('calendar.off') }}</strong> {{ offLabel(entry.band) }}
              </span>
            </span>
            <template v-if="loading">
              <span class="skeleton wg-skeleton wg-skeleton--a" aria-hidden="true"></span>
              <span v-if="day.weekday % 2 === 1" class="skeleton wg-skeleton wg-skeleton--b" aria-hidden="true"></span>
            </template>
            <button
              v-for="item in day.items"
              :key="item.key"
              :ref="(element) => setItem(item.key, element)"
              type="button"
              class="wg-item"
              :class="[
                `wg-item--${item.kind}`,
                {
                  'wg-item--done': item.done,
                  'wg-item--continued': item.continued,
                  'wg-item--continues': item.continues,
                  'wg-item--short': item.bottom - item.top < 45,
                  'wg-item--open': item.key === openKey,
                  'wg-item--invalid': item.invalid,
                  'wg-item--locked': item.block?.locked === true,
                  'wg-item--editable': editable && item.kind === 'proposal',
                },
              ]"
              :style="itemStyle(item)"
              :tabindex="item.key === activeKey ? 0 : -1"
              :aria-label="itemName(item)"
              aria-haspopup="dialog"
              :aria-expanded="item.key === openKey ? 'true' : 'false'"
              :aria-invalid="item.invalid ? 'true' : undefined"
              :aria-describedby="item.kind === 'proposal' ? proposalDescribedBy : undefined"
              :data-item="item.key"
              :data-kind="item.kind"
              :data-source="item.fromGoogle ? 'google' : undefined"
              :data-change="item.change ?? undefined"
              :data-proposal="item.proposalIndex ?? undefined"
              @click="onItemClick($event, item)"
              @keydown="onItemKeydown($event, item)"
              @focus="activeKey = item.key"
              @pointerdown="onItemPointerDown($event, item, 'move')"
            >
              <UiDeadlineFlag v-if="item.kind === 'deadline'" class="wg-item-mark" :size="12" />
              <UiIcon v-else-if="item.done" name="check" :size="12" class="wg-item-mark" />
              <UiIcon v-else-if="item.block?.locked" name="lock" :size="12" class="wg-item-mark wg-item-lock" />
              <UiIcon v-else-if="item.invalid" name="warn" :size="12" class="wg-item-mark" />
              <span class="wg-item-title">{{ itemTitle(item) }}</span>
              <span v-if="item.kind !== 'deadline'" class="wg-item-time tabular">
                {{ itemTime(item).lead }}<span class="wg-item-time-rest">{{ itemTime(item).rest }}</span>
              </span>
              <span
                v-if="editable && item.kind === 'proposal' && !item.continues"
                class="wg-item-resize"
                aria-hidden="true"
                data-resize
                @pointerdown.stop="onItemPointerDown($event, item, 'resize')"
              ></span>
            </button>
            <span
              v-if="grid.now && grid.now.date === day.date"
              class="wg-now"
              :style="nowStyle(grid.now.minutes)"
              aria-hidden="true"
              data-week-now
            ></span>
          </div>
        </div>
        <slot name="card" />
      </div>
    </div>
    <p id="week-grid-hint" class="visually-hidden">
      {{ t('planner.week.hint') }}<template v-if="editable"> {{ t('planner.week.editHint') }}</template>
    </p>
  </div>
</template>
