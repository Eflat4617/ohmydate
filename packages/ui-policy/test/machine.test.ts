import {
  HOLD_MS,
  applyUserIntent,
  canUndo,
  initialLayoutState,
  pageItemOf,
  proposeLayout,
  stepLayout,
  undoLayout,
  type LayoutState,
} from '../src/index.js';
import { MINUTE, SESSION_A, SESSION_B, T0, input } from './helpers.js';

const SECOND = 1000;
const ON_TODAY = { route: 'today' as const };
const SESSION = { activeSessionId: SESSION_A };

function overviewState(): LayoutState {
  return initialLayoutState(input(T0, ON_TODAY));
}

/** Overview, then an automatic switch to the deadline-risk layout at `T0`. */
function switchedToRisk(): LayoutState {
  const result = stepLayout(overviewState(), input(T0, { ...ON_TODAY, riskTaskCount: 1 }));
  expect(result.outcome.kind).toBe('switched');
  expect(result.state.current.mode).toBe('deadline_risk');
  return result.state;
}

/** Overview, then an automatic switch to focus at `T0`. */
function switchedToFocus(): LayoutState {
  const result = stepLayout(overviewState(), input(T0, { ...ON_TODAY, ...SESSION }));
  expect(result.outcome.kind).toBe('switched');
  return result.state;
}

describe('initial layout', () => {
  it('starts from the user’s route without a hold or an undo step', () => {
    const state = overviewState();
    expect(state.current.mode).toBe('overview');
    expect(state.holdUntil).toBeNull();
    expect(canUndo(state)).toBe(false);
  });

  it('is unchanged when nothing changes', () => {
    expect(stepLayout(overviewState(), input(T0 + MINUTE, ON_TODAY)).outcome).toEqual({ kind: 'unchanged' });
  });
});

describe('automatic switch', () => {
  it('switches to focus when a session starts and keeps one undo step', () => {
    const before = overviewState();
    const result = stepLayout(before, input(T0, { ...ON_TODAY, ...SESSION }));
    expect(result.outcome).toMatchObject({ kind: 'switched' });
    expect(result.state.current.mode).toBe('focus');
    expect(result.state.current.reason).toBe('active_session');
    expect(pageItemOf(result.state.current)).toEqual({ component: 'FocusTimer', props: { sessionId: SESSION_A } });
    expect(result.state.undo?.spec).toEqual(before.current);
    expect(result.state.holdUntil).toBe(T0 + HOLD_MS);
  });

  // Hold boundaries on Today: a deadline risk appears at T0 (automatic switch),
  // then clears again; the risk layout must stay for 10 minutes.
  it('holds the layout for 10 minutes: 9:59 still waits', () => {
    const state = switchedToRisk();
    const result = stepLayout(state, input(T0 + 9 * MINUTE + 59 * SECOND, ON_TODAY));
    expect(result.outcome).toMatchObject({ kind: 'deferred', because: 'hold', retryAt: T0 + HOLD_MS });
    expect(result.state.current.mode).toBe('deadline_risk');
    expect(result.state.pending?.mode).toBe('overview');
  });

  it('holds the layout for 10 minutes: 10:00 switches', () => {
    const state = switchedToRisk();
    const result = stepLayout(state, input(T0 + 10 * MINUTE, ON_TODAY));
    expect(result.outcome.kind).toBe('switched');
    expect(result.state.current.mode).toBe('overview');
    expect(result.state.pending).toBeNull();
  });

  it('holds exactly HOLD_MS: one millisecond before still waits', () => {
    expect(HOLD_MS).toBe(600_000);
    const state = switchedToRisk();
    expect(stepLayout(state, input(T0 + HOLD_MS - 1, ON_TODAY)).outcome.kind).toBe('deferred');
    expect(stepLayout(state, input(T0 + HOLD_MS, ON_TODAY)).outcome.kind).toBe('switched');
  });

  it('a switch restarts the hold', () => {
    const state = switchedToRisk();
    const back = stepLayout(state, input(T0 + 10 * MINUTE, ON_TODAY)).state;
    expect(back.holdUntil).toBe(T0 + 10 * MINUTE + HOLD_MS);
    const again = stepLayout(back, input(T0 + 11 * MINUTE, { ...ON_TODAY, riskTaskCount: 1 }));
    expect(again.outcome).toMatchObject({ kind: 'deferred', because: 'hold' });
  });

  it('a deferred switch happens on the first step after the hold', () => {
    const state = switchedToRisk();
    const held = stepLayout(state, input(T0 + 3 * MINUTE, { ...ON_TODAY, riskTaskCount: 1, ...SESSION }));
    expect(held.outcome).toMatchObject({ kind: 'deferred', because: 'hold' });
    const later = stepLayout(held.state, input(T0 + HOLD_MS, { ...ON_TODAY, riskTaskCount: 1, ...SESSION }));
    expect(later.outcome.kind).toBe('switched');
    expect(later.state.current.mode).toBe('focus');
  });
});

