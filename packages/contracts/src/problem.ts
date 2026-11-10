import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { IdSchema } from './common.js';

export const PROBLEM_CODES = [
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
  'not_found',
  'forbidden',
  'rate_limited',
  'unauthenticated',
  'idempotency_in_progress',
  'internal_error',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const ProblemCodeSchema = Type.Union(
  PROBLEM_CODES.map((code) => Type.Literal(code)) as TLiteral<ProblemCode>[],
);

export const VIOLATION_CODES = [
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'H7',
  'H8',
] as const;

export type ViolationCode = (typeof VIOLATION_CODES)[number];

export const ViolationCodeSchema = Type.Union(
  VIOLATION_CODES.map((code) => Type.Literal(code)) as TLiteral<ViolationCode>[],
);

/**
 * Validator finding attached to a `constraint_violation` problem. The codes are
 * the scheduler's public hard-constraint labels (06 §3); the scheduler-only H0
 * preconditions stay internal because callers cannot express them.
 */
export const ViolationSchema = Type.Object(
  {
    code: ViolationCodeSchema,
    taskId: Type.Optional(IdSchema),
    message: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false, $id: 'Violation' },
);

export type Violation = Static<typeof ViolationSchema>;

export const ProblemErrorSchema = Type.Object(
  {
    path: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

export const ProblemSchema = Type.Object(
  {
    type: Type.String({ format: 'uri' }),
    title: Type.String(),
    status: Type.Integer({ minimum: 100, maximum: 599 }),
    detail: Type.Optional(Type.String()),
    code: ProblemCodeSchema,
    errors: Type.Optional(Type.Array(ProblemErrorSchema)),
    violations: Type.Optional(Type.Array(ViolationSchema, { maxItems: 1_000 })),
    traceId: Type.Optional(Type.String()),
  },
  { additionalProperties: false, $id: 'Problem' },
);

export type Problem = Static<typeof ProblemSchema>;
