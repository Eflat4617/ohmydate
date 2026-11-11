import {
  INTAKE_STATES,
  MAX_QUESTIONS_PER_ROUND,
  OPTIONAL_INTAKE_FIELDS,
  REQUIRED_INTAKE_FIELDS,
  type DecompositionStepKind,
  type IntakeAnswerAction,
  type IntakeAssumption,
} from '@ohmydate/domain';
import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { IdSchema, InstantSchema, VersionSchema } from './common.js';

export const INTAKE_FIELDS = [
  ...REQUIRED_INTAKE_FIELDS,
  ...OPTIONAL_INTAKE_FIELDS,
] as const;

export type IntakeFieldName = (typeof INTAKE_FIELDS)[number];

export const IntakeFieldSchema = Type.Union(
  INTAKE_FIELDS.map((field) => Type.Literal(field)) as TLiteral<IntakeFieldName>[],
);

export const IntakeStateSchema = Type.Union(
  INTAKE_STATES.map((state) => Type.Literal(state)) as TLiteral<(typeof INTAKE_STATES)[number]>[],
);

export const INTAKE_ANSWER_ACTIONS = ['answer', 'skip', 'idk'] as const;

export const IntakeAnswerActionSchema = Type.Union(
  INTAKE_ANSWER_ACTIONS.map((action) => Type.Literal(action)) as TLiteral<IntakeAnswerAction>[],
);

export const INTAKE_ASSUMPTION_REASONS = ['skip', 'idk', 'unanswered'] as const;

export type IntakeAssumptionReason = (typeof INTAKE_ASSUMPTION_REASONS)[number];

export const IntakeAssumptionReasonSchema = Type.Union(
  INTAKE_ASSUMPTION_REASONS.map((reason) => Type.Literal(reason)) as TLiteral<IntakeAssumptionReason>[],
);

const IntakeInputValueSchema = Type.Union([
  Type.String({ maxLength: 2_000 }),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 }),
  Type.Null(),
]);

/**
 * Intake form values. Fields mirror 05 §4; every field is optional because the
 * interview exists to fill the gaps. `additionalProperties: false` keeps typos
 * from being silently accepted as known values.
 */
export const IntakeInputSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 4_000 })),
    deliverable: Type.Optional(Type.String({ maxLength: 2_000 })),
    dueAt: Type.Optional(InstantSchema),
    estimatedScope: Type.Optional(Type.Union([
      Type.Literal('small'),
      Type.Literal('medium'),
      Type.Literal('large'),
    ])),
    currentProgress: Type.Optional(Type.Union([
      Type.Number({ minimum: 0, maximum: 1 }),
      Type.String({ maxLength: 100 }),
    ])),
    availabilityConfirmed: Type.Optional(Type.Boolean()),
    prerequisites: Type.Optional(IntakeInputValueSchema),
    priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    maxFocusMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 1_440 })),
    reviewNeeded: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1, $id: 'IntakeInput' },
);

export const IntakeDetectedTypeSchema = Type.Object(
  {
    classification: Type.Union([Type.Literal('new'), Type.Literal('similar')]),
    templateId: Type.Optional(IdSchema),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    reasons: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 }),
    missingRequired: Type.Array(IntakeFieldSchema),
  },
  { additionalProperties: false, $id: 'IntakeDetectedType' },
);

export const IntakeAnswerSchema = Type.Object(
  {
    questionKey: IntakeFieldSchema,
    questionText: Type.Optional(Type.String({ maxLength: 300 })),
    action: IntakeAnswerActionSchema,
    value: Type.Optional(IntakeInputValueSchema),
    skipped: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'IntakeAnswer' },
);

/**
 * Answers are a discriminated union on `action`: a real answer must carry a
 * value, while `skip`/`idk` must not smuggle one in (08 §2.3).
 */
