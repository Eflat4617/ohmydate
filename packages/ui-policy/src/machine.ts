import { buildLayoutSpec, isPageRoute } from './build.js';
import {
  DEFAULT_DECISION,
  decideMode,
  pruneSuppressions,
  type ModeDecision,
  type Suppressions,
} from './decide.js';
import type { LayoutComponentId, LayoutMode } from './registry.js';
import type { InstantMs, InteractionSignals, LayoutPreferences, LayoutSignals } from './signals.js';
import {
  componentsOf,
  pageItemOf,
  sameLayout,
  sameStructure,
  validateLayoutSpec,
  type LayoutSpec,
} from './spec.js';
import { evaluateSuggestion, type SuggestionVerdict } from './suggestion.js';

/**
 * Layout stability (07 §2.3) as a pure state machine. Callers pass the time in;
 * nothing here reads a clock.
 *
 * - An automatic switch holds the new layout for at least HOLD_MS.
 * - While the user types or drags, switches wait.
 * - A component the user is working in is not removed until they are idle.
 * - The lock and "auto switch off" stop automatic switches entirely.
 * - One undo step restores the layout before the last automatic switch and
 *   turns that context down, so it does not switch straight back.
 * - An automatic step never changes the page of a Focus screen the user is
 *   on (e.g. the review sheet after a session ends); they leave it themselves.
 * - The user's own navigation always applies at once (no hold, no toast).
 * - A spec that fails validation is never applied: the previous one stays.
 */
export const HOLD_MS = 10 * 60 * 1000;

export interface UndoEntry {
  /** Layout shown before the automatic switch. */
  readonly spec: LayoutSpec;
  /** Context to turn down when the user undoes the switch. */
  readonly suppress: { readonly mode: LayoutMode | 'ai_suggestion'; readonly key: string };
}

export interface LayoutState {
  readonly current: LayoutSpec;
  readonly undo: UndoEntry | null;
  /** Automatic switches wait until this instant (exclusive), or null. */
  readonly holdUntil: InstantMs | null;
  readonly suppressed: Suppressions;
  /** The layout a deferred switch is waiting to show, for callers that want to retry. */
  readonly pending: LayoutSpec | null;
}

export interface LayoutInput {
  readonly now: InstantMs;
  readonly signals: LayoutSignals;
  readonly prefs: LayoutPreferences;
  readonly interaction: InteractionSignals;
  /** Optional AI layout suggestion (untrusted, lowest priority). */
  readonly suggestion?: unknown;
}

export type DeferReason = 'hold' | 'typing' | 'dragging' | 'interacting' | 'page';

export type StepOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refreshed' }
  | { readonly kind: 'switched'; readonly from: LayoutSpec; readonly to: LayoutSpec }
  | {
      readonly kind: 'deferred';
      readonly because: DeferReason;
      readonly target: LayoutSpec;
      /** For `hold`: the first instant at which the switch may happen. */
      readonly retryAt: InstantMs | null;
    }
  | { readonly kind: 'blocked'; readonly because: 'locked' | 'auto_off' }
  | { readonly kind: 'rejected'; readonly errors: readonly string[] };

export interface StepResult {
  readonly state: LayoutState;
  readonly outcome: StepOutcome;
  readonly suggestion: SuggestionVerdict | null;
}

export interface IntentResult {
  readonly state: LayoutState;
  /** The layout actually changed. */
  readonly changed: boolean;
  /** New value for the persisted lock when the user's navigation moved it. */
  readonly relock: LayoutMode | null;
}

function holdActive(state: LayoutState, now: InstantMs): boolean {
  return state.holdUntil !== null && now < state.holdUntil;
}

function removedComponents(from: LayoutSpec, to: LayoutSpec): LayoutComponentId[] {
  const next = new Set(componentsOf(to));
  return componentsOf(from).filter((component) => !next.has(component));
}

/**
 * Only the user moves off a Focus screen they are on. Today may change into
 * Focus automatically (that is the point); planning and notes pages never
 * change by construction (see buildLayoutSpec).
 */
