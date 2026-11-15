<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useCapture, type CaptureRow } from '../../composables/useCapture';
import { useMediaQuery } from '../../composables/useMediaQuery';
import { weeklyRepeatOf } from '../../domain/commitmentDraft';
import { localDateOf } from '../../domain/time';
import { t, tp } from '../../i18n';
import { browserTimeZone, formatDateTime, formatDateTimeRange } from '../../i18n/format';
import { useAuthStore } from '../../stores/auth';
import { useUiStore } from '../../stores/ui';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiSpinner from '../ui/UiSpinner.vue';
import CaptureSearch from './CaptureSearch.vue';

/**
 * 담기 줄 (HOLO-04, FLOW.md §4): the one thing that is on every screen. A
 * line in plain Korean becomes to-dos and appointments; `n` or `Ctrl+K`
 * focuses it, `/` opens it as the search.
 *
 * - `bar`: in the top bar, with its panel as glass under it. The panel closes
 *   when the focus or a press goes elsewhere; what was typed and read stays.
 * - `sheet`: the same thing inside the phone's bottom sheet (AppShell).
 *
 * Enter is the flow: it takes the line, then adds the drafts, then — with
 * the line empty — takes the next step (계획에 넣기). The ending is never
 * "closed": it is the next stage of the loop.
 */
const props = withDefaults(defineProps<{ variant?: 'bar' | 'sheet' }>(), { variant: 'bar' });
const emit = defineEmits<{ close: [] }>();

const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());

const capture = useCapture({ timeZone });
const {
  note,
  reading,
  adding,
  elapsedSeconds,
  failure,
  failureText,
  status,
  leftover,
  noteField,
  canAct,
  readyRows,
  pending,
  done,
  next,
  added,
  notice,
  remove,
  cancel,
} = capture;

const inputId = `capture-${useId()}`;
const panelId = `${inputId}-panel`;
const root = ref<HTMLElement | null>(null);
const mode = computed(() => ui.captureMode);
const query = ref('');
const open = ref(props.variant === 'sheet');

const text = computed({
  get: () => (mode.value === 'search' ? query.value : note.value),
  set: (value: string) => {
    if (mode.value === 'search') query.value = value;
    else note.value = value;
  },
});

const idle = computed(() => !reading.value && !done.value && pending.value.length === 0);
/** The panel's one filled button, as a word: what Enter does now. */
const primaryLabel = computed(() => {
  if (readyRows.value.length > 1) return tp('capture.addMany', readyRows.value.length);
  return t('capture.add');
});
const doneTitle = computed(() => {
  const first = added.value[0];
  if (added.value.length === 1 && first !== undefined) return t('capture.done.one', { title: first.title });
  return tp('capture.done.many', added.value.length);
});
const noticeText = computed(() => (notice.value === null ? '' : t(`capture.notice.${notice.value}`)));

function focusInput(): void {
  void nextTick(() => noteField.value?.focus());
}

function show(): void {
  open.value = true;
}

/** Put the panel away. A finished round is over; an unfinished one waits for the owner to come back. */
function hide(): void {
  if (props.variant === 'sheet') {
    if (done.value) capture.reset();
    emit('close');
    return;
  }
  open.value = false;
  if (done.value) capture.reset();
}

function setMode(nextMode: 'capture' | 'search'): void {
  ui.setCaptureMode(nextMode);
  focusInput();
}

// `n`, `Ctrl+K` and `/` (AppShell) ask for the bar by bumping a counter. The
// bar in the top bar answers from 1024px, where it is on screen; below that
// the shell opens the sheet, and the bar inside it answers.
const wide = useMediaQuery('(min-width: 1024px)');
watch(
  () => ui.captureRequest,
  () => {
    if (props.variant === 'bar' && !wide.value) return;
    show();
    focusInput();
  },
);

function whenText(row: CaptureRow): string {
  if (row.kind === 'task') {
    return row.at === null ? t('capture.row.noDue') : t('capture.row.due', { when: formatDateTime(row.at, row.timeZone) });
  }
  if (row.at === null || row.endAt === null) return t('capture.row.needsTime');
  return formatDateTimeRange(row.at, row.endAt, row.timeZone);
}

function repeatText(row: CaptureRow): string | null {
  if (row.kind !== 'commitment') return null;
  const weekly = weeklyRepeatOf(row.rrule);
  if (weekly === null) return row.rrule === undefined ? null : t('commitments.repeats');
  return t('commitments.parse.repeatWeekly', { days: weekly.days.map((day) => t(`commitments.day.${day}`)).join('·') });
}

function goNext(): void {
  const step = next.value;
  if (step === null) return;
  const target =
    step.to === 'plan'
      ? { path: '/plan/schedule', query: { taskIds: step.taskIds.join(',') } }
      : { path: '/planner', query: step.at === null ? {} : { view: 'day', d: localDateOf(step.at, timeZone.value) } };
  capture.reset();
  if (props.variant === 'sheet') emit('close');
  else open.value = false;
  void router.push(target);
}

