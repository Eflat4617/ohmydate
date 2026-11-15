import { computed, ref } from 'vue';
import { ActionStore, ApiError, isStoredFinalResult, plannerClient, type PlannerClient, type Project, type Task, type TaskPatch } from '../api';
import { t } from '../i18n';
import { errorMessage } from '../i18n/problem';
import { runOwnerBound, type OwnerScope, type OwnerSteps, type OwnerTask } from '../session/ownerBound';
import { RANGE_MAX_PAGES, RANGE_PAGE_SIZE } from './usePlannerRange';

/**
 * What the 할 일 canvas does to folders and to where a to-do is (HOLO-05).
 * A folder is a project: made with `POST /projects`, renamed and archived
 * with `PATCH /projects/{id}` (FOLD-01), and a to-do is filed by changing its
 * `projectId`. Nothing here deletes a to-do.
 *
 * **Removing a folder has one safe order**, fixed by how the backend behaves:
 * it refuses every write to a to-do inside an archived folder, hides that
 * folder from the project list and hides its to-dos from the task list. So:
 *
 *   1. move EVERY to-do of the folder — open and finished — to the inbox, one
 *      by one; if a move fails, stop there and say so (the folder stays,
 *      partly emptied, and is never archived with things inside);
 *   2. only when the server says the folder is empty, archive it.
 *
 * Undo runs the other way round: bring the folder back FIRST (with the id
 * and the version this page still holds — the list no longer returns it),
 * THEN move the to-dos back into it.
 *
 * A change that names one field (`projectId`, `dueAt`) is retried once on a
 * 412 against the to-do's newest version: it does not overwrite what the
 * other change was about. Every request runs in an owner-bound task under
 * one idempotency key per logical action (ADR-023, 08 §1).
 */
export interface RemovedFolder {
  /** The folder as the archive answered: its id and the version an un-archive must send. */
  readonly project: Project;
  /** The to-dos that were in it, as they are now (in the inbox). */
  readonly moved: readonly Task[];
}

export type RemoveOutcome =
  | { readonly status: 'removed'; readonly removed: RemovedFolder }
  /** A to-do could not be moved out: the folder is still there, with `left` things in it. */
  | { readonly status: 'partial'; readonly moved: readonly Task[] }
  | { readonly status: 'failed' };

export interface FolderActionsOptions {
  readonly client?: PlannerClient;
  readonly actions?: ActionStore;
  readonly canMutate: () => boolean;
  /** The inbox, where a removed folder's to-dos go. */
  readonly inboxId: () => string | null;
  /** A to-do or a folder as the server last answered it. */
  readonly onTask?: (task: Task) => void;
  readonly onProject?: (project: Project) => void;
}