describe('the Focus screen the user is on', () => {
  const ON_FOCUS = { route: 'focus' as const, routeSessionId: SESSION_A };

  it('stays after its session ends, even once the hold is over (review sheet)', () => {
    const onFocus = stepLayout(switchedToFocus(), input(T0 + SECOND, { ...ON_FOCUS, ...SESSION })).state;
    const ended = stepLayout(onFocus, input(T0 + HOLD_MS + MINUTE, ON_FOCUS));
    expect(ended.outcome).toMatchObject({ kind: 'deferred', because: 'page' });
    expect(pageItemOf(ended.state.current)).toEqual({ component: 'FocusTimer', props: { sessionId: SESSION_A } });
  });

  it('stays when the user opened it themselves and the session ends', () => {
    const opened = applyUserIntent(null, input(T0, { ...ON_FOCUS, ...SESSION })).state;
    expect(opened.holdUntil).toBeNull();
    const ended = stepLayout(opened, input(T0 + MINUTE, { ...ON_FOCUS, riskTaskCount: 1 }));
    expect(ended.outcome).toMatchObject({ kind: 'deferred', because: 'page' });
    expect(ended.state.current.mode).toBe('focus');
  });

  it('is not moved to another session started elsewhere', () => {
    const opened = applyUserIntent(null, input(T0, { ...ON_FOCUS, ...SESSION })).state;
    const other = stepLayout(opened, input(T0 + MINUTE, { route: 'today', activeSessionId: SESSION_B }));
    // On Today the page may change (Today → Focus is the adaptive switch)…
    expect(other.outcome.kind).not.toBe('deferred');
    // …but on the Focus route the session in the URL stays on screen.
    const onRoute = stepLayout(opened, input(T0 + MINUTE, { ...ON_FOCUS, activeSessionId: SESSION_B }));
    expect(onRoute.outcome).toEqual({ kind: 'unchanged' });
    expect(pageItemOf(onRoute.state.current)).toEqual({ component: 'FocusTimer', props: { sessionId: SESSION_A } });
  });

  it('still lets the user leave by undo (negative for the guard)', () => {
    const onFocus = stepLayout(switchedToFocus(), input(T0 + SECOND, { ...ON_FOCUS, ...SESSION })).state;
    const undone = undoLayout(onFocus, T0 + 2 * SECOND);
    expect(undone.undone).toBe(true);
    expect(pageItemOf(undone.state.current)?.component).toBe('TodayPlan');
  });
});

describe('deferral while the user works', () => {
  it('waits while the user is typing, then switches when they stop', () => {
    const typing = stepLayout(overviewState(), input(T0, { ...ON_TODAY, ...SESSION }, { interaction: { typing: true } }));
    expect(typing.outcome).toMatchObject({ kind: 'deferred', because: 'typing' });
    expect(typing.state.current.mode).toBe('overview');
    expect(typing.state.pending?.mode).toBe('focus');
    const idle = stepLayout(typing.state, input(T0 + 2 * SECOND, { ...ON_TODAY, ...SESSION }));
    expect(idle.outcome.kind).toBe('switched');
    expect(idle.state.current.mode).toBe('focus');
  });

  it('waits while the user is dragging', () => {
    const result = stepLayout(overviewState(), input(T0, { ...ON_TODAY, ...SESSION }, { interaction: { dragging: true } }));
    expect(result.outcome).toMatchObject({ kind: 'deferred', because: 'dragging' });
  });

  it('never removes a component the user is working in until they are idle', () => {
    const result = stepLayout(
      overviewState(),
      input(T0, { ...ON_TODAY, ...SESSION }, { interaction: { activeComponents: ['TodayPlan'] } }),
    );
    expect(result.outcome).toMatchObject({ kind: 'deferred', because: 'interacting' });
    expect(result.state.current.regions.primary[0]?.component).toBe('TodayPlan');
  });

  it('does switch when the busy component survives the switch', () => {
    // RelatedNotes is in both the overview and the focus layout.
    const result = stepLayout(
      overviewState(),
      input(T0, { ...ON_TODAY, ...SESSION }, { interaction: { activeComponents: ['RelatedNotes'] } }),
    );
    expect(result.outcome.kind).toBe('switched');
  });

  it('typing also delays a silent props update', () => {
    const state = switchedToFocus();
    const result = stepLayout(state, input(T0 + MINUTE, { ...ON_TODAY, activeSessionId: SESSION_B }, { interaction: { typing: true } }));
    expect(result.outcome).toMatchObject({ kind: 'deferred', because: 'typing' });
  });
});

