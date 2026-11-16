import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ApiError, plannerClient, type Commitment, type ScheduleBlock, type Task } from '../api';
import type { OwnerBinding } from '../session/ownerEpoch';
import { OwnerChangedError, collectPages, ownerFenced, useOwnerKey } from '../session/ownerBound';
import { browserTimeZone } from '../i18n/format';
import { isNotReady } from '../platform/notReady';

/**
 * Read-only lookups for the calendar views: the month page (CAL-01) reads the
 * approved blocks, the 약속 and the tasks of a range of at most 42 days, and
 * Today reads the day's 약속 and the tasks due on it.
 *
 * Owner isolation (ADR-023, FU-77): every cache key carries the owner, and a
 * lookup runs in `ownerFenced` — one OwnerBinding for all of its pages, its
 * signal on every request, re-checked before each next page and before the
 * result is returned (and so cached). Nothing here writes.
 */

/** Page size of every list read here (the API's usual bound). */
export const RANGE_PAGE_SIZE = 100;
/** Pages per list before the result is called partial (2,000 rows). */
export const RANGE_MAX_PAGES = 20;

export interface PlannerRange {
  readonly blocks: readonly ScheduleBlock[];
  readonly commitments: readonly Commitment[];
  readonly tasks: readonly Task[];
  /** A list had more pages than RANGE_MAX_PAGES: what is shown is partial. */
  readonly truncated: boolean;
}

export interface InstantRange {
  readonly from: string;
  readonly to: string;
}

function pageOptions(cursor: string | undefined, signal: AbortSignal) {
  return { limit: RANGE_PAGE_SIZE, signal, ...(cursor === undefined ? {} : { cursor }) };
}

export function readScheduleBlocks(binding: OwnerBinding, range: InstantRange) {
  return collectPages(
    binding,
    (cursor, signal) => plannerClient.listScheduleBlocks({ ...range, ...pageOptions(cursor, signal) }),
    { maxPages: RANGE_MAX_PAGES },
  );
}

export function readCommitments(binding: OwnerBinding, range: InstantRange) {
  return collectPages(
    binding,
    (cursor, signal) => plannerClient.listCommitments({ ...range, ...pageOptions(cursor, signal) }),
    { maxPages: RANGE_MAX_PAGES },
  );
}

export function readTasks(binding: OwnerBinding) {
  return collectPages(binding, (cursor, signal) => plannerClient.listTasks(pageOptions(cursor, signal)), {
    maxPages: RANGE_MAX_PAGES,
  });
}

/** All three lists of `range`, every page, under one binding. */
export async function readPlannerRange(binding: OwnerBinding, range: InstantRange): Promise<PlannerRange> {
  const [blocks, commitments, tasks] = await Promise.all([
    readScheduleBlocks(binding, range),
    readCommitments(binding, range),
    readTasks(binding),
  ]);
  return {
    blocks: blocks.items,
    commitments: commitments.items,
    tasks: tasks.items,
    truncated: blocks.truncated || commitments.truncated || tasks.truncated,
  };
}

/** Retry what may pass on its own (network, 5xx); never a stale owner, a 4xx answer or a place that is not ready. */
export function retryTransient(count: number, cause: unknown): boolean {
  if (cause instanceof OwnerChangedError) return false;
  if (isNotReady(cause)) return false;
  if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) return false;
  return count < 2;
}

/**
 * The owner's zone, as the other screens resolve it: the availability time
 * zone, else the browser's. `ready` is false until availability has answered
 * (or failed), so a range is never asked for in a zone about to change.
 */
export function useOwnerTimeZone() {
  const availability = useQuery({
    queryKey: ['availability'],
    queryFn: () => plannerClient.getAvailability(),
  });
  const timeZone = computed(() => availability.data.value?.timeZone ?? browserTimeZone());
  const ready = computed(() => availability.data.value !== undefined || availability.isError.value);
  return { timeZone, ready };
}

/** Blocks, 약속 and tasks of `range` (null: nothing to read yet). The cache key is the range read. */
export function usePlannerRange(range: Ref<InstantRange | null>) {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => ['planner-range', owner.value, range.value?.from ?? 'none', range.value?.to ?? 'none']),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[1]), (binding) =>
        readPlannerRange(binding, { from: String(queryKey[2]), to: String(queryKey[3]) }),
      ),
    enabled: computed(() => range.value !== null),
    retry: retryTransient,
  });
}

export interface DayAgenda {
  readonly commitments: readonly Commitment[];
  readonly tasks: readonly Task[];
}

/** Today's 약속 and the task list (for what is due), for the day `[from, to)`. */
export function useDayAgenda(range: Ref<InstantRange | null>) {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => ['day-agenda', owner.value, range.value?.from ?? 'none', range.value?.to ?? 'none']),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[1]), async (binding): Promise<DayAgenda> => {
        const day = { from: String(queryKey[2]), to: String(queryKey[3]) };
        const [commitments, tasks] = await Promise.all([readCommitments(binding, day), readTasks(binding)]);
        return { commitments: commitments.items, tasks: tasks.items };
      }),
    enabled: computed(() => range.value !== null),
    retry: retryTransient,
  });
}
