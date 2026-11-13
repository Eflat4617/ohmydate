import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient } from '../api';
import { ownerFenced, useOwnerKey } from '../session/ownerBound';
import { retryTransient } from './usePlannerRange';

/**
 * CAL-04 — read-only lookups of the Google Calendar integration (CAL-03
 * server): the connection itself (캘린더 연동 and the 약속 screen's notes) and
 * the imported all-day events of a date range (한달's day labels).
 *
 * Owner isolation (ADR-023): every cache key carries the owner and each lookup
 * runs in `ownerFenced`. Nothing here writes; the settings screen does its
 * writes in owner-bound tasks of its own.
 */

/** Cache key prefix of `GET /integrations/google` (the owner follows). */
export const GOOGLE_INTEGRATION_QUERY = 'google-integration';
/** Cache key prefix of `GET /calendar-day-events` (owner, from, to follow). */
export const CALENDAR_DAY_EVENTS_QUERY = 'calendar-day-events';

export function useGoogleIntegration() {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => [GOOGLE_INTEGRATION_QUERY, owner.value]),
    queryFn: ({ queryKey, signal }) =>
      ownerFenced(String(queryKey[1]), () => plannerClient.getGoogleIntegration({ fresh: true, signal })),
    retry: retryTransient,
  });
}

export interface CivilRange {
  /** First date, inclusive (`YYYY-MM-DD`). */
  readonly from: string;
  /** Last date, inclusive. */
  readonly to: string;
}

/** Imported all-day events touching `range` (null: nothing to read yet). They never block time. */
export function useCalendarDayEvents(range: Ref<CivilRange | null>) {
  const owner = useOwnerKey();
  return useQuery({
    queryKey: computed(() => [CALENDAR_DAY_EVENTS_QUERY, owner.value, range.value?.from ?? 'none', range.value?.to ?? 'none']),
    queryFn: ({ queryKey, signal }) =>
      ownerFenced(String(queryKey[1]), () =>
        plannerClient.listCalendarDayEvents({ from: String(queryKey[2]), to: String(queryKey[3]), signal }),
      ),
    enabled: computed(() => range.value !== null),
    retry: retryTransient,
  });
}

/**
 * The consent screen is a top-level navigation (08 §2.11). A seam so tests
 * can see where the page would go without leaving it.
 */
let navigator: ((url: string) => void) | null = null;

export function setTopLevelNavigator(next: ((url: string) => void) | null): void {
  navigator = next;
}

export function navigateTopLevel(url: string): void {
  if (navigator !== null) {
    navigator(url);
    return;
  }
  window.location.assign(url);
}
