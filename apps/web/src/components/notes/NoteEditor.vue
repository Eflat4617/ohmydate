<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, useId, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  isStoredFinalResult,
  plannerClient,
  type ContextDocument,
  type ContextDocumentCreate,
  type ContextDocumentPatch,
  type DocumentLinkCreate,
  type NoteSensitivity,
} from '../../api';
import {
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  codePointLength,
  forgetNote,
  isApiStatus,
  keyOwner,
  noteKeys,
  ownerFenced,
  ownerKeyOf,
  publishNote,
  rebaseFields,
  retryFenced,
  useLinkTargets,
  useOwnerKey,
} from '../../composables/notes';
import { useMediaQuery } from '../../composables/useMediaQuery';
import { t } from '../../i18n';
import { browserTimeZone, formatDateTime, formatNumber } from '../../i18n/format';
import { errorMessage } from '../../i18n/problem';
import { runOwnerBound, type OwnerScope, type OwnerSteps } from '../../session/ownerBound';
import { ownerState } from '../../session/ownerEpoch';
import { useAuthStore } from '../../stores/auth';
import { useOfflineStore } from '../../stores/offline';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import MarkdownView from './MarkdownView.vue';
import NoteAiUsage from './NoteAiUsage.vue';
import NoteConfirmDialog from './NoteConfirmDialog.vue';
import NoteConflictDialog from './NoteConflictDialog.vue';
import NoteLinks from './NoteLinks.vue';

/**
 * Note editor (07 §3.5 Notes): title, Markdown body with edit / preview /
 * side-by-side (desktop) or tabs (mobile), sensitivity, the explicit
 * "AI에 보내기 허용" opt-in, links and the AI usage history.
 *
 * Every write carries an Idempotency-Key (UUIDv7) and, for an existing note,
 * `If-Match` with the version being edited (07 §6). A 412 opens the conflict
 * dialog (reload / keep mine as a copy / keep editing). Each async write
 * captures the owner binding first (ADR-023) and drops its continuation when
 * the signed-in user changed meanwhile.
 */
const props = withDefaults(
  defineProps<{
    noteId: string | null;
    presetLink?: DocumentLinkCreate | null;
  }>(),
  { presetLink: null },
);

const emit = defineEmits<{
  created: [note: ContextDocument];
  copied: [note: ContextDocument];
  deleted: [title: string];
  'dirty-change': [dirty: boolean];
}>();

interface Fields {
  title: string;
  bodyMd: string;
  sensitivity: NoteSensitivity;
  llmAllowed: boolean;
}

const DEFAULTS: Readonly<Fields> = { title: '', bodyMd: '', sensitivity: 'P2', llmAllowed: false };
type ViewMode = 'edit' | 'preview' | 'split';
const SPLIT_DEBOUNCE_MS = 150;

const uid = useId();
const owner = useOwnerKey();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const auth = useAuthStore();
const actions = new ActionStore();
const desktop = useMediaQuery('(min-width: 1024px)');
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());

const docQuery = useQuery({
  queryKey: computed(() => noteKeys.doc(owner.value, props.noteId ?? 'new')),
  queryFn: ({ queryKey }) =>
    ownerFenced(keyOwner(queryKey), (binding) => plannerClient.getDocument(props.noteId ?? '', binding.signal)),
  enabled: computed(() => props.noteId !== null),
  refetchOnWindowFocus: false,
  retry: retryFenced(2),
});

/** The server version being edited; `null` for a note that is not saved yet. */
const base = ref<ContextDocument | null>(null);
// Task names only matter for a note promoted from a task description.
const targets = useLinkTargets(() => base.value?.source === 'task_description');
const fields = reactive<Fields>({ ...DEFAULTS });
const attempted = ref(false);
const saving = ref(false);
const deleting = ref(false);
const saveError = ref<string | null>(null);
const statusText = ref('');
const conflict = ref<{ server: ContextDocument } | null>(null);
const conflictBusy = ref(false);
const conflictError = ref<string | null>(null);
const deleteOpen = ref(false);
const deleteError = ref<string | null>(null);
const notFound = ref(false);
const mode = ref<ViewMode>('edit');
const titleInput = ref<HTMLInputElement | null>(null);
const bodyInput = ref<HTMLTextAreaElement | null>(null);

