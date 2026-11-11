import { computed, type ComputedRef, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import { isInReviewWindow, type LayoutSignals } from '@ohmydate/ui-policy';
import type { Today, WorkSession } from '../api';
import { localDateOf, localMinutesOf, todayInZone } from '../domain/time';
import { browserTimeZone } from '../i18n/format';
import { useAuthStore } from '../stores/auth';
import { useSessionStore } from '../stores/session';
import { isReviewSkipped, isRiskAcknowledged, isSessionReviewed } from './localSignals';
import { focusRouteSessionId, routeKindOf } from './routes';
import { riskTaskCount, useTodaySnapshot } from './useTodaySnapshot';

export interface ContextObserver {
  readonly signals: ComputedRef<LayoutSignals>;
  readonly today: ComputedRef<Today | null>;
  readonly timeZone: ComputedRef<string>;
  readonly day: ComputedRef<string>;
  readonly unreviewed: ComputedRef<WorkSession[]>;
}

/**
 * Context Observer (07 §2): turns the route, the running session, today's
 * risk and its acknowledgement, the review window and unreviewed sessions
 * into the policy's signals. Interaction (typing/dragging) is tracked
 * separately because it is read at decision time, not watched.
 */
export function useContextObserver(now: Ref<number>): ContextObserver {
  const route = useRoute();
  const auth = useAuthStore();
  const sessions = useSessionStore();
  const { today } = useTodaySnapshot();

  const timeZone = computed(() => auth.user?.timeZone ?? today.value?.timeZone ?? browserTimeZone());
  const instant = computed(() => new Date(now.value).toISOString());
  const day = computed(() => todayInZone(timeZone.value, now.value));
  const minuteOfDay = computed(() => localMinutesOf(instant.value, timeZone.value));

  const unreviewed = computed(() => {
    const owner = sessions.ownerId;
    if (isReviewSkipped(owner, day.value)) return [];
    return Object.values(sessions.sessions).filter(
      (session) =>
        session.state === 'completed' &&
        session.endedAt !== undefined &&
        localDateOf(session.endedAt, timeZone.value) === day.value &&
        !isSessionReviewed(owner, session.id),
    );
  });

  const signals = computed<LayoutSignals>(() => ({
    route: routeKindOf(route),
    routeSessionId: focusRouteSessionId(route),
    activeSessionId: sessions.active?.id ?? null,
    riskTaskCount: riskTaskCount(today.value),
    riskAcknowledged: isRiskAcknowledged(sessions.ownerId, day.value),
    inReviewWindow: isInReviewWindow(minuteOfDay.value),
    unreviewedSessionCount: unreviewed.value.length,
    day: day.value,
  }));

  return { signals, today, timeZone, day, unreviewed };
}
