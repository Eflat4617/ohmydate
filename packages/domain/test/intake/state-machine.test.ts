import {
  INTAKE_STATES,
  IntakeTransitionError,
  canTransition,
  transition,
  type IntakeEvent,
  type IntakeEventType,
  type IntakeState,
} from '../../src/index.js';

const representativeEvents: Record<IntakeEventType, IntakeEvent> = {
  input_accepted: { type: 'input_accepted' },
  type_detected: {
    type: 'type_detected',
    classification: 'similar',
    missingRequired: [],
    similarConfirmed: true,
  },
  user_requested_more_time: { type: 'user_requested_more_time' },
  user_answered: { type: 'user_answered' },
  proceed_with_defaults: { type: 'proceed_with_defaults' },
  draft_approved: { type: 'draft_approved' },
  scheduler_completed: { type: 'scheduler_completed', candidateCount: 0 },
  user_selected_candidate: { type: 'user_selected_candidate' },
  approval_succeeded: { type: 'approval_succeeded' },
  availability_version_mismatch: { type: 'availability_version_mismatch' },
  user_requested_rescope: { type: 'user_requested_rescope' },
  user_requested_regeneration: { type: 'user_requested_regeneration' },
  user_cancelled: { type: 'user_cancelled' },
  unrecoverable_error: { type: 'unrecoverable_error' },
};

const eventTypes = Object.keys(representativeEvents) as IntakeEventType[];

const expected: Record<IntakeState, Partial<Record<IntakeEventType, IntakeState>>> = {
  created: {
    input_accepted: 'type_detection',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  type_detection: {
    type_detected: 'decomposition',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  clarification: {
    user_requested_more_time: 'needs_input',
    proceed_with_defaults: 'decomposition',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  needs_input: {
    user_answered: 'clarification',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  decomposition: {
    draft_approved: 'feasibility_check',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  feasibility_check: {
    scheduler_completed: 'plan_proposals',
    user_requested_rescope: 'decomposition',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  plan_proposals: {
    user_selected_candidate: 'awaiting_approval',
    user_requested_rescope: 'decomposition',
    user_requested_regeneration: 'feasibility_check',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  awaiting_approval: {
    approval_succeeded: 'scheduled',
    availability_version_mismatch: 'plan_proposals',
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  scheduled: {
    user_cancelled: 'cancelled',
    unrecoverable_error: 'failed',
  },
  cancelled: {},
  failed: {},
};

test.each(INTAKE_STATES.flatMap((state) => eventTypes.map((eventType) => [state, eventType] as const)))(
  '%s --%s--> follows the transition table',
  (state, eventType) => {
    const event = representativeEvents[eventType];
    const expectedNext = expected[state][eventType];
    const legal = expectedNext !== undefined;

    expect(canTransition(state, event)).toBe(legal);

    if (legal) {
      expect(transition(state, event).state).toBe(expectedNext);
    } else {
      try {
        transition(state, event);
        throw new Error('expected IntakeTransitionError');
      } catch (error) {
        expect(error).toBeInstanceOf(IntakeTransitionError);
        expect((error as IntakeTransitionError).code).toBe('illegal_transition');
        expect((error as IntakeTransitionError).from).toBe(state);
        expect((error as IntakeTransitionError).eventType).toBe(eventType);
      }
    }
  },
);

test('every legal transition carries the documented effects', () => {
  expect(transition('created', { type: 'input_accepted' }).effects).toEqual([
    { type: 'agent_run', agent: 'detect_type' },
  ]);
  expect(
    transition('type_detection', {
      type: 'type_detected',
      classification: 'new',
      missingRequired: [],
    }).effects,
  ).toEqual([{ type: 'generate_questions' }]);
  expect(
    transition('type_detection', representativeEvents.type_detected).effects,
  ).toEqual([{ type: 'load_template' }]);
  expect(transition('clarification', { type: 'proceed_with_defaults' }).effects).toEqual([
    { type: 'apply_conservative_defaults' },
  ]);
  expect(transition('decomposition', { type: 'draft_approved' }).effects).toEqual([
    { type: 'create_tasks' },
  ]);
  expect(
    transition('feasibility_check', { type: 'scheduler_completed', candidateCount: 0 }).effects,
  ).toEqual([{ type: 'store_plan_candidates' }]);
  expect(transition('awaiting_approval', { type: 'approval_succeeded' }).effects).toEqual([
    { type: 'schedule_blocks' },
    { type: 'notify' },
  ]);
  expect(
    transition('awaiting_approval', { type: 'availability_version_mismatch' }).effects,
  ).toEqual([{ type: 'regenerate_plan' }]);
  expect(transition('clarification', { type: 'unrecoverable_error' }).effects).toEqual([
    { type: 'enter_manual_mode' },
  ]);
});

test('type_detected with a new classification routes to clarification', () => {
  expect(
    transition('type_detection', {
      type: 'type_detected',
      classification: 'new',
      missingRequired: [],
    }).state,
  ).toBe('clarification');
});

test('type_detected with missing required fields routes to clarification', () => {
  expect(
    transition('type_detection', {
      type: 'type_detected',
      classification: 'similar',
      missingRequired: ['dueAt'],
      similarConfirmed: true,
    }).state,
  ).toBe('clarification');
});

test('similar type without explicit confirmation is rejected by the guard', () => {
  expect(() =>
    transition('type_detection', {
      type: 'type_detected',
      classification: 'similar',
      missingRequired: [],
    }),
  ).toThrow(IntakeTransitionError);
});

test('terminal states are cancellable only from non-cancelled states', () => {
  expect(() => transition('cancelled', { type: 'user_cancelled' })).toThrow(IntakeTransitionError);
  expect(() => transition('failed', { type: 'user_cancelled' })).toThrow(IntakeTransitionError);
  expect(transition('scheduled', { type: 'user_cancelled' }).state).toBe('cancelled');
});
