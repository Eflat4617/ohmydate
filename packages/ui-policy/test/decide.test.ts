import {
  DEFAULT_REVIEW_WINDOW,
  LAYOUT_MODES,
  decideMode,
  isInReviewWindow,
  pruneSuppressions,
  type LayoutMode,
  type LayoutSignals,
} from '../src/index.js';
import { SESSION_A, SESSION_B, prefs, signals } from './helpers.js';

/** Signals that make exactly one rule of 07 §2.2 fire. */
const TRIGGERS: Record<Exclude<LayoutMode, 'overview'>, Partial<LayoutSignals>> = {
  focus: { activeSessionId: SESSION_A },
  planning: { route: 'planning' },
  deadline_risk: { riskTaskCount: 2 },
  review: { inReviewWindow: true, unreviewedSessionCount: 1 },
  notes: { route: 'notes' },
};
const PRIORITY: readonly Exclude<LayoutMode, 'overview'>[] = ['focus', 'planning', 'deadline_risk', 'review', 'notes'];

function merge(...parts: Partial<LayoutSignals>[]): Partial<LayoutSignals> {
  return Object.assign({}, ...parts) as Partial<LayoutSignals>;
}

describe('decideMode — 07 §2.2 priority', () => {
  it('lists the modes in priority order', () => {
    expect(LAYOUT_MODES).toEqual(['focus', 'planning', 'deadline_risk', 'review', 'notes', 'overview']);
  });

  it('falls back to overview when nothing fires', () => {
    expect(decideMode(signals(), prefs())).toEqual({ mode: 'overview', reason: 'default', key: 'default' });
  });

  it.each(PRIORITY)('fires %s on its own trigger', (mode) => {
    expect(decideMode(signals(TRIGGERS[mode]), prefs()).mode).toBe(mode);
  });

  it('keys each rule by its context', () => {
    expect(decideMode(signals(TRIGGERS.focus), prefs()).key).toBe(`session:${SESSION_A}`);
    expect(decideMode(signals(TRIGGERS.planning), prefs()).key).toBe('route:planning');
    expect(decideMode(signals(TRIGGERS.deadline_risk), prefs()).key).toBe('risk:2026-11-14');
    expect(decideMode(signals(TRIGGERS.review), prefs()).key).toBe('review:2026-11-14');
    expect(decideMode(signals(TRIGGERS.notes), prefs()).key).toBe('route:notes');
  });

  // Every ordered pair: when both rules fire, the higher one wins.
  const pairs = PRIORITY.flatMap((higher, i) => PRIORITY.slice(i + 1).map((lower) => [higher, lower] as const));
  // planning and notes are both routes and can never fire together.
  const possible = pairs.filter(([a, b]) => !(a === 'planning' && b === 'notes'));

  it.each(possible)('%s beats %s', (higher, lower) => {
    const decision = decideMode(signals(merge(TRIGGERS[lower], TRIGGERS[higher])), prefs());
    expect(decision.mode).toBe(higher);
  });

  it.each(PRIORITY)('the lock beats %s', (mode) => {
    const decision = decideMode(signals(TRIGGERS[mode]), prefs({ locked: 'overview' }));
    expect(decision).toEqual({ mode: 'overview', reason: 'locked', key: 'locked' });
  });

  it('the lock beats every rule at once', () => {
    const all = merge(TRIGGERS.focus, TRIGGERS.deadline_risk, TRIGGERS.review, TRIGGERS.planning);
    expect(decideMode(signals(all), prefs({ locked: 'review' })).mode).toBe('review');
  });

  it.each(PRIORITY)('%s beats the overview default', (mode) => {
    expect(decideMode(signals(TRIGGERS[mode]), prefs()).mode).not.toBe('overview');
  });

  it('ignores a deadline risk the user acknowledged today (negative)', () => {
    expect(decideMode(signals({ riskTaskCount: 3, riskAcknowledged: true }), prefs()).mode).toBe('overview');
  });

  it('needs both the review window and an unreviewed session (negative)', () => {
    expect(decideMode(signals({ inReviewWindow: true, unreviewedSessionCount: 0 }), prefs()).mode).toBe('overview');
    expect(decideMode(signals({ inReviewWindow: false, unreviewedSessionCount: 4 }), prefs()).mode).toBe('overview');
  });

  it('treats a non-numeric risk count as no risk (negative)', () => {
    expect(decideMode(signals({ riskTaskCount: Number.NaN }), prefs()).mode).toBe('overview');
  });

  it('does not depend on the auto-switch preference (that is the machine’s job)', () => {
    expect(decideMode(signals(TRIGGERS.focus), prefs({ autoSwitch: false })).mode).toBe('focus');
  });

  it('skips a turned-down context and lets the next rule decide', () => {
    const both = signals(merge(TRIGGERS.focus, TRIGGERS.deadline_risk));
    expect(decideMode(both, prefs(), { focus: `session:${SESSION_A}` }).mode).toBe('deadline_risk');
    // A different session is a new context and fires again.
    const other = signals(merge({ activeSessionId: SESSION_B }, TRIGGERS.deadline_risk));
    expect(decideMode(other, prefs(), { focus: `session:${SESSION_A}` }).mode).toBe('focus');
  });

  it('prunes suppressions whose context is gone', () => {
    const live = signals({ activeSessionId: SESSION_A });
    expect(pruneSuppressions({ focus: `session:${SESSION_A}` }, live)).toEqual({ focus: `session:${SESSION_A}` });
    expect(pruneSuppressions({ focus: `session:${SESSION_A}` }, signals())).toEqual({});
    expect(pruneSuppressions({ ai_suggestion: '2026-11-14' }, signals())).toEqual({ ai_suggestion: '2026-11-14' });
    expect(pruneSuppressions({ ai_suggestion: '2026-11-13' }, signals())).toEqual({});
  });
});

describe('isInReviewWindow', () => {
  it('starts at 20:00 and ends at midnight', () => {
    expect(DEFAULT_REVIEW_WINDOW).toEqual({ startMinute: 1200, endMinute: 1440 });
    expect(isInReviewWindow(19 * 60 + 59)).toBe(false);
    expect(isInReviewWindow(20 * 60)).toBe(true);
    expect(isInReviewWindow(23 * 60 + 59)).toBe(true);
    expect(isInReviewWindow(0)).toBe(false);
  });

  it('supports a window that wraps past midnight', () => {
    const window = { startMinute: 22 * 60, endMinute: 2 * 60 };
    expect(isInReviewWindow(23 * 60, window)).toBe(true);
    expect(isInReviewWindow(60, window)).toBe(true);
    expect(isInReviewWindow(2 * 60, window)).toBe(false);
    expect(isInReviewWindow(12 * 60, window)).toBe(false);
  });

  it('rejects non-finite minutes (negative)', () => {
    expect(isInReviewWindow(Number.NaN)).toBe(false);
    expect(isInReviewWindow(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
