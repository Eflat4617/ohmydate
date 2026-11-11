import { Type, type Static } from '@sinclair/typebox';
import type { ModeDecision, Suppressions } from './decide.js';
import { PINNED_COMPONENTS, POLICY_VERSION, isLayoutMode, type LayoutMode } from './registry.js';
import type { LayoutPreferences } from './signals.js';
import { LayoutSpecSchema, pageItemOf, validateLayoutSpec, type LayoutSpec } from './spec.js';

/**
 * `llm.layout_suggestion.v1` (05 §7): an AI may only *suggest* a layout. The
 * suggestion is checked with the same validator as every other spec and it has
 * the lowest priority — any rule, the lock, the auto-switch setting and the
 * page the user opened all win over it. Wiring a real model is a follow-up;
 * the web does not request suggestions yet.
 */
export const LAYOUT_SUGGESTION_ID = 'llm.layout_suggestion.v1' as const;

export const LayoutSuggestionSchema = Type.Object(
  {
    kind: Type.Literal(LAYOUT_SUGGESTION_ID),
    spec: LayoutSpecSchema,
  },
  { additionalProperties: false, $id: LAYOUT_SUGGESTION_ID },
);
export type LayoutSuggestion = Static<typeof LayoutSuggestionSchema>;

export type SuggestionVerdict =
  | { readonly status: 'accepted'; readonly spec: LayoutSpec }
  | { readonly status: 'rejected'; readonly errors: readonly string[] }
  | {
      readonly status: 'ignored';
      readonly because: 'higher_priority_rule' | 'locked' | 'auto_off' | 'declined' | 'mode_mismatch' | 'page_mismatch';
    };

export interface SuggestionContext {
  readonly decision: ModeDecision;
  readonly prefs: LayoutPreferences;
  readonly suppressed: Suppressions;
  /** What the rules alone would show. */
  readonly ruleSpec: LayoutSpec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function evaluateSuggestion(candidate: unknown, context: SuggestionContext): SuggestionVerdict {
  if (!isRecord(candidate)) return { status: 'rejected', errors: ['/: expected an object'] };
  const extra = Object.keys(candidate).filter((key) => key !== 'kind' && key !== 'spec');
  if (candidate['kind'] !== LAYOUT_SUGGESTION_ID) {
    return { status: 'rejected', errors: ['/kind: expected llm.layout_suggestion.v1'] };
  }
  if (extra.length > 0) return { status: 'rejected', errors: ['/: unexpected property'] };
  const validated = validateLayoutSpec(candidate['spec']);
  if (!validated.ok) return { status: 'rejected', errors: validated.errors.map((error) => `/spec${error}`) };

  if (context.prefs.locked !== null) return { status: 'ignored', because: 'locked' };
  if (!context.prefs.autoSwitch) return { status: 'ignored', because: 'auto_off' };
  if (context.decision.reason !== 'default') return { status: 'ignored', because: 'higher_priority_rule' };
  if (context.suppressed.ai_suggestion !== undefined) return { status: 'ignored', because: 'declined' };

  const suggested = validated.value;
  const mode: LayoutMode = suggested.mode;
  if (!isLayoutMode(mode) || mode !== context.ruleSpec.mode) return { status: 'ignored', because: 'mode_mismatch' };
  // The suggestion may rearrange panels, never change or move the page.
  const page = pageItemOf(suggested);
  const rulePage = pageItemOf(context.ruleSpec);
  if (page === null || rulePage === null || JSON.stringify(page) !== JSON.stringify(rulePage)) {
    return { status: 'ignored', because: 'page_mismatch' };
  }
  const spec: LayoutSpec = {
    mode: suggested.mode,
    regions: suggested.regions,
    pinned: [...PINNED_COMPONENTS],
    reason: 'ai_suggestion',
    policyVersion: POLICY_VERSION,
  };
  return { status: 'accepted', spec };
}
