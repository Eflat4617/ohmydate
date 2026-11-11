<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import {
  ActionStore,
  isStoredFinalResult,
  plannerClient,
  type ContextDocument,
  type DocumentLink,
  type DocumentLinkCreate,
} from '../../api';
import { isApiStatus, useLinkTargets } from '../../composables/notes';
import { t } from '../../i18n';
import { errorMessage } from '../../i18n/problem';
import { runOwnerBound, type OwnerScope } from '../../session/ownerBound';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import LinkPickerDialog from './LinkPickerDialog.vue';

/**
 * "연결 대상" (07 §3.5): the goals, projects and tasks a note is linked to.
 * Link and unlink pin `If-Match` to the NOTE version and answer the note at
 * version + 1 (`updated`). On 412 the latest note is handed to the editor as
 * `stale`; the editor decides whether that is a link-only change it can adopt
 * or a content conflict for the reload / keep-mine-as-copy dialog
 * (M6-03R-1 M1). This component never advances the edit base itself.
 */
const props = withDefaults(defineProps<{ note: ContextDocument | null; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ updated: [note: ContextDocument]; stale: [note: ContextDocument] }>();

const MAX_LINKS = 50;
const headingId = `note-links-${useId()}`;
const actions = new ActionStore();
const targets = useLinkTargets(() => props.note !== null);
const pickerOpen = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const pickerError = ref<string | null>(null);
const announcement = ref('');
const addButton = ref<InstanceType<typeof UiButton> | null>(null);

const links = computed<readonly DocumentLink[]>(() => props.note?.links ?? []);
const full = computed(() => links.value.length >= MAX_LINKS);

function kindLabel(link: Pick<DocumentLink, 'targetKind'>): string {
  return t(`notes.links.kind.${link.targetKind}`);
}

function targetName(link: Pick<DocumentLink, 'targetKind' | 'targetId'>): string {
  if (link.targetKind === 'project') {
    const project = targets.projectOf(link.targetId);
    if (project === undefined) return t('notes.links.unknownTarget');
    return project.kind === 'inbox' ? t('nav.inbox') : project.title;
  }
  if (link.targetKind === 'task') return targets.taskTitle(link.targetId) ?? t('notes.links.unknownTarget');
  return targets.goalTitle(link.targetId) ?? t('notes.links.goalUnnamed');
}

function targetRoute(link: DocumentLink): string | null {
  if (link.targetKind === 'project' && targets.projectOf(link.targetId) !== undefined) return `/projects/${link.targetId}`;
  if (link.targetKind === 'task' && targets.taskTitle(link.targetId) !== undefined) return `/tasks/${link.targetId}`;
  return null;
}

async function announce(message: string): Promise<void> {
  announcement.value = '';
  await nextTick();
  announcement.value = message;
}

function failure(cause: unknown): string {
  if (isApiStatus(cause, 422)) return links.value.length >= MAX_LINKS - 1 ? t('notes.links.limit') : t('notes.links.duplicate');
  if (isApiStatus(cause, 404)) return t('notes.links.notFound');
  return errorMessage(cause, t('notes.links.error'));
}

/** 412: the note moved on elsewhere; hand the server version to the editor to judge. */
async function reportStale(bound: OwnerScope, noteId: string): Promise<void> {
  try {
    const latest = await bound.wait(plannerClient.getDocument(noteId, bound.signal));
    emit('stale', latest);
  } catch (cause) {
    bound.rethrowIfStale(cause);
    // The conflict message below still tells the user to retry.
  }
}

function openPicker(): void {
  if (props.disabled || props.note === null || full.value) return;
  pickerError.value = null;
  error.value = null;
  pickerOpen.value = true;
}

async function addLink(link: DocumentLinkCreate): Promise<void> {
  const note = props.note;
  if (note === null || busy.value || props.disabled) return;
  const scope = `note:${note.id}:link`;
  const action = actions.begin(scope, link, (left, right) => left.targetKind === right.targetKind && left.targetId === right.targetId, note.version);
  busy.value = true;
  pickerError.value = null;
  await runOwnerBound(
    async (bound) => {
      try {
        const updated = await bound.wait(plannerClient.linkDocument(note.id, action.payload, action.key, note.version, bound.signal));
        actions.settle(scope, action);
        pickerOpen.value = false;
        emit('updated', updated);
        await bound.wait(announce(t('notes.links.linked', { target: targetName(link) })));
      } catch (cause) {
        bound.rethrowIfStale(cause);
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (isApiStatus(cause, 412)) {
          // The picker closes: the editor may need its own conflict dialog now.
          pickerOpen.value = false;
          error.value = t('notes.links.conflict');
          await bound.wait(reportStale(bound, note.id));
        } else {
          pickerError.value = failure(cause);
        }
      }
    },
    {
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}

async function removeLink(link: DocumentLink): Promise<void> {
  const note = props.note;
  if (note === null || busy.value || props.disabled) return;
  const scope = `note:${note.id}:unlink:${link.id}`;
  const action = actions.begin(scope, { linkId: link.id }, (left, right) => left.linkId === right.linkId, note.version);
  busy.value = true;
  error.value = null;
  const name = targetName(link);
  await runOwnerBound(
    async (bound) => {
      try {
        const updated = await bound.wait(plannerClient.unlinkDocument(note.id, link.id, action.key, note.version, bound.signal));
        actions.settle(scope, action);
        emit('updated', updated);
        await bound.wait(announce(t('notes.links.unlinked', { target: name })));
        await bound.wait(nextTick());
        (addButton.value?.$el as HTMLElement | undefined)?.focus();
      } catch (cause) {
        bound.rethrowIfStale(cause);
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (isApiStatus(cause, 412)) {
          error.value = t('notes.links.conflict');
          await bound.wait(reportStale(bound, note.id));
        } else {
          error.value = failure(cause);
        }
      }
    },
    {
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}
</script>

<template>
  <section class="note-section note-links" :aria-labelledby="headingId" data-note-links>
    <header class="note-section-header">
      <h3 :id="headingId" class="note-section-title"><UiIcon name="link" :size="18" />{{ t('notes.links.title') }}</h3>
      <UiButton
        ref="addButton"
        size="sm"
        icon="plus"
        :disabled="disabled || note === null || busy || full"
        data-note-link-add
        @click="openPicker"
      >
        {{ t('notes.links.add') }}
      </UiButton>
    </header>
    <p class="muted">{{ t('notes.links.lede') }}</p>
    <p class="visually-hidden" role="status" aria-live="polite">{{ announcement }}</p>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <p v-if="note === null" class="muted">{{ t('notes.links.saveFirst') }}</p>
    <p v-else-if="links.length === 0" class="muted" data-note-links-empty>{{ t('notes.links.empty') }}</p>
    <ul v-else class="note-link-list">
      <li v-for="link in links" :key="link.id" class="note-link-item" :data-note-link="link.targetKind">
        <UiBadge tone="outline">{{ kindLabel(link) }}</UiBadge>
        <RouterLink v-if="targetRoute(link)" :to="targetRoute(link) ?? ''" class="note-link-name">{{ targetName(link) }}</RouterLink>
        <span v-else class="note-link-name">{{ targetName(link) }}</span>
        <UiButton
          size="sm"
          variant="ghost"
          icon="close"
          :aria-label="t('notes.links.removeAria', { kind: kindLabel(link), target: targetName(link) })"
          :disabled="disabled || busy"
          @click="removeLink(link)"
        >
          <span class="task-action-label">{{ t('notes.links.remove') }}</span>
        </UiButton>
      </li>
    </ul>
    <p v-if="full" class="field-help">{{ t('notes.links.limit') }}</p>

    <LinkPickerDialog
      v-if="pickerOpen && note"
      :links="links"
      :targets="targets"
      :busy="busy"
      :error="pickerError"
      @pick="addLink"
      @close="pickerOpen = false"
    />
  </section>
</template>