function onSubmit(): void {
  if (mode.value === 'search') {
    // Enter opens the first result.
    root.value?.querySelector<HTMLElement>('.capture-result')?.click();
    return;
  }
  // With nothing typed after a finished round, Enter is the next step.
  if (note.value.trim().length === 0 && done.value && next.value !== null) {
    goNext();
    return;
  }
  void capture.submit();
}

function again(): void {
  capture.reset();
  focusInput();
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return; // a Hangul syllable is still being composed
  if (event.key === '/' && mode.value === 'capture' && note.value.length === 0) {
    event.preventDefault();
    ui.setCaptureMode('search');
    return;
  }
  if (event.key === 'Backspace' && mode.value === 'search' && query.value.length === 0) {
    event.preventDefault();
    ui.setCaptureMode('capture');
    return;
  }
  if (event.key === 'ArrowDown') {
    const first = root.value?.querySelector<HTMLElement>('.capture-result, .capture-row-title');
    if (first !== null && first !== undefined) {
      event.preventDefault();
      first.focus();
    }
  }
}

/** Up and down walk the results; up from the first goes back to the line. */
function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = Array.from(root.value?.querySelectorAll<HTMLElement>('.capture-result') ?? []);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index === -1) return;
  event.preventDefault();
  const target = event.key === 'ArrowDown' ? items[index + 1] : index === 0 ? noteField.value : items[index - 1];
  target?.focus();
}

function onEscape(event: KeyboardEvent): void {
  if (reading.value) {
    event.stopPropagation();
    cancel();
    return;
  }
  if (props.variant === 'sheet' || !open.value) return; // the sheet's own dialog closes it
  event.stopPropagation();
  hide();
  noteField.value?.blur();
}

function onFocusOut(event: FocusEvent): void {
  if (props.variant === 'sheet') return;
  const nextTarget = event.relatedTarget;
  // Focus that goes nowhere (a press on the page) is the pointer handler's.
  if (!(nextTarget instanceof Node) || root.value?.contains(nextTarget) === true) return;
  hide();
}

function onOutsidePointer(event: PointerEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) hide();
}

watch(
  open,
  (value) => {
    if (typeof document === 'undefined' || props.variant === 'sheet') return;
    if (value) document.addEventListener('pointerdown', onOutsidePointer);
    else document.removeEventListener('pointerdown', onOutsidePointer);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onOutsidePointer);
});

function fromSearch(words: string): void {
  ui.setCaptureMode('capture');
  note.value = words;
  query.value = '';
  focusInput();
}

function onSearchGo(): void {
  query.value = '';
  ui.setCaptureMode('capture');
  hide();
}

defineExpose({ focus: focusInput });
</script>

