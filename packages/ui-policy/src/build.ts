import type { ModeDecision } from './decide.js';
import { PINNED_COMPONENTS, POLICY_VERSION, type LayoutItem, type LayoutMode } from './registry.js';
import type { LayoutSignals } from './signals.js';
import type { LayoutSpec } from './spec.js';

/**
 * Turns a mode decision into a LayoutSpec.
 *
 * The page the user opened is never replaced: on planning and notes routes the
 * routed page stays the primary component and the mode only changes the panels
 * around it. On the daily workspace (Today / Focus) the mode also chooses the
 * page — `focus` shows the session timer, every other mode shows Today.
 */

const NEXT_UP = (count: number): LayoutItem => ({ component: 'NextUp', props: { count } });
const RELATED_NOTES = (limit: number): LayoutItem => ({ component: 'RelatedNotes', props: { limit } });
const DEADLINE_RISK: LayoutItem = { component: 'DeadlineRiskPanel' };
const REVIEW_PROMPT: LayoutItem = { component: 'ReviewPrompt' };

export function isPageRoute(signals: LayoutSignals): boolean {
  return signals.route === 'planning' || signals.route === 'notes';
}

/** The session a focus layout is about: the one in the URL wins on a focus route. */
export function focusSessionId(signals: LayoutSignals): string | null {
  return signals.route === 'focus'
    ? (signals.routeSessionId ?? signals.activeSessionId)
    : (signals.activeSessionId ?? signals.routeSessionId);
}

function pageItem(mode: LayoutMode, signals: LayoutSignals): LayoutItem {
  if (signals.route === 'planning') return { component: 'PlanningWorkspace' };
  if (signals.route === 'notes') return { component: 'NotesWorkspace' };
  const sessionId = mode === 'focus' ? focusSessionId(signals) : null;
  return sessionId === null ? { component: 'TodayPlan' } : { component: 'FocusTimer', props: { sessionId } };
}

interface Arrangement {
  readonly primary: readonly LayoutItem[];
  readonly secondary: readonly LayoutItem[];
  readonly tertiary: readonly LayoutItem[];
}

function sessionItems(sessionId: string | null, withActiveCard: boolean): LayoutItem[] {
  if (sessionId === null) return [];
  const items: LayoutItem[] = [];
  if (withActiveCard) items.push({ component: 'ActiveSessionCard', props: { sessionId } });
  items.push({ component: 'CurrentTaskCard', props: { sessionId } });
  return items;
}

function workspaceArrangement(mode: LayoutMode, page: LayoutItem, signals: LayoutSignals): Arrangement {
  switch (mode) {
    case 'focus':
      return {
        primary: [page],
        secondary: [...sessionItems(focusSessionId(signals), false), RELATED_NOTES(3)],
        tertiary: [NEXT_UP(2)],
      };
    case 'deadline_risk':
      return { primary: [DEADLINE_RISK, page], secondary: [NEXT_UP(3)], tertiary: [RELATED_NOTES(3)] };
    case 'review':
      return { primary: [REVIEW_PROMPT, page], secondary: [NEXT_UP(2)], tertiary: [RELATED_NOTES(3)] };
    case 'planning':
      return { primary: [page], secondary: [RELATED_NOTES(3)], tertiary: [NEXT_UP(2)] };
    case 'notes':
      return { primary: [page], secondary: [RELATED_NOTES(5)], tertiary: [NEXT_UP(2)] };
    case 'overview':
      return { primary: [page], secondary: [NEXT_UP(3)], tertiary: [RELATED_NOTES(3)] };
  }
}

function pageRouteArrangement(mode: LayoutMode, page: LayoutItem, signals: LayoutSignals): Arrangement {
  // A running session stays reachable from any page it is not shown on.
  const running = signals.activeSessionId;
  const runningCard: LayoutItem[] =
    running === null ? [] : [{ component: 'ActiveSessionCard', props: { sessionId: running } }];
  switch (mode) {
    case 'focus':
      return {
        primary: [page],
        secondary: sessionItems(focusSessionId(signals), true),
        tertiary: [RELATED_NOTES(3)],
      };
    case 'deadline_risk':
      return { primary: [page], secondary: [...runningCard, DEADLINE_RISK], tertiary: [RELATED_NOTES(3)] };
    case 'review':
      return { primary: [page], secondary: [...runningCard, REVIEW_PROMPT], tertiary: [RELATED_NOTES(3)] };
    case 'notes':
      return { primary: [page], secondary: [...runningCard, RELATED_NOTES(5)], tertiary: [NEXT_UP(2)] };
    case 'planning':
      return { primary: [page], secondary: [...runningCard, RELATED_NOTES(3)], tertiary: [NEXT_UP(2)] };
    case 'overview':
      return { primary: [page], secondary: [...runningCard, NEXT_UP(3)], tertiary: [RELATED_NOTES(3)] };
  }
}

export function buildLayoutSpec(decision: ModeDecision, signals: LayoutSignals): LayoutSpec {
  const page = pageItem(decision.mode, signals);
  const arrangement = isPageRoute(signals)
    ? pageRouteArrangement(decision.mode, page, signals)
    : workspaceArrangement(decision.mode, page, signals);
  return {
    mode: decision.mode,
    regions: {
      primary: [...arrangement.primary],
      secondary: [...arrangement.secondary],
      tertiary: [...arrangement.tertiary],
    },
    pinned: [...PINNED_COMPONENTS],
    reason: decision.reason,
    policyVersion: POLICY_VERSION,
  };
}
