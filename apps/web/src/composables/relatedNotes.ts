import { computed, type ComputedRef } from 'vue';
import { useRoute } from 'vue-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/vue-query';
import { plannerClient, type ContextDocument, type DocumentTargetKind, type IntakeSession } from '../api';
import { useLayoutContext } from '../layout/context';
import { useLayoutNow } from '../layout/now';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { useSessionStore } from '../stores/session';
import { focusContextFor } from './focusContext';
import { isApiStatus, noteKeys, useOwnerKey } from './notes';

/**
 * RelatedNotes (07 §3.4 "관련 노트 3개", §2.1 `RelatedNotes{limit}`): notes
 * linked to what the user is working on right now. The context is, in order:
 *
 * 1. the task of the focus session on screen (or the running one) and its project;
 * 2. on a planning session page, the plan's goal;
 * 3. on an open note, the targets that note is linked to (the note itself excluded);
 * 4. on the daily workspace, the task of the next block today and its project.
 *
 * Each target is one `GET /documents?targetKind&targetId` (owner-scoped cache);
 * the results are merged, newest first, at most `limit`.
 */

export interface RelatedTarget {
  readonly kind: DocumentTargetKind;
  readonly id: string;
}

export type RelatedContext =
  | { readonly kind: 'task'; readonly title: string | null; readonly targets: readonly RelatedTarget[] }
  | { readonly kind: 'goal'; readonly targets: readonly RelatedTarget[] }
  | { readonly kind: 'note'; readonly noteId: string; readonly targets: readonly RelatedTarget[] }
  | { readonly kind: 'none'; readonly targets: readonly RelatedTarget[] };

export interface RelatedNote {
  readonly note: ContextDocument;
  readonly via: DocumentTargetKind;
}

/** At most this many targets are queried for one panel (an open note can have 50 links). */
const MAX_TARGETS = 4;

/** Merge per-target pages: first reason wins, newest first, owner's note excluded. */
export function mergeRelated(
  pages: readonly { readonly target: RelatedTarget; readonly items: readonly ContextDocument[] }[],
  limit: number,
  exclude: string | null,
): RelatedNote[] {
  const seen = new Map<string, RelatedNote>();
  for (const page of pages) {
    for (const note of page.items) {
      if (note.id === exclude || seen.has(note.id)) continue;
      seen.set(note.id, { note, via: page.target.kind });
    }
  }
  return [...seen.values()]
    .sort((left, right) => right.note.updatedAt.localeCompare(left.note.updatedAt) || left.note.id.localeCompare(right.note.id))
    .slice(0, Math.max(0, limit));
}

