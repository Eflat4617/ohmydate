<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ActionStore, isStoredFinalResult, plannerClient, type ContextDocument } from '../../api';
import { isApiStatus, keyOwner, noteKeys, ownerFenced, publishNote, retryFenced, useLinkedNotes, useOwnerKey } from '../../composables/notes';
import { t } from '../../i18n';
import { errorMessage } from '../../i18n/problem';
import { ownerKeyOf, runOwnerBound, type OwnerSteps } from '../../session/ownerBound';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';

/**
 * "이 계획에 참고할 노트" (05 §9/§12, 08 §2.7): the planning session's goal is
 * the only thing the decomposition grounds on, so the user links notes to it
 * here, explicitly. Only notes with "AI에 보내기 허용" are ever sent, and only
 * the sections related to the plan; the badges say which ones qualify.
 */
const props = withDefaults(
  defineProps<{ goalId: string; afterDraft?: boolean; disabled?: boolean }>(),
  { afterDraft: false, disabled: false },
);

const SEARCH_DEBOUNCE_MS = 300;
const uid = useId();
const owner = useOwnerKey();
const queryClient = useQueryClient();
const actions = new ActionStore();

const linkedQuery = useLinkedNotes(
  () => 'goal',
  () => props.goalId,
);
const linked = computed<ContextDocument[]>(() => linkedQuery.data.value?.items ?? []);
const linkedIds = computed(() => new Set(linked.value.map((note) => note.id)));

const busyId = ref<string | null>(null);
const error = ref<string | null>(null);
const announcement = ref('');
const pickerOpen = ref(false);
const pickerError = ref<string | null>(null);
const searchInput = ref('');
const q = ref('');
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchInput, (value) => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    q.value = Array.from(value.trim()).slice(0, 200).join('');
  }, SEARCH_DEBOUNCE_MS);
});
onBeforeUnmount(() => {
  if (searchTimer !== null) clearTimeout(searchTimer);
});

const candidatesQuery = useQuery({
  queryKey: computed(() => [...noteKeys.list(owner.value, q.value), 'wizard']),
  queryFn: ({ queryKey }) =>
    ownerFenced(keyOwner(queryKey), (binding) =>
      plannerClient.listDocuments({ ...(q.value.length > 0 ? { q: q.value } : {}), limit: 20, signal: binding.signal }),
    ),
  enabled: computed(() => pickerOpen.value),
  retry: retryFenced(),
});
const candidates = computed(() => candidatesQuery.data.value?.items ?? []);

/** Announce politely. A generator: its own wait is fenced like the task's (delegate with `yield*`). */
function* announce(message: string): OwnerSteps<void> {
  announcement.value = '';
  yield nextTick();
  announcement.value = message;
}

async function link(note: ContextDocument): Promise<void> {
  if (props.disabled || busyId.value !== null || linkedIds.value.has(note.id)) return;
  const payload = { targetKind: 'goal' as const, targetId: props.goalId };
  const scope = `note:${note.id}:link:goal:${props.goalId}`;
  const action = actions.begin(scope, payload, (left, right) => left.targetId === right.targetId, note.version);
  busyId.value = note.id;
  pickerError.value = null;
  await runOwnerBound(
    function* (bound) {
      try {
        const updated = yield* bound.wait(plannerClient.linkDocument(note.id, payload, action.key, note.version, bound.signal));
        actions.settle(scope, action);
        yield* bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), updated));
        yield* announce(t('notes.wizard.linked', { title: updated.title }));
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        // 412: the note changed elsewhere; the refreshed list carries its new version.
        if (isApiStatus(cause, 412)) yield* bound.wait(candidatesQuery.refetch());
        pickerError.value = isApiStatus(cause, 422) ? t('notes.links.duplicate') : errorMessage(cause, t('notes.wizard.error'));
      }
    },
    {
      onSettled: () => {
        busyId.value = null;
      },
    },
  );
}

async function unlink(note: ContextDocument): Promise<void> {
  const target = note.links.find((item) => item.targetKind === 'goal' && item.targetId === props.goalId);
  if (props.disabled || busyId.value !== null || target === undefined) return;
  const scope = `note:${note.id}:unlink:${target.id}`;
  const action = actions.begin(scope, { linkId: target.id }, (left, right) => left.linkId === right.linkId, note.version);
  busyId.value = note.id;
  error.value = null;
  await runOwnerBound(
    function* (bound) {
      try {
        const updated = yield* bound.wait(plannerClient.unlinkDocument(note.id, target.id, action.key, note.version, bound.signal));
        actions.settle(scope, action);
        yield* bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), updated));
        yield* announce(t('notes.wizard.unlinked', { title: updated.title }));
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (isApiStatus(cause, 412)) yield* bound.wait(linkedQuery.refetch());
        error.value = errorMessage(cause, t('notes.wizard.error'));
      }
    },
    {
      onSettled: () => {
        busyId.value = null;
      },
    },
  );
}

function openPicker(): void {
  if (props.disabled) return;
  pickerError.value = null;
  searchInput.value = '';
  q.value = '';
  pickerOpen.value = true;
}
</script>

