<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { QueryKey } from '@tanstack/vue-query';
import { plannerClient, type CommitmentCreate, type CommitmentDraft, type CommitmentDraftNote } from '../api';
import { useNlDraftRead, type NlDraftRow } from '../composables/useNlDraftRead';
import {
  draftCreateInput,
  draftFormValues,
  draftHasTime,
  draftInstants,
  draftMeridiemGuessed,
  switchDraftMeridiem,
  weeklyRepeatOf,
  type DraftFormValues,
} from '../domain/commitmentDraft';
import { t, tp } from '../i18n';
import { formatCivilDate, formatDateTimeRange } from '../i18n/format';
import { useAuthStore } from '../stores/auth';
import LlmDisclosure from './LlmDisclosure.vue';
import UiBadge from './ui/UiBadge.vue';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiField from './ui/UiField.vue';

/**
 * CAL-02 "말로 적기": the person writes what they have on in their own words,
 * the AI reads it into commitment drafts (POST /commitments:parse, nothing
 * saved), and each draft is added with the ordinary create call.
 *
 * - The read / cancel / consent / owner-reset / add flow is the shared
 *   useNlDraftRead (CAL-05 shares it with the inbox's task drafts).
 * - Consent: the same dialog as the wizard (`askBeforeAi`); with AI off or
 *   unavailable the note stays in the field and the manual form ("직접 입력")
 *   next to it is the way on. No dead end.
 * - One filled button: 읽기, or the add action once drafts are ready — unless
 *   the manual form is in use (`manualActive`), which then owns it.
 * - CAL-05 addendum: a start read as AM from a bare "7시" says so and offers
 *   one small switch to the PM reading (and back).
 * - Owner isolation (ADR-023): every request runs in an owner-bound task.
 */
const props = withDefaults(
  defineProps<{
    manualActive: boolean;
    /** HOLO-02: more query keys to refresh after a draft was added (the planner's lists). Read once, at setup. */
    alsoRefresh?: readonly QueryKey[];
    /** HOLO-02: the heading's level where the section is not a page's own `h2` (inside a dialog). */
    headingLevel?: 2 | 3;
  }>(),
  { alsoRefresh: () => [], headingLevel: 2 },
);
const emit = defineEmits<{ edit: [values: DraftFormValues] }>();

interface DraftRow extends NlDraftRow<CommitmentDraft> {
  /** The draft as read; `draft` is it moved to the PM reading while `switched`. */
  readonly base: CommitmentDraft;
  switched: boolean;
  start: string;
  end: string;
}

const auth = useAuthStore();

function rowInput(row: DraftRow): CommitmentCreate | null {
  return draftCreateInput(row.draft, { start: row.start, end: row.end });
}

const {
  note,
  reading,
  adding,
  elapsedSeconds,
  failure,
  failureText,
  status,
  rows,
  leftover,
  readEmpty,
  resultHeading,
  noteField,
  canAct,
  readyRows,
  showResult,
  isReady,
  read,
  cancel,
  onNoteKeydown,
  addRows,
  addAll,
  dropRow,
  remove,
} = useNlDraftRead<CommitmentDraft, DraftRow, CommitmentCreate>({
  parseScope: 'commitment:parse',
  draftScope: 'commitment:draft',
  parse: (text, key, signal) => plannerClient.parseCommitments(text, key, { signal }),
  toRow: (draft, key) => ({ key, draft, base: draft, switched: false, state: 'idle', start: '', end: '', error: null }),
  createInput: rowInput,
  create: (input, key) => plannerClient.createCommitment(input, key),
  rowTitle: (row) => row.draft.title,
  inputTitle: (input) => input.title,
  refresh: [['commitments'], ['availability'], ...props.alsoRefresh],
  messages: {
    empty: () => t('commitments.parse.empty'),
    consentOff: () => t('commitments.parse.consentOff'),
    resultNone: () => t('commitments.parse.resultNone'),
    resultCount: (count) => tp('commitments.parse.resultCount', count),
    cancelled: () => t('commitments.parse.cancelled'),
    budget: () => t('commitments.parse.budget'),
    unavailable: () => t('commitments.parse.unavailable'),
    readError: () => t('commitments.parse.readError'),
    addedOne: (title) => t('commitments.parse.addedOne', { title }),
    addedMany: (count) => tp('commitments.parse.addedMany', count),
    addError: (title) => t('commitments.parse.addError', { title }),
    removed: (title) => t('commitments.parse.removed', { title }),
  },
});

