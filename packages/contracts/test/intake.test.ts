import { INTAKE_STATES, REQUIRED_INTAKE_FIELDS } from '@ohmydate/domain';
import {
  DecompositionDraftSchema,
  IntakeAssumptionSchema,
  IntakeSessionSchema,
  IntakeStateSchema,
  IntakeTypeConfirmationSchema,
  PlannedQuestionSchema,
  TaskTemplateSchema,
} from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

test('intake state schema is the domain state machine enum', () => {
  const schema = IntakeStateSchema as unknown as { anyOf: readonly { const: string }[] };
  expect(schema.anyOf.map((entry) => entry.const)).toEqual([...INTAKE_STATES]);
  const validate = compile(IntakeStateSchema);
  expect(validate('clarification')).toBe(true);
  expect(validate('unknown_state')).toBe(false);
});

test('planned questions expose the three answer choices', () => {
  const validate = compile(PlannedQuestionSchema);
  const question = {
    field: REQUIRED_INTAKE_FIELDS[0],
    prompt: 'What is the deliverable?',
    required: true,
    choices: ['answer', 'skip', 'idk'],
  };
  expect(validate(question)).toBe(true);
  expect(validate({ ...question, choices: ['answer', 'skip'] })).toBe(false);
  expect(validate({ ...question, extra: true })).toBe(false);
});

test('assumptions carry a reason and a conservative value', () => {
  const validate = compile(IntakeAssumptionSchema);
  expect(
    validate({ field: 'dueAt', reason: 'skip', value: 'no deadline assumed' }),
  ).toBe(true);
  expect(validate({ field: 'dueAt', reason: 'unanswered', value: 'no deadline assumed' })).toBe(
    true,
  );
  expect(validate({ field: 'dueAt', reason: 'guessed', value: 'tomorrow' })).toBe(false);
});

test('decomposition drafts require dependency-safe step fields', () => {
  const validate = compile(DecompositionDraftSchema);
  const step = {
    key: 's1',
    title: 'Read papers',
    deliverable: 'notes',
    doneCriteria: 'five summaries',
    kind: 'work',
    estimate: { p50Minutes: 60, p90Minutes: 120 },
    dependsOn: [],
    splittable: true,
  };
  const draft = { steps: [step], assumptions: ['P90 assumed'], questionsRemaining: [] };
  expect(validate(draft)).toBe(true);
  expect(validate({ ...draft, steps: [{ ...step, key: 'step-1' }] })).toBe(false);
  expect(validate({ ...draft, steps: [{ ...step, dependsOn: ['s99'] }] })).toBe(true);
  expect(validate({ ...draft, steps: [{ ...step, extra: true }] })).toBe(false);
});

test('type confirmation is exactly similar+templateId or not-similar', () => {
  const validate = compile(IntakeTypeConfirmationSchema);
  expect(validate({ similar: true, templateId: ID })).toBe(true);
  expect(validate({ similar: false })).toBe(true);
  expect(validate({ similar: true })).toBe(false);
  expect(validate({ similar: false, templateId: ID })).toBe(false);
});

test('intake session rejects unknown state/fields and accepts manual mode', () => {
  const validate = compile(IntakeSessionSchema);
  const session = {
    id: ID,
    ownerId: ID,
    state: 'clarification',
    input: { deliverable: 'report' },
    round: 1,
    manual: false,
    version: 1,
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
  };
  expect(validate(session)).toBe(true);
  expect(validate({ ...session, state: 'paused' })).toBe(false);
  expect(validate({ ...session, manual: true })).toBe(true);
  expect(validate({ ...session, extra: true })).toBe(false);
});

test('task templates mirror the decomposition step shape', () => {
  const validate = compile(TaskTemplateSchema);
  const template = {
    id: ID,
    ownerId: ID,
    name: 'Paper summary',
    steps: [
      {
        key: 's1',
        title: 'Collect',
        deliverable: 'papers',
        doneCriteria: 'five collected',
        kind: 'prep',
        estimate: { p50Minutes: 30, p90Minutes: 60 },
        dependsOn: [],
        splittable: true,
      },
    ],
    stats: { sampleCount: 2, meanRatio: 1.1 },
    source: 'user',
    confidence: 0.6,
    version: 1,
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
  };
  expect(validate(template)).toBe(true);
  expect(validate({ ...template, source: 'imported' })).toBe(false);
  expect(validate({ ...template, stats: { sampleCount: 2, extra: 1 } })).toBe(false);
});
