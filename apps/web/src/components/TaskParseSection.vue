<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { plannerClient, type TaskCreate, type TaskDraft, type TaskDraftNote } from '../api';
import { useNlDraftRead, type NlDraftRow } from '../composables/useNlDraftRead';
import {
  TASK_TITLE_MAX,
  dueFromInputValue,
  dueInputValue,
  switchDueMeridiem,
  taskDraftCreateInput,
  taskDraftMeridiemGuessed,
} from '../domain/taskDraft';
import { t, tp } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { useAuthStore } from '../stores/auth';
import { useLlmConsentStore } from '../stores/llmConsent';
import LlmDisclosure from './LlmDisclosure.vue';
import UiBadge from './ui/UiBadge.vue';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiField from './ui/UiField.vue';

/**
 * CAL-05 "말로 적기" in the inbox: the person writes what they have to do in
 * their own words ("금요일까지 보고서 초안, 내일 교수님께 메일, 장보기"), the AI
 * reads it into task drafts (POST /tasks:parse, nothing saved) and each draft
 * is added to the inbox with the same create call as the quick add.
 *
 * - The read / cancel / consent / owner-reset / add flow is the shared
 *   useNlDraftRead (the 약속 screen's CAL-02 flow).
 * - A row: the title, editable in place; 마감 in the app's date-time format or
 *   "마감 없음", changeable with the `datetime-local` input (the planning
 *   wizard's deadline input) or cleared; notes in plain Korean; a guessed AM
 *   offers one switch to PM (CAL-05 addendum).
 * - The quick add above stays the fastest path. One filled button on the
 *   page: the quick add while it has text (`quickAddActive`), otherwise this
 *   section's next step (읽기 while the note has text, then the add action),
 *   otherwise the quick add again (`primary-change`).
 * - With AI off or unavailable the note stays and the quick add still works.
 * - Owner isolation (ADR-023): every request runs in an owner-bound task.
 */
const props = defineProps<{ quickAddActive: boolean; timeZone: string }>();
const emit = defineEmits<{ 'primary-change': [wantsPrimary: boolean] }>();

interface TaskRow extends NlDraftRow<TaskDraft> {
  /** The title as it will be added (editable in place). */
  title: string;
  /** The deadline as it will be added: the draft's, switched, changed or cleared. */
  dueAt: string | null;
  /** The `datetime-local` value while the deadline input is open. */
  dueLocal: string;
  editingDue: boolean;
  /** The person set the deadline by hand: the AI's notes no longer describe it. */
  dueEdited: boolean;
  /** The guessed AM was switched to PM. */
  switched: boolean;
}

const auth = useAuthStore();
const llmConsent = useLlmConsentStore();

function rowInput(row: TaskRow): TaskCreate | null {
  return taskDraftCreateInput(row.title, row.dueAt);
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
  remove,
} = useNlDraftRead<TaskDraft, TaskRow, TaskCreate>({
  parseScope: 'task:parse',
  draftScope: 'task:draft',
  parse: (text, key, signal) => plannerClient.parseTasks(text, key, { timeZone: props.timeZone, signal }),
  toRow: (draft, key) => ({
    key,
    draft,
    state: 'idle',
    error: null,
    title: draft.title,
    dueAt: draft.dueAt ?? null,
    dueLocal: '',
    editingDue: false,
    dueEdited: false,
    switched: false,
  }),
  createInput: rowInput,
  // The same create call as the quick add: no project, so the task goes to the inbox.
  create: (input, key) => plannerClient.createTask(input, key),
  rowTitle: (row) => row.title.trim() || row.draft.title,
  inputTitle: (input) => input.title,
  refresh: [['tasks'], ['projects']],
  messages: {
    empty: () => t('taskParse.empty'),
    consentOff: () => t('taskParse.consentOff'),
    resultNone: () => t('taskParse.resultNone'),
    resultCount: (count) => tp('taskParse.resultCount', count),
    cancelled: () => t('taskParse.cancelled'),
    budget: () => t('taskParse.budget'),
    unavailable: () => t('taskParse.unavailable'),
    readError: () => t('taskParse.readError'),
    addedOne: (title) => t('taskParse.addedOne', { title }),
    addedMany: (count) => tp('taskParse.addedMany', count),
    addError: (title) => t('taskParse.addError', { title }),
    removed: (title) => t('taskParse.removed', { title }),
  },
});

const showDisclosure = computed(() => auth.user?.llmProvider === 'deepseek');

/** Which control of this section is the page's one filled button (null: the quick add's). */
const primary = computed<'read' | 'addOne' | 'addAll' | null>(() => {
  if (props.quickAddActive) return null;
  if (readyRows.value.length >= 2) return 'addAll';
  if (readyRows.value.length === 1) return 'addOne';
  if (note.value.trim().length > 0) return 'read';
  return null;
});

watch(
  () => primary.value !== null,
  (wants) => emit('primary-change', wants),
  { immediate: true },
);

const elapsedText = computed(() => t('taskParse.waitElapsed', { seconds: elapsedSeconds.value }));

