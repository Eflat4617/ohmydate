import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { CursorSchema, IdSchema, InstantSchema, VersionSchema, pageSchema } from './common.js';
import { DecompositionStepSchema } from './intake.js';

export const TEMPLATE_SOURCES = ['user', 'system'] as const;

export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];

export const TemplateSourceSchema = Type.Union(
  TEMPLATE_SOURCES.map((source) => Type.Literal(source)) as TLiteral<TemplateSource>[],
);

/**
 * Template statistics are intentionally a small, closed object rather than a
 * free-form jsonb contract: the estimator may add fields, but clients only rely
 * on these. The database column stays jsonb for forward compatibility.
 */
export const TemplateStatsSchema = Type.Object(
  {
    sampleCount: Type.Optional(Type.Integer({ minimum: 0 })),
    meanRatio: Type.Optional(Type.Number({ minimum: 0 })),
    p90Ratio: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false, $id: 'TemplateStats' },
);

export const TaskTemplateSchema = Type.Object(
  {
    id: IdSchema,
    ownerId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    steps: Type.Array(DecompositionStepSchema, { minItems: 1, maxItems: 12 }),
    stats: TemplateStatsSchema,
    source: TemplateSourceSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    deletedAt: Type.Optional(InstantSchema),
  },
  { additionalProperties: false, $id: 'TaskTemplate' },
);

export const PageTaskTemplateSchema = pageSchema(TaskTemplateSchema, {
  id: 'PageTaskTemplate',
});

export const TaskTemplateListQuerySchema = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 200 })),
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'TaskTemplateListQuery' },
);

export const TaskTemplateIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'TaskTemplateIdParams' },
);

export type TemplateStats = Static<typeof TemplateStatsSchema>;
export type TaskTemplate = Static<typeof TaskTemplateSchema>;
export type TaskTemplateListQuery = Static<typeof TaskTemplateListQuerySchema>;
export type TaskTemplateIdParams = Static<typeof TaskTemplateIdParamsSchema>;
