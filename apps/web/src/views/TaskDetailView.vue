<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ActionStore, isStoredFinalResult, plannerClient, type Task } from '../api';
import LinkedNotesList from '../components/notes/LinkedNotesList.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import {
  findPromotedNote,
  htmlToPlainText,
  isApiStatus,
  keyOwner,
  ownerFenced,
  publishNote,
  retryFenced,
  useLinkTargets,
  useLinkedNotes,
  useOwnerKey,
} from '../composables/notes';
import { t } from '../i18n';
import { browserTimeZone, formatDateTime } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { ownerKeyOf, runOwnerBound } from '../session/ownerBound';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';

/**
 * Task detail (07 §3.5 / §7): the task's short provider description (shown as
 * text only — it may be editor HTML), the notes linked to it, and the one-time
 * "설명을 노트로 승격" copy. 409 means it was promoted before: open that note.
 */
const props = defineProps<{ id: string }>();

const router = useRouter();
const owner = useOwnerKey();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const auth = useAuthStore();
const toast = useToastStore();
const actions = new ActionStore();
const targets = useLinkTargets();
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());

const taskQuery = useQuery({
  queryKey: computed(() => ['task', owner.value, props.id]),
  queryFn: ({ queryKey }) =>
    ownerFenced(keyOwner(queryKey), (binding) => plannerClient.getTask(props.id, { fresh: true, signal: binding.signal })),
  retry: retryFenced(2),
});
const task = computed<Task | null>(() => taskQuery.data.value ?? null);
const notesQuery = useLinkedNotes(
  () => 'task',
  () => props.id,
);
const notes = computed(() => notesQuery.data.value?.items ?? []);

const description = computed(() => {
  const raw = task.value?.description;
  return typeof raw === 'string' ? htmlToPlainText(raw) : '';
});
const projectLink = computed(() => {
  const current = task.value;
  if (current === null) return null;
  const project = targets.projectOf(current.projectId);
  if (project === undefined) return null;
  return project.kind === 'inbox'
    ? { to: '/inbox', title: t('nav.inbox') }
    : { to: `/projects/${project.id}`, title: project.title };
});

const statusTone = computed(() => {
  switch (task.value?.status) {
    case 'done':
      return 'success' as const;
    case 'in_progress':
      return 'info' as const;
    default:
      return 'neutral' as const;
  }
});

const promoting = ref(false);
const promoteError = ref<string | null>(null);

async function promote(): Promise<void> {
  const current = task.value;
  if (current === null || promoting.value || !offline.mutationsEnabled) return;
  const scope = `task:${current.id}:promote`;
  const action = actions.begin(scope, { taskId: current.id }, (left, right) => left.taskId === right.taskId, current.version);
  promoting.value = true;
  promoteError.value = null;
  // Owner isolation (ADR-023): cache, toast and navigation only for the owner who promoted.
  await runOwnerBound(
    async (bound) => {
      try {
        const note = await bound.wait(plannerClient.promoteTaskDescription(current.id, action.key, current.version, bound.signal));
        actions.settle(scope, action);
        await bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), note));
        toast.show(t('notes.promote.done'));
        await bound.wait(router.push(`/notes/${note.id}`));
      } catch (cause) {
        bound.rethrowIfStale(cause);
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (isApiStatus(cause, 409)) {
          try {
            const existing = await bound.wait(findPromotedNote(current.id, bound.binding));
            if (existing === null) {
              promoteError.value = t('notes.promote.existsMissing');
              return;
            }
            toast.show(t('notes.promote.exists'));
            await bound.wait(router.push(`/notes/${existing.id}`));
          } catch (lookup) {
            bound.rethrowIfStale(lookup);
            promoteError.value = errorMessage(lookup, t('notes.promote.existsMissing'));
          }
        } else if (isApiStatus(cause, 412)) {
          await bound.wait(taskQuery.refetch());
          promoteError.value = t('notes.promote.conflict');
        } else if (isApiStatus(cause, 422)) {
          promoteError.value = t('notes.promote.empty');
        } else {
          promoteError.value = errorMessage(cause, t('notes.promote.error'));
        }
      }
    },
    {
      onSettled: () => {
        promoting.value = false;
      },
    },
  );
}
</script>

