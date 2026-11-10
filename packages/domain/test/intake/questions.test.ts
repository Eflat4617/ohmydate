import {
  CONSERVATIVE_DEFAULTS,
  MAX_QUESTIONS_PER_ROUND,
  OPTIONAL_INTAKE_FIELDS,
  REQUIRED_INTAKE_FIELDS,
  conservativeAssumptions,
  planQuestions,
  type IntakeField,
} from '../../src/index.js';

const ALL_FIELDS: IntakeField[] = [...REQUIRED_INTAKE_FIELDS, ...OPTIONAL_INTAKE_FIELDS];

const sampleValue = (field: IntakeField): unknown => {
  switch (field) {
    case 'deliverable':
      return 'Final report';
    case 'dueAt':
      return '2026-11-20T14:59:00.000Z';
    case 'estimatedScope':
      return 'medium';
    case 'currentProgress':
      return '30%';
    case 'availabilityConfirmed':
      return true;
    case 'prerequisites':
      return ['library access'];
    case 'priority':
      return 2;
    case 'maxFocusMinutes':
      return 90;
    case 'reviewNeeded':
      return false;
  }
};

test('zero questions when every required and optional field is provided', () => {
  const known = Object.fromEntries(
    ALL_FIELDS.map((field) => [field, sampleValue(field)]),
  ) as Partial<Record<IntakeField, unknown>>;
  const plan = planQuestions({ known });
  expect(plan.questions).toEqual([]);
  expect(plan.complete).toBe(true);
  expect(plan.remainingFields).toEqual([]);
});

test('required fields are asked before optional fields and deduplicated', () => {
  const plan = planQuestions({
    requiredFields: ['dueAt', 'deliverable', 'dueAt'],
    optionalFields: ['priority', 'deliverable'],
  });
  expect(plan.questions.map((question) => question.field)).toEqual(['dueAt', 'deliverable', 'priority']);
  expect(plan.questions[0]?.required).toBe(true);
  expect(plan.questions[2]?.required).toBe(false);
});

test('each question offers skip and idk choices', () => {
  const plan = planQuestions();
  expect(plan.questions.length).toBeGreaterThan(0);
  for (const question of plan.questions) {
    expect(question.choices).toEqual(['answer', 'skip', 'idk']);
  }
});

test('a round is capped at five questions', () => {
  const all = [...REQUIRED_INTAKE_FIELDS, ...OPTIONAL_INTAKE_FIELDS];
  const plan = planQuestions({ requiredFields: all, optionalFields: [] });
  expect(plan.questions).toHaveLength(MAX_QUESTIONS_PER_ROUND);
  expect(plan.remainingFields.length).toBe(all.length - MAX_QUESTIONS_PER_ROUND);
  expect(plan.exhausted).toBe(false);
});

test('the interview stops after two rounds and reports exhaustion', () => {
  const all = [...REQUIRED_INTAKE_FIELDS, ...OPTIONAL_INTAKE_FIELDS];
  const first = planQuestions({ requiredFields: all, optionalFields: [], maxPerRound: 2 });
  const second = planQuestions({
    requiredFields: all,
    optionalFields: [],
    round: 2,
    maxPerRound: 2,
    askedFields: first.questions.map((question) => question.field),
  });
  expect(first.questions).toHaveLength(2);
  expect(second.questions).toHaveLength(2);
  expect(second.exhausted).toBe(true);
  expect(second.remainingFields).toHaveLength(all.length - 2);

  const third = planQuestions({
    requiredFields: all,
    optionalFields: [],
    round: 3,
    maxPerRound: 2,
    askedFields: [
      ...first.questions.map((question) => question.field),
      ...second.questions.map((question) => question.field),
    ],
  });
  expect(third.questions).toEqual([]);
  expect(third.exhausted).toBe(true);
  expect(third.complete).toBe(false);
});

test('fields asked in a previous round are deduplicated', () => {
  const plan = planQuestions({ askedFields: ['deliverable', 'dueAt'] });
  const fields = plan.questions.map((question) => question.field);
  expect(fields).not.toContain('deliverable');
  expect(fields).not.toContain('dueAt');
});

test('skip and idk produce conservative assumptions with no original values', () => {
  const assumptions = conservativeAssumptions([
    { field: 'currentProgress', action: 'idk' },
    { field: 'maxFocusMinutes', action: 'skip' },
    { field: 'deliverable', action: 'answer', value: 'Essay' },
    { field: 'maxFocusMinutes', action: 'idk' },
  ]);
  expect(assumptions).toEqual([
    { field: 'currentProgress', reason: 'idk', value: CONSERVATIVE_DEFAULTS.currentProgress },
    { field: 'maxFocusMinutes', reason: 'skip', value: CONSERVATIVE_DEFAULTS.maxFocusMinutes },
  ]);
});

test('previous answers remove fields from later rounds', () => {
  const plan = planQuestions({
    previousAnswers: [
      { field: 'deliverable', action: 'answer', value: 'Slides' },
      { field: 'dueAt', action: 'skip' },
    ],
  });
  const fields = plan.questions.map((question) => question.field);
  expect(fields).not.toContain('deliverable');
  expect(fields).not.toContain('dueAt');
  expect(plan.assumptions).toEqual([
    { field: 'dueAt', reason: 'skip', value: CONSERVATIVE_DEFAULTS.dueAt },
  ]);
});

test('empty strings are not treated as provided values', () => {
  const plan = planQuestions({ known: { deliverable: '   ', dueAt: '' } });
  const fields = plan.questions.map((question) => question.field);
  expect(fields).toContain('deliverable');
  expect(fields).toContain('dueAt');
});

test('planning is deterministic', () => {
  const input = { known: { dueAt: '2026-11-20T14:59:00.000Z' } } as const;
  expect(planQuestions(input)).toEqual(planQuestions(input));
});

test('asked-but-unanswered fields remain unresolved and get unanswered assumptions', () => {
  const all = [...REQUIRED_INTAKE_FIELDS, ...OPTIONAL_INTAKE_FIELDS];
  const plan = planQuestions({ round: 2, askedFields: all });
  expect(plan.questions).toEqual([]);
  expect(plan.complete).toBe(false);
  expect(plan.exhausted).toBe(true);
  expect(plan.remainingFields).toEqual(all);
  expect(plan.assumptions).toHaveLength(all.length);
  for (const assumption of plan.assumptions) {
    expect(assumption.reason).toBe('unanswered');
  }
});

test('an empty-value answer stays unresolved rather than completing the plan', () => {
  const plan = planQuestions({
    previousAnswers: [{ field: 'deliverable', action: 'answer', value: '   ' }],
  });
  expect(plan.complete).toBe(false);
  expect(plan.remainingFields).toContain('deliverable');
  expect(plan.questions.map((question) => question.field)).not.toContain('deliverable');
  expect(plan.assumptions).toContainEqual({
    field: 'deliverable',
    reason: 'unanswered',
    value: CONSERVATIVE_DEFAULTS.deliverable,
  });
});

test('Date, zero and false values count as provided', () => {
  const plan = planQuestions({
    known: {
      dueAt: new Date('2026-11-20T14:59:00.000Z'),
      currentProgress: 0,
      availabilityConfirmed: false,
    },
  });
  const fields = plan.questions.map((question) => question.field);
  expect(fields).not.toContain('dueAt');
  expect(fields).not.toContain('currentProgress');
  expect(fields).not.toContain('availabilityConfirmed');
});

test.each([0, -1, 1.5, Number.NaN])('an invalid round %s is rejected', (round) => {
  expect(() => planQuestions({ round })).toThrow(RangeError);
});
