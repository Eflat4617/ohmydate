import { buildLayoutSpec, decideMode, focusSessionId, pageItemOf, type LayoutSpec } from '../src/index.js';
import { SESSION_A, SESSION_B, prefs, signals } from './helpers.js';
import type { LayoutSignals } from '../src/index.js';

function specFor(overrides: Partial<LayoutSignals>): LayoutSpec {
  const context = signals(overrides);
  return buildLayoutSpec(decideMode(context, prefs()), context);
}

function ids(spec: LayoutSpec): Record<string, string[]> {
  return {
    primary: spec.regions.primary.map((item) => item.component),
    secondary: spec.regions.secondary.map((item) => item.component),
    tertiary: spec.regions.tertiary.map((item) => item.component),
  };
}

describe('buildLayoutSpec — workspace (Today / Focus)', () => {
  it('overview: Today first, next up and related notes beside it', () => {
    expect(ids(specFor({}))).toEqual({
      primary: ['TodayPlan'],
      secondary: ['NextUp'],
      tertiary: ['RelatedNotes'],
    });
  });

  it('focus: the timer, the current task and notes, next up last', () => {
    expect(ids(specFor({ activeSessionId: SESSION_A }))).toEqual({
      primary: ['FocusTimer'],
      secondary: ['CurrentTaskCard', 'RelatedNotes'],
      tertiary: ['NextUp'],
    });
  });

  it('deadline risk: the risk panel above Today', () => {
    expect(ids(specFor({ riskTaskCount: 1 }))).toEqual({
      primary: ['DeadlineRiskPanel', 'TodayPlan'],
      secondary: ['NextUp'],
      tertiary: ['RelatedNotes'],
    });
  });

  it('review: the review prompt above Today', () => {
    expect(ids(specFor({ inReviewWindow: true, unreviewedSessionCount: 2 }))).toEqual({
      primary: ['ReviewPrompt', 'TodayPlan'],
      secondary: ['NextUp'],
      tertiary: ['RelatedNotes'],
    });
  });

  it('focus on a focus route shows the session in the URL', () => {
    const spec = specFor({ route: 'focus', routeSessionId: SESSION_B, activeSessionId: SESSION_A });
    expect(pageItemOf(spec)).toEqual({ component: 'FocusTimer', props: { sessionId: SESSION_B } });
    expect(focusSessionId(signals({ route: 'today', activeSessionId: SESSION_A }))).toBe(SESSION_A);
  });

  it('a focus lock without any session keeps Today as the page (negative)', () => {
    const spec = buildLayoutSpec({ mode: 'focus', reason: 'locked', key: 'locked' }, signals());
    expect(ids(spec)).toEqual({ primary: ['TodayPlan'], secondary: ['RelatedNotes'], tertiary: ['NextUp'] });
  });
});

describe('buildLayoutSpec — the page the user opened is never replaced', () => {
  it('planning route: the planning page stays primary', () => {
    expect(ids(specFor({ route: 'planning' }))).toEqual({
      primary: ['PlanningWorkspace'],
      secondary: ['RelatedNotes'],
      tertiary: ['NextUp'],
    });
  });

  it('planning route with a running session: focus panels go beside the page', () => {
    const spec = specFor({ route: 'planning', activeSessionId: SESSION_A });
    expect(spec.mode).toBe('focus');
    expect(ids(spec)).toEqual({
      primary: ['PlanningWorkspace'],
      secondary: ['ActiveSessionCard', 'CurrentTaskCard'],
      tertiary: ['RelatedNotes'],
    });
  });

  it('notes route: the notes page with more related notes', () => {
    const spec = specFor({ route: 'notes' });
    expect(spec.mode).toBe('notes');
    expect(ids(spec)).toEqual({ primary: ['NotesWorkspace'], secondary: ['RelatedNotes'], tertiary: ['NextUp'] });
    expect(spec.regions.secondary[0]).toEqual({ component: 'RelatedNotes', props: { limit: 5 } });
  });

  it('notes route with a deadline risk: the risk panel goes to the side', () => {
    expect(ids(specFor({ route: 'notes', riskTaskCount: 1 }))).toEqual({
      primary: ['NotesWorkspace'],
      secondary: ['DeadlineRiskPanel'],
      tertiary: ['RelatedNotes'],
    });
  });

  it('notes route in the review window: the review prompt goes to the side', () => {
    expect(ids(specFor({ route: 'notes', inReviewWindow: true, unreviewedSessionCount: 1 }))).toEqual({
      primary: ['NotesWorkspace'],
      secondary: ['ReviewPrompt'],
      tertiary: ['RelatedNotes'],
    });
  });

  it('a locked planning layout keeps the running session reachable', () => {
    const spec = buildLayoutSpec(
      { mode: 'planning', reason: 'locked', key: 'locked' },
      signals({ route: 'planning', activeSessionId: SESSION_A }),
    );
    expect(ids(spec).secondary).toEqual(['ActiveSessionCard', 'RelatedNotes']);
  });

  it('never puts the Today or Focus page on a planning or notes route (negative)', () => {
    for (const route of ['planning', 'notes'] as const) {
      for (const mode of ['focus', 'overview', 'deadline_risk', 'review', 'planning', 'notes'] as const) {
        const spec = buildLayoutSpec({ mode, reason: 'locked', key: 'locked' }, signals({ route, activeSessionId: SESSION_A }));
        const page = pageItemOf(spec)?.component;
        expect(page).toBe(route === 'planning' ? 'PlanningWorkspace' : 'NotesWorkspace');
      }
    }
  });
});