function fieldsOf(note: ContextDocument): Fields {
  return { title: note.title, bodyMd: note.bodyMd, sensitivity: note.sensitivity, llmAllowed: note.llmAllowed };
}

function load(note: ContextDocument): void {
  base.value = note;
  Object.assign(fields, fieldsOf(note));
  notFound.value = false;
}

const baseFields = computed<Fields>(() => (base.value === null ? { ...DEFAULTS } : fieldsOf(base.value)));
const dirty = computed(() => {
  const reference = baseFields.value;
  return (
    fields.title !== reference.title ||
    fields.bodyMd !== reference.bodyMd ||
    fields.sensitivity !== reference.sensitivity ||
    fields.llmAllowed !== reference.llmAllowed
  );
});
watch(dirty, (value) => emit('dirty-change', value), { immediate: true });

watch(
  () => docQuery.data.value,
  (note) => {
    if (note === undefined) return;
    if (base.value === null || base.value.id !== note.id) {
      load(note);
      mode.value = desktop.value ? 'split' : 'preview';
      return;
    }
    // A newer version (refetch): follow it only when nothing local is pending.
    // With unsaved edits the next save gets 412 and the conflict dialog.
    if (note.version > base.value.version && !dirty.value) load(note);
  },
  { immediate: true },
);

watch(
  () => docQuery.error.value,
  (cause) => {
    if (isApiStatus(cause, 404)) notFound.value = true;
  },
);

// ADR-023: another owner signed in — nothing of this editor survives.
watch(
  () => ownerState.ownerId.value,
  () => {
    base.value = null;
    Object.assign(fields, DEFAULTS);
    conflict.value = null;
    deleteOpen.value = false;
    saving.value = false;
    statusText.value = '';
  },
);

const loading = computed(() => props.noteId !== null && base.value === null && !notFound.value && !docQuery.isError.value);
const readOnly = computed(() => !offline.mutationsEnabled);
const titleLength = computed(() => codePointLength(fields.title.trim()));
const titleError = computed(() => {
  if (titleLength.value > NOTE_TITLE_MAX) return t('notes.editor.titleTooLong');
  if (attempted.value && titleLength.value === 0) return t('notes.editor.titleRequired');
  return null;
});
const bodyLength = computed(() => codePointLength(fields.bodyMd));
const bodyOver = computed(() => Math.max(0, bodyLength.value - NOTE_BODY_MAX));
const bodyNear = computed(() => bodyOver.value === 0 && bodyLength.value >= NOTE_BODY_MAX * 0.9);
const valid = computed(() => titleLength.value > 0 && titleLength.value <= NOTE_TITLE_MAX && bodyOver.value === 0);
const canSave = computed(() => !readOnly.value && !saving.value && (base.value === null || dirty.value));

const effectiveMode = computed<ViewMode>(() => (mode.value === 'split' && !desktop.value ? 'edit' : mode.value));
const modeOptions = computed<ViewMode[]>(() => (desktop.value ? ['edit', 'preview', 'split'] : ['edit', 'preview']));
const showEditor = computed(() => effectiveMode.value !== 'preview');
const showPreview = computed(() => effectiveMode.value !== 'edit');

// The preview follows the text at once, except side by side while typing.
const previewSource = ref(fields.bodyMd);
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function syncPreview(): void {
  if (previewTimer !== null) clearTimeout(previewTimer);
  previewTimer = null;
  previewSource.value = fields.bodyMd;
}
watch(effectiveMode, syncPreview);
watch(
  () => fields.bodyMd,
  () => {
    if (effectiveMode.value !== 'split') {
      syncPreview();
      return;
    }
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = setTimeout(syncPreview, SPLIT_DEBOUNCE_MS);
  },
);