function param(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function useRelatedNotes(limit: () => number) {
  const route = useRoute();
  const context = useLayoutContext();
  const sessions = useSessionStore();
  const owner = useOwnerKey();
  const queryClient = useQueryClient();
  const now = useLayoutNow();

  const sessionId = computed(() => {
    const signals = context.signals.value;
    return signals.route === 'focus'
      ? (signals.routeSessionId ?? signals.activeSessionId)
      : (signals.activeSessionId ?? signals.routeSessionId);
  });

  /** The task being worked on: the focus session's, else the next block of today. */
  const currentTask = computed<{ id: string; title: string | null } | null>(() => {
    const id = sessionId.value;
    if (id !== null) {
      const session = sessions.get(id);
      if (session !== null) {
        const focus = focusContextFor(sessions.ownerId, session.blockId, session.taskId);
        const block = context.today.value?.blocks.find((item) => item.taskId === session.taskId);
        return { id: session.taskId, title: focus?.title ?? block?.title ?? null };
      }
    }
    if (context.signals.value.route !== 'today' && context.signals.value.route !== 'focus') return null;
    const today = context.today.value;
    if (today === null) return null;
    const at = now.value;
    const next = today.blocks.find(
      (block) =>
        block.status !== 'done' && block.status !== 'skipped' && block.status !== 'superseded' && Date.parse(block.endAt) > at,
    );
    return next === undefined ? null : { id: next.taskId, title: next.title };
  });

  const taskQuery = useQuery({
    queryKey: computed(() => ['task', owner.value, currentTask.value?.id ?? 'none']),
    queryFn: () => plannerClient.getTask(currentTask.value?.id ?? '', { fresh: true }),
    enabled: computed(() => currentTask.value !== null),
    retry: (count, cause) => !isApiStatus(cause, 404) && count < 1,
    staleTime: 60_000,
  });

  const planningSessionId = computed(() => (route.name === 'plan-session' ? param(route.params['sessionId']) : null));
  const intakeQuery = useQuery({
    queryKey: computed(() => ['intake', planningSessionId.value ?? '']),
    queryFn: () => plannerClient.getIntakeSession(planningSessionId.value ?? '', { fresh: true }),
    enabled: computed(() => planningSessionId.value !== null && currentTask.value === null),
  });

  const openNoteId = computed(() => (route.name === 'notes-detail' ? param(route.params['id']) : null));
  const openNote = computed<ContextDocument | null>(() => {
    const id = openNoteId.value;
    if (id === null) return null;
    return queryClient.getQueryData<ContextDocument>(noteKeys.doc(owner.value, id)) ?? null;
  });
  // Re-read the cached note when its query updates (link changes).
  const openNoteQuery = useQuery({
    queryKey: computed(() => noteKeys.doc(owner.value, openNoteId.value ?? 'new')),
    queryFn: () => {
      const binding = captureOwnerBinding();
      return plannerClient.getDocument(openNoteId.value ?? '', binding.signal);
    },
    enabled: computed(() => openNoteId.value !== null && currentTask.value === null),
    refetchOnWindowFocus: false,
    retry: false,
  });

  const related = computed<RelatedContext>(() => {
    const task = currentTask.value;
    if (task !== null) {
      const targets: RelatedTarget[] = [{ kind: 'task', id: task.id }];
      const projectId = taskQuery.data.value?.projectId;
      if (projectId !== undefined) targets.push({ kind: 'project', id: projectId });
      return { kind: 'task', title: task.title ?? taskQuery.data.value?.title ?? null, targets };
    }
    const intake: IntakeSession | undefined = intakeQuery.data.value;
    if (planningSessionId.value !== null && intake?.goalId !== undefined) {
      return { kind: 'goal', targets: [{ kind: 'goal', id: intake.goalId }] };
    }
    const note = openNoteQuery.data.value ?? openNote.value;
    if (openNoteId.value !== null && note !== null && note !== undefined) {
      return {
        kind: 'note',
        noteId: note.id,
        targets: note.links.slice(0, MAX_TARGETS).map((link) => ({ kind: link.targetKind, id: link.targetId })),
      };
    }
    return { kind: 'none', targets: [] };
  });

  const queries = useQueries({
    queries: computed(() =>
      related.value.targets.map((target) => ({
        queryKey: [...noteKeys.linked(owner.value, target.kind, target.id), limit() + 1],
        queryFn: () => {
          const binding = captureOwnerBinding();
          // One extra: the open note itself may be in the page.
          return plannerClient.listDocuments({ targetKind: target.kind, targetId: target.id, limit: limit() + 1, signal: binding.signal });
        },
      })),
    ),
  });

  const notes: ComputedRef<RelatedNote[]> = computed(() => {
    const current = related.value;
    const pages = current.targets.flatMap((target, index) => {
      const data = queries.value[index]?.data;
      return data === undefined ? [] : [{ target, items: data.items }];
    });
    return mergeRelated(pages, limit(), current.kind === 'note' ? current.noteId : null);
  });

  const loading = computed(
    () => related.value.targets.length > 0 && queries.value.some((query) => query.isLoading) && notes.value.length === 0,
  );
  const failed = computed(() => queries.value.length > 0 && queries.value.every((query) => query.isError));

  function retry(): void {
    for (const query of queries.value) void query.refetch();
  }

  return { context: related, notes, loading, failed, retry };
}
