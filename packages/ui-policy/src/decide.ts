import type { LayoutMode, LayoutReason } from './registry.js';
import type { LayoutPreferences, LayoutSignals } from './signals.js';

export interface ModeDecision {
  readonly mode: LayoutMode;
  readonly reason: LayoutReason;
  /**
   * Identity of the context that fired the rule (e.g. `session:<id>`). An undo
   * suppresses exactly this key, so the same context does not switch back.
   */
  readonly key: string;
}

/** Contexts the user turned down, by mode (plus `ai_suggestion`). */
export type Suppressions = Readonly<Partial<Record<LayoutMode | 'ai_suggestion', string>>>;

interface Rule {
  readonly mode: Exclude<LayoutMode, 'overview'>;
  readonly reason: LayoutReason;
  readonly key: (signals: LayoutSignals) => string | null;
}

/** 07 §2.2 rules 2–6, in priority order. Rule 1 (lock) and 7 (default) wrap them. */
export const MODE_RULES: readonly Rule[] = [
  {
    mode: 'focus',
    reason: 'active_session',
    key: (s) => (s.activeSessionId === null ? null : `session:${s.activeSessionId}`),
  },
  {
    mode: 'planning',
    reason: 'planning_route',
    key: (s) => (s.route === 'planning' ? 'route:planning' : null),
  },
  {
    mode: 'deadline_risk',
    reason: 'deadline_risk',
    key: (s) => (s.riskTaskCount > 0 && !s.riskAcknowledged ? `risk:${s.day}` : null),
  },
  {
    mode: 'review',
    reason: 'review_window',
    key: (s) => (s.inReviewWindow && s.unreviewedSessionCount > 0 ? `review:${s.day}` : null),
  },
  {
    mode: 'notes',
    reason: 'notes_route',
    key: (s) => (s.route === 'notes' ? 'route:notes' : null),
  },
];

export const DEFAULT_DECISION: ModeDecision = { mode: 'overview', reason: 'default', key: 'default' };

/** The context key a mode's rule would fire with right now, or null. */
export function liveKeyFor(mode: LayoutMode, signals: LayoutSignals): string | null {
  const rule = MODE_RULES.find((candidate) => candidate.mode === mode);
  return rule === undefined ? null : rule.key(signals);
}

/**
 * Mode decision (07 §2.2), first match wins:
 * 1 locked → 2 active session → 3 planning route → 4 deadline risk not yet
 * acknowledged today → 5 review window with an unreviewed session → 6 notes
 * route → 7 overview. A rule whose context the user turned down (undo) is
 * skipped, so the next rule decides.
 */
export function decideMode(
  signals: LayoutSignals,
  prefs: LayoutPreferences,
  suppressed: Suppressions = {},
): ModeDecision {
  if (prefs.locked !== null) return { mode: prefs.locked, reason: 'locked', key: 'locked' };
  for (const rule of MODE_RULES) {
    const key = rule.key(signals);
    if (key !== null && suppressed[rule.mode] !== key) {
      return { mode: rule.mode, reason: rule.reason, key };
    }
  }
  return DEFAULT_DECISION;
}

/** Drops suppressions whose context is gone (another session, another day…). */
export function pruneSuppressions(suppressed: Suppressions, signals: LayoutSignals): Suppressions {
  const next: Partial<Record<LayoutMode | 'ai_suggestion', string>> = {};
  for (const [mode, key] of Object.entries(suppressed) as [LayoutMode | 'ai_suggestion', string][]) {
    if (mode === 'ai_suggestion') {
      // A turned-down suggestion stays declined for the rest of the day.
      if (key === signals.day) next[mode] = key;
      continue;
    }
    if (mode === 'overview') continue;
    if (liveKeyFor(mode, signals) === key) next[mode] = key;
  }
  return next;
}
