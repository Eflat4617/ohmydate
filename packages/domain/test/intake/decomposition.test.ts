import {
  MAX_DECOMPOSITION_STEPS,
  MAX_STEP_P50_MINUTES,
  validateDecomposition,
  type DecompositionDraft,
  type DecompositionStep,
} from '../../src/index.js';

const step = (overrides: Partial<DecompositionStep> & { key: string }): DecompositionStep => ({
  title: `Step ${overrides.key}`,
  deliverable: 'Something concrete',
  doneCriteria: 'It is done',
  kind: 'work',
  estimate: { p50Minutes: 60, p90Minutes: 90 },
  dependsOn: [],
  splittable: true,
  ...overrides,
});

const draft = (steps: readonly DecompositionStep[]): DecompositionDraft => ({
  steps,
  assumptions: [],
  questionsRemaining: [],
});

const validDraft = (): DecompositionDraft =>
  draft([
    step({ key: 's1', kind: 'prep' }),
    step({ key: 's2', dependsOn: ['s1'] }),
    step({ key: 's3', kind: 'review', dependsOn: ['s2'] }),
  ]);

test('a well-formed draft passes', () => {
  const result = validateDecomposition(validDraft());
  expect(result.valid).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.splitRequested).toBe(false);
});

test('fewer than three steps is rejected', () => {
  const result = validateDecomposition(
    draft([step({ key: 's1' }), step({ key: 's2', kind: 'review' })]),
  );
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain('step_count_out_of_range');
});

test('more than twelve steps is rejected', () => {
  const steps = Array.from({ length: MAX_DECOMPOSITION_STEPS + 1 }, (_, index) =>
    step({ key: `s${index + 1}`, kind: index === 0 ? 'review' : 'work' }),
  );
  const result = validateDecomposition(draft(steps));
  expect(result.issues.map((issue) => issue.code)).toContain('step_count_out_of_range');
});

test('a single step above the P50 ceiling requests a split', () => {
  const oversized = validDraft();
  const steps = oversized.steps.map((item) =>
    item.key === 's2'
      ? { ...item, estimate: { p50Minutes: MAX_STEP_P50_MINUTES + 1, p90Minutes: 400 } }
      : item,
  );
  const result = validateDecomposition(draft(steps));
  expect(result.valid).toBe(false);
  expect(result.splitRequested).toBe(true);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: 'step_too_large', stepKey: 's2', splitRequested: true }),
  );
});

test('P90 below P50 is rejected', () => {
  const base = validDraft();
  const steps = base.steps.map((item) =>
    item.key === 's1' ? { ...item, estimate: { p50Minutes: 60, p90Minutes: 30 } } : item,
  );
  const result = validateDecomposition(draft(steps));
  expect(result.issues.map((issue) => issue.code)).toContain('p90_less_than_p50');
});

test('at least one review or buffer step is required', () => {
  const result = validateDecomposition(
    draft([
      step({ key: 's1' }),
      step({ key: 's2', dependsOn: ['s1'] }),
      step({ key: 's3', kind: 'prep', dependsOn: ['s2'] }),
    ]),
  );
  expect(result.issues.map((issue) => issue.code)).toContain('missing_review_or_buffer');
});

test('a buffer step satisfies the review/buffer rule', () => {
  const result = validateDecomposition(
    draft([
      step({ key: 's1' }),
      step({ key: 's2', dependsOn: ['s1'] }),
      step({ key: 's3', kind: 'buffer', dependsOn: ['s2'] }),
    ]),
  );
  expect(result.valid).toBe(true);
});

test('unknown dependency keys are stripped and reported as hallucinated_ref', () => {
  const result = validateDecomposition(
    draft([
      step({ key: 's1' }),
      step({ key: 's2', dependsOn: ['s1', 's99'] }),
      step({ key: 's3', kind: 'review', dependsOn: ['s2'] }),
    ]),
  );
  expect(result.valid).toBe(false);
  expect(result.hallucinatedRefs).toEqual(['s99']);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: 'hallucinated_ref', stepKey: 's2', ref: 's99' }),
  );
  expect(result.draft.steps.find((item) => item.key === 's2')?.dependsOn).toEqual(['s1']);
});

test('a dependency cycle is rejected', () => {
  const result = validateDecomposition(
    draft([
      step({ key: 's1', dependsOn: ['s3'] }),
      step({ key: 's2', dependsOn: ['s1'] }),
      step({ key: 's3', kind: 'review', dependsOn: ['s2'] }),
    ]),
  );
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain('cycle');
});

test('a self dependency is a cycle', () => {
  const result = validateDecomposition(
    draft([
      step({ key: 's1', dependsOn: ['s1'] }),
      step({ key: 's2', dependsOn: ['s1'] }),
      step({ key: 's3', kind: 'review', dependsOn: ['s2'] }),
    ]),
  );
  expect(result.issues.map((issue) => issue.code)).toContain('cycle');
});

test('duplicate keys are rejected', () => {
  const result = validateDecomposition(
    draft([
      step({ key: 's1' }),
      step({ key: 's1', dependsOn: ['s1'] }),
      step({ key: 's2', kind: 'review' }),
    ]),
  );
  expect(result.issues.map((issue) => issue.code)).toContain('duplicate_key');
});

test('validation is deterministic and does not mutate the input', () => {
  const input = validDraft();
  const snapshot = JSON.stringify(input);
  const first = validateDecomposition(input);
  const second = validateDecomposition(input);
  expect(first).toEqual(second);
  expect(JSON.stringify(input)).toBe(snapshot);
});