const showDisclosure = computed(() => auth.user?.llmProvider === 'deepseek');

/** Which control of this section is the screen's one filled button. */
const primary = computed<'read' | 'addOne' | 'addAll' | null>(() => {
  if (props.manualActive) return null;
  if (readyRows.value.length >= 2) return 'addAll';
  if (readyRows.value.length === 1) return 'addOne';
  return 'read';
});

const elapsedText = computed(() => t('commitments.parse.waitElapsed', { seconds: elapsedSeconds.value }));

function whenText(row: DraftRow): string {
  const instants = draftInstants(row.draft, { start: row.start, end: row.end });
  if (instants !== null) return formatDateTimeRange(instants.startAt, instants.endAt, row.draft.timeZone);
  return formatCivilDate(row.draft.date);
}

function repeatText(draft: CommitmentDraft): string | null {
  const repeat = weeklyRepeatOf(draft.rrule);
  if (repeat === null) return null;
  const days = repeat.days.map((day) => t(`commitments.day.${day}`)).join('·');
  return repeat.until === null
    ? t('commitments.parse.repeatWeekly', { days })
    : t('commitments.parse.repeatUntil', { days, date: formatCivilDate(repeat.until, { weekday: false }) });
}

/**
 * Plain-Korean notes; the weekly repeat is already said by the repeat words
 * and the guessed half-day has its own line with the switch.
 */
function noteTexts(row: DraftRow): string[] {
  const notes = row.draft.notes
    .filter(
      (code): code is Exclude<CommitmentDraftNote, 'repeats_weekly' | 'meridiem_assumed'> =>
        code !== 'repeats_weekly' && code !== 'meridiem_assumed',
    )
    .map((code) => t(`commitments.parse.note.${code}`));
  if (!draftHasTime(row.draft) && draftInstants(row.draft, { start: row.start, end: row.end })?.endDefaulted === true) {
    notes.unshift(t('commitments.parse.note.duration_defaulted'));
  }
  return notes;
}

function meridiemText(row: DraftRow): string {
  return row.switched ? t('nlRead.meridiem.switchedPm') : t('nlRead.meridiem.assumedAm');
}

/** 오후로 바꾸기 / 오전으로 바꾸기: the start (and end) move 12 hours in the draft's zone. */
function switchMeridiem(row: DraftRow): void {
  if (row.state !== 'idle') return;
  row.switched = !row.switched;
  row.draft = row.switched ? switchDraftMeridiem(row.base, 1) : row.base;
  status.value = t(row.switched ? 'nlRead.meridiem.statusPm' : 'nlRead.meridiem.statusAm', {
    title: row.draft.title,
    when: whenText(row),
  });
}

function timeError(row: DraftRow): string | null {
  if (draftHasTime(row.draft) || row.start.length === 0 || row.end.length === 0) return null;
  return draftInstants(row.draft, { start: row.start, end: row.end }) === null
    ? t('commitments.parse.endBeforeStart')
    : null;
}

function rowId(row: DraftRow, part: string): string {
  return `nl-draft-${row.key}-${part}`;
}

function edit(row: DraftRow): void {
  emit('edit', draftFormValues(row.draft, { start: row.start, end: row.end }));
  dropRow(row);
  status.value = t('commitments.parse.movedToForm', { title: row.draft.title });
}
</script>

