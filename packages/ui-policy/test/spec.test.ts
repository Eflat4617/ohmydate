import {
  LAYOUT_COMPONENTS,
  LAYOUT_MODES,
  LAYOUT_SPEC_ID,
  LayoutSpecSchema,
  POLICY_VERSION,
  buildLayoutSpec,
  decideMode,
  sameLayout,
  sameStructure,
  validateLayoutSpec,
  type LayoutSpec,
  type RouteKind,
} from '../src/index.js';
import { SESSION_A, SESSION_B, prefs, signals } from './helpers.js';

function focusSpec(): LayoutSpec {
  return buildLayoutSpec(decideMode(signals({ activeSessionId: SESSION_A }), prefs()), signals({ activeSessionId: SESSION_A }));
}

function mutate(change: (spec: Record<string, unknown>) => void): unknown {
  const spec = JSON.parse(JSON.stringify(focusSpec())) as Record<string, unknown>;
  change(spec);
  return spec;
}

function regions(spec: Record<string, unknown>): Record<string, Record<string, unknown>[]> {
  return spec['regions'] as Record<string, Record<string, unknown>[]>;
}

describe('LayoutSpec ui.layout.v1', () => {
  it('has the contract id and a policy version', () => {
    expect(LayoutSpecSchema.$id).toBe(LAYOUT_SPEC_ID);
    expect(LAYOUT_SPEC_ID).toBe('ui.layout.v1');
    expect(POLICY_VERSION).toMatch(/^ui-policy@\d+\.\d+\.\d+$/);
    expect(focusSpec().policyVersion).toBe(POLICY_VERSION);
  });

  it('matches the 07 §2.1 example shape for an active session', () => {
    const spec = focusSpec();
    expect(spec).toEqual({
      mode: 'focus',
      regions: {
        primary: [{ component: 'FocusTimer', props: { sessionId: SESSION_A } }],
        secondary: [
          { component: 'CurrentTaskCard', props: { sessionId: SESSION_A } },
          { component: 'RelatedNotes', props: { limit: 3 } },
        ],
        tertiary: [{ component: 'NextUp', props: { count: 2 } }],
      },
      pinned: ['NavRail', 'BottomNav'],
      reason: 'active_session',
      policyVersion: POLICY_VERSION,
    });
    expect(validateLayoutSpec(spec)).toEqual({ ok: true, value: spec });
  });

  it('accepts every spec the policy can build', () => {
    const routes: RouteKind[] = ['today', 'focus', 'planning', 'notes', 'other'];
    for (const route of routes) {
      for (const mode of LAYOUT_MODES) {
        for (const activeSessionId of [null, SESSION_A]) {
          const context = signals({ route, activeSessionId, routeSessionId: route === 'focus' ? SESSION_B : null });
          const spec = buildLayoutSpec({ mode, reason: 'locked', key: 'locked' }, context);
          const result = validateLayoutSpec(spec);
          expect(result.ok, `${route}/${mode}/${String(activeSessionId)} ${result.ok ? '' : result.errors.join(', ')}`).toBe(true);
        }
      }
    }
  });

  it('only knows registry components', () => {
    expect(LAYOUT_COMPONENTS).toEqual([
      'TodayPlan',
      'FocusTimer',
      'PlanningWorkspace',
      'NotesWorkspace',
      'CurrentTaskCard',
      'NextUp',
      'RelatedNotes',
      'DeadlineRiskPanel',
      'ReviewPrompt',
      'ActiveSessionCard',
    ]);
  });
});

