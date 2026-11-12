import { computed } from 'vue';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/vue-query';
import {
  ApiError,
  plannerClient,
  type ContextDocument,
  type DocumentLink,
  type DocumentTargetKind,
  type IntakeSession,
  type Project,
  type Task,
} from '../api';
import type { OwnerBinding } from '../session/ownerEpoch';
import {
  MAX_LOOKUP_PAGES,
  OwnerChangedError,
  assertOwnerCurrent,
  collectPages,
  ownerFenced,
  ownerKeyOf,
  useOwnerKey,
} from '../session/ownerBound';

/**
 * Shared notes plumbing (M6-03). Owner isolation (ADR-023, M6-03R-1 H1):
 *
 * - every cache key starts with the owner it belongs to;
 * - every lookup runs inside `ownerFenced`: ONE OwnerBinding for the whole
 *   lookup (all pages), its AbortSignal on every request, the key's owner must
 *   be the bound owner, and the binding is re-checked after every await —
 *   before the next page is fetched and before anything is returned (and so
 *   cached). A stale lookup throws `OwnerChangedError`: nothing of it is kept.
 *
 * The fence itself is the app-wide primitive in session/ownerBound.ts
 * (FU-77); it is re-exported here for the notes screens.
 */
export { MAX_LOOKUP_PAGES, OwnerChangedError, assertOwnerCurrent, collectPages, ownerFenced, ownerKeyOf, useOwnerKey };

export const NOTE_BODY_MAX = 65_536;
export const NOTE_TITLE_MAX = 200;
export const NOTE_PAGE_SIZE = 20;
/** Notes shown in a "linked to this" list (project tab, task detail, wizard). */
export const LINKED_NOTES_LIMIT = 50;

/** The owner a notes/task cache key belongs to (second key segment). */
export function keyOwner(queryKey: readonly unknown[]): string {
  return String(queryKey[1]);
}

/** Retry transient failures only: never a stale-owner lookup or a 404. */
export function retryFenced(limit = 2): (count: number, cause: unknown) => boolean {
  return (count, cause) => !(cause instanceof OwnerChangedError) && !isApiStatus(cause, 404) && count < limit;
}

export const noteKeys = {
  all: (owner: string) => ['notes', owner] as const,
  list: (owner: string, q: string) => ['notes', owner, 'list', q] as const,
  doc: (owner: string, id: string) => ['notes', owner, 'doc', id] as const,
  usage: (owner: string, id: string) => ['notes', owner, 'usage', id] as const,
  linked: (owner: string, kind: DocumentTargetKind, id: string) => ['notes', owner, 'linked', kind, id] as const,
  targets: (owner: string, kind: 'project' | 'task') => ['notes', owner, 'targets', kind] as const,
};

/** Unicode code points: the API measures `bodyMd` this way (Ajv `unicode`). */
export function codePointLength(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

/** Store a fresh note everywhere it is cached and refresh every list. */
export async function publishNote(queryClient: QueryClient, owner: string, note: ContextDocument): Promise<void> {
  queryClient.setQueryData(noteKeys.doc(owner, note.id), note);
  await queryClient.invalidateQueries({
    queryKey: noteKeys.all(owner),
    predicate: (query) => query.queryKey[2] !== 'doc' && query.queryKey[2] !== 'targets',
  });
}

export async function forgetNote(queryClient: QueryClient, owner: string, noteId: string): Promise<void> {
  queryClient.removeQueries({ queryKey: noteKeys.doc(owner, noteId) });
  queryClient.removeQueries({ queryKey: noteKeys.usage(owner, noteId) });
  await queryClient.invalidateQueries({
    queryKey: noteKeys.all(owner),
    predicate: (query) => query.queryKey[2] !== 'targets',
  });
}

/** Notes linked to one goal/project/task (newest first, one page of 50). */
export function useLinkedNotes(
  kind: () => DocumentTargetKind,
  targetId: () => string | null,
  options: { limit?: () => number } = {},
) {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => [...noteKeys.linked(owner.value, kind(), targetId() ?? 'none'), options.limit?.() ?? LINKED_NOTES_LIMIT]),
    queryFn: ({ queryKey }) =>
      ownerFenced(keyOwner(queryKey), async (binding) => {
        const id = targetId();
        if (id === null) return { items: [], nextCursor: null };
        return plannerClient.listDocuments({
          targetKind: kind(),
          targetId: id,
          limit: options.limit?.() ?? LINKED_NOTES_LIMIT,
          signal: binding.signal,
        });
      }),
    enabled: computed(() => targetId() !== null),
    retry: retryFenced(),
  });
}

/**
 * A 409 on promote means a live promoted note already exists; the API does not
 * say which one, so search the task's linked notes page by page (M6-03R-1 M2),
 * under the caller's binding, until it is found or the pages run out.
 */
