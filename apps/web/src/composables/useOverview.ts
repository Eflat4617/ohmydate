import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type EstimationProfile,
  type Project,
  type ReplanProposalPage,
  type SessionCreate,
  type Task,
  type WorkSession,
} from '../api';
import { sessionsWithin } from '../domain/overview';
import { rememberFocusTask } from './focusContext';
import { t } from '../i18n';
import { errorMessage } from '../i18n/problem';
import { layoutClock } from '../layout/clock';
import { focusClientId } from '../session/clientId';
import type { OwnerBinding } from '../session/ownerEpoch';
import { collectPages, ownerFenced, runOwnerBound, useOwnerKey } from '../session/ownerBound';
import { useLayoutStore } from '../stores/layout';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { RANGE_MAX_PAGES, RANGE_PAGE_SIZE, readTasks, retryTransient, type InstantRange } from './usePlannerRange';

/**
 * Read-only lookups and the one action of 개요 (HOLO-01). Nothing here is a
 * new API: every number on the dashboard comes from routes other screens
 * already use.
 *
 * Owner isolation (ADR-023, FU-77): every cache key carries the owner, every
 * lookup runs in `ownerFenced` under one OwnerBinding (its signal on every
 * request, re-checked before the result is returned and cached), and starting
 * a session is an owner-bound task.
 */

/** How many of the newest sessions the tracker's "최근 작업" looks at. */
export const RECENT_SESSION_COUNT = 20;

export interface WeekSessions {
  /** Sessions that started inside the range. */
  readonly sessions: readonly WorkSession[];
  /** The newest sessions of all, whatever their week (newest first). */
  readonly recent: readonly WorkSession[];
  /** The list had more pages than the bound: the totals are partial. */
  readonly truncated: boolean;
}

/**
 * `GET /sessions` lists newest first and takes no date range, so the pages
 * are followed until one reaches back past `from` (or the page bound).
 */
export async function readSessionsOf(binding: OwnerBinding, range: InstantRange): Promise<WeekSessions> {
  const fromMs = Date.parse(range.from);
  const pages = await collectPages(
    binding,
    (cursor, signal) =>
      plannerClient.listSessions({ limit: RANGE_PAGE_SIZE, signal, ...(cursor === undefined ? {} : { cursor }) }),
    { maxPages: RANGE_MAX_PAGES, until: (session) => Date.parse(session.startedAt) < fromMs },
  );
  return {
    sessions: sessionsWithin(pages.items, range.from, range.to),
    recent: pages.items.slice(0, RECENT_SESSION_COUNT),
    truncated: pages.truncated,
  };
}

/** The work sessions of `range` (null: nothing to read yet). The cache key is the range read. */
export function useWeekSessions(range: Ref<InstantRange | null>) {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => ['overview-sessions', owner.value, range.value?.from ?? 'none', range.value?.to ?? 'none']),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[1]), (binding) =>
        readSessionsOf(binding, { from: String(queryKey[2]), to: String(queryKey[3]) }),
      ),
    enabled: computed(() => range.value !== null),
    retry: retryTransient,
  });
}

export interface TaskDirectory {
  readonly tasks: ReadonlyMap<string, Task>;
  readonly projects: ReadonlyMap<string, Project>;
}

/** Titles for the sessions on screen: every task and project of the owner, by id. */
export function useTaskDirectory() {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => ['overview-directory', owner.value]),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[1]), async (binding): Promise<TaskDirectory> => {
        const [tasks, projects] = await Promise.all([
          readTasks(binding),
          collectPages(
            binding,
            (cursor, signal) =>
              plannerClient.listProjects({ limit: RANGE_PAGE_SIZE, signal, ...(cursor === undefined ? {} : { cursor }) }),
            { maxPages: RANGE_MAX_PAGES },
          ),
        ]);
        return {
          tasks: new Map(tasks.items.map((task) => [task.id, task])),
          projects: new Map(projects.items.map((project) => [project.id, project])),
        };
      }),
    retry: retryTransient,
  });
}

/** 내 패턴's profile (the same cache entry PatternsView reads). */
export function useEstimationProfile() {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => ['estimation-profile', owner.value]),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[1]), (binding): Promise<EstimationProfile> =>
        plannerClient.getEstimationProfile(binding.signal),
      ),
    retry: retryTransient,
  });
}

/** Replan proposals waiting for an answer (the same cache entry Today's banner reads). */
export function usePendingReplans() {
  const owner = useOwnerKey();
  const offline = useOfflineStore();
  return useQuery({
    queryKey: computed(() => ['replan-proposals', 'pending', owner.value]),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[2]), (binding): Promise<ReplanProposalPage> =>
        plannerClient.listReplanProposals({ state: 'pending', limit: 10, signal: binding.signal }),
      ),
    enabled: computed(() => offline.online),
    retry: retryTransient,
  });
}

