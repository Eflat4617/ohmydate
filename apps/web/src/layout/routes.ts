import type { LayoutSpec, RouteKind } from '@ohmydate/ui-policy';
import { pageItemOf } from '@ohmydate/ui-policy';
import type { RouteLocationNormalizedLoaded } from 'vue-router';

/** Routes of the planning flow ("진행 중 Intake/Plan 비교 라우트", 07 §2.2 rule 3). */
export const PLANNING_ROUTES: ReadonlySet<string> = new Set(['plan', 'plan-session', 'plan-scope', 'plan-schedule']);
/** The schedule stages own a wide grid; their context panels go below it. */
export const WIDE_PAGE_ROUTES: ReadonlySet<string> = new Set(['plan-scope', 'plan-schedule']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function focusRouteSessionId(route: Pick<RouteLocationNormalizedLoaded, 'name' | 'params'>): string | null {
  if (route.name !== 'focus') return null;
  const value = route.params['sessionId'];
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

export function routeKindOf(route: Pick<RouteLocationNormalizedLoaded, 'name' | 'params'>): RouteKind {
  const name = typeof route.name === 'string' ? route.name : '';
  // HOLO-04: 오늘 lives in 개요, so 개요 is the daily workspace's own page.
  if (name === 'overview') return 'today';
  // `/focus/new?taskId=` starts a session itself; it is not a layout surface.
  if (name === 'focus') return focusRouteSessionId(route) === null ? 'other' : 'focus';
  if (PLANNING_ROUTES.has(name)) return 'planning';
  if (name === 'notes' || name.startsWith('notes-')) return 'notes';
  return 'other';
}

/**
 * The daily workspace has two addresses. When the layout's page changes there,
 * the URL follows it: the focus timer lives at /focus/:id, everything else at
 * /overview. Planning and notes pages are never navigated away from.
 */
export function workspacePathFor(spec: LayoutSpec, kind: RouteKind): string | null {
  if (kind !== 'today' && kind !== 'focus') return null;
  const page = pageItemOf(spec);
  if (page === null) return null;
  if (page.component === 'FocusTimer') return `/focus/${page.props.sessionId}`;
  if (page.component === 'TodayPlan') return '/overview';
  return null;
}
