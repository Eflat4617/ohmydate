/**
 * Intake state machine (05-AI-AGENT-SPEC §2).
 *
 * Pure transition table: `transition(state, event)` returns the next state plus the ordered
 * effects the application layer must perform. Illegal transitions throw
 * `IntakeTransitionError` with the stable code `illegal_transition`.
 *
 * The machine deliberately knows nothing about persistence or scheduling: it only names the
 * effects. All states are resumable; `cancelled` and `failed` are terminal.
 */

import type { IntakeField } from './questions.js';

export const INTAKE_STATES = [
  'created',
  'type_detection',
  'clarification',
  'needs_input',
  'decomposition',
  'feasibility_check',
  'plan_proposals',
  'awaiting_approval',
  'scheduled',
  'cancelled',
  'failed',
] as const;

export type IntakeState = (typeof INTAKE_STATES)[number];

export const TERMINAL_INTAKE_STATES = ['cancelled', 'failed'] as const;
export type TerminalIntakeState = (typeof TERMINAL_INTAKE_STATES)[number];

export type IntakeEffect =
  | { readonly type: 'agent_run'; readonly agent: 'detect_type' }
  | { readonly type: 'generate_questions' }
  | { readonly type: 'load_template' }
  | { readonly type: 'apply_conservative_defaults' }
  | { readonly type: 'create_tasks' }
  | { readonly type: 'store_plan_candidates' }
  | { readonly type: 'schedule_blocks' }
  | { readonly type: 'notify' }
  | { readonly type: 'regenerate_plan' }
  | { readonly type: 'enter_manual_mode' };

export type IntakeEventType =
  | 'input_accepted'
  | 'type_detected'
  | 'user_requested_more_time'
  | 'user_answered'
  | 'proceed_with_defaults'
  | 'draft_approved'
  | 'scheduler_completed'
  | 'user_selected_candidate'
  | 'approval_succeeded'
  | 'availability_version_mismatch'
  | 'user_requested_rescope'
  | 'user_requested_regeneration'
  | 'user_cancelled'
  | 'unrecoverable_error';

export type IntakeEvent =
  | { readonly type: 'input_accepted' }
  | {
      readonly type: 'type_detected';
      readonly classification: 'new' | 'similar';
      readonly missingRequired: readonly IntakeField[];
      readonly similarConfirmed?: boolean;
    }
  | { readonly type: 'user_requested_more_time' }
  | { readonly type: 'user_answered' }
  | { readonly type: 'proceed_with_defaults' }
  | { readonly type: 'draft_approved' }
  | { readonly type: 'scheduler_completed'; readonly candidateCount: number }
  | { readonly type: 'user_selected_candidate' }
  | { readonly type: 'approval_succeeded' }
  | { readonly type: 'availability_version_mismatch' }
  | { readonly type: 'user_requested_rescope' }
  | { readonly type: 'user_requested_regeneration' }
  | { readonly type: 'user_cancelled' }
  | { readonly type: 'unrecoverable_error' };

export interface IntakeTransitionResult {
  readonly state: IntakeState;
  readonly effects: readonly IntakeEffect[];
}

export class IntakeTransitionError extends Error {
  readonly code = 'illegal_transition' as const;

  constructor(
    readonly from: IntakeState,
    readonly eventType: IntakeEventType,
  ) {
    super(`illegal intake transition: ${from} --${eventType}-->`);
    this.name = 'IntakeTransitionError';
  }
}

export function isTerminalIntakeState(state: IntakeState): state is TerminalIntakeState {
  return state === 'cancelled' || state === 'failed';
}

const LEGAL: ReadonlySet<string> = new Set([
  'created:input_accepted',
  'type_detection:type_detected',
  'clarification:user_requested_more_time',
  'needs_input:user_answered',
  'clarification:proceed_with_defaults',
  'decomposition:draft_approved',
  'feasibility_check:scheduler_completed',
  'plan_proposals:user_selected_candidate',
  'awaiting_approval:approval_succeeded',
  'awaiting_approval:availability_version_mismatch',
  'feasibility_check:user_requested_rescope',
  'plan_proposals:user_requested_rescope',
  'plan_proposals:user_requested_regeneration',
]);

function legalKey(state: IntakeState, eventType: IntakeEventType): string {
  return `${state}:${eventType}`;
}

function isStructurallyLegal(state: IntakeState, event: IntakeEvent): boolean {
  if (event.type === 'user_cancelled') return !isTerminalIntakeState(state);
  if (event.type === 'unrecoverable_error') return !isTerminalIntakeState(state);
  return LEGAL.has(legalKey(state, event.type));
}

/**
 * Pure predicate for tests/UI affordances. Guard-dependent events (`type_detected`) are
 * checked by `transition` itself; this predicate answers only whether the (state, event)
 * pair can be legal at all.
 */
export function canTransition(state: IntakeState, event: IntakeEvent): boolean {
  return isStructurallyLegal(state, event);
}

function guardTypeDetected(
  event: Extract<IntakeEvent, { type: 'type_detected' }>,
): 'clarification' | 'decomposition' | null {
  if (event.classification === 'new' || event.missingRequired.length > 0) {
    return 'clarification';
  }
  if (event.classification === 'similar' && event.similarConfirmed === true) {
    return 'decomposition';
  }
  return null;
}

export function transition(
  state: IntakeState,
  event: IntakeEvent,
): IntakeTransitionResult {
  if (!isStructurallyLegal(state, event)) {
    throw new IntakeTransitionError(state, event.type);
  }

  switch (event.type) {
    case 'input_accepted':
      return { state: 'type_detection', effects: [{ type: 'agent_run', agent: 'detect_type' }] };

    case 'type_detected': {
      if (state !== 'type_detection') throw new IntakeTransitionError(state, event.type);
      const next = guardTypeDetected(event);
      if (next === null) throw new IntakeTransitionError(state, event.type);
      return next === 'clarification'
        ? { state: 'clarification', effects: [{ type: 'generate_questions' }] }
        : { state: 'decomposition', effects: [{ type: 'load_template' }] };
    }

    case 'user_requested_more_time':
      return { state: 'needs_input', effects: [] };

    case 'user_answered':
      return { state: 'clarification', effects: [] };

    case 'proceed_with_defaults':
      return { state: 'decomposition', effects: [{ type: 'apply_conservative_defaults' }] };

    case 'draft_approved':
      return { state: 'feasibility_check', effects: [{ type: 'create_tasks' }] };

    case 'scheduler_completed':
      // Zero feasible candidates still advances; the reason is surfaced in proposals.
      return { state: 'plan_proposals', effects: [{ type: 'store_plan_candidates' }] };

    case 'user_selected_candidate':
      return { state: 'awaiting_approval', effects: [] };

    case 'approval_succeeded':
      return {
        state: 'scheduled',
        effects: [{ type: 'schedule_blocks' }, { type: 'notify' }],
      };

    case 'availability_version_mismatch':
      return { state: 'plan_proposals', effects: [{ type: 'regenerate_plan' }] };

    case 'user_requested_rescope':
      return { state: 'decomposition', effects: [] };

    case 'user_requested_regeneration':
      return { state: 'feasibility_check', effects: [] };

    case 'user_cancelled':
      return { state: 'cancelled', effects: [] };

    case 'unrecoverable_error':
      return { state: 'failed', effects: [{ type: 'enter_manual_mode' }] };

    default: {
      const exhaustive: never = event;
      throw new IntakeTransitionError(state, (exhaustive as IntakeEvent).type);
    }
  }
}
