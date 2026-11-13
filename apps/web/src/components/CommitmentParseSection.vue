<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ActionStore, ApiError, plannerClient, type CommitmentCreate, type CommitmentDraft } from '../api';
import {
  draftCreateInput,
  draftFormValues,
  draftHasTime,
  draftInstants,
  weeklyRepeatOf,
  type DraftFormValues,
} from '../domain/commitmentDraft';
import { t, tp } from '../i18n';
import { formatCivilDate, formatDateTimeRange } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { captureOwnerBinding, isOwnerBindingCurrent, ownerState, type OwnerBinding } from '../session/ownerEpoch';
import { runOwnerBound } from '../session/ownerBound';
import { useAuthStore } from '../stores/auth';
import { useLlmConsentStore } from '../stores/llmConsent';
import { useOfflineStore } from '../stores/offline';
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
 * - Consent: the same dialog as the wizard (`askBeforeAi`); with AI off or
 *   unavailable the note stays in the field and the manual form ("직접 입력")
 *   next to it is the way on. No dead end.
 * - One filled button: 읽기, or the add action once drafts are ready — unless
 *   the manual form is in use (`manualActive`), which then owns it.
 * - Owner isolation (ADR-023): every request runs in an owner-bound task.
 */
const props = defineProps<{ manualActive: boolean }>();
const emit = defineEmits<{ edit: [values: DraftFormValues] }>();

type RowState = 'idle' | 'adding' | 'added';

interface DraftRow {
  readonly key: string;
  readonly draft: CommitmentDraft;
  state: RowState;
  start: string;
  end: string;
  error: string | null;
}

type Failure = 'empty' | 'consent' | 'unavailable' | 'budget' | 'error';

const PARSE_SCOPE = 'commitment:parse';

const auth = useAuthStore();
const llmConsent = useLlmConsentStore();
const offline = useOfflineStore();
const queryClient = useQueryClient();
const actions = new ActionStore();

const note = ref('');
const reading = ref(false);
const adding = ref(false);
const elapsedSeconds = ref(0);
const failure = ref<Failure | null>(null);
const failureText = ref('');
const status = ref('');
const rows = ref<DraftRow[]>([]);
const leftover = ref('');
const hasResult = ref(false);
/** The last read found no event at all (as opposed to rows the person added, edited or removed). */
const readEmpty = ref(false);
const resultHeading = ref<HTMLElement | null>(null);
const noteField = ref<HTMLTextAreaElement | null>(null);

let readCount = 0;
/** The owner the shown drafts were read for: adding them runs under this binding only. */
let rowsBinding: OwnerBinding | null = null;
let controller: AbortController | null = null;
let cancelRequested = false;
let ticker: ReturnType<typeof setInterval> | undefined;

const showDisclosure = computed(() => auth.user?.llmProvider === 'deepseek');
const canAct = computed(() => offline.mutationsEnabled);

function rowInput(row: DraftRow): CommitmentCreate | null {
  return draftCreateInput(row.draft, { start: row.start, end: row.end });
}

function isReady(row: DraftRow): boolean {
  return row.state === 'idle' && rowInput(row) !== null;
}

const readyRows = computed(() => rows.value.filter((row) => isReady(row)));
const showResult = computed(
  () => hasResult.value && (rows.value.length > 0 || leftover.value.length > 0 || readEmpty.value),
);

/** Which control of this section is the screen's one filled button. */
const primary = computed<'read' | 'addOne' | 'addAll' | null>(() => {
  if (props.manualActive) return null;
  if (readyRows.value.length >= 2) return 'addAll';
  if (readyRows.value.length === 1) return 'addOne';
  return 'read';
});

const elapsedText = computed(() => t('commitments.parse.waitElapsed', { seconds: elapsedSeconds.value }));

function stopTicker(): void {
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
}

onUnmounted(() => {
  stopTicker();
  controller?.abort();
});

// ADR-023: another owner signed in — nothing of this note or its drafts survives.
watch(
  () => [ownerState.ownerId.value, ownerState.epoch.value],
  () => {
    controller?.abort();
    controller = null;
    stopTicker();
    rowsBinding = null;
    note.value = '';
    rows.value = [];
    leftover.value = '';
    hasResult.value = false;
    readEmpty.value = false;
    failure.value = null;
    status.value = '';
    reading.value = false;
    adding.value = false;
  },
);

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