<template>
  <section class="page task-detail" aria-labelledby="task-detail-title" data-task-detail>
    <header class="page-header">
      <div class="page-heading">
        <p class="breadcrumb">
          <RouterLink :to="projectLink?.to ?? '/inbox'"><UiIcon name="arrow-left" :size="16" />{{ projectLink?.title ?? t('notes.task.back') }}</RouterLink>
        </p>
        <h1 id="task-detail-title">{{ task?.title ?? t('notes.task.details') }}</h1>
        <p class="page-lede">{{ t('notes.task.lede') }}</p>
      </div>
    </header>

    <div v-if="taskQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('notes.task.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="2" />
    </div>
    <UiBanner v-else-if="isApiStatus(taskQuery.error.value, 404)" tone="warn" role="alert">{{ t('notes.task.notFound') }}</UiBanner>
    <UiBanner v-else-if="taskQuery.isError.value || task === null" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('notes.task.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="taskQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <div v-else class="task-detail-layout">
      <UiCard class="task-detail-card" aria-labelledby="task-detail-info">
        <h2 id="task-detail-info" class="card-title">{{ t('notes.task.details') }}</h2>
        <dl class="kv-list">
          <div>
            <dt>{{ t('notes.task.status') }}</dt>
            <dd><UiBadge :tone="statusTone">{{ t(`task.status.${task.status}`) }}</UiBadge></dd>
          </div>
          <div>
            <dt>{{ t('notes.task.due') }}</dt>
            <dd class="tabular">{{ task.dueAt ? formatDateTime(task.dueAt, timeZone) : t('notes.task.noDue') }}</dd>
          </div>
          <div v-if="projectLink">
            <dt>{{ t('notes.task.project') }}</dt>
            <dd><RouterLink :to="projectLink.to">{{ projectLink.title }}</RouterLink></dd>
          </div>
        </dl>

        <section class="task-detail-description" aria-labelledby="task-detail-description">
          <h3 id="task-detail-description" class="note-section-title">{{ t('notes.task.description') }}</h3>
          <p class="field-help">{{ t('notes.task.descriptionHelp') }}</p>
          <p v-if="description" class="task-description-text" data-task-description>{{ description }}</p>
          <p v-else class="muted">{{ t('notes.promote.noDescription') }}</p>
          <div class="task-promote">
            <UiButton
              icon="note"
              :busy="promoting"
              :disabled="!description || promoting || !offline.mutationsEnabled"
              aria-describedby="task-promote-help"
              data-task-promote
              @click="promote"
            >
              {{ promoting ? t('notes.promote.busy') : t('notes.promote.action') }}
            </UiButton>
            <p id="task-promote-help" class="field-help">{{ t('notes.promote.help') }}</p>
            <UiBanner v-if="promoteError" tone="error" role="alert" data-task-promote-error>{{ promoteError }}</UiBanner>
          </div>
        </section>
      </UiCard>

      <UiCard class="task-detail-notes" aria-labelledby="task-detail-notes">
        <header class="note-section-header">
          <h2 id="task-detail-notes" class="card-title">{{ t('notes.task.notesTitle') }}</h2>
          <RouterLink :to="`/notes/new?link=task:${task.id}`" class="btn btn--secondary btn--sm" data-task-new-note>
            <UiIcon name="plus" :size="16" /><span>{{ t('notes.task.newNote') }}</span>
          </RouterLink>
        </header>
        <LinkedNotesList
          :notes="notes"
          :loading="notesQuery.isLoading.value"
          :failed="notesQuery.isError.value"
          :empty-text="t('notes.task.notesEmpty')"
          :loading-text="t('notes.task.notesLoading')"
          :error-text="t('notes.task.notesLoadError')"
          :label="t('notes.task.notesTitle')"
          @retry="notesQuery.refetch()"
        />
      </UiCard>
    </div>
  </section>
</template>
