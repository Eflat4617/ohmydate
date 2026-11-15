<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ActionStore, isStoredFinalResult, plannerClient, type Task } from '../api';
import DurationNumeral from '../components/overview/DurationNumeral.vue';
import LinkedNotesList from '../components/notes/LinkedNotesList.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
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
import { readSessionsOf, useFocusStart, useRunningSession } from '../composables/useOverview';
import { readScheduleBlocks } from '../composables/usePlannerRange';
import { minutesOfSeconds, newestFirst, projectHue, sessionFocusedSec } from '../domain/overview';
import { addDaysToDate, todayInZone, zonedWallClockToInstant } from '../domain/time';
import { t, tp } from '../i18n';
import {
  browserTimeZone,
  formatDate,
  formatDateTime,
  formatDateTimeRange,
  formatDuration,
  formatTime,
  formatTimeRange,
} from '../i18n/format';
import { useLayoutNow } from '../layout/now';
import { errorMessage } from '../i18n/problem';
import { ownerKeyOf, runOwnerBound } from '../session/ownerBound';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';

/**
 * Task detail (07 §3.5 / §7): the task's short provider description (shown as
 * text only — it may be editor HTML), the notes linked to it, and the one-time
 * "설명을 노트로 승격" copy. 409 means it was promoted before: open that note.
 *
 * HOLO-02: a two-column page of cards. At the left the task itself (state,
 * deadline, project, description); at the right what belongs to it — its
 * blocks to come, its focus record of the last four weeks, its notes. The
 * page's one filled button starts a focus session on the task. No id and no
 * version number is on the page.
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
    ? { to: '/tasks', title: t('nav.inbox') }
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

const overdue = computed(() => {
  const current = task.value;
  return current !== null && current.status !== 'done' && current.dueAt !== undefined && Date.parse(current.dueAt) < now.value;
});
const projectTag = computed(() => {
  const current = task.value;
  const project = current === null ? undefined : targets.projectOf(current.projectId);
  return project === undefined ? null : projectHue(project.id);
});

// ── What belongs to the task: its blocks and its focus sessions ─────────
/** How many blocks to come the card lists before it counts the rest. */
const BLOCK_ROWS = 4;
const SESSION_ROWS = 5;

const now = useLayoutNow();
const today = computed(() => todayInZone(timeZone.value, now.value));

/**
 * Blocks from two weeks back to four weeks ahead (42 days, the month page's
 * bound) and the sessions of the last four weeks, both narrowed to this task
 * here: neither list can be asked for one task.
 */
const relatedQuery = useQuery({
  queryKey: computed(() => ['task-related', owner.value, props.id, today.value, timeZone.value]),
  queryFn: ({ queryKey }) =>
    ownerFenced(keyOwner(queryKey), async (binding) => {
      const taskId = String(queryKey[2]);
      const day = String(queryKey[3]);
      const zone = String(queryKey[4]);
      const at = (offset: number): string => zonedWallClockToInstant(addDaysToDate(day, offset), 0, zone);
      const [blocks, sessions] = await Promise.all([
        readScheduleBlocks(binding, { from: at(-14), to: at(28) }),
        readSessionsOf(binding, { from: at(-27), to: at(1) }),
      ]);
      return {
        blocks: blocks.items.filter((block) => block.taskId === taskId),
        sessions: sessions.sessions.filter((session) => session.taskId === taskId),
        truncated: blocks.truncated || sessions.truncated,
      };
    }),
  retry: retryFenced(2),
});

const upcomingBlocks = computed(() =>
  (relatedQuery.data.value?.blocks ?? [])
    .filter((block) => block.status === 'planned' && Date.parse(block.endAt) > now.value)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)),
);
const doneBlocks = computed(
  () => (relatedQuery.data.value?.blocks ?? []).filter((block) => block.status === 'done').length,
);
const sessions = computed(() => newestFirst(relatedQuery.data.value?.sessions ?? []));
const focusedMin = computed(() =>
  minutesOfSeconds(sessions.value.reduce((sum, session) => sum + sessionFocusedSec(session, now.value), 0)),
);
const SESSION_TONES = { active: 'accent', paused: 'warn', completed: 'success', abandoned: 'neutral' } as const;

// ── The page's one filled button: start a focus session on this task ────
const { running, refetch: refetchRunning } = useRunningSession();
const focus = useFocusStart({ onActiveExists: refetchRunning });

function start(): void {
  const current = task.value;
  if (current === null) return;
  // The next block of this task, when it has one, is what the session is for.
  const block = upcomingBlocks.value[0];
  void focus.start(
    block === undefined
      ? { taskId: current.id, title: current.title }
      : { taskId: current.id, blockId: block.id, title: current.title },
  );
}