export const IntakeAnswerInputSchema = Type.Union(
  [
    Type.Object(
      {
        questionKey: IntakeFieldSchema,
        action: Type.Literal('answer'),
        value: IntakeInputValueSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        questionKey: IntakeFieldSchema,
        action: Type.Literal('skip'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        questionKey: IntakeFieldSchema,
        action: Type.Literal('idk'),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'IntakeAnswerInput' },
);

export const IntakeAnswersRequestSchema = Type.Object(
  {
    answers: Type.Array(IntakeAnswerInputSchema, {
      minItems: 1,
      maxItems: MAX_QUESTIONS_PER_ROUND,
    }),
  },
  { additionalProperties: false, $id: 'IntakeAnswersRequest' },
);

export const PlannedQuestionSchema = Type.Object(
  {
    field: IntakeFieldSchema,
    prompt: Type.String({ minLength: 1, maxLength: 300 }),
    required: Type.Boolean(),
    choices: Type.Tuple([Type.Literal('answer'), Type.Literal('skip'), Type.Literal('idk')]),
  },
  { additionalProperties: false, $id: 'PlannedQuestion' },
);

export const IntakeAssumptionSchema = Type.Object(
  {
    field: IntakeFieldSchema,
    reason: IntakeAssumptionReasonSchema,
    value: Type.String({ maxLength: 200 }),
  },
  { additionalProperties: false, $id: 'IntakeAssumption' },
);

export const DECOMPOSITION_STEP_KINDS = [
  'prep',
  'work',
  'review',
  'buffer',
] as const satisfies readonly DecompositionStepKind[];

export type DecompositionStepKindName = (typeof DECOMPOSITION_STEP_KINDS)[number];

export const DecompositionStepKindSchema = Type.Union(
  DECOMPOSITION_STEP_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<DecompositionStepKindName>[],
);

export const DecompositionEstimateSchema = Type.Object(
  {
    p50Minutes: Type.Integer({ minimum: 5, maximum: 2_400 }),
    p90Minutes: Type.Integer({ minimum: 5, maximum: 4_800 }),
  },
  { additionalProperties: false, $id: 'DecompositionEstimate' },
);

export const DecompositionStepSchema = Type.Object(
  {
    key: Type.String({ pattern: '^s[0-9]{1,2}$' }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    deliverable: Type.String({ maxLength: 300 }),
    doneCriteria: Type.String({ maxLength: 300 }),
    kind: DecompositionStepKindSchema,
    estimate: DecompositionEstimateSchema,
    dependsOn: Type.Array(Type.String({ pattern: '^s[0-9]{1,2}$' })),
    splittable: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'DecompositionStep' },
);

export const DECOMPOSITION_EVIDENCE_KINDS = ['fact', 'inference'] as const;

export type DecompositionEvidenceKindName = (typeof DECOMPOSITION_EVIDENCE_KINDS)[number];

/**
 * M6-01 note grounding (05 §9/§10): one note section the model relied on. `kind`
 * separates what the note states (`fact`) from what was derived (`inference`); `source`
 * is the cited note section, validated against the sections actually sent (unknown
 * refs are removed as hallucinated); `updatedAt` is the note's update time when it was
 * sent. Server-produced only: PATCH cannot set evidence.
 */
export const DecompositionEvidenceSchema = Type.Object(
  {
    kind: Type.Union(
      DECOMPOSITION_EVIDENCE_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<DecompositionEvidenceKindName>[],
    ),
    statement: Type.String({ maxLength: 200 }),
    source: Type.Object(
      {
        kind: Type.Literal('note'),
        docId: IdSchema,
        sectionHash: Type.String({ pattern: '^[0-9a-f]{16}$' }),
      },
      { additionalProperties: false },
    ),
    stepKeys: Type.Array(Type.String({ pattern: '^s[0-9]{1,2}$' }), { maxItems: 12 }),
    updatedAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'DecompositionEvidence' },
);

export const DecompositionDraftSchema = Type.Object(
  {
    steps: Type.Array(DecompositionStepSchema, { minItems: 1, maxItems: 12 }),
    assumptions: Type.Array(Type.String({ maxLength: 200 })),
    questionsRemaining: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 5 }),
    evidence: Type.Optional(Type.Array(DecompositionEvidenceSchema, { maxItems: 12 })),
  },
  { additionalProperties: false, $id: 'DecompositionDraft' },
);

export const DecompositionDraftPatchSchema = Type.Object(
  {
    steps: Type.Optional(Type.Array(DecompositionStepSchema, { minItems: 1, maxItems: 12 })),
    assumptions: Type.Optional(Type.Array(Type.String({ maxLength: 200 }))),
    questionsRemaining: Type.Optional(
      Type.Array(Type.String({ maxLength: 300 }), { maxItems: 5 }),
    ),
  },
  { additionalProperties: false, $id: 'DecompositionDraftPatch' },
);

export const IntakeTypeConfirmationSchema = Type.Union(
  [
    Type.Object(
      {
        similar: Type.Literal(true),
        templateId: IdSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        similar: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'IntakeTypeConfirmation' },
);

export const IntakeErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 100 }),
    message: Type.String({ maxLength: 500 }),
  },
  { additionalProperties: false, $id: 'IntakeError' },
);

