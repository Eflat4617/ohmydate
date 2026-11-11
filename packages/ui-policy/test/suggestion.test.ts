import {
  LAYOUT_SUGGESTION_ID,
  LayoutSuggestionSchema,
  buildLayoutSpec,
  decideMode,
  evaluateSuggestion,
  initialLayoutState,
  stepLayout,
  undoLayout,
  type LayoutPreferences,
  type LayoutSignals,
} from '../src/index.js';
import invalidFixture from './fixtures/layout-suggestion.invalid.json' with { type: 'json' };
import validFixture from './fixtures/layout-suggestion.valid.json' with { type: 'json' };
import { MINUTE, SESSION_A, T0, input, prefs, signals } from './helpers.js';

function context(signalOverrides: Partial<LayoutSignals> = {}, prefOverrides: Partial<LayoutPreferences> = {}) {
  const s = signals(signalOverrides);
  const p = prefs(prefOverrides);
  const decision = decideMode(s, p);
  return { decision, prefs: p, suppressed: {}, ruleSpec: buildLayoutSpec(decision, s) };
}

describe('llm.layout_suggestion.v1 (suggestion only, lowest priority)', () => {
  it('has its contract id', () => {
    expect(LayoutSuggestionSchema.$id).toBe(LAYOUT_SUGGESTION_ID);
  });

  it('accepts the valid fixture when no rule fires', () => {
    const verdict = evaluateSuggestion(validFixture, context());
    expect(verdict.status).toBe('accepted');
    if (verdict.status === 'accepted') {
      expect(verdict.spec.reason).toBe('ai_suggestion');
      expect(verdict.spec.regions.tertiary).toEqual([{ component: 'NextUp', props: { count: 4 } }]);
    }
  });

  it('rejects the invalid fixture (html prop, unknown component, unpinned nav)', () => {
    const verdict = evaluateSuggestion(invalidFixture, context());
    expect(verdict.status).toBe('rejected');
    if (verdict.status === 'rejected') {
      expect(verdict.errors.join('\n')).not.toContain('steal');
      expect(verdict.errors.join('\n')).not.toContain('example.invalid');
    }
  });

  it.each([
    ['a missing kind', { spec: validFixture.spec }],
    ['another kind', { ...validFixture, kind: 'llm.layout_suggestion.v2' }],
    ['an extra field', { ...validFixture, rationale: '<b>trust me</b>' }],
    ['not an object', 'focus please'],
  ])('rejects %s', (_label, candidate) => {
    expect(evaluateSuggestion(candidate, context()).status).toBe('rejected');
  });

  it('loses to every rule', () => {
    for (const overrides of [
      { activeSessionId: SESSION_A },
      { route: 'planning' as const },
      { riskTaskCount: 1 },
      { inReviewWindow: true, unreviewedSessionCount: 1 },
      { route: 'notes' as const },
    ]) {
      const verdict = evaluateSuggestion(validFixture, context(overrides));
      expect(verdict.status).toBe('ignored');
    }
  });

  it('loses to the lock and to auto switch off', () => {
    expect(evaluateSuggestion(validFixture, context({}, { locked: 'overview' }))).toEqual({
      status: 'ignored',
      because: 'locked',
    });
    expect(evaluateSuggestion(validFixture, context({}, { autoSwitch: false }))).toEqual({
      status: 'ignored',
      because: 'auto_off',
    });
  });

  it('may not change the page the user opened', () => {
    const verdict = evaluateSuggestion(validFixture, context({ route: 'notes' }, { locked: null }));
    expect(verdict.status).toBe('ignored');
    const planningPage = {
      ...validFixture,
      spec: { ...validFixture.spec, regions: { ...validFixture.spec.regions, primary: [{ component: 'PlanningWorkspace' }] } },
    };
    expect(evaluateSuggestion(planningPage, context())).toEqual({ status: 'ignored', because: 'page_mismatch' });
  });

  it('switches through the machine and stays declined for the day after an undo', () => {
    const state = initialLayoutState(input(T0));
    const step = stepLayout(state, input(T0 + MINUTE, {}, { suggestion: validFixture }));
    expect(step.suggestion?.status).toBe('accepted');
    expect(step.outcome.kind).toBe('switched');
    expect(step.state.current.reason).toBe('ai_suggestion');
    const undone = undoLayout(step.state, T0 + 2 * MINUTE).state;
    expect(undone.current.reason).toBe('default');
    const again = stepLayout(undone, input(T0 + 30 * MINUTE, {}, { suggestion: validFixture }));
    expect(again.suggestion).toEqual({ status: 'ignored', because: 'declined' });
    expect(again.state.current.reason).toBe('default');
  });

  it('an invalid suggestion through the machine keeps the rule layout', () => {
    const state = initialLayoutState(input(T0));
    const step = stepLayout(state, input(T0 + MINUTE, {}, { suggestion: invalidFixture }));
    expect(step.suggestion?.status).toBe('rejected');
    expect(step.outcome.kind).toBe('unchanged');
    expect(step.state.current).toEqual(state.current);
  });
});