function pageChangeAllowed(from: LayoutSpec, to: LayoutSpec, signals: LayoutSignals): boolean {
  if (signals.route !== 'focus') return true;
  return JSON.stringify(pageItemOf(from)) === JSON.stringify(pageItemOf(to));
}

function withPending(state: LayoutState, pending: LayoutSpec | null): LayoutState {
  return state.pending === pending ? state : { ...state, pending };
}

/** Rule-based target, optionally replaced by an accepted suggestion. */
function target(
  input: LayoutInput,
  suppressed: Suppressions,
): { decision: ModeDecision; spec: LayoutSpec; verdict: SuggestionVerdict | null; suppressKey: UndoEntry['suppress'] } {
  const decision = decideMode(input.signals, input.prefs, suppressed);
  const ruleSpec = buildLayoutSpec(decision, input.signals);
  if (input.suggestion === undefined) {
    return { decision, spec: ruleSpec, verdict: null, suppressKey: { mode: decision.mode, key: decision.key } };
  }
  const verdict = evaluateSuggestion(input.suggestion, { decision, prefs: input.prefs, suppressed, ruleSpec });
  if (verdict.status === 'accepted') {
    return {
      decision,
      spec: verdict.spec,
      verdict,
      suppressKey: { mode: 'ai_suggestion', key: input.signals.day },
    };
  }
  return { decision, spec: ruleSpec, verdict, suppressKey: { mode: decision.mode, key: decision.key } };
}

/**
 * Re-evaluates the layout after a context change that the user did not ask
 * for directly (a session started, a risk appeared, time passed…).
 */
export function stepLayout(state: LayoutState, input: LayoutInput): StepResult {
  const suppressed = pruneSuppressions(state.suppressed, input.signals);
  const base: LayoutState = suppressed === state.suppressed ? state : { ...state, suppressed };
  const next = target(input, suppressed);
  const verdict = next.verdict;
  const done = (stateOut: LayoutState, outcome: StepOutcome): StepResult => ({
    state: stateOut,
    outcome,
    suggestion: verdict,
  });

  const validated = validateLayoutSpec(next.spec);
  if (!validated.ok) return done(withPending(base, null), { kind: 'rejected', errors: validated.errors });
  const to = validated.value;
  const from = base.current;

  if (sameLayout(from, to)) return done(withPending(base, null), { kind: 'unchanged' });

  if (!pageChangeAllowed(from, to, input.signals)) {
    return done(withPending(base, to), { kind: 'deferred', because: 'page', target: to, retryAt: null });
  }

  // Same components in the same places: a silent props/reason update.
  if (sameStructure(from, to)) {
    if (input.interaction.typing || input.interaction.dragging) {
      return done(withPending(base, to), {
        kind: 'deferred',
        because: input.interaction.typing ? 'typing' : 'dragging',
        target: to,
        retryAt: null,
      });
    }
    return done({ ...base, current: to, pending: null }, { kind: 'refreshed' });
  }

  if (input.prefs.locked !== null) return done(withPending(base, null), { kind: 'blocked', because: 'locked' });
  if (!input.prefs.autoSwitch) return done(withPending(base, null), { kind: 'blocked', because: 'auto_off' });

  if (holdActive(base, input.now)) {
    return done(withPending(base, to), { kind: 'deferred', because: 'hold', target: to, retryAt: base.holdUntil });
  }
  if (input.interaction.typing) {
    return done(withPending(base, to), { kind: 'deferred', because: 'typing', target: to, retryAt: null });
  }
  if (input.interaction.dragging) {
    return done(withPending(base, to), { kind: 'deferred', because: 'dragging', target: to, retryAt: null });
  }
  const busy = new Set(input.interaction.activeComponents);
  if (removedComponents(from, to).some((component) => busy.has(component))) {
    return done(withPending(base, to), { kind: 'deferred', because: 'interacting', target: to, retryAt: null });
  }

  return done(
    {
      current: to,
      undo: { spec: from, suppress: next.suppressKey },
      holdUntil: input.now + HOLD_MS,
      suppressed,
      pending: null,
    },
    { kind: 'switched', from, to },
  );
}