export const IntakeSessionCreateSchema = Type.Object(
  {
    goalId: Type.Optional(IdSchema),
    input: IntakeInputSchema,
  },
  { additionalProperties: false, $id: 'IntakeSessionCreate' },
);

export const IntakeSessionSchema = Type.Object(
  {
    id: IdSchema,
    ownerId: IdSchema,
    goalId: Type.Optional(IdSchema),
    state: IntakeStateSchema,
    input: IntakeInputSchema,
    detectedType: Type.Optional(IntakeDetectedTypeSchema),
    templateId: Type.Optional(IdSchema),
    round: Type.Integer({ minimum: 1 }),
    manual: Type.Boolean(),
    error: Type.Optional(IntakeErrorSchema),
    questions: Type.Optional(Type.Array(PlannedQuestionSchema, { maxItems: MAX_QUESTIONS_PER_ROUND })),
    assumptions: Type.Optional(Type.Array(IntakeAssumptionSchema)),
    answers: Type.Optional(Type.Array(IntakeAnswerSchema)),
    draft: Type.Optional(DecompositionDraftSchema),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'IntakeSession' },
);

export const IntakeSessionIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'IntakeSessionIdParams' },
);

export type IntakeFieldNameDto = IntakeFieldName;
export type IntakeInput = Static<typeof IntakeInputSchema>;
export type IntakeDetectedType = Static<typeof IntakeDetectedTypeSchema>;
export type IntakeAnswer = Static<typeof IntakeAnswerSchema>;
export type IntakeAnswerInput = Static<typeof IntakeAnswerInputSchema>;
export type IntakeAnswersRequest = Static<typeof IntakeAnswersRequestSchema>;
export type PlannedQuestion = Static<typeof PlannedQuestionSchema>;
export type IntakeAssumptionDto = Static<typeof IntakeAssumptionSchema> & IntakeAssumption;
export type DecompositionEstimateDto = Static<typeof DecompositionEstimateSchema>;
export type DecompositionStepDto = Static<typeof DecompositionStepSchema>;
export type DecompositionDraftDto = Static<typeof DecompositionDraftSchema>;
export type DecompositionEvidenceDto = Static<typeof DecompositionEvidenceSchema>;
export type DecompositionDraftPatch = Static<typeof DecompositionDraftPatchSchema>;
export type IntakeTypeConfirmation = Static<typeof IntakeTypeConfirmationSchema>;
export type IntakeError = Static<typeof IntakeErrorSchema>;
export type IntakeSessionCreate = Static<typeof IntakeSessionCreateSchema>;
export type IntakeSessionDto = Static<typeof IntakeSessionSchema>;
export type IntakeSessionIdParams = Static<typeof IntakeSessionIdParamsSchema>;
