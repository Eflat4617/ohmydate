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
 * Validator finding attached to a `constraint_violation` problem. Only H1-H8
 * are public contract codes. H0 preflight findings are a request-shape error,
 * not a planning constraint: edited blocks outside the persisted plan horizon
 * or outside the plan's task scope are reported as 422 `validation_failed` with
 * errors[{path: "/blocks/<i>", message}] for preview-edit (body field `blocks`)
 * and errors[{path: "/editedBlocks/<i>", message}] for approve (body field
 * `editedBlocks`) before H1-H8 validation runs.
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
