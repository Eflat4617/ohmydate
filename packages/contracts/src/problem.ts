import { Type, type Static, type TLiteral } from '@sinclair/typebox';

export const PROBLEM_CODES = [
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
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const ProblemCodeSchema = Type.Union(
  PROBLEM_CODES.map((code) => Type.Literal(code)) as TLiteral<ProblemCode>[],
);

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
    traceId: Type.Optional(Type.String()),
  },
  { additionalProperties: false, $id: 'Problem' },
);

export type Problem = Static<typeof ProblemSchema>;