function isStale(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status === 412;
}

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useFolderActions(options: FolderActionsOptions) {
  const client = options.client ?? plannerClient;
  const actions = options.actions ?? new ActionStore();
  const pending = ref(0);
  const busy = computed(() => pending.value > 0);
  const error = ref<string | null>(null);

  /** Run one action for the owner who asked; `fallback` is what a failure (or another owner) leaves. */
  async function run<T>(task: OwnerTask<T>, fallback: T): Promise<T> {
    if (!options.canMutate()) {
      error.value = t('errors.offlineEdit');
      return fallback;
    }
    pending.value += 1;
    error.value = null;
    const outcome = await runOwnerBound(task, {
      onError: (cause) => {
        error.value = errorMessage(cause);
      },
      onSettled: () => {
        pending.value -= 1;
      },
    });
    return outcome.status === 'done' ? outcome.value : fallback;
  }

  /** One field of a to-do, retried once against its newest version on a 412. */
  function* patchTask(owner: OwnerScope, task: Task, patch: TaskPatch, scopeName: string): OwnerSteps<Task> {
    const scope = `task:${task.id}:${scopeName}`;
    let current = task;
    for (let attempt = 0; ; attempt += 1) {
      const action = actions.begin(scope, patch, samePayload, current.version);
      try {
        const updated = yield* owner.wait(client.updateTask(task.id, action.payload, action.key, current.version));
        actions.settle(scope, action);
        options.onTask?.(updated);
        return updated;
      } catch (cause) {
        if (isStale(cause) && attempt === 0) {
          current = yield* owner.wait(client.getTask(task.id, { fresh: true, signal: owner.signal }));
          continue;
        }
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        throw cause;
      }
    }
  }

  /** The project's newest version, from the list (which is where a live folder is). */
  function* freshProject(owner: OwnerScope, projectId: string): OwnerSteps<Project | null> {
    const pages = yield* owner.pages(
      (cursor, signal) => client.listProjects({ limit: RANGE_PAGE_SIZE, signal, ...(cursor === undefined ? {} : { cursor }) }),
      { maxPages: RANGE_MAX_PAGES, until: (project: Project) => project.id === projectId },
    );
    return pages.found;
  }

  function* patchProject(
    owner: OwnerScope,
    project: Project,
    patch: { title?: string; archived?: boolean },
    scopeName: string,
    retryStale: boolean,
  ): OwnerSteps<Project> {
    const scope = `folder:${project.id}:${scopeName}`;
    let current = project;
    for (let attempt = 0; ; attempt += 1) {
      const action = actions.begin(scope, patch, samePayload, current.version);
      try {
        const updated = yield* owner.wait(client.updateProject(project.id, action.payload, action.key, current.version, owner.signal));
        actions.settle(scope, action);
        options.onProject?.(updated);
        return updated;
      } catch (cause) {
        if (isStale(cause) && retryStale && attempt === 0) {
          const fresh = yield* freshProject(owner, project.id);
          if (fresh !== null) {
            current = fresh;
            continue;
          }
        }
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        throw cause;
      }
    }
  }

  /** 폴더 만들기: a new, empty folder. */
  function create(title: string): Promise<Project | null> {
    const name = title.trim();
    if (name.length === 0) return Promise.resolve(null);
    return run<Project | null>(function* (owner) {
      const scope = 'folder:create';
      const action = actions.begin(scope, { title: name }, samePayload);
      try {
        const project = yield* owner.wait(client.createProject(action.payload.title, action.key));
        actions.settle(scope, action);
        options.onProject?.(project);
        return project;
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        throw cause;
      }
    }, null);
  }

  /** Rename in place. A name that is blank or unchanged sends nothing. */
  function rename(project: Project, title: string): Promise<Project | null> {
    const name = title.trim();
    if (name.length === 0 || name === project.title) return Promise.resolve(null);
    return run<Project | null>((owner) => patchProject(owner, project, { title: name }, 'rename', true), null);
  }

  /**
   * File to-dos into a folder, or back onto the open water (the inbox's id),
   * one by one. What could not be moved is in `failed`; the rest are filed.
   */
  function file(tasks: readonly Task[], projectId: string): Promise<{ moved: Task[]; failed: Task[] }> {
    const wanted = tasks.filter((task) => task.projectId !== projectId);
    if (wanted.length === 0) return Promise.resolve({ moved: [], failed: [] });
    return run(
      function* (owner) {
        const moved: Task[] = [];
        const failed: Task[] = [];
        for (const task of wanted) {
          try {
            moved.push(yield* patchTask(owner, task, { projectId }, 'file'));
          } catch (cause) {
            failed.push(task);
            error.value = errorMessage(cause);
          }
        }
        return { moved, failed };
      },
      { moved: [], failed: [...wanted] },
    );
  }

  /** 마감: set it, or take it away with null. */
  function setDue(task: Task, dueAt: string | null): Promise<Task | null> {
    return run<Task | null>((owner) => patchTask(owner, task, { dueAt }, 'due'), null);
  }

  /** 폴더 없애기, in its one safe order (see the module comment). */
  function remove(project: Project): Promise<RemoveOutcome> {
    return run<RemoveOutcome>(function* (owner) {
      const inboxId = options.inboxId();
      if (inboxId === null || project.kind === 'inbox') return { status: 'failed' };
      const moved: Task[] = [];
      // (1) Empty it. Asked from the server each round: the page may not know every to-do in it.
      for (let round = 0; round < 3; round += 1) {
        const inside = yield* owner.pages(
          (cursor, signal) =>
            client.listTasks({ projectId: project.id, limit: RANGE_PAGE_SIZE, signal, ...(cursor === undefined ? {} : { cursor }) }),
          { maxPages: RANGE_MAX_PAGES },
        );
        const here = inside.items.filter((task: Task) => task.projectId === project.id && task.deletedAt === undefined);
        if (here.length === 0) break;
        for (const task of here) {
          try {
            moved.push(yield* patchTask(owner, task, { projectId: inboxId }, 'file'));
          } catch (cause) {
            // Stop here: the folder stays, partly emptied, and is not archived.
            error.value = t('canvas.folder.removePartial', { title: project.title });
            void cause;
            return { status: 'partial', moved };
          }
        }
      }
      const left = yield* owner.wait(client.listTasks({ projectId: project.id, limit: 1, signal: owner.signal }));
      if (left.items.some((task) => task.deletedAt === undefined)) {
        error.value = t('canvas.folder.removePartial', { title: project.title });
        return { status: 'partial', moved };
      }
      // (2) Only now, archive it.
      const archived = yield* patchProject(owner, project, { archived: true }, 'archive', true);
      return { status: 'removed', removed: { project: archived, moved } };
    }, { status: 'failed' });
  }

  /**
   * Undo a removal: the folder first, then its to-dos. `failed` counts the
   * to-dos that stayed in the inbox; they are never lost, only not moved back.
   */
  function restore(removed: RemovedFolder): Promise<{ restored: boolean; failed: number }> {
    return run<{ restored: boolean; failed: number }>(
      function* (owner) {
        // The list does not return an archived folder: the version is the one the archive answered.
        const back = yield* patchProject(owner, removed.project, { archived: false }, 'restore', false);
        let failed = 0;
        for (const task of removed.moved) {
          try {
            yield* patchTask(owner, task, { projectId: back.id }, 'file');
          } catch {
            failed += 1;
          }
        }
        return { restored: true, failed };
      },
      { restored: false, failed: removed.moved.length },
    );
  }

  return { busy, error, create, rename, file, setDue, remove, restore };
}

export type FolderActions = ReturnType<typeof useFolderActions>;