export async function findPromotedNote(taskId: string, binding: OwnerBinding): Promise<ContextDocument | null> {
  const { found } = await collectPages(
    binding,
    (cursor, signal) =>
      plannerClient.listDocuments({
        targetKind: 'task',
        targetId: taskId,
        limit: LINKED_NOTES_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
        signal,
      }),
    {
      maxPages: 20,
      until: (note) => note.source === 'task_description' && note.sourceTaskId === taskId,
    },
  );
  return found;
}

export function isApiStatus(cause: unknown, status: number): cause is ApiError {
  return cause instanceof ApiError && cause.status === status;
}

/**
 * Projects and tasks a note can be linked to, with names for its existing
 * links. Goals have no list endpoint: a goal is named when its planning
 * session is cached on this device (the wizard), otherwise it stays generic.
 * Each list is ONE owner-fenced lookup over all its pages (M6-03R-1 H1).
 */
export function useLinkTargets(enabled: () => boolean = () => true) {
  const owner = useOwnerKey();
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: computed(() => noteKeys.targets(owner.value, 'project')),
    queryFn: ({ queryKey }) =>
      ownerFenced(keyOwner(queryKey), async (binding) => {
        const { items } = await collectPages<Project>(binding, (cursor, signal) =>
          plannerClient.listProjects({ limit: 100, ...(cursor === undefined ? {} : { cursor }), signal }),
        );
        return items;
      }),
    enabled: computed(enabled),
    staleTime: 30_000,
    retry: retryFenced(),
  });
  const tasksQuery = useQuery({
    queryKey: computed(() => noteKeys.targets(owner.value, 'task')),
    queryFn: ({ queryKey }) =>
      ownerFenced(keyOwner(queryKey), async (binding) => {
        const { items } = await collectPages<Task>(binding, (cursor, signal) =>
          plannerClient.listTasks({ limit: 100, ...(cursor === undefined ? {} : { cursor }), signal }),
        );
        return items.filter((task) => task.deletedAt === undefined);
      }),
    enabled: computed(enabled),
    staleTime: 30_000,
    retry: retryFenced(),
  });

  const projects = computed(() => (projectsQuery.data.value ?? []).filter((project) => !project.archived));
  const tasks = computed(() => tasksQuery.data.value ?? []);
  const projectNames = computed(() => new Map((projectsQuery.data.value ?? []).map((project) => [project.id, project] as const)));
  const taskNames = computed(() => new Map(tasks.value.map((task) => [task.id, task.title] as const)));

  function goalTitle(goalId: string): string | null {
    for (const [, data] of queryClient.getQueriesData<IntakeSession>({ queryKey: ['intake'] })) {
      if (data !== undefined && data !== null && data.goalId === goalId) return data.input.title;
    }
    return null;
  }

  return {
    projectsQuery,
    tasksQuery,
    projects,
    tasks,
    loading: computed(() => projectsQuery.isLoading.value || tasksQuery.isLoading.value),
    failed: computed(() => projectsQuery.isError.value || tasksQuery.isError.value),
    projectOf: (id: string): Project | undefined => projectNames.value.get(id),
    taskTitle: (id: string): string | undefined => taskNames.value.get(id),
    goalTitle,
  };
}

export type LinkTargets = ReturnType<typeof useLinkTargets>;

/** Same target? (a link and a picker option). */
export function sameTarget(link: Pick<DocumentLink, 'targetKind' | 'targetId'>, kind: DocumentTargetKind, id: string): boolean {
  return link.targetKind === kind && link.targetId === id;
}

/**
 * Three-way merge of the editable fields after the server version moved for
 * another reason (a link change): a field the user did not touch follows the
 * server, a field they edited keeps their text.
 */
export function rebaseFields<T extends Record<string, unknown>>(local: T, base: T, next: T): T {
  const merged = { ...next };
  for (const key of Object.keys(local) as (keyof T)[]) {
    if (local[key] !== base[key]) merged[key] = local[key];
  }
  return merged;
}

/** Parse `?link=project:<id>` (new note pre-linked from a project/task/plan screen). */
export function parsePresetLink(value: unknown): { targetKind: DocumentTargetKind; targetId: string } | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const match = /^(goal|project|task):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
  if (match === null) return null;
  return { targetKind: match[1] as DocumentTargetKind, targetId: (match[2] as string).toLowerCase() };
}

/** Task descriptions from the provider may be editor HTML: show text only. */
export function htmlToPlainText(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    // An inert document: no script runs and no resource loads.
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const element of parsed.querySelectorAll('br')) element.replaceWith('\n');
    for (const element of parsed.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')) element.append('\n');
    return (parsed.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