<template>
  <UiCard class="wizard-notes" :aria-labelledby="`${uid}-title`" data-wizard-notes>
    <header class="note-section-header">
      <h2 :id="`${uid}-title`" class="card-title">{{ t('notes.wizard.title') }}</h2>
      <UiButton size="sm" icon="link" :disabled="disabled" data-wizard-notes-add @click="openPicker">{{ t('notes.wizard.add') }}</UiButton>
    </header>
    <p class="muted">{{ t('notes.wizard.lede') }}</p>
    <UiBanner v-if="afterDraft" tone="info" inline>{{ t('notes.wizard.after') }}</UiBanner>
    <p class="visually-hidden" role="status" aria-live="polite">{{ announcement }}</p>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <div v-if="linkedQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('notes.wizard.loading') }}</p>
      <UiSkeleton variant="lines" :lines="2" />
    </div>
    <UiBanner v-else-if="linkedQuery.isError.value" tone="error">
      <p role="alert">{{ t('notes.wizard.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="linkedQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <p v-else-if="linked.length === 0" class="muted" data-wizard-notes-empty>{{ t('notes.wizard.empty') }}</p>
    <ul v-else class="wizard-note-list" :aria-label="t('notes.wizard.list')">
      <li v-for="note in linked" :key="note.id" class="wizard-note" :data-wizard-note="note.id">
        <div class="wizard-note-main">
          <RouterLink :to="`/notes/${note.id}`" class="wizard-note-title">{{ note.title }}</RouterLink>
          <UiBadge v-if="note.llmAllowed" tone="info">{{ t('notes.wizard.allowed') }}</UiBadge>
          <UiBadge v-else tone="neutral">{{ t('notes.wizard.notAllowed') }}</UiBadge>
        </div>
        <p v-if="!note.llmAllowed" class="field-help">{{ t('notes.wizard.notAllowedHelp') }}</p>
        <UiButton
          size="sm"
          variant="ghost"
          icon="close"
          :aria-label="t('notes.wizard.removeAria', { title: note.title })"
          :disabled="disabled || busyId !== null"
          @click="unlink(note)"
        >
          <span class="task-action-label">{{ t('notes.wizard.remove') }}</span>
        </UiButton>
      </li>
    </ul>

    <UiDialog v-if="pickerOpen" :labelledby="`${uid}-picker-title`" :describedby="`${uid}-picker-lede`" class="wizard-note-picker" @close="pickerOpen = false">
      <header class="dialog-header">
        <div class="dialog-heading">
          <h2 :id="`${uid}-picker-title`" class="dialog-title">{{ t('notes.wizard.pickerTitle') }}</h2>
          <p :id="`${uid}-picker-lede`" class="muted">{{ t('notes.wizard.pickerLede') }}</p>
        </div>
      </header>
      <div class="field">
        <label :for="`${uid}-picker-search`" class="field-label">{{ t('notes.wizard.searchLabel') }}</label>
        <input :id="`${uid}-picker-search`" v-model="searchInput" type="search" maxlength="200" autocomplete="off" data-autofocus />
      </div>
      <UiBanner v-if="pickerError" tone="error" role="alert">{{ pickerError }}</UiBanner>
      <div v-if="candidatesQuery.isLoading.value">
        <p class="visually-hidden" role="status">{{ t('notes.wizard.pickerLoading') }}</p>
        <UiSkeleton variant="lines" :lines="3" />
      </div>
      <UiBanner v-else-if="candidatesQuery.isError.value" tone="error" role="alert">{{ t('notes.wizard.pickerError') }}</UiBanner>
      <p v-else-if="candidates.length === 0" class="muted" role="status">{{ t('notes.wizard.pickerEmpty') }}</p>
      <ul v-else class="wizard-picker-list">
        <li v-for="note in candidates" :key="note.id" class="wizard-picker-item" :data-wizard-candidate="note.id">
          <span class="wizard-picker-title">{{ note.title }}</span>
          <UiBadge v-if="note.llmAllowed" tone="info">{{ t('notes.wizard.allowed') }}</UiBadge>
          <UiBadge v-else tone="neutral">{{ t('notes.wizard.notAllowed') }}</UiBadge>
          <UiBadge v-if="linkedIds.has(note.id)" tone="outline">{{ t('notes.wizard.alreadyLinked') }}</UiBadge>
          <UiButton
            v-else
            size="sm"
            icon="link"
            :busy="busyId === note.id"
            :disabled="disabled || busyId !== null"
            :aria-label="t('notes.wizard.linkAria', { title: note.title })"
            @click="link(note)"
          >
            {{ t('notes.wizard.linkAction') }}
          </UiButton>
        </li>
      </ul>
      <div class="dialog-actions dialog-actions--split">
        <RouterLink :to="`/notes/new?link=goal:${goalId}`" class="btn btn--ghost btn--sm">
          <UiIcon name="plus" :size="16" /><span>{{ t('notes.wizard.newNote') }}</span>
        </RouterLink>
        <UiButton @click="pickerOpen = false">{{ t('notes.wizard.close') }}</UiButton>
      </div>
    </UiDialog>
  </UiCard>
</template>