function rowId(row: TaskRow, part: string): string {
  return `task-draft-${row.key}-${part}`;
}

function shownTitle(row: TaskRow): string {
  return row.title.trim() || row.draft.title;
}

function dueText(row: TaskRow): string {
  return row.dueAt === null ? t('taskParse.noDue') : t('taskParse.due', { when: formatDateTime(row.dueAt, props.timeZone) });
}

function titleError(row: TaskRow): string | null {
  return row.state === 'idle' && row.title.trim().length === 0 ? t('taskParse.titleEmpty') : null;
}

/** Plain-Korean notes about what the AI assumed; gone once the deadline was set by hand. */
function noteTexts(row: TaskRow): string[] {
  if (row.dueEdited) return [];
  return row.draft.notes
    .filter((code): code is Exclude<TaskDraftNote, 'meridiem_assumed'> => code !== 'meridiem_assumed')
    .map((code) => t(`taskParse.note.${code}`));
}

function showMeridiem(row: TaskRow): boolean {
  return !row.dueEdited && taskDraftMeridiemGuessed(row.draft);
}

/** 오후로 바꾸기 / 오전으로 바꾸기: the deadline moves 12 hours in the read's zone. */
function switchMeridiem(row: TaskRow): void {
  const base = row.draft.dueAt;
  if (row.state !== 'idle' || base === undefined) return;
  row.switched = !row.switched;
  row.dueAt = row.switched ? switchDueMeridiem(base, props.timeZone, 1) : base;
  status.value = t(row.switched ? 'nlRead.meridiem.statusPm' : 'nlRead.meridiem.statusAm', {
    title: shownTitle(row),
    when: formatDateTime(row.dueAt, props.timeZone),
  });
}

function toggleDue(row: TaskRow): void {
  if (row.state !== 'idle') return;
  row.editingDue = !row.editingDue;
  if (!row.editingDue) return;
  row.dueLocal = dueInputValue(row.dueAt, props.timeZone);
  void nextTick(() => document.getElementById(rowId(row, 'due'))?.focus());
}

function onDueInput(row: TaskRow, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  row.dueLocal = value;
  const due = dueFromInputValue(value, props.timeZone);
  if (due === undefined) return;
  row.dueAt = due;
  row.dueEdited = true;
}

function clearDue(row: TaskRow): void {
  if (row.state !== 'idle') return;
  row.dueAt = null;
  row.dueLocal = '';
  row.dueEdited = true;
}
</script>