<template>
  <section class="nl-entry" aria-labelledby="nl-entry-heading" data-testid="nl-entry">
    <component :is="`h${headingLevel}`" id="nl-entry-heading" class="settings-group-title nl-entry-heading">
      {{ t('commitments.parse.heading') }}
    </component>
    <p class="nl-entry-lede">{{ t('commitments.parse.lede') }}</p>

    <form class="nl-entry-form" @submit.prevent="read">
      <UiField id="commitment-note" :label="t('commitments.parse.label')" :help="t('commitments.parse.help')">
        <template #default="{ describedby }">
          <textarea
            id="commitment-note"
            ref="noteField"
            v-model="note"
            class="nl-entry-note"
            rows="3"
            maxlength="500"
            :placeholder="t('commitments.parse.placeholder')"
            :aria-describedby="describedby"
            :readonly="reading"
            :disabled="!canAct"
            @keydown="onNoteKeydown"
          ></textarea>
        </template>
      </UiField>
      <div class="nl-entry-actions">
        <UiButton
          type="submit"
          :variant="primary === 'read' ? 'primary' : 'secondary'"
          :busy="reading"
          :disabled="!canAct || reading || note.trim().length === 0"
        >
          {{ t('commitments.parse.read') }}
        </UiButton>
        <p class="nl-entry-send muted">{{ t('commitments.parse.sendNote') }}</p>
      </div>
      <details v-if="showDisclosure" class="nl-entry-disclosure">
        <summary>{{ t('commitments.parse.disclosure') }}</summary>
        <LlmDisclosure />
      </details>
    </form>

    <div v-if="reading" class="nl-wait" aria-busy="true" data-testid="nl-wait">
      <div class="ai-wait-track" aria-hidden="true"><span class="ai-wait-track-fill"></span></div>
      <p class="nl-wait-text">
        <span>{{ t('commitments.parse.waitTitle') }}</span>
        <span v-if="elapsedSeconds > 0" class="nl-wait-elapsed" role="timer" :aria-label="elapsedText">{{
          elapsedText
        }}</span>
        <span class="muted">{{ t('commitments.parse.waitHint') }}</span>
      </p>
      <UiButton size="sm" @click="cancel">{{ t('commitments.parse.cancel') }}</UiButton>
    </div>

    <p class="status-region status-note" role="status" aria-live="polite">{{ status }}</p>

    <UiBanner
      v-if="failure !== null"
      :tone="failure === 'error' || failure === 'empty' ? 'error' : 'warn'"
      inline
      role="alert"
      class="nl-failure"
    >
      {{ failureText }}
      <RouterLink v-if="failure === 'consent'" to="/settings/ai" class="nl-failure-link">
        {{ t('commitments.parse.consentLink') }}
      </RouterLink>
    </UiBanner>

    <section v-if="showResult" class="nl-result" aria-labelledby="nl-result-heading" data-testid="nl-result">
      <component
        :is="`h${headingLevel + 1}`"
        id="nl-result-heading"
        ref="resultHeading"
        class="nl-result-heading"
        tabindex="-1"
      >
        {{ t('commitments.parse.resultHeading') }}
      </component>
      <p v-if="readEmpty" class="muted">{{ t('commitments.parse.resultNone') }}</p>
      <ul v-if="rows.length > 0" class="nl-draft-list">
        <li
          v-for="row in rows"
          :key="row.key"
          class="nl-draft"
          :class="{ 'nl-draft--added': row.state === 'added' }"
          data-testid="nl-draft"
        >
          <div class="nl-draft-main">
            <div class="nl-draft-title-row">
              <strong class="nl-draft-title">{{ row.draft.title }}</strong>
              <UiBadge v-if="row.state === 'added'" tone="success">{{ t('commitments.parse.added') }}</UiBadge>
              <UiBadge v-else-if="!draftHasTime(row.draft) && rowInput(row) === null" tone="warn">
                {{ t('commitments.parse.needsTimeBadge') }}
              </UiBadge>
            </div>
            <span class="nl-draft-when tabular">{{ whenText(row) }}</span>
            <span v-if="repeatText(row.draft)" class="nl-draft-repeat">{{ repeatText(row.draft) }}</span>
            <ul v-if="noteTexts(row).length > 0 || draftMeridiemGuessed(row.base)" class="nl-draft-notes">
              <li v-for="text in noteTexts(row)" :key="text">{{ text }}</li>
              <li v-if="draftMeridiemGuessed(row.base)" class="nl-draft-meridiem" data-testid="nl-meridiem">
                <span>{{ meridiemText(row) }}</span>
                <UiButton
                  v-if="row.state !== 'added'"
                  size="sm"
                  variant="ghost"
                  class="nl-draft-meridiem-switch"
                  :disabled="row.state !== 'idle'"
                  @click="switchMeridiem(row)"
                >
                  <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: row.draft.title }) }}</span
                  >{{ row.switched ? t('nlRead.meridiem.toAm') : t('nlRead.meridiem.toPm') }}
                </UiButton>
              </li>
            </ul>
            <fieldset v-if="!draftHasTime(row.draft) && row.state !== 'added'" class="nl-draft-times">
              <legend class="nl-draft-times-legend">{{ t('commitments.parse.needsTime') }}</legend>
              <div class="nl-draft-time-fields">
                <UiField :id="rowId(row, 'start')" :label="t('commitments.parse.startTime')">
                  <input :id="rowId(row, 'start')" v-model="row.start" type="time" :disabled="!canAct || row.state !== 'idle'" />
                </UiField>
                <UiField :id="rowId(row, 'end')" :label="t('commitments.parse.endTime')" :error="timeError(row)">
                  <template #default="{ describedby }">
                    <input
                      :id="rowId(row, 'end')"
                      v-model="row.end"
                      type="time"
                      :aria-describedby="describedby"
                      :disabled="!canAct || row.state !== 'idle'"
                    />
                  </template>
                </UiField>
              </div>
            </fieldset>
            <p v-if="row.error" class="error-text nl-draft-error" role="alert">{{ row.error }}</p>
          </div>
          <div v-if="row.state !== 'added'" class="nl-draft-actions" role="group" :aria-label="t('commitments.parse.rowActions', { title: row.draft.title })">
            <UiButton
              size="sm"
              :variant="primary === 'addOne' && isReady(row) ? 'primary' : 'secondary'"
              :busy="row.state === 'adding'"
              :disabled="!canAct || adding || !isReady(row)"
              @click="addRows([row])"
            >
              <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: row.draft.title }) }}</span
              >{{ t('commitments.parse.add') }}
            </UiButton>
            <UiButton size="sm" variant="ghost" :disabled="row.state !== 'idle'" @click="edit(row)">
              <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: row.draft.title }) }}</span
              >{{ t('commitments.parse.edit') }}
            </UiButton>
            <UiButton size="sm" variant="ghost" :disabled="row.state !== 'idle'" @click="remove(row)">
              <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: row.draft.title }) }}</span
              >{{ t('commitments.parse.remove') }}
            </UiButton>
          </div>
        </li>
      </ul>
      <p v-if="leftover.length > 0" class="nl-leftover">{{ t('commitments.parse.leftover', { text: leftover }) }}</p>
      <div v-if="readyRows.length >= 2" class="nl-add-all">
        <UiButton
          :variant="primary === 'addAll' ? 'primary' : 'secondary'"
          :busy="adding"
          :disabled="!canAct || adding"
          data-testid="nl-add-all"
          @click="addAll"
        >
          {{ tp('commitments.parse.addAll', readyRows.length) }}
        </UiButton>
      </div>
    </section>
  </section>
</template>
