import { PROBLEM_CODES, ProblemCodeSchema, ProblemSchema } from '../src/index.js';
import { compile } from './ajv.js';

const EXPECTED_CODES = [
  'validation_failed',
  'version_conflict',
  'availability_changed',
  'idempotency_mismatch',
  'provider_unavailable',
  'llm_unavailable',
  'budget_exceeded',
  'dependency_cycle',
  'illegal_transition',
  'not_found',
  'forbidden',
  'rate_limited',
  'unauthenticated',
  'idempotency_in_progress',
  'internal_error',
];

test('problem code enum is exhaustive and stable', () => {
  expect(PROBLEM_CODES).toEqual(EXPECTED_CODES);
  const schema = ProblemCodeSchema as unknown as {
    anyOf: readonly { const: string }[];
  };
  expect(schema.anyOf.map((entry) => entry.const)).toEqual(EXPECTED_CODES);
});

test('every problem code validates against the code schema', () => {
  const validate = compile({
    type: 'object',
    properties: { code: ProblemCodeSchema },
    required: ['code'],
    additionalProperties: false,
  });
  for (const code of PROBLEM_CODES) {
    expect({ code, valid: validate({ code }) }).toEqual({ code, valid: true });
  }
  expect(validate({ code: 'unknown_code' })).toBe(false);
});

test('Problem follows RFC 9457 fields and rejects extra properties', () => {
  const validate = compile(ProblemSchema);
  const problem = {
    type: 'about:blank',
    title: 'Not found',
    status: 404,
    detail: 'task not found',
    code: 'not_found',
    errors: [{ path: 'id', message: 'unknown id' }],
    traceId: 'trace-1',
  };
  expect(validate(problem)).toBe(true);
  expect(validate({ ...problem, extra: true })).toBe(false);
  expect(validate({ ...problem, code: 'dependency_cycle' })).toBe(true);
  expect(validate({ ...problem, code: 'not_a_code' })).toBe(false);
});

test('illegal_transition is a stable 409 problem code', () => {
  expect(PROBLEM_CODES).toContain('illegal_transition');
  const validate = compile(ProblemSchema);
  expect(
    validate({
      type: 'about:blank',
      title: 'Illegal transition',
      status: 409,
      detail: 'created cannot be paused',
      code: 'illegal_transition',
    }),
  ).toBe(true);
});
