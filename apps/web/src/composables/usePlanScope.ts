import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient, type GoalSummary, type Task } from '../api';
import { PICKER_GOAL_PAGES, PICKER_PAGE_SIZE, PICKER_TASK_PAGES } from '../domain/planPicker';
import { collectPages, ownerFenced, useOwnerKey } from '../session/ownerBound';
import { keyOwner, retryFenced } from './notes';

/**
 * 계획 세우기 · 일정안 (HOLO-03A): what a plan can be made of — every open
 * task and every goal (a plan made in 계획 세우기) of the owner. Read-only.
 *
 * Owner isolation (ADR-023): the cache key carries the owner and each lookup
 * runs in `ownerFenced`, every page under one binding.
 */

/** Every task of the owner, up to the picker's bound (`truncated` past it). */
export function usePickerTasks() {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => ['tasks', owner.value, 'plan-picker'] as const),
    queryFn: ({ queryKey }) =>
      ownerFenced(keyOwner(queryKey), (binding) =>
        collectPages<Task>(
          binding,
          (cursor, signal) =>
            plannerClient.listTasks({ limit: PICKER_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), signal }),
          { maxPages: PICKER_TASK_PAGES },
        ),
      ),
    retry: retryFenced(),
  });
}

/** Every goal of the owner, newest pages first, up to the picker's bound. */
export function usePickerGoals() {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => ['goals', owner.value, 'plan-picker'] as const),
    queryFn: ({ queryKey }) =>
      ownerFenced(keyOwner(queryKey), (binding) =>
        collectPages<GoalSummary>(
          binding,
          (cursor, signal) =>
            plannerClient.listGoals({ limit: PICKER_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), signal }),
          { maxPages: PICKER_GOAL_PAGES },
        ),
      ),
    retry: retryFenced(),
  });
}