<template>
  <div
    ref="root"
    class="capture"
    :class="[`capture--${variant}`, { 'capture--open': open }]"
    data-capture
    :data-capture-mode="mode"
    @focusout="onFocusOut"
    @keydown.esc="onEscape"
  >
    <form class="capture-field" :class="{ 'capture-field--busy': reading }" data-capture-form @submit.prevent="onSubmit">
      <UiIcon :name="mode === 'search' ? 'search' : 'plus'" :size="18" class="capture-icon" />
      <label class="visually-hidden" :for="inputId">{{ mode === 'search' ? t('capture.searchLabel') : t('capture.label') }}</label>
      <input
        :id="inputId"
        ref="noteField"
        v-model="text"
        class="capture-input"
        type="text"
        maxlength="2000"
        autocomplete="off"
        enterkeyhint="done"
        :placeholder="mode === 'search' ? t('capture.searchPlaceholder') : t('capture.placeholder')"
        :aria-controls="open ? panelId : undefined"
        :data-autofocus="variant === 'sheet' ? '' : undefined"
        data-capture-input
        @focus="show"
        @keydown="onInputKeydown"
      />
      <kbd v-if="variant === 'bar' && !open" class="capture-key" aria-hidden="true">n</kbd>
    </form>

    <div
      v-if="open"
      :id="panelId"
      class="capture-panel"
      :class="{ glass: variant === 'bar' }"
      role="group"
      :aria-label="mode === 'search' ? t('capture.searchLabel') : t('capture.panel')"
      data-capture-panel
      @keydown="onPanelKeydown"
    >
      <div class="capture-panel-head">
        <div class="segmented glass glass--still glass--flat capture-modes" role="group" :aria-label="t('capture.modes')">
          <button
            type="button"
            class="btn segmented-item"
            :aria-pressed="mode === 'capture' ? 'true' : 'false'"
            data-capture-mode-button="capture"
            @click="setMode('capture')"
          >
            <UiIcon name="plus" :size="16" />{{ t('capture.mode.capture') }}
          </button>
          <button
            type="button"
            class="btn segmented-item"
            :aria-pressed="mode === 'search' ? 'true' : 'false'"
            data-capture-mode-button="search"
            @click="setMode('search')"
          >
            <UiIcon name="search" :size="16" />{{ t('capture.mode.search') }} <kbd>/</kbd>
          </button>
        </div>
      </div>

      <CaptureSearch v-if="mode === 'search'" :query="query" @go="onSearchGo" @capture="fromSearch" />

      <div v-else class="capture-body">
        <p class="visually-hidden" role="status" aria-live="polite" data-capture-status>{{ status }}</p>

        <p v-if="!canAct" class="capture-hint" role="status" data-capture-offline>{{ t('capture.offline') }}</p>

        <p v-if="reading" class="capture-wait" data-capture-wait>
          <UiSpinner />
          <span>{{ t('capture.reading', { seconds: elapsedSeconds }) }}</span>
          <UiButton size="sm" variant="ghost" data-capture-cancel @click="cancel">{{ t('common.cancel') }}</UiButton>
        </p>

        <p v-if="failure === 'empty'" class="capture-hint" role="alert">{{ failureText }}</p>

        <!-- The drafts: each says what it is, and can become the other kind. -->
        <template v-if="pending.length > 0">
          <p v-if="notice === 'unread'" class="capture-notice" data-capture-notice>{{ noticeText }}</p>
          <ul class="capture-rows" :aria-label="t('capture.rows')">
            <li v-for="row in pending" :key="row.key" class="capture-row" :data-capture-row="row.kind">
              <UiBadge :class="row.kind === 'commitment' ? 'badge--cyan' : 'badge--lime'" data-capture-kind>
                {{ t(`capture.kind.${row.kind}`) }}
              </UiBadge>
              <input
                v-model="row.title"
                class="capture-row-title"
                type="text"
                maxlength="200"
                :aria-label="t('capture.row.title')"
                :aria-invalid="row.title.trim().length === 0 ? 'true' : undefined"
                :disabled="row.state !== 'idle'"
                @keydown.enter.prevent="onSubmit"
              />
              <p class="capture-row-when tabular" data-capture-when>
                {{ whenText(row) }}
                <span v-if="repeatText(row)" class="capture-row-repeat">· {{ repeatText(row) }}</span>
              </p>
              <input
                v-if="row.kind === 'commitment' && row.startLocal !== ''"
                class="capture-row-start"
                type="datetime-local"
                :value="row.startLocal"
                :aria-label="t('capture.row.start', { title: row.title })"
                :disabled="row.state !== 'idle'"
                data-capture-start
                @input="capture.setStart(row, ($event.target as HTMLInputElement).value)"
              />
              <div class="capture-row-actions">
                <UiButton size="sm" variant="ghost" :disabled="row.state !== 'idle'" data-capture-flip @click="capture.flip(row)">
                  {{ row.kind === 'task' ? t('capture.row.toCommitment') : t('capture.row.toTask') }}
                </UiButton>
                <UiButton
                  size="sm"
                  variant="ghost"
                  icon="close"
                  icon-only
                  :aria-label="t('capture.row.remove', { title: row.title })"
                  :disabled="row.state !== 'idle'"
                  data-capture-remove
                  @click="remove(row)"
                />
              </div>
              <p v-if="row.error" class="field-error capture-row-error" role="alert">{{ row.error }}</p>
            </li>
          </ul>
          <p v-if="leftover.length > 0" class="capture-hint" data-capture-leftover>{{ t('capture.leftover', { text: leftover }) }}</p>
        </template>

        <!-- The ending is the next step of the loop (FLOW §5). -->
        <div v-if="done" class="capture-done" role="status" data-capture-done>
          <p class="capture-done-title">
            <UiIcon name="check-circle" :size="18" class="capture-done-icon" />
            <span>{{ doneTitle }}</span>
          </p>
          <p v-if="noticeText" class="capture-notice" data-capture-notice>{{ noticeText }}</p>
          <p v-if="next?.to === 'plan'" class="capture-done-ask">{{ t('capture.done.ask') }}</p>
        </div>

        <p v-if="idle" class="capture-hint" data-capture-hint>{{ t('capture.hint') }}</p>

        <div class="capture-actions">
          <template v-if="done">
            <UiButton v-if="next?.to === 'plan'" variant="primary" icon="plan" data-capture-next="plan" @click="goNext">
              {{ t('capture.done.toPlan') }}
            </UiButton>
            <UiButton v-else-if="next?.to === 'planner'" variant="primary" icon="month" data-capture-next="planner" @click="goNext">
              {{ t('capture.done.toPlanner') }}
            </UiButton>
            <button type="button" class="capture-link" data-capture-again @click="again">{{ t('capture.done.again') }}</button>
          </template>
          <template v-else>
            <UiButton
              variant="primary"
              :disabled="!canAct || reading || adding || (pending.length === 0 ? note.trim().length === 0 : readyRows.length === 0)"
              :busy="adding"
              data-capture-submit
              @click="onSubmit"
            >
              {{ primaryLabel }}
            </UiButton>
            <button
              v-if="pending.length === 0 && note.trim().length > 0 && !reading"
              type="button"
              class="capture-link"
              :disabled="!canAct || adding"
              data-capture-as-title
              @click="capture.addAsTitle()"
            >
              {{ t('capture.asTitle') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
