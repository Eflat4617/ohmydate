<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  initialItemKey,
  isWeekGridKey,
  itemAfterKey,
  type Rect,
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
 * 플래너 주 (HOLO-02): Monday to Sunday over one time axis. Approved blocks
 * are lime, 약속 cyan, a deadline an orange flag at its time; a finished
 * block is quieter and ticked; today's column and the now line are marked.
 * What overlaps sits side by side (domain/weekGrid.ts did the placing).
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
  }>(),
  { loading: false, openKey: null, showEarly: false },
);
const emit = defineEmits<{ open: [item: WeekItem, element: HTMLElement]; 'toggle-early': [] }>();

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
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!isWeekGridKey(event.key)) return;
  event.preventDefault();
  const next = itemAfterKey(props.grid.days, item.key, event.key);
  if (next !== null) focusItem(next);
}

function onItemClick(event: MouseEvent, item: WeekItem): void {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  activeKey.value = item.key;
  emit('open', item, event.currentTarget);
}

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
  if (item.kind === 'block') return item.done ? t('month.detail.kind.blockDone') : t('month.detail.kind.block');
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

// ── Where the page opens ───────────────────────────────────────────────
/** An hour before now when today is on show, else half an hour before the first item, else 08:00. */
const openAtMin = computed(() => {
  if (props.grid.now !== null) return props.grid.now.minutes - 60;
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
watch([() => props.grid.days[0]?.date, () => props.grid.empty, () => props.grid.startHour], () => {
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
                },
              ]"
              :style="itemStyle(item)"
              :tabindex="item.key === activeKey ? 0 : -1"
              :aria-label="itemName(item)"
              aria-haspopup="dialog"
              :aria-expanded="item.key === openKey ? 'true' : 'false'"
              :data-item="item.key"
              :data-kind="item.kind"
              :data-source="item.fromGoogle ? 'google' : undefined"
              @click="onItemClick($event, item)"
              @keydown="onItemKeydown($event, item)"
              @focus="activeKey = item.key"
            >
              <UiDeadlineFlag v-if="item.kind === 'deadline'" class="wg-item-mark" :size="12" />
              <UiIcon v-else-if="item.done" name="check" :size="12" class="wg-item-mark" />
              <span class="wg-item-title">{{ itemTitle(item) }}</span>
              <span v-if="item.kind !== 'deadline'" class="wg-item-time tabular">
                {{ itemTime(item).lead }}<span class="wg-item-time-rest">{{ itemTime(item).rest }}</span>
              </span>
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
    <p id="week-grid-hint" class="visually-hidden">{{ t('planner.week.hint') }}</p>
  </div>
</template>