function resume(): void {
  const session = running.value;
  if (session !== null) void router.push(`/focus/${session.id}`);
}

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
    function* (bound) {
      try {
        const note = yield* bound.wait(plannerClient.promoteTaskDescription(current.id, action.key, current.version, bound.signal));
        actions.settle(scope, action);
        yield* bound.wait(publishNote(queryClient, ownerKeyOf(bound.ownerId), note));
        toast.show(t('notes.promote.done'));
        yield* bound.wait(router.push(`/notes/${note.id}`));
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (isApiStatus(cause, 409)) {
          try {
            const existing = yield* bound.wait(findPromotedNote(current.id, bound.binding));
            if (existing === null) {
              promoteError.value = t('notes.promote.existsMissing');
              return;
            }
            toast.show(t('notes.promote.exists'));
            yield* bound.wait(router.push(`/notes/${existing.id}`));
          } catch (lookup) {
            promoteError.value = errorMessage(lookup, t('notes.promote.existsMissing'));
          }
        } else if (isApiStatus(cause, 412)) {
          yield* bound.wait(taskQuery.refetch());
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
  <section class="page page--wide task-page task-detail" aria-labelledby="task-detail-title" data-task-detail>
    <header class="page-header">
      <div class="page-heading">
        <p class="breadcrumb">
          <RouterLink :to="projectLink?.to ?? '/tasks'"><UiIcon name="arrow-left" :size="16" />{{ projectLink?.title ?? t('notes.task.back') }}</RouterLink>
        </p>
        <h1 id="task-detail-title">{{ task?.title ?? t('notes.task.details') }}</h1>
      </div>
      <div v-if="task" class="page-actions">
        <UiButton v-if="running" icon="play" data-task-resume @click="resume">{{ t('overview.resume') }}</UiButton>
        <UiButton
          v-else-if="task.status !== 'done'"
          variant="primary"
          icon="play"
          :disabled="!focus.canStart.value"
          :busy="focus.startingTaskId.value !== null"
          data-task-start
          @click="start"
        >
          {{ focus.startingTaskId.value !== null ? t('overview.starting') : t('taskDetail.startFocus') }}
        </UiButton>
        <!-- The selection travels: this task arrives picked in 계획 (FLOW §5). -->
        <RouterLink
          v-if="task.status !== 'done'"
          class="btn"
          :to="{ path: '/plan/schedule', query: { taskIds: task.id } }"
          data-task-to-plan
        >
          <UiIcon name="plan" :size="18" class="btn-icon" />{{ t('tasks.toPlan') }}
        </RouterLink>
      </div>
    </header>

    <UiBanner v-if="focus.error.value" tone="error" role="alert" data-task-start-error>{{ focus.error.value }}</UiBanner>

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

    <div v-else class="task-page-grid">
      <UiCard class="task-page-main" aria-labelledby="task-detail-info" data-task-fields>
        <h2 id="task-detail-info" class="card-title">
          <UiIcon name="check-circle" :size="18" />
          {{ t('notes.task.details') }}
        </h2>
        <dl class="task-fields">
          <div>
            <dt>{{ t('notes.task.status') }}</dt>
            <dd><UiBadge :tone="statusTone">{{ t(`task.status.${task.status}`) }}</UiBadge></dd>
          </div>
          <div>
            <dt>{{ t('notes.task.due') }}</dt>
            <dd class="tabular" data-task-due>
              {{ task.dueAt ? formatDateTime(task.dueAt, timeZone) : t('notes.task.noDue') }}
              <UiBadge v-if="overdue" tone="danger">{{ t('task.overdue') }}</UiBadge>
            </dd>
          </div>
          <div v-if="projectLink">
            <dt>{{ t('notes.task.project') }}</dt>
            <dd>
              <RouterLink :to="projectLink.to" class="badge" :class="projectTag ? `badge--${projectTag}` : null" data-task-project>
                {{ projectLink.title }}
              </RouterLink>
            </dd>
          </div>
        </dl>

        <section class="task-describe" aria-labelledby="task-detail-description">
          <h3 id="task-detail-description" class="h3">{{ t('notes.task.description') }}</h3>
          <p class="field-help">{{ t('notes.task.descriptionHelp') }}</p>
          <p v-if="description" class="task-describe-text" data-task-description>{{ description }}</p>
          <p v-else class="muted">{{ t('notes.promote.noDescription') }}</p>
          <div class="task-describe-promote">
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

      <div class="task-page-side">
        <UiCard aria-labelledby="task-detail-blocks" data-task-blocks>
          <header class="card-header">
            <h2 id="task-detail-blocks" class="card-title">
              <UiIcon name="month" :size="18" />
              {{ t('taskDetail.blocks.title') }}
            </h2>
            <RouterLink to="/planner" class="icon-link" :aria-label="t('taskDetail.blocks.open')">
              <UiIcon name="open" :size="16" />
            </RouterLink>
          </header>
          <div v-if="relatedQuery.isLoading.value" aria-hidden="true">
            <UiSkeleton variant="lines" :lines="2" />
          </div>
          <p v-else-if="relatedQuery.isError.value && !relatedQuery.data.value" class="task-related-error" role="alert">
            {{ t('taskDetail.relatedError') }}
            <UiButton size="sm" icon="sync" data-task-related-retry @click="relatedQuery.refetch()">{{ t('common.retry') }}</UiButton>
          </p>
          <template v-else>
            <ul v-if="upcomingBlocks.length > 0" class="task-related-list">
              <li v-for="block in upcomingBlocks.slice(0, BLOCK_ROWS)" :key="block.id" class="task-related-item" data-task-block>
                <span class="task-related-when">{{ formatDateTimeRange(block.startAt, block.endAt, timeZone) }}</span>
                <span class="task-related-meta">
                  <span class="tabular">{{ formatDuration(Math.round((Date.parse(block.endAt) - Date.parse(block.startAt)) / 60000)) }}</span>
                  <UiBadge v-if="block.locked" tone="outline"><UiIcon name="lock" :size="12" />{{ t('blockLock.locked') }}</UiBadge>
                </span>
              </li>
            </ul>
            <UiEmptyState v-else :icon="null" compact :title="t('taskDetail.blocks.empty')" data-task-blocks-empty>
              {{ t('taskDetail.blocks.emptyBody') }}
            </UiEmptyState>
            <p v-if="upcomingBlocks.length > BLOCK_ROWS" class="task-related-note">
              {{ tp('taskDetail.blocks.more', upcomingBlocks.length - BLOCK_ROWS) }}
            </p>
            <p v-if="doneBlocks > 0" class="task-related-note" data-task-blocks-done>{{ tp('taskDetail.blocks.done', doneBlocks) }}</p>
          </template>
        </UiCard>

        <UiCard aria-labelledby="task-detail-sessions" data-task-sessions>
          <header class="card-header">
            <h2 id="task-detail-sessions" class="card-title">
              <UiIcon name="timer" :size="18" />
              {{ t('taskDetail.sessions.title') }}
            </h2>
            <RouterLink to="/focus" class="icon-link" :aria-label="t('overview.tracker.open')">
              <UiIcon name="open" :size="16" />
            </RouterLink>
          </header>
          <div v-if="relatedQuery.isLoading.value" aria-hidden="true">
            <UiSkeleton variant="lines" :lines="2" />
          </div>
          <template v-else-if="relatedQuery.data.value">
            <template v-if="sessions.length > 0">
              <div class="task-related-figure">
                <DurationNumeral :minutes="focusedMin" />
                <p class="task-related-note">
                  {{ t('taskDetail.sessions.total') }} · {{ tp('taskDetail.sessions.count', sessions.length) }}
                </p>
              </div>
              <ul class="task-related-list">
                <li v-for="session in sessions.slice(0, SESSION_ROWS)" :key="session.id" class="task-related-item" data-task-session>
                  <span class="task-related-when">
                    {{ formatDate(session.startedAt, timeZone) }}
                    {{
                      session.endedAt
                        ? formatTimeRange(session.startedAt, session.endedAt, timeZone)
                        : t('overview.log.untilNow', { start: formatTime(session.startedAt, timeZone) })
                    }}
                  </span>
                  <span class="task-related-meta">
                    <span class="tabular">{{ formatDuration(minutesOfSeconds(sessionFocusedSec(session, now))) }}</span>
                    <UiBadge :tone="SESSION_TONES[session.state]">{{ t(`overview.log.state.${session.state}`) }}</UiBadge>
                  </span>
                </li>
              </ul>
            </template>
            <UiEmptyState v-else :icon="null" compact :title="t('taskDetail.sessions.empty')" data-task-sessions-empty />
            <p v-if="relatedQuery.data.value.truncated" class="task-related-note">{{ t('taskDetail.sessions.truncated') }}</p>
          </template>
        </UiCard>

        <UiCard class="task-detail-notes" aria-labelledby="task-detail-notes">
          <header class="note-section-header">
            <h2 id="task-detail-notes" class="card-title">
              <UiIcon name="note" :size="18" />
              {{ t('notes.task.notesTitle') }}
            </h2>
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
    </div>
  </section>
</template>