function unloadGuard(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', unloadGuard);
onBeforeUnmount(() => {
  if (previewTimer !== null) clearTimeout(previewTimer);
  if (typeof window !== 'undefined') window.removeEventListener('beforeunload', unloadGuard);
});

/** Announce politely. A generator: its own wait is fenced like the task's (delegate with `yield*`). */
function* announce(message: string): OwnerSteps<void> {
  statusText.value = '';
  yield nextTick();
  statusText.value = message;
}

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function patchFor(current: ContextDocument): ContextDocumentPatch {
  const patch: ContextDocumentPatch = {};
  const title = fields.title.trim();
  if (title !== current.title) patch.title = title;
  if (fields.bodyMd !== current.bodyMd) patch.bodyMd = fields.bodyMd;
  if (fields.sensitivity !== current.sensitivity) patch.sensitivity = fields.sensitivity;
  if (fields.llmAllowed !== current.llmAllowed) patch.llmAllowed = fields.llmAllowed;
  return patch;
}

function* focusFirstInvalid(): OwnerSteps<void> {
  yield nextTick();
  if (titleError.value !== null) titleInput.value?.focus();
  else if (bodyOver.value > 0) bodyInput.value?.focus();
}

/**
 * Save answered 412. If the newer server version only moved links/version
 * (nothing editable changed there), adopt it and report `true` so the save is
 * sent once more against it; otherwise open the conflict dialog (M6-03R-1 M1).
 */
function* resolveSaveConflict(bound: OwnerScope, noteId: string, allowRebase: boolean): OwnerSteps<boolean> {
  try {
    const latest = yield* bound.wait(plannerClient.getDocument(noteId, bound.signal));
    const current = base.value;
    if (
      allowRebase &&
      current !== null &&
      latest.id === current.id &&
      latest.version > current.version &&
      sameEditable(fieldsOf(latest), fieldsOf(current))
    ) {
      base.value = latest;
      void publishNote(queryClient, ownerKeyOf(bound.ownerId), latest);
      return true;
    }
    conflictError.value = null;
    conflict.value = { server: latest };
    return false;
  } catch (cause) {
    if (isApiStatus(cause, 404)) notFound.value = true;
    else saveError.value = errorMessage(cause, t('notes.editor.saveError'));
    return false;
  }
}

/** Form submit / Ctrl+S (never receives the event as an option). */
async function save(): Promise<void> {
  // Owner isolation (ADR-023): the whole save — the announcements, the
  // request, the cache update, a retry after a link-only change — is one
  // owner-bound task. After a user switch none of it continues.
  await runOwnerBound((bound) => saveNote(bound, false));
}

function* saveNote(bound: OwnerScope, retried: boolean): OwnerSteps<void> {
  attempted.value = true;
  if (!valid.value) {
    yield* focusFirstInvalid();
    return;
  }
  if (!canSave.value) return;
  const current = base.value;
  saving.value = true;
  saveError.value = null;
  yield* announce(t('notes.editor.saving'));
  if (current === null) {
    const payload: ContextDocumentCreate = {
      title: fields.title.trim(),
      bodyMd: fields.bodyMd,
      sensitivity: fields.sensitivity,
      llmAllowed: fields.llmAllowed,
      ...(props.presetLink === null ? {} : { links: [props.presetLink] }),
    };
    const scope = 'note:create';
    const action = actions.begin(scope, payload, samePayload);
    const sent: Fields = { ...fields };
    try {
      const created = yield* bound.wait(plannerClient.createDocument(action.payload, action.key, bound.signal));
      actions.settle(scope, action);
      // Text typed while the request was in flight stays; the rest follows the server.
      const merged = rebaseFields({ ...fields }, sent, fieldsOf(created));
      base.value = created;
      Object.assign(fields, merged);
      yield* bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), created));
      yield* announce(t('notes.editor.created'));
      emit('created', created);
    } catch (cause) {
      if (isStoredFinalResult(cause)) actions.settle(scope, action);
      saveError.value = errorMessage(cause, t('notes.editor.saveError'));
      yield* announce(t('notes.editor.saveError'));
    } finally {
      saving.value = false;
    }
    return;
  }

  const patch = patchFor(current);
  if (Object.keys(patch).length === 0) {
    saving.value = false;
    Object.assign(fields, fieldsOf(current));
    yield* announce(t('notes.editor.clean', { version: current.version }));
    return;
  }
  const scope = `note:${current.id}:patch`;
  const action = actions.begin(scope, patch, samePayload, current.version);
  const sent: Fields = { ...fields };
  let rebased = false;
  try {
    const updated = yield* bound.wait(
      plannerClient.updateDocument(current.id, action.payload, action.key, current.version, bound.signal),
    );
    actions.settle(scope, action);
    // Text typed while the request was in flight stays; the rest follows the server.
    const merged = rebaseFields({ ...fields }, sent, fieldsOf(updated));
    base.value = updated;
    Object.assign(fields, merged);
    yield* bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), updated));
    yield* announce(t('notes.editor.saved', { version: updated.version }));
  } catch (cause) {
    if (isStoredFinalResult(cause)) actions.settle(scope, action);
    if (isApiStatus(cause, 412)) {
      rebased = yield* resolveSaveConflict(bound, current.id, !retried);
      statusText.value = '';
    } else if (isApiStatus(cause, 404)) {
      notFound.value = true;
    } else {
      saveError.value = errorMessage(cause, t('notes.editor.saveError'));
      yield* announce(t('notes.editor.saveError'));
    }
  } finally {
    saving.value = false;
  }
  // A link-only change elsewhere: send the same edit once more against the new version.
  if (rebased) yield* saveNote(bound, true);
}

