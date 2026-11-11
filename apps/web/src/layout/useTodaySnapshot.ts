import { computed, type ComputedRef } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient, type Today } from '../api';
import { localDateAt, useLayoutNow } from './now';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { useSessionStore } from '../stores/session';

export interface TodaySnapshot {
  readonly today: ComputedRef<Today | null>;
  readonly isLoading: ComputedRef<boolean>;
  readonly isError: ComputedRef<boolean>;
}

/**
 * The same `GET /today` query TodayView uses (same key), so the layout's
 * panels and the Today page share one cached response. The date follows the
 * shared clock, so a screen left open past midnight asks for the new day.
 */
export function useTodaySnapshot(): TodaySnapshot {
  const sessions = useSessionStore();
  const now = useLayoutNow();
  const date = computed(() => localDateAt(now.value));
  const query = useQuery({
    queryKey: computed(() => ['today', date.value, sessions.ownerId ?? 'anonymous']),
    queryFn: () => {
      const binding = captureOwnerBinding();
      return plannerClient.getToday(date.value, binding.signal);
    },
  });
  return {
    today: computed(() => query.data.value ?? null),
    isLoading: computed(() => query.isLoading.value),
    isError: computed(() => query.isError.value),
  };
}

/**
 * Tasks at deadline risk (07 §2.2 rule 4: P90 slack < 0). The Today API
 * reports them as `negative_slack:<min>` (the day's plan as a whole) and
 * `task_overdue:<taskId>` (one per task); the daily focus cap is not a
 * deadline risk.
 */
export function riskTaskCount(today: Today | null): number {
  if (today === null) return 0;
  let count = 0;
  for (const reason of today.risk.reasons) {
    if (reason.startsWith('task_overdue:') || reason.startsWith('negative_slack:')) count += 1;
  }
  return count;
}