<template>
  <section class="nl-entry task-parse" aria-labelledby="task-parse-heading" data-testid="task-parse">
    <h2 id="task-parse-heading" class="settings-group-title nl-entry-heading">{{ t('taskParse.heading') }}</h2>

    <form class="nl-entry-form task-parse-form" @submit.prevent="read">
      <UiField id="task-note" :label="t('taskParse.label')" :help="t('taskParse.help')">
        <template #default="{ describedby }">
          <textarea
            id="task-note"
            ref="noteField"
            v-model="note"
            class="nl-entry-note task-parse-note"
            rows="2"
            maxlength="500"
            :placeholder="t('taskParse.placeholder')"
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
          {{ t('taskParse.read') }}
        </UiButton>
        <p class="nl-entry-send muted">{{ t('taskParse.sendNote') }}</p>
      </div>
      <details v-if="showDisclosure" class="nl-entry-disclosure">
        <summary>{{ t('taskParse.disclosure') }}</summary>
        <LlmDisclosure />
      </details>
    </form>

    <div v-if="reading" class="nl-wait" aria-busy="true" data-testid="task-parse-wait">
      <div class="ai-wait-track" aria-hidden="true"><span class="ai-wait-track-fill"></span></div>
      <p class="nl-wait-text">
        <span>{{ t('taskParse.waitTitle') }}</span>
        <span v-if="elapsedSeconds > 0" class="nl-wait-elapsed" role="timer" :aria-label="elapsedText">{{
          elapsedText
        }}</span>
        <span class="muted">{{ t('taskParse.waitHint') }}</span>
      </p>
      <UiButton size="sm" @click="cancel">{{ t('taskParse.cancel') }}</UiButton>
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
      <!-- Asked for where it is needed (FLOW §1): the consent dialog opens here, not in 설정. -->
      <button v-if="failure === 'consent'" type="button" class="nl-failure-link" data-nl-consent @click="llmConsent.ask()">
        {{ t('taskParse.consentLink') }}
      </button>
    </UiBanner>

    <section v-if="showResult" class="nl-result" aria-labelledby="task-parse-result-heading" data-testid="task-parse-result">
      <h3 id="task-parse-result-heading" ref="resultHeading" class="nl-result-heading" tabindex="-1">
        {{ t('taskParse.resultHeading') }}
      </h3>
      <p v-if="readEmpty" class="muted">{{ t('taskParse.resultNone') }}</p>
      <ul v-if="rows.length > 0" class="nl-draft-list">
        <li
          v-for="row in rows"
          :key="row.key"
          class="nl-draft task-draft"
          :class="{ 'nl-draft--added': row.state === 'added' }"
          data-testid="task-draft"
        >
          <div class="nl-draft-main">
            <div class="nl-draft-title-row">
              <strong v-if="row.state === 'added'" class="nl-draft-title">{{ shownTitle(row) }}</strong>
              <template v-else>
                <label :for="rowId(row, 'title')" class="visually-hidden">{{ t('taskParse.titleLabel') }}</label>
                <input
                  :id="rowId(row, 'title')"
                  v-model="row.title"
                  class="task-draft-title"
                  type="text"
                  :maxlength="TASK_TITLE_MAX"
                  autocomplete="off"
                  :aria-invalid="titleError(row) !== null ? 'true' : undefined"
                  :aria-describedby="titleError(row) !== null ? rowId(row, 'title-error') : undefined"
                  :disabled="!canAct || row.state !== 'idle'"
                />
              </template>
              <UiBadge v-if="row.state === 'added'" tone="success">{{ t('taskParse.added') }}</UiBadge>
            </div>
            <p v-if="titleError(row)" :id="rowId(row, 'title-error')" class="error-text nl-draft-error">
              {{ titleError(row) }}
            </p>
            <span class="nl-draft-when tabular" data-testid="task-draft-due">{{ dueText(row) }}</span>
            <ul v-if="noteTexts(row).length > 0 || showMeridiem(row)" class="nl-draft-notes">
              <li v-for="text in noteTexts(row)" :key="text">{{ text }}</li>
              <li v-if="showMeridiem(row)" class="nl-draft-meridiem" data-testid="nl-meridiem">
                <span>{{ row.switched ? t('nlRead.meridiem.switchedPm') : t('nlRead.meridiem.assumedAm') }}</span>
                <UiButton
                  v-if="row.state !== 'added'"
                  size="sm"
                  variant="ghost"
                  class="nl-draft-meridiem-switch"
                  :disabled="row.state !== 'idle'"
                  @click="switchMeridiem(row)"
                >
                  <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: shownTitle(row) }) }}</span
                  >{{ row.switched ? t('nlRead.meridiem.toAm') : t('nlRead.meridiem.toPm') }}
                </UiButton>
              </li>
            </ul>
            <div v-if="row.editingDue && row.state === 'idle'" class="task-draft-due-edit">
              <UiField :id="rowId(row, 'due')" :label="t('taskParse.dueLabel')" :help="t('taskParse.dueHelp')">
                <template #default="{ describedby }">
                  <input
                    :id="rowId(row, 'due')"
                    :value="row.dueLocal"
                    type="datetime-local"
                    :aria-describedby="describedby"
                    :disabled="!canAct"
                    @input="onDueInput(row, $event)"
                    @change="onDueInput(row, $event)"
                  />
                </template>
              </UiField>
              <UiButton size="sm" variant="ghost" :disabled="row.dueAt === null" @click="clearDue(row)">
                <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: shownTitle(row) }) }}</span
                >{{ t('taskParse.clearDue') }}
              </UiButton>
            </div>
            <p v-if="row.error" class="error-text nl-draft-error" role="alert">{{ row.error }}</p>
          </div>
          <div
            v-if="row.state !== 'added'"
            class="nl-draft-actions"
            role="group"
            :aria-label="t('taskParse.rowActions', { title: shownTitle(row) })"
          >
            <UiButton
              size="sm"
              :variant="primary === 'addOne' && isReady(row) ? 'primary' : 'secondary'"
              :busy="row.state === 'adding'"
              :disabled="!canAct || adding || !isReady(row)"
              @click="addRows([row])"
            >
              <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: shownTitle(row) }) }}</span
              >{{ t('taskParse.add') }}
            </UiButton>
            <UiButton
              size="sm"
              variant="ghost"
              :aria-expanded="row.editingDue ? 'true' : 'false'"
              :aria-controls="row.editingDue ? rowId(row, 'due') : undefined"
              :disabled="row.state !== 'idle'"
              @click="toggleDue(row)"
            >
              <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: shownTitle(row) }) }}</span
              >{{ row.editingDue ? t('taskParse.closeDue') : t('taskParse.changeDue') }}
            </UiButton>
            <UiButton size="sm" variant="ghost" :disabled="row.state !== 'idle'" @click="remove(row)">
              <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: shownTitle(row) }) }}</span
              >{{ t('taskParse.remove') }}
            </UiButton>
          </div>
        </li>
      </ul>
      <p v-if="leftover.length > 0" class="nl-leftover">{{ t('taskParse.leftover', { text: leftover }) }}</p>
      <div v-if="readyRows.length >= 2" class="nl-add-all">
        <UiButton
          :variant="primary === 'addAll' ? 'primary' : 'secondary'"
          :busy="adding"
          :disabled="!canAct || adding"
          data-testid="task-parse-add-all"
          @click="addAll"
        >
          {{ tp('taskParse.addAll', readyRows.length) }}
        </UiButton>
      </div>
    </section>
  </section>
</template>