function sameEditable(left: Fields, right: Fields): boolean {
  return (
    left.title === right.title &&
    left.bodyMd === right.bodyMd &&
    left.sensitivity === right.sensitivity &&
    left.llmAllowed === right.llmAllowed
  );
}

/**
 * A newer server version reached the editor outside a save (a link/unlink
 * answer, or the latest note after a link/unlink 412). M6-03R-1 M1: the edit
 * base only advances silently when the remote change touched links/version
 * alone. If editable content changed remotely while I have unsaved edits, the
 * base stays where I started and the reload / keep-mine-as-copy dialog opens —
 * a later Save can never overwrite the other change.
 */
function adoptServerNote(note: ContextDocument): void {
  const current = base.value;
  if (current === null || note.id !== current.id || note.version <= current.version) return;
  if (sameEditable(fieldsOf(note), fieldsOf(current))) {
    // Link/version-only: my unsaved text stays and now targets the new version.
    base.value = note;
    void publishNote(queryClient, owner.value, note);
    return;
  }
  if (!dirty.value) {
    load(note);
    void publishNote(queryClient, owner.value, note);
    return;
  }
  conflictError.value = null;
  conflict.value = { server: note };
}

function onLinksUpdated(note: ContextDocument): void {
  adoptServerNote(note);
}

async function reloadFromConflict(): Promise<void> {
  const current = conflict.value;
  if (current === null) return;
  await runOwnerBound(function* (bound) {
    load(current.server);
    conflict.value = null;
    attempted.value = false;
    yield* bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), current.server));
    yield* announce(t('notes.conflict.reloaded'));
  });
}

function copyTitle(title: string): string {
  const text = t('notes.conflict.copyTitle', { title: title.trim().length === 0 ? t('notes.editor.newTitle') : title.trim() });
  const chars = Array.from(text);
  return chars.length > NOTE_TITLE_MAX ? chars.slice(0, NOTE_TITLE_MAX).join('') : text;
}