describe('undo (one step)', () => {
  it('restores the previous layout and does not switch straight back', () => {
    const state = switchedToFocus();
    const undone = undoLayout(state, T0 + 5 * SECOND);
    expect(undone.undone).toBe(true);
    expect(undone.state.current.mode).toBe('overview');
    expect(undone.state.current).toEqual(overviewState().current);
    expect(canUndo(undone.state)).toBe(false);
    // The session is still running, but its focus layout was turned down.
    const after = stepLayout(undone.state, input(T0 + 11 * MINUTE, { ...ON_TODAY, ...SESSION }));
    expect(after.state.current.mode).toBe('overview');
    expect(after.outcome.kind).toBe('unchanged');
  });

  it('allows only one step', () => {
    const state = switchedToFocus();
    const once = undoLayout(state, T0 + SECOND).state;
    const twice = undoLayout(once, T0 + 2 * SECOND);
    expect(twice.undone).toBe(false);
    expect(twice.state).toBe(once);
  });

  it('holds the restored layout', () => {
    const state = switchedToFocus();
    const undone = undoLayout(state, T0 + MINUTE).state;
    expect(undone.holdUntil).toBe(T0 + MINUTE + HOLD_MS);
    const risk = stepLayout(undone, input(T0 + 2 * MINUTE, { ...ON_TODAY, ...SESSION, riskTaskCount: 1 }));
    expect(risk.outcome).toMatchObject({ kind: 'deferred', because: 'hold' });
  });

  it('a new session is a new context and may switch again after the hold', () => {
    const undone = undoLayout(switchedToFocus(), T0 + MINUTE).state;
    const next = stepLayout(undone, input(T0 + MINUTE + HOLD_MS, { ...ON_TODAY, activeSessionId: SESSION_B }));
    expect(next.outcome.kind).toBe('switched');
    expect(next.state.current.mode).toBe('focus');
  });

  it('has nothing to undo after the user’s own navigation (negative)', () => {
    const state = switchedToFocus();
    const navigated = applyUserIntent(state, input(T0 + MINUTE, { route: 'focus', routeSessionId: SESSION_A, ...SESSION }));
    expect(canUndo(navigated.state)).toBe(false);
    expect(undoLayout(navigated.state, T0 + 2 * MINUTE).undone).toBe(false);
  });
});

describe('lock and auto switch off', () => {
  it('locking the shown layout only marks it locked: a session and a risk change nothing', () => {
    const state = overviewState();
    const locked = { prefs: { locked: 'overview' as const } };
    const result = stepLayout(state, input(T0, { ...ON_TODAY, ...SESSION, riskTaskCount: 2 }, locked));
    expect(result.outcome).toEqual({ kind: 'refreshed' });
    expect(result.state.current.mode).toBe('overview');
    expect(result.state.current.reason).toBe('locked');
    expect(result.state.current.regions).toEqual(state.current.regions);
    expect(canUndo(result.state)).toBe(false);
  });

  it('the lock blocks any change of arrangement', () => {
    // Locked in focus; the session ends, which would normally go back to Today.
    const state = switchedToFocus();
    const result = stepLayout(state, input(T0 + HOLD_MS, ON_TODAY, { prefs: { locked: 'focus' } }));
    expect(result.outcome).toEqual({ kind: 'blocked', because: 'locked' });
    expect(result.state.current).toEqual(state.current);
  });

  it('auto switch off keeps the layout', () => {
    const result = stepLayout(overviewState(), input(T0, { ...ON_TODAY, ...SESSION }, { prefs: { autoSwitch: false } }));
    expect(result.outcome).toEqual({ kind: 'blocked', because: 'auto_off' });
    expect(result.state.current.mode).toBe('overview');
  });

  it('auto switch off still follows the user’s navigation', () => {
    const result = applyUserIntent(
      overviewState(),
      input(T0, { route: 'focus', routeSessionId: SESSION_A, ...SESSION }, { prefs: { autoSwitch: false } }),
    );
    expect(result.state.current.mode).toBe('focus');
    expect(result.changed).toBe(true);
  });

  it('auto switch off opens Today in its basic layout even with a risk', () => {
    const result = applyUserIntent(null, input(T0, { ...ON_TODAY, riskTaskCount: 1 }, { prefs: { autoSwitch: false } }));
    expect(result.state.current.mode).toBe('overview');
    expect(result.state.current.reason).toBe('user_navigation');
  });

  it('opening a focus session moves a lock that cannot show it', () => {
    const result = applyUserIntent(
      overviewState(),
      input(T0, { route: 'focus', routeSessionId: SESSION_A, ...SESSION }, { prefs: { locked: 'overview' } }),
    );
    expect(result.relock).toBe('focus');
    expect(result.state.current.mode).toBe('focus');
  });

  it('opening Today moves a focus lock to what Today shows', () => {
    const result = applyUserIntent(null, input(T0, { ...ON_TODAY, ...SESSION }, { prefs: { locked: 'focus' } }));
    expect(result.relock).toBe('overview');
    expect(result.state.current.mode).toBe('overview');
  });

  it('a compatible lock survives navigation', () => {
    const result = applyUserIntent(null, input(T0, { ...ON_TODAY, riskTaskCount: 1 }, { prefs: { locked: 'review' } }));
    expect(result.relock).toBeNull();
    expect(result.state.current.mode).toBe('review');
    expect(result.state.current.reason).toBe('locked');
  });
});