/**
 * The session that is running or paused, if any: what this device already
 * knows (the session store), else what the server reports (the same lookup
 * Today makes). A cached answer never overwrites a newer copy on the device.
 */
export function useRunningSession() {
  const owner = useOwnerKey();
  const offline = useOfflineStore();
  const sessionStore = useSessionStore();
  const query = useQuery({
    queryKey: computed(() => ['sessions', 'resumable', owner.value]),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[2]), async (binding) => {
        const active = await plannerClient.listSessions({ state: 'active', limit: 1, signal: binding.signal });
        let session = active.items[0] ?? null;
        if (session === null) {
          const paused = await plannerClient.listSessions({ state: 'paused', limit: 1, signal: binding.signal });
          session = paused.items[0] ?? null;
        }
        return { ownerId: binding.ownerId, session };
      }),
    enabled: computed(() => offline.online),
    retry: retryTransient,
  });

  watch(
    query.data,
    (result) => {
      if (result === undefined || result.session === null) return;
      if (result.ownerId !== sessionStore.ownerId) return;
      const known = sessionStore.get(result.session.id);
      if (known !== null && known.version > result.session.version) return;
      sessionStore.remember(result.session);
    },
    { immediate: true },
  );

  const running = computed<WorkSession | null>(() => {
    const fromQuery = query.data.value?.ownerId === sessionStore.ownerId ? (query.data.value?.session ?? null) : null;
    return sessionStore.active ?? fromQuery;
  });
  return { running, refetch: () => query.refetch() };
}

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface FocusTarget {
  readonly taskId: string;
  readonly blockId?: string;
  /** The task's name, when the caller has it: Focus shows it instead of asking for it. */
  readonly title?: string;
}

/**
 * Start a focus session on a task (a block of today, or "다시 시작" on an
 * earlier one) the way Today does: one idempotent `POST /sessions`, the
 * session remembered on the device, then the Focus screen. It follows the
 * offline rule (nothing starts while mutations are off) and runs as an
 * owner-bound task, so nothing after the request happens for another user.
 */
export function useFocusStart(options: { readonly onActiveExists?: () => unknown } = {}) {
  const router = useRouter();
  const offline = useOfflineStore();
  const sessionStore = useSessionStore();
  const layout = useLayoutStore();
  const actions = new ActionStore();

  const startingTaskId = ref<string | null>(null);
  const error = ref<string | null>(null);
  /** The server refused because another session is running. */
  const activeExists = ref(false);
  const canStart = computed(() => offline.mutationsEnabled && startingTaskId.value === null);

  async function start(target: FocusTarget): Promise<void> {
    if (!canStart.value) return;
    startingTaskId.value = target.taskId;
    error.value = null;
    activeExists.value = false;
    // Presentational only, in this owner's memory: the name Focus shows.
    if (target.title !== undefined) rememberFocusTask(sessionStore.ownerId, target.taskId, target.title);
    const scope = `focus:start:${target.taskId}`;
    const input: SessionCreate = actions.peek<SessionCreate>(scope)?.payload ?? {
      taskId: target.taskId,
      ...(target.blockId === undefined ? {} : { blockId: target.blockId }),
      clientStartedAt: new Date(layoutClock().now()).toISOString(),
      clientId: focusClientId(),
    };
    const action = actions.begin(scope, input, samePayload);
    await runOwnerBound(
      function* (owner) {
        try {
          const session = yield* owner.wait(plannerClient.createSession(action.payload, action.key, owner.signal));
          actions.settle(scope, action);
          sessionStore.remember(session);
          // With automatic layout switching the layout itself moves to the
          // session's focus page; otherwise open it here.
          if (!layout.sessionStarted(session.id)) yield* owner.wait(router.push(`/focus/${session.id}`));
        } catch (cause) {
          if (cause instanceof ApiError) actions.settle(scope, action);
          if (cause instanceof ApiError && cause.status === 409 && cause.code === 'active_session_exists') {
            activeExists.value = true;
            error.value = t('overview.tracker.activeExists');
            yield* owner.wait(options.onActiveExists?.());
          } else {
            error.value = errorMessage(cause);
          }
        }
      },
      {
        onSettled: () => {
          startingTaskId.value = null;
        },
      },
    );
  }

  return { start, startingTaskId, error, activeExists, canStart };
}

/** A clock that ticks every second while `running` is true (the tracker's timer). */
export function useSecondTick(
  running: Ref<boolean>,
  read: () => number = () => layoutClock().now(),
): Readonly<Ref<number>> {
  const now = ref(read());
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  watch(
    running,
    (value) => {
      stop();
      now.value = read();
      if (value) {
        timer = setInterval(() => {
          now.value = read();
        }, 1000);
      }
    },
    { immediate: true },
  );
  onScopeDispose(stop);
  return now;
}
