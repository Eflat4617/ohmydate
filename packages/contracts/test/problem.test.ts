import {
  PROBLEM_CODES,
  ProblemCodeSchema,
  ProblemSchema,
  VIOLATION_CODES,
  ViolationSchema,
} from '../src/index.js';
import { compile } from './ajv.js';

const EXPECTED_CODES = [
  'validation_failed',
  'version_conflict',
  'availability_changed',
  'constraint_violation',
  'idempotency_mismatch',
  'provider_unavailable',
  'llm_unavailable',
  'budget_exceeded',
  'dependency_cycle',
  'illegal_transition',
  'approval_in_progress',
  'not_found',
  'forbidden',
  'rate_limited',
  'unauthenticated',
  'idempotency_in_progress',
  'active_session_exists',
  'session_state_conflict',
  'replan_suppressed',
  'proposal_state_conflict',
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

test('constraint_violation carries the H1-H8 validator violations extension', () => {
  expect(PROBLEM_CODES).toContain('constraint_violation');
  expect(PROBLEM_CODES).toContain('availability_changed');
  expect(VIOLATION_CODES).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']);

  const validateViolation = compile(ViolationSchema);
  expect(validateViolation({ code: 'H1', message: 'blocks overlap' })).toBe(true);
  expect(validateViolation({ code: 'H7', taskId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55', message: 'short' })).toBe(true);
  expect(validateViolation({ code: 'H0_horizon', message: 'internal code' })).toBe(false);
  expect(validateViolation({ code: 'H1', message: 'x', extra: true })).toBe(false);

  const validateProblem = compile(ProblemSchema);
  expect(
    validateProblem({
      type: 'about:blank',
      title: 'Constraint violation',
      status: 422,
      code: 'constraint_violation',
      violations: [{ code: 'H4', taskId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55', message: 'past due' }],
    }),
  ).toBe(true);
  expect(
    validateProblem({
      type: 'about:blank',
      title: 'Constraint violation',
      status: 422,
      code: 'constraint_violation',
      violations: [{ code: 'H9', message: 'unknown' }],
    }),
  ).toBe(false);
});
