import {
  DEFAULT_PREFERENCES,
  IDLE_INTERACTION,
  type InteractionSignals,
  type LayoutInput,
  type LayoutPreferences,
  type LayoutSignals,
} from '../src/index.js';

export const SESSION_A = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
export const SESSION_B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
export const MINUTE = 60_000;
export const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);

export function signals(overrides: Partial<LayoutSignals> = {}): LayoutSignals {
  return {
    route: 'today',
    routeSessionId: null,
    activeSessionId: null,
    riskTaskCount: 0,
    riskAcknowledged: false,
    inReviewWindow: false,
    unreviewedSessionCount: 0,
    day: '2026-11-14',
    ...overrides,
  };
}

export function prefs(overrides: Partial<LayoutPreferences> = {}): LayoutPreferences {
  return { ...DEFAULT_PREFERENCES, ...overrides };
}

export function input(
  now: number,
  signalOverrides: Partial<LayoutSignals> = {},
  options: {
    prefs?: Partial<LayoutPreferences>;
    interaction?: Partial<InteractionSignals>;
    suggestion?: unknown;
  } = {},
): LayoutInput {
  return {
    now,
    signals: signals(signalOverrides),
    prefs: prefs(options.prefs),
    interaction: { ...IDLE_INTERACTION, ...options.interaction },
    ...(options.suggestion === undefined ? {} : { suggestion: options.suggestion }),
  };
}
