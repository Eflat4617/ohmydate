import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { plannerClient, type Project, type ScheduleBlock, type Task } from '../api';
import { canvasTodos, type CanvasTodo } from '../domain/canvas/todo';
import { addDaysToDate, todayInZone, zonedWallClockToInstant } from '../domain/time';
import { browserTimeZone } from '../i18n/format';
import { useLayoutNow } from '../layout/now';
import { collectPages, ownerFenced, useOwnerKey } from '../session/ownerBound';
import { useAuthStore } from '../stores/auth';
import { RANGE_MAX_PAGES, RANGE_PAGE_SIZE, readScheduleBlocks, readTasks, retryTransient } from './usePlannerRange';

/**
 * What the 할 일 place shows (HOLO-05): every to-do of the owner, the inbox
 * and the folders (projects), and which to-dos already have a block to come
 * in a confirmed plan. Read-only; nothing here is a new route.
 *
 * - A **folder** is a project that is neither the inbox nor archived. The
 *   live API leaves archived projects out of its list; the mock and the Rust
 *   core list them — so `archived` is filtered here, for all three.
 * - The **open water** is the inbox. A to-do whose project is not listed (an
 *   archived folder's) is not drawn anywhere.
 *
 * Owner isolation (ADR-023, FU-77): the cache keys carry the owner and each
 * lookup runs in `ownerFenced` under one binding. The first key is `tasks`,
 * so everything that changes a to-do (the capture bar, a list, this canvas)
 * refreshes the board by invalidating `['tasks']`.
 */
export interface TodoBoard {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  /** The task list had more pages than the bound: the board is partial. */
  readonly truncated: boolean;
}

/** How far ahead a block still counts as "in a plan" (the planner's own bound). */
export const PLANNED_HORIZON_DAYS = 42;

export function boardKey(owner: string): readonly unknown[] {
  return ['tasks', 'board', owner];
}

export function useTodoBoard() {
  const owner = useOwnerKey();
  const auth = useAuthStore();
  const queryClient = useQueryClient();
  const now = useLayoutNow();
  const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
  const today = computed(() => todayInZone(timeZone.value, now.value));

  const boardQuery = useQuery({
    queryKey: computed(() => boardKey(owner.value)),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[2]), async (binding): Promise<TodoBoard> => {
        const [tasks, projects] = await Promise.all([
          readTasks(binding),
          collectPages(
            binding,
            (cursor, signal) =>
              plannerClient.listProjects({ limit: RANGE_PAGE_SIZE, signal, ...(cursor === undefined ? {} : { cursor }) }),
            { maxPages: RANGE_MAX_PAGES },
          ),
        ]);
        return { projects: projects.items, tasks: tasks.items, truncated: tasks.truncated || projects.truncated };
      }),
    retry: retryTransient,
  });

  // Blocks to come: a separate lookup, so a failure here only loses the "in a plan" mark.
  const blocksQuery = useQuery({
    queryKey: computed(() => ['planner-range', 'todo-board', owner.value, today.value, timeZone.value]),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[2]), async (binding): Promise<readonly ScheduleBlock[]> => {
        const day = String(queryKey[3]);
        const zone = String(queryKey[4]);
        const blocks = await readScheduleBlocks(binding, {
          from: zonedWallClockToInstant(day, 0, zone),
          to: zonedWallClockToInstant(addDaysToDate(day, PLANNED_HORIZON_DAYS), 0, zone),
        });
        return blocks.items;
      }),
    retry: retryTransient,
  });

  const projects = computed<readonly Project[]>(() => boardQuery.data.value?.projects ?? []);
  const inbox = computed<Project | null>(() => projects.value.find((project) => project.kind === 'inbox') ?? null);
  const folders = computed<Project[]>(() =>
    projects.value
      .filter((project) => project.kind !== 'inbox' && !project.archived)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
  );
  const folderIds = computed(() => new Set(folders.value.map((folder) => folder.id)));

  /** Every to-do that is somewhere on the board: the inbox's and the folders', open and finished. */
  const tasks = computed<Task[]>(() =>
    (boardQuery.data.value?.tasks ?? []).filter(
      (task) => task.deletedAt === undefined && (task.projectId === inbox.value?.id || folderIds.value.has(task.projectId)),
    ),
  );

  const plannedIds = computed(() => {
    const ids = new Set<string>();
    for (const block of blocksQuery.data.value ?? []) {
      if (block.status === 'planned' && Date.parse(block.endAt) > now.value) ids.add(block.taskId);
    }
    return ids;
  });

  const todos = computed<CanvasTodo<Task>[]>(() =>
    canvasTodos(tasks.value, {
      inboxId: inbox.value?.id ?? null,
      folderIds: folderIds.value,
      plannedIds: plannedIds.value,
      nowMs: now.value,
      timeZone: timeZone.value,
    }),
  );

  /** Put a changed to-do into the cached board at once (the refetch that follows confirms it). */
  function patchTask(task: Task): void {
    queryClient.setQueryData<TodoBoard>(boardKey(owner.value), (board) =>
      board === undefined ? board : { ...board, tasks: board.tasks.map((item) => (item.id === task.id ? task : item)) },
    );
  }

  function dropTask(taskId: string): void {
    queryClient.setQueryData<TodoBoard>(boardKey(owner.value), (board) =>
      board === undefined ? board : { ...board, tasks: board.tasks.filter((item) => item.id !== taskId) },
    );
  }

  /** A folder as the server last answered it (created, renamed, archived, brought back). */
  function patchProject(project: Project): void {
    queryClient.setQueryData<TodoBoard>(boardKey(owner.value), (board) => {
      if (board === undefined) return board;
      const known = board.projects.some((item) => item.id === project.id);
      return {
        ...board,
        projects: known ? board.projects.map((item) => (item.id === project.id ? project : item)) : [...board.projects, project],
      };
    });
  }

  /** Everything that lists a to-do or a project reads again. */
  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
      queryClient.invalidateQueries({ queryKey: ['overview-directory'] }),
    ]);
  }

  return {
    timeZone,
    now,
    inbox,
    folders,
    tasks,
    todos,
    plannedIds,
    truncated: computed(() => boardQuery.data.value?.truncated === true),
    isLoading: computed(() => boardQuery.isLoading.value),
    isError: computed(() => boardQuery.isError.value && boardQuery.data.value === undefined),
    inboxMissing: computed(() => boardQuery.isSuccess.value && inbox.value === null),
    refetch: () => boardQuery.refetch(),
    refresh,
    patchTask,
    dropTask,
    patchProject,
  };
}

export type TodoBoardState = ReturnType<typeof useTodoBoard>;