describe('validateLayoutSpec negatives (invalid → caller keeps previous layout)', () => {
  const cases: [string, unknown][] = [
    ['not an object', 'focus'],
    ['null', null],
    ['an array', []],
    ['an unknown component', mutate((s) => regions(s)['secondary']?.push({ component: 'IframeEmbed', props: {} }))],
    ['a script component', mutate((s) => regions(s)['tertiary']?.push({ component: 'script' }))],
    ['an html prop', mutate((s) => { (regions(s)['secondary']?.[1] as { props: Record<string, unknown> }).props['html'] = '<b>x</b>'; })],
    ['a style prop', mutate((s) => { (regions(s)['tertiary']?.[0] as { props: Record<string, unknown> }).props['style'] = 'color:red'; })],
    ['a url prop', mutate((s) => { (regions(s)['primary']?.[0] as { props: Record<string, unknown> }).props['url'] = 'https://example.invalid'; })],
    ['a session id that is not a uuid', mutate((s) => { (regions(s)['primary']?.[0] as { props: Record<string, unknown> }).props['sessionId'] = 'javascript:alert(1)'; })],
    ['a count out of range', mutate((s) => { (regions(s)['tertiary']?.[0] as { props: Record<string, unknown> }).props['count'] = 99; })],
    ['a fractional count', mutate((s) => { (regions(s)['tertiary']?.[0] as { props: Record<string, unknown> }).props['count'] = 1.5; })],
    ['a missing required prop', mutate((s) => { delete (regions(s)['primary']?.[0] as Record<string, unknown>)['props']; })],
    ['props on a component without props', mutate((s) => { regions(s)['tertiary']?.push({ component: 'ReviewPrompt', props: { title: 'x' } }); })],
    ['an extra item field', mutate((s) => { (regions(s)['tertiary']?.[0] as Record<string, unknown>)['className'] = 'x'; })],
    ['an extra top-level field', mutate((s) => { s['css'] = 'body{}'; })],
    ['an extra region', mutate((s) => { regions(s)['sidebar'] = []; })],
    ['an unknown mode', mutate((s) => { s['mode'] = 'dashboard'; })],
    ['an unknown reason', mutate((s) => { s['reason'] = 'because'; })],
    ['a bad policy version', mutate((s) => { s['policyVersion'] = 'v1'; })],
    ['an empty primary region', mutate((s) => { regions(s)['primary'] = []; })],
    ['too many items in a region', mutate((s) => { regions(s)['tertiary'] = [
      { component: 'NextUp', props: { count: 1 } },
      { component: 'ReviewPrompt' },
      { component: 'DeadlineRiskPanel' },
      { component: 'ActiveSessionCard', props: { sessionId: SESSION_A } },
    ]; })],
    ['navigation that is not pinned', mutate((s) => { s['pinned'] = ['NavRail']; })],
    ['duplicate pinned navigation', mutate((s) => { s['pinned'] = ['NavRail', 'NavRail']; })],
    ['a duplicate component', mutate((s) => { regions(s)['tertiary']?.push({ component: 'RelatedNotes', props: { limit: 2 } }); })],
    ['two pages', mutate((s) => { regions(s)['primary']?.push({ component: 'TodayPlan' }); })],
    ['no page', mutate((s) => { regions(s)['primary'] = [{ component: 'DeadlineRiskPanel' }]; })],
    ['a page outside primary', mutate((s) => {
      regions(s)['primary'] = [{ component: 'DeadlineRiskPanel' }];
      regions(s)['tertiary'] = [{ component: 'FocusTimer', props: { sessionId: SESSION_A } }];
    })],
    ['a focus timer outside focus mode', mutate((s) => { s['mode'] = 'overview'; })],
    ['two different sessions', mutate((s) => {
      (regions(s)['secondary']?.[0] as { props: Record<string, unknown> }).props['sessionId'] = SESSION_B;
    })],
  ];

  it.each(cases)('rejects %s', (_label, candidate) => {
    const result = validateLayoutSpec(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it('reports paths and rules, never the offending value', () => {
    const result = validateLayoutSpec(
      mutate((s) => { (regions(s)['secondary']?.[1] as { props: Record<string, unknown> }).props['html'] = '<img src=x onerror=alert(1)>'; }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('/regions/secondary/1');
      expect(result.errors.join('\n')).not.toContain('onerror');
    }
  });
});

describe('layout comparison', () => {
  it('tells a props change from a structure change', () => {
    const a = focusSpec();
    const sameIds = buildLayoutSpec(decideMode(signals({ activeSessionId: SESSION_B }), prefs()), signals({ activeSessionId: SESSION_B }));
    expect(sameStructure(a, sameIds)).toBe(true);
    expect(sameLayout(a, sameIds)).toBe(false);
    const overview = buildLayoutSpec(decideMode(signals(), prefs()), signals());
    expect(sameStructure(a, overview)).toBe(false);
    expect(sameLayout(a, JSON.parse(JSON.stringify(a)) as LayoutSpec)).toBe(true);
  });
});