/** Mode the user's own navigation asks for, ignoring the hold and the toast. */
function intentDecision(
  signals: LayoutSignals,
  prefs: LayoutPreferences,
  suppressed: Suppressions,
): { decision: ModeDecision; relock: LayoutMode | null } {
  if (signals.route === 'focus') {
    const sessionId = signals.routeSessionId ?? signals.activeSessionId;
    const decision: ModeDecision =
      sessionId === null
        ? DEFAULT_DECISION
        : {
            mode: 'focus',
            reason: sessionId === signals.activeSessionId ? 'active_session' : 'user_navigation',
            key: `session:${sessionId}`,
          };
    const relock = prefs.locked !== null && prefs.locked !== decision.mode ? decision.mode : null;
    return { decision: relock === null && prefs.locked !== null ? { ...decision, reason: 'locked' } : decision, relock };
  }

  if (prefs.locked !== null) {
    // A locked focus layout cannot show a Today page: the lock follows the user.
    if (prefs.locked === 'focus' && !isPageRoute(signals)) {
      const decision = decideMode(signals, { ...prefs, locked: null }, suppressed);
      return { decision, relock: decision.mode };
    }
    return { decision: { mode: prefs.locked, reason: 'locked', key: 'locked' }, relock: null };
  }
  if (!prefs.autoSwitch) {
    const mode: LayoutMode =
      signals.route === 'planning' ? 'planning' : signals.route === 'notes' ? 'notes' : 'overview';
    return { decision: { mode, reason: 'user_navigation', key: `route:${mode}` }, relock: null };
  }
  return { decision: decideMode(signals, prefs, suppressed), relock: null };
}

/**
 * The user navigated (or acknowledged something): show what they asked for
 * right away. Opening Today while a session runs turns that session's focus
 * layout down until the session changes, so Today is not taken away again.
 */
export function applyUserIntent(state: LayoutState | null, input: LayoutInput): IntentResult {
  const previous = state === null ? {} : pruneSuppressions(state.suppressed, input.signals);
  let suppressed: Suppressions = previous;
  const active = input.signals.activeSessionId;
  if (input.signals.route === 'today' && active !== null) {
    suppressed = { ...suppressed, focus: `session:${active}` };
  }
  const { decision, relock } = intentDecision(input.signals, input.prefs, suppressed);
  const spec = buildLayoutSpec(decision, input.signals);
  const validated = validateLayoutSpec(spec);
  if (!validated.ok) {
    if (state !== null) return { state, changed: false, relock: null };
    throw new Error(`ui-policy produced an invalid layout: ${validated.errors.join('; ')}`);
  }
  const next: LayoutState = {
    current: validated.value,
    undo: null,
    holdUntil: null,
    suppressed,
    pending: null,
  };
  return { state: next, changed: state === null || !sameLayout(state.current, next.current), relock };
}

export function initialLayoutState(input: LayoutInput): LayoutState {
  return applyUserIntent(null, input).state;
}

export function canUndo(state: LayoutState): boolean {
  return state.undo !== null;
}

/**
 * One undo step: restore the layout before the last automatic switch, turn its
 * context down, and hold the restored layout like any switch.
 */
export function undoLayout(state: LayoutState, now: InstantMs): { state: LayoutState; undone: boolean } {
  const entry = state.undo;
  if (entry === null) return { state, undone: false };
  const validated = validateLayoutSpec(entry.spec);
  if (!validated.ok) return { state: { ...state, undo: null }, undone: false };
  return {
    state: {
      current: validated.value,
      undo: null,
      holdUntil: now + HOLD_MS,
      suppressed: { ...state.suppressed, [entry.suppress.mode]: entry.suppress.key },
      pending: null,
    },
    undone: true,
  };
}

/**
 * Applies an externally supplied spec (e.g. a restored or proposed layout)
 * only if it validates; otherwise the previous layout stays.
 */
export function proposeLayout(
  state: LayoutState,
  candidate: unknown,
): { state: LayoutState; accepted: boolean; errors: readonly string[] } {
  const validated = validateLayoutSpec(candidate);
  if (!validated.ok) return { state, accepted: false, errors: validated.errors };
  return { state: { ...state, current: validated.value, pending: null }, accepted: true, errors: [] };
}