/** Plain-Korean notes; the weekly repeat is already said by the repeat words. */
function noteTexts(row: DraftRow): string[] {
  const notes = row.draft.notes.filter((code) => code !== 'repeats_weekly').map((code) => t(`commitments.parse.note.${code}`));
  if (!draftHasTime(row.draft) && draftInstants(row.draft, { start: row.start, end: row.end })?.endDefaulted === true) {
    notes.unshift(t('commitments.parse.note.duration_defaulted'));
  }
  return notes;
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

function onNoteKeydown(event: KeyboardEvent): void {
  // Enter reads; Shift+Enter is a line break; Enter that ends a Hangul IME composition is not a submit.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void read();
}

function failWith(kind: Failure, text: string): void {
  failure.value = kind;
  failureText.value = text;
}

async function read(): Promise<void> {
  if (reading.value || !canAct.value) return;
  const text = note.value.trim();
  if (text.length === 0) {
    failWith('empty', t('commitments.parse.empty'));
    return;
  }
  failure.value = null;
  // The wizard's consent rule (FU-91): an undecided owner is asked first.
  const asked = captureOwnerBinding();
  await llmConsent.askBeforeAi();
  if (!isOwnerBindingCurrent(asked)) return;
  if (llmConsent.needed) {
    failWith('consent', t('commitments.parse.consentOff'));
    return;
  }

  const action = actions.begin(PARSE_SCOPE, text, (left, right) => left === right);
  const request = new AbortController();
  controller = request;
  cancelRequested = false;
  reading.value = true;
  status.value = '';
  elapsedSeconds.value = 0;
  stopTicker();
  ticker = setInterval(() => {
    elapsedSeconds.value += 1;
  }, 1_000);

  await runOwnerBound(
    function* (owner) {
      try {
        const result = yield* owner.wait(plannerClient.parseCommitments(text, action.key, { signal: request.signal }));
        actions.settle(PARSE_SCOPE, action);
        readCount += 1;
        rowsBinding = owner.binding;
        rows.value = result.drafts.map((draft, index) => ({
          key: `${readCount}-${index}`,
          draft,
          state: 'idle' as RowState,
          start: '',
          end: '',
          error: null,
        }));
        leftover.value = result.leftover;
        readEmpty.value = result.drafts.length === 0;
        hasResult.value = true;
        status.value =
          result.drafts.length === 0
            ? t('commitments.parse.resultNone')
            : tp('commitments.parse.resultCount', result.drafts.length);
        yield nextTick();
        resultHeading.value?.focus();
      } catch (cause) {
        if (cancelRequested) {
          // The request is gone and the server cancels the read; a new read gets a new key.
          actions.settle(PARSE_SCOPE, action);
          status.value = t('commitments.parse.cancelled');
          return;
        }
        // The server answered: nothing is pending under this key. Otherwise keep the
        // key, so a retry after a network drop replays the stored answer.
        if (cause instanceof ApiError) actions.settle(PARSE_SCOPE, action);
        if (cause instanceof ApiError && cause.code === 'budget_exceeded') {
          failWith('budget', t('commitments.parse.budget'));
        } else if (cause instanceof ApiError && cause.code === 'llm_unavailable') {
          failWith('unavailable', t('commitments.parse.unavailable'));
        } else {
          failWith('error', t('commitments.parse.readError'));
        }
      }
    },
    {
      onSettled: () => {
        reading.value = false;
        controller = null;
        stopTicker();
      },
    },
  );
}

function cancel(): void {
  if (!reading.value || controller === null) return;
  cancelRequested = true;
  controller.abort();
  void nextTick(() => noteField.value?.focus());
}

function everyRowResolved(): boolean {
  return rows.value.length > 0 && rows.value.every((row) => row.state === 'added');
}

async function addRows(targets: readonly DraftRow[]): Promise<void> {
  if (!canAct.value || adding.value) return;
  // Drafts belong to the owner who read them; after an owner change nothing is sent.
  const binding = rowsBinding;
  if (binding === null || !isOwnerBindingCurrent(binding)) return;
  const work = targets
    .map((row) => ({ row, input: rowInput(row) }))
    .filter((entry): entry is { row: DraftRow; input: CommitmentCreate } => entry.row.state === 'idle' && entry.input !== null);
  if (work.length === 0) return;
  adding.value = true;
  for (const { row } of work) {
    row.state = 'adding';
    row.error = null;
  }
  await runOwnerBound(
    function* (owner) {
      let added = 0;
      let lastTitle = '';
      for (const { row, input } of work) {
        // One key per draft: a retry of the same draft never creates it twice.
        const scope = `commitment:draft:${row.key}`;
        const action = actions.begin(scope, input, (left, right) => JSON.stringify(left) === JSON.stringify(right));
        try {
          yield* owner.wait(plannerClient.createCommitment(input, action.key));
          actions.settle(scope, action);
          row.state = 'added';
          added += 1;
          lastTitle = input.title;
        } catch (cause) {
          row.state = 'idle';
          row.error = errorMessage(cause, t('commitments.parse.addError', { title: input.title }));
        }
      }
      if (added === 0) return;
      status.value =
        added === 1 ? t('commitments.parse.addedOne', { title: lastTitle }) : tp('commitments.parse.addedMany', added);
      if (everyRowResolved()) note.value = '';
      yield queryClient.invalidateQueries({ queryKey: ['commitments'] });
      yield queryClient.invalidateQueries({ queryKey: ['availability'] });
    },
    {
      binding,
      onSettled: () => {
        adding.value = false;
      },
    },
  );
}

function addAll(): Promise<void> {
  return addRows(readyRows.value);
}

function focusResult(): void {
  void nextTick(() => resultHeading.value?.focus());
}

function edit(row: DraftRow): void {
  emit('edit', draftFormValues(row.draft, { start: row.start, end: row.end }));
  rows.value = rows.value.filter((candidate) => candidate.key !== row.key);
  status.value = t('commitments.parse.movedToForm', { title: row.draft.title });
}

function remove(row: DraftRow): void {
  rows.value = rows.value.filter((candidate) => candidate.key !== row.key);
  status.value = t('commitments.parse.removed', { title: row.draft.title });
  focusResult();
}
</script>

<template>
  <section class="nl-entry" aria-labelledby="nl-entry-heading" data-testid="nl-entry">
    <h2 id="nl-entry-heading" class="settings-group-title nl-entry-heading">{{ t('commitments.parse.heading') }}</h2>
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
        <span class="nl-wait-elapsed" role="timer" :aria-label="elapsedText">{{ elapsedText }}</span>
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
      <h3 id="nl-result-heading" ref="resultHeading" class="nl-result-heading" tabindex="-1">
        {{ t('commitments.parse.resultHeading') }}
      </h3>
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
            <ul v-if="noteTexts(row).length > 0" class="nl-draft-notes">
              <li v-for="text in noteTexts(row)" :key="text">{{ text }}</li>
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