async function copyFromConflict(): Promise<void> {
  if (conflict.value === null || conflictBusy.value || readOnly.value) return;
  const payload: ContextDocumentCreate = {
    title: copyTitle(fields.title),
    bodyMd: fields.bodyMd,
    sensitivity: fields.sensitivity,
    llmAllowed: fields.llmAllowed,
  };
  const scope = 'note:conflict-copy';
  const action = actions.begin(scope, payload, samePayload);
  conflictBusy.value = true;
  conflictError.value = null;
  await runOwnerBound(
    function* (bound) {
      try {
        const created = yield* bound.wait(plannerClient.createDocument(action.payload, action.key, bound.signal));
        actions.settle(scope, action);
        const server = conflict.value?.server;
        conflict.value = null;
        // The original note now shows the server version; my text lives in the copy.
        if (server !== undefined) load(server);
        yield* bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), created));
        yield* announce(t('notes.conflict.copied'));
        emit('copied', created);
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        conflictError.value = errorMessage(cause, t('notes.editor.saveError'));
      }
    },
    {
      onSettled: () => {
        conflictBusy.value = false;
      },
    },
  );
}

function keepEditing(): void {
  conflict.value = null;
  void nextTick(() => bodyInput.value?.focus());
}

function openDelete(): void {
  if (base.value === null || readOnly.value) return;
  deleteError.value = null;
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const current = base.value;
  if (current === null || deleting.value || readOnly.value) return;
  const scope = `note:${current.id}:delete`;
  const action = actions.begin(scope, { id: current.id }, samePayload, current.version);
  deleting.value = true;
  deleteError.value = null;
  await runOwnerBound(
    function* (bound) {
      try {
        yield* bound.wait(plannerClient.deleteDocument(current.id, action.key, current.version, bound.signal));
        actions.settle(scope, action);
        yield* finishDelete(bound, current);
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (isApiStatus(cause, 404)) {
          yield* finishDelete(bound, current);
        } else if (isApiStatus(cause, 412)) {
          deleteError.value = t('notes.editor.deleteConflict');
          try {
            const latest = yield* bound.wait(plannerClient.getDocument(current.id, bound.signal));
            if (!dirty.value) load(latest);
          } catch (lookup) {
            // The message above already asks the user to check and retry.
          }
        } else {
          deleteError.value = errorMessage(cause, t('notes.editor.deleteError'));
        }
      }
    },
    {
      onSettled: () => {
        deleting.value = false;
      },
    },
  );
}

/**
 * Clears the deleted note for the owner that deleted it. The cache
 * invalidation can outlive that owner (M6-03R2): it is awaited through the
 * owner scope, so a stale owner gets no `deleted` toast or navigation.
 */
function* finishDelete(bound: OwnerScope, current: ContextDocument): OwnerSteps<void> {
  deleteOpen.value = false;
  base.value = null;
  Object.assign(fields, DEFAULTS);
  yield* bound.wait(forgetNote(queryClient, ownerKeyOf(bound.ownerId), current.id));
  emit('deleted', current.title);
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
  }
}

const sourceText = computed(() => {
  const current = base.value;
  if (current === null || current.source !== 'task_description') return null;
  const title = current.sourceTaskId === undefined ? undefined : targets.taskTitle(current.sourceTaskId);
  return title === undefined ? t('notes.editor.sourceUnknown') : t('notes.editor.source', { title });
});

const statusBadge = computed(() => {
  if (base.value === null) return { tone: 'neutral' as const, text: t('notes.editor.unsavedNew') };
  if (dirty.value) return { tone: 'warn' as const, text: t('notes.editor.dirty') };
  return { tone: 'success' as const, text: t('notes.editor.clean', { version: base.value.version }) };
});

function focusTitle(): void {
  titleInput.value?.focus();
}

defineExpose({ isDirty: () => dirty.value, focusTitle });
</script>

