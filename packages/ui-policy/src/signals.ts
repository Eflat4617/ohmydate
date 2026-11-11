import type { LayoutComponentId, LayoutMode } from './registry.js';

/**
 * Inputs of the policy. The web's Context Observer derives them; the policy
 * itself never reads a clock, storage or the DOM.
 */

/** Epoch milliseconds of a UTC instant, supplied by the caller's Clock port. */
export type InstantMs = number;

export interface Clock {
  now(): InstantMs;
}

/** Which kind of screen the router shows. */
export type RouteKind = 'today' | 'focus' | 'planning' | 'notes' | 'other';

export interface LayoutSignals {
  readonly route: RouteKind;
  /** Session id in the URL of a focus route, otherwise null. */
  readonly routeSessionId: string | null;
  /** The owner's active or paused work session, if any. */
  readonly activeSessionId: string | null;
  /** Tasks whose P90 slack is negative (07 §2.2 rule 4). */
  readonly riskTaskCount: number;
  /** The user already acknowledged today's deadline risk. */
  readonly riskAcknowledged: boolean;
  /** Local time is inside the end-of-day review window. */
  readonly inReviewWindow: boolean;
  /** Sessions finished today that have no review yet. */
  readonly unreviewedSessionCount: number;
  /** Local civil date (YYYY-MM-DD); only used to key suppressions per day. */
  readonly day: string;
}

export interface LayoutPreferences {
  /** "레이아웃 자동 전환". Off: only the user's own navigation changes the layout. */
  readonly autoSwitch: boolean;
  /** Mode pinned by the user (`layout.locked`), or null. */
  readonly locked: LayoutMode | null;
}

export interface InteractionSignals {
  /** An editable field has focus. */
  readonly typing: boolean;
  /** A pointer drag or HTML drag is in progress. */
  readonly dragging: boolean;
  /** Components the user is working in right now (pressed, open dialog, editing). */
  readonly activeComponents: readonly LayoutComponentId[];
}

export const IDLE_INTERACTION: InteractionSignals = { typing: false, dragging: false, activeComponents: [] };

export const DEFAULT_PREFERENCES: LayoutPreferences = { autoSwitch: true, locked: null };

export interface ReviewWindow {
  /** Minutes after local midnight, inclusive. */
  readonly startMinute: number;
  /** Minutes after local midnight, exclusive. */
  readonly endMinute: number;
}

/** "하루 마감 시간대" [가정]: 20:00 until midnight, local time. */
export const DEFAULT_REVIEW_WINDOW: ReviewWindow = { startMinute: 20 * 60, endMinute: 24 * 60 };

export function isInReviewWindow(minuteOfDay: number, window: ReviewWindow = DEFAULT_REVIEW_WINDOW): boolean {
  if (!Number.isFinite(minuteOfDay)) return false;
  if (window.startMinute <= window.endMinute) {
    return minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute;
  }
  // A window that wraps past midnight, e.g. 22:00–02:00.
  return minuteOfDay >= window.startMinute || minuteOfDay < window.endMinute;
}