describe('the user’s navigation', () => {
  it('applies at once, even during a hold, and clears the hold', () => {
    const state = switchedToFocus();
    const result = applyUserIntent(state, input(T0 + MINUTE, { ...ON_TODAY, ...SESSION }));
    expect(result.changed).toBe(true);
    expect(result.state.current.mode).toBe('overview');
    expect(result.state.holdUntil).toBeNull();
  });

  it('opening Today during a session turns that session’s focus layout down', () => {
    const result = applyUserIntent(null, input(T0, { ...ON_TODAY, ...SESSION }));
    expect(result.state.current.mode).toBe('overview');
    const later = stepLayout(result.state, input(T0 + 30 * MINUTE, { ...ON_TODAY, ...SESSION }));
    expect(later.outcome.kind).toBe('unchanged');
    // …but a new session still switches.
    const other = stepLayout(result.state, input(T0 + 31 * MINUTE, { ...ON_TODAY, activeSessionId: SESSION_B }));
    expect(other.outcome.kind).toBe('switched');
  });

  it('opening Today with a risk shows the risk layout', () => {
    expect(applyUserIntent(null, input(T0, { ...ON_TODAY, riskTaskCount: 1 })).state.current.mode).toBe('deadline_risk');
  });

  it('opening a finished session’s focus page shows that session', () => {
    const result = applyUserIntent(null, input(T0, { route: 'focus', routeSessionId: SESSION_B }));
    expect(result.state.current.mode).toBe('focus');
    expect(result.state.current.reason).toBe('user_navigation');
    expect(pageItemOf(result.state.current)).toEqual({ component: 'FocusTimer', props: { sessionId: SESSION_B } });
  });

  it('reports no change when the layout is already what the user asked for', () => {
    const state = overviewState();
    expect(applyUserIntent(state, input(T0, ON_TODAY)).changed).toBe(false);
  });
});

describe('silent refresh', () => {
  it('updates props without a switch, hold or undo step', () => {
    const state = switchedToFocus();
    const result = stepLayout(state, input(T0 + MINUTE, { ...ON_TODAY, activeSessionId: SESSION_B }));
    expect(result.outcome).toEqual({ kind: 'refreshed' });
    expect(pageItemOf(result.state.current)).toEqual({ component: 'FocusTimer', props: { sessionId: SESSION_B } });
    expect(result.state.holdUntil).toBe(state.holdUntil);
    expect(result.state.undo).toBe(state.undo);
  });
});

describe('invalid spec → keep the previous layout', () => {
  it('rejects a proposed spec that fails validation', () => {
    const state = switchedToFocus();
    const result = proposeLayout(state, { ...state.current, regions: { ...state.current.regions, primary: [{ component: 'Script' }] } });
    expect(result.accepted).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.state).toBe(state);
  });

  it('accepts a proposed spec that validates', () => {
    const state = switchedToFocus();
    const result = proposeLayout(state, overviewState().current);
    expect(result.accepted).toBe(true);
    expect(result.state.current.mode).toBe('overview');
  });

  it('drops an undo entry that no longer validates and keeps the layout', () => {
    const state = switchedToFocus();
    const broken = { ...state, undo: { spec: { ...state.current, pinned: [] } as never, suppress: { mode: 'focus' as const, key: 'x' } } };
    const result = undoLayout(broken, T0 + MINUTE);
    expect(result.undone).toBe(false);
    expect(result.state.current).toEqual(state.current);
    expect(result.state.undo).toBeNull();
  });
});