<template>
  <UiCard as="article" class="note-editor" :aria-labelledby="`${uid}-heading`" data-note-editor @keydown="onKeydown">
    <div v-if="loading">
      <p class="visually-hidden" role="status">{{ t('notes.loading') }}</p>
      <UiSkeleton variant="lines" :lines="6" />
    </div>
    <UiBanner v-else-if="notFound" tone="warn" role="alert" tabindex="-1" data-note-not-found>{{ t('notes.notFound') }}</UiBanner>
    <UiBanner v-else-if="noteId !== null && base === null && docQuery.isError.value" tone="error">
      <p role="alert">{{ t('notes.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="docQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <form v-else class="note-form" novalidate @submit.prevent="save">
      <header class="note-editor-header">
        <h2 :id="`${uid}-heading`" class="note-editor-heading" tabindex="-1">
          {{ base === null ? t('notes.editor.newTitle') : t('notes.editor.editTitle') }}
        </h2>
        <div class="note-editor-status">
          <UiBadge :tone="statusBadge.tone" dot data-note-status>{{ statusBadge.text }}</UiBadge>
        </div>
      </header>
      <p class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-note-live>{{ statusText }}</p>
      <UiBanner v-if="readOnly" tone="offline" role="status">{{ t('notes.editor.readOnly') }}</UiBanner>
      <UiBanner v-if="sourceText" tone="info">{{ sourceText }}</UiBanner>
      <UiBanner v-if="saveError" tone="error" role="alert" data-note-error>{{ saveError }}</UiBanner>

      <div class="field" :class="{ 'field--invalid': titleError }">
        <label :for="`${uid}-title`" class="field-label">{{ t('notes.editor.titleLabel') }}</label>
        <input
          :id="`${uid}-title`"
          ref="titleInput"
          v-model="fields.title"
          type="text"
          class="note-title-input"
          autocomplete="off"
          required
          :placeholder="t('notes.editor.titlePlaceholder')"
          :readonly="readOnly"
          :aria-invalid="titleError ? 'true' : undefined"
          :aria-describedby="titleError ? `${uid}-title-error` : undefined"
          data-note-title
        />
        <p v-if="titleError" :id="`${uid}-title-error`" class="field-error">
          <UiIcon name="error" :size="16" /><span>{{ titleError }}</span>
        </p>
      </div>

      <div class="note-body-toolbar">
        <span :id="`${uid}-body-label`" class="field-label">{{ t('notes.editor.bodyLabel') }}</span>
        <fieldset class="choice-group note-view-modes" data-note-modes>
          <legend class="visually-hidden">{{ t('notes.editor.viewMode') }}</legend>
          <label v-for="option in modeOptions" :key="option" class="choice-chip">
            <input v-model="mode" type="radio" :name="`${uid}-mode`" :value="option" :data-note-mode="option" />
            {{ t(`notes.editor.modes.${option}`) }}
          </label>
        </fieldset>
      </div>

      <div class="note-body" :class="`note-body--${effectiveMode}`">
        <div v-show="showEditor" class="note-body-editor">
          <textarea
            :id="`${uid}-body`"
            ref="bodyInput"
            v-model="fields.bodyMd"
            class="note-body-input"
            rows="16"
            spellcheck="true"
            :readonly="readOnly"
            :aria-labelledby="`${uid}-body-label`"
            :aria-describedby="`${uid}-body-help ${uid}-counter`"
            :aria-invalid="bodyOver > 0 ? 'true' : undefined"
            data-note-body
          ></textarea>
        </div>
        <section
          v-show="showPreview"
          class="note-body-preview"
          :aria-label="t('notes.editor.previewLabel')"
          data-note-preview
        >
          <MarkdownView :source="previewSource" />
        </section>
      </div>
      <p :id="`${uid}-body-help`" class="field-help">{{ t('notes.editor.bodyHelp') }}</p>
      <p
        :id="`${uid}-counter`"
        class="note-counter tabular"
        :class="{ 'note-counter--over': bodyOver > 0, 'note-counter--near': bodyNear }"
        data-note-counter
      >
        {{ t('notes.editor.counter', { count: formatNumber(bodyLength), max: formatNumber(NOTE_BODY_MAX) }) }}
        <span v-if="bodyOver > 0" class="field-error" role="alert">
          <UiIcon name="error" :size="16" />{{ t('notes.editor.counterOver', { over: formatNumber(bodyOver) }) }}
        </span>
        <span v-else-if="bodyNear" class="muted">{{ t('notes.editor.counterNear') }}</span>
      </p>

      <div class="note-settings">
        <fieldset class="note-sensitivity" data-note-sensitivity>
          <legend class="field-label">{{ t('notes.editor.sensitivity.legend') }}</legend>
          <label class="note-radio">
            <input v-model="fields.sensitivity" type="radio" :name="`${uid}-sensitivity`" value="P2" :disabled="readOnly" />
            <span>
              <span class="note-radio-label">{{ t('notes.editor.sensitivity.P2') }}</span>
              <span class="field-help">{{ t('notes.editor.sensitivity.P2Help') }}</span>
            </span>
          </label>
          <label class="note-radio">
            <input v-model="fields.sensitivity" type="radio" :name="`${uid}-sensitivity`" value="P1" :disabled="readOnly" />
            <span>
              <span class="note-radio-label">{{ t('notes.editor.sensitivity.P1') }}</span>
              <span class="field-help">{{ t('notes.editor.sensitivity.P1Help') }}</span>
            </span>
          </label>
        </fieldset>

        <div class="note-llm" data-note-llm>
          <label class="layout-switch">
            <input
              v-model="fields.llmAllowed"
              type="checkbox"
              role="switch"
              :disabled="readOnly"
              :aria-describedby="`${uid}-llm-help ${uid}-llm-mask ${uid}-llm-state`"
              data-note-llm-toggle
            />
            <span>{{ t('notes.editor.llm.label') }}</span>
          </label>
          <p :id="`${uid}-llm-help`" class="field-help">{{ t('notes.editor.llm.help') }}</p>
          <p :id="`${uid}-llm-mask`" class="field-help">{{ t('notes.editor.llm.masking') }}</p>
          <p :id="`${uid}-llm-state`" class="note-llm-state" :class="{ 'note-llm-state--on': fields.llmAllowed }">
            <UiIcon :name="fields.llmAllowed ? 'ai' : 'shield'" :size="16" />
            {{ fields.llmAllowed ? t('notes.editor.llm.on') : t('notes.editor.llm.off') }}
          </p>
          <UiBanner v-if="fields.llmAllowed && fields.sensitivity === 'P1'" tone="warn" inline>
            {{ t('notes.editor.llm.sensitiveWarn') }}
          </UiBanner>
        </div>
      </div>

      <div class="note-editor-actions">
        <UiButton
          v-if="base !== null"
          variant="danger-ghost"
          icon="trash"
          class="danger"
          :disabled="readOnly || saving || deleting"
          data-note-delete
          @click="openDelete"
        >
          {{ t('notes.editor.delete') }}
        </UiButton>
        <UiButton type="submit" variant="primary" icon="check" :busy="saving" :disabled="!canSave" data-note-save>
          {{ saving ? t('notes.editor.saving') : base === null ? t('notes.editor.create') : t('notes.editor.save') }}
        </UiButton>
      </div>
      <p v-if="base" class="muted note-meta tabular">
        {{ t('notes.editor.meta', { created: formatDateTime(base.createdAt, timeZone), updated: formatDateTime(base.updatedAt, timeZone) }) }}
      </p>
    </form>

    <template v-if="!loading && !notFound && (noteId === null || base !== null)">
      <NoteLinks :note="base" :disabled="readOnly || saving" @updated="onLinksUpdated" @stale="adoptServerNote" />
      <NoteAiUsage :document-id="base?.id ?? null" />
    </template>

    <NoteConflictDialog
      v-if="conflict"
      :server-version="conflict.server.version"
      :server-title="conflict.server.title"
      :local-title="fields.title"
      :busy="conflictBusy"
      :disabled="readOnly"
      :error="conflictError"
      @reload="reloadFromConflict"
      @copy="copyFromConflict"
      @keep="keepEditing"
    />
    <NoteConfirmDialog
      v-if="deleteOpen && base"
      :title="t('notes.deleteDialog.title')"
      :body="t('notes.deleteDialog.body', { title: base.title })"
      :confirm-label="t('notes.deleteDialog.confirm')"
      :cancel-label="t('notes.deleteDialog.cancel')"
      :busy="deleting"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="deleteOpen = false"
    />
  </UiCard>
</template>
