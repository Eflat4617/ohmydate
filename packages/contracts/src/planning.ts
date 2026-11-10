import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import {
  CursorSchema,
  IanaTimeZoneSchema,
  IdSchema,
  InstantSchema,
  VersionSchema,
} from './common.js';
import { ViolationSchema } from './problem.js';

const MINUTE_MAX = 100_000;

/** Maximum supported planning horizon; mirrors `@ohmydate/scheduler`. */
export const MAX_HORIZON_DAYS = 366;

/** Whole minutes, bounded to the scheduler input contract (06 §2, 08 §2.4a). */
export const MinuteSchema = Type.Integer({ minimum: 0, maximum: MINUTE_MAX });

const LocalTimeSchema = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });

const LocalTimeEndSchema = Type.String({
  pattern: '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$',
});

const LocalDateSchema = Type.String({ format: 'date' });

/**
 * Bounded RFC 5545 recurrence rule. Expansion is server-side and limited to
 * 366 days and 2,000 occurrences per query (08 §2.4a); the schema only bounds
 * the stored string so malformed rules fail validation early.
 */
export const RRuleSchema = Type.String({
  minLength: 5,
  maxLength: 500,
  pattern: '^FREQ=',
});

export const AVAILABILITY_KINDS = ['work', 'focus'] as const;

export type AvailabilityKindName = (typeof AVAILABILITY_KINDS)[number];

export const AvailabilityKindSchema = Type.Union(
  AVAILABILITY_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<AvailabilityKindName>[],
);

export const AvailabilityRuleSchema = Type.Object(
  {
    weekday: Type.Integer({ minimum: 1, maximum: 7 }),
    startLocal: LocalTimeSchema,
    endLocal: LocalTimeEndSchema,
    kind: AvailabilityKindSchema,
  },
  { additionalProperties: false, $id: 'AvailabilityRule' },
);

export const AVAILABILITY_EXCEPTION_KINDS = ['off', 'extra'] as const;

export type AvailabilityExceptionKindName = (typeof AVAILABILITY_EXCEPTION_KINDS)[number];

export const AvailabilityExceptionKindSchema = Type.Union(
  AVAILABILITY_EXCEPTION_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<AvailabilityExceptionKindName>[],
);

export const AvailabilityExceptionSchema = Type.Object(
  {
    date: LocalDateSchema,
    kind: AvailabilityExceptionKindSchema,
    startLocal: Type.Optional(LocalTimeSchema),
    endLocal: Type.Optional(LocalTimeEndSchema),
  },
  { additionalProperties: false, $id: 'AvailabilityException' },
);

export const RISK_LEVELS = ['p50', 'p90'] as const;

export type RiskLevelName = (typeof RISK_LEVELS)[number];

export const RiskLevelSchema = Type.Union(
  RISK_LEVELS.map((level) => Type.Literal(level)) as TLiteral<RiskLevelName>[],
);

export const AvailabilityPreferencesSchema = Type.Object(
  {
    maxDailyFocusMin: MinuteSchema,
    breakAfterMin: MinuteSchema,
    breakMin: MinuteSchema,
    dayStartLocal: LocalTimeSchema,
    dayEndLocal: LocalTimeEndSchema,
    riskLevel: RiskLevelSchema,
  },
  { additionalProperties: false, $id: 'AvailabilityPreferences' },
);

export const AvailabilitySchema = Type.Object(
  {
    version: VersionSchema,
    timeZone: IanaTimeZoneSchema,
    rules: Type.Array(AvailabilityRuleSchema, { maxItems: 50 }),
    exceptions: Type.Array(AvailabilityExceptionSchema, { maxItems: 400 }),
    prefs: AvailabilityPreferencesSchema,
  },
  { additionalProperties: false, $id: 'Availability' },
);

/** Full replacement payload; the `version` comes from `If-Match`. */
export const AvailabilityPutSchema = Type.Object(
  {
    timeZone: IanaTimeZoneSchema,
    rules: Type.Array(AvailabilityRuleSchema, { maxItems: 50 }),
    exceptions: Type.Array(AvailabilityExceptionSchema, { maxItems: 400 }),
    prefs: AvailabilityPreferencesSchema,
  },
  { additionalProperties: false, $id: 'AvailabilityPut' },
);

export const COMMITMENT_SOURCES = ['manual', 'caldav', 'vikunja'] as const;

export type CommitmentSourceName = (typeof COMMITMENT_SOURCES)[number];

export const CommitmentSourceSchema = Type.Union(
  COMMITMENT_SOURCES.map((source) => Type.Literal(source)) as TLiteral<CommitmentSourceName>[],
);

export const CommitmentOccurrenceSchema = Type.Object(
  {
    commitmentId: IdSchema,
    startAt: InstantSchema,
    endAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'CommitmentOccurrence' },
);

const CommitmentTitleSchema = Type.String({ minLength: 1, maxLength: 200 });

export const CommitmentSchema = Type.Object(
  {
    id: IdSchema,
    ownerId: IdSchema,
    title: CommitmentTitleSchema,
    startAt: InstantSchema,
    endAt: InstantSchema,
    timeZone: IanaTimeZoneSchema,
    rrule: Type.Optional(RRuleSchema),
    source: CommitmentSourceSchema,
    occurrences: Type.Optional(
      Type.Array(CommitmentOccurrenceSchema, { maxItems: 2_000 }),
    ),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'Commitment' },
);

export const CommitmentCreateSchema = Type.Object(
  {
    title: CommitmentTitleSchema,
    startAt: InstantSchema,
    endAt: InstantSchema,
    timeZone: IanaTimeZoneSchema,
    rrule: Type.Optional(RRuleSchema),
    source: Type.Optional(CommitmentSourceSchema),
  },
  { additionalProperties: false, $id: 'CommitmentCreate' },
);

export const CommitmentPatchSchema = Type.Object(
  {
    title: Type.Optional(CommitmentTitleSchema),
    startAt: Type.Optional(InstantSchema),
    endAt: Type.Optional(InstantSchema),
    timeZone: Type.Optional(IanaTimeZoneSchema),
    rrule: Type.Optional(Type.Union([RRuleSchema, Type.Null()])),
    source: Type.Optional(CommitmentSourceSchema),
  },
  { additionalProperties: false, $id: 'CommitmentPatch' },
);

export const CommitmentListQuerySchema = Type.Object(
  {
    from: InstantSchema,
    to: InstantSchema,
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'CommitmentListQuery' },
);

export const CommitmentPageSchema = Type.Object(
  {
    items: Type.Array(CommitmentSchema),
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
  },
  { additionalProperties: false, $id: 'CommitmentPage' },
);

export const PLAN_POLICIES = ['front_loaded', 'balanced', 'focus_blocked'] as const;

export type PlanPolicyName = (typeof PLAN_POLICIES)[number];

export const PlanPolicySchema = Type.Union(
  PLAN_POLICIES.map((policy) => Type.Literal(policy)) as TLiteral<PlanPolicyName>[],
);

export const PlanScopeSchema = Type.Union(
  [
    Type.Object(
      {
        goalId: IdSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        taskIds: Type.Array(IdSchema, { minItems: 1, maxItems: 100 }),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'PlanScope' },
);

export const PlanHorizonSchema = Type.Object(
  {
    start: InstantSchema,
    end: InstantSchema,
  },
  { additionalProperties: false, $id: 'PlanHorizon' },
);

/**
 * Planning request. The server validates that `horizon.end - horizon.start` is
 * at most 366 days (`MAX_HORIZON_DAYS`) and that every task belongs to the
 * caller; the client never sends a `ScheduleInput` (08 §2.4a).
 */
export const PlanCreateSchema = Type.Object(
  {
    scope: PlanScopeSchema,
    policies: Type.Optional(
      Type.Array(PlanPolicySchema, { minItems: 1, maxItems: 3, uniqueItems: true }),
    ),
    horizon: PlanHorizonSchema,
  },
  { additionalProperties: false, $id: 'PlanCreate' },
);

export const PlanBlockSchema = Type.Object(
  {
    taskId: IdSchema,
    startAt: InstantSchema,
    endAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'PlanBlock' },
);

/**
 * Deterministic candidate metrics (06 §6), field-for-field with the scheduler's
 * `PlanMetrics`. `minSlackMin` is signed and may be fractional (a 30-second
 * overdue deadline is -0.5) and must never be rounded or clamped; Ajv rejects
 * non-finite numbers. Average loads and coverage ratios are also fractional.
 */
export const PlanMetricsSchema = Type.Object(
  {
    totalFocusMin: Type.Integer({ minimum: 0 }),
    minSlackMin: Type.Number(),
    maxDailyLoadMin: Type.Integer({ minimum: 0 }),
    avgDailyLoadMin: Type.Number({ minimum: 0 }),
    contextSwitches: Type.Integer({ minimum: 0 }),
    changedBlocks: Type.Integer({ minimum: 0 }),
    deficitMin: Type.Integer({ minimum: 0 }),
    capacityDeficitMin: Type.Integer({ minimum: 0 }),
    p90CoverageRatio: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'PlanMetrics' },
);

export const PlanCandidateSchema = Type.Object(
  {
    id: IdSchema,
    policy: PlanPolicySchema,
    blocks: Type.Array(PlanBlockSchema, { maxItems: 5_000 }),
    metrics: PlanMetricsSchema,
    feasible: Type.Boolean(),
    deficitMin: Type.Integer({ minimum: 0 }),
    capacityDeficitMin: Type.Integer({ minimum: 0 }),
    explanation: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 }),
    diversityNote: Type.Optional(Type.String({ maxLength: 500 })),
    generatorVersion: Type.String({ minLength: 1, maxLength: 100 }),
    inputHash: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false, $id: 'PlanCandidate' },
);

export const PLAN_STATUSES = ['draft', 'active', 'superseded'] as const;

export type PlanStatusName = (typeof PLAN_STATUSES)[number];

export const PlanStatusSchema = Type.Union(
  PLAN_STATUSES.map((status) => Type.Literal(status)) as TLiteral<PlanStatusName>[],
);

export const PlanSchema = Type.Object(
  {
    id: IdSchema,
    ownerId: IdSchema,
    scope: PlanScopeSchema,
    status: PlanStatusSchema,
    availabilityVersion: Type.Integer({ minimum: 1 }),
    currentVersionId: Type.Optional(IdSchema),
    horizon: PlanHorizonSchema,
    timeZone: IanaTimeZoneSchema,
    candidates: Type.Array(PlanCandidateSchema, { maxItems: 3 }),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'Plan' },
);

export const PlanIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'PlanIdParams' },
);

export const PlanCandidateParamsSchema = Type.Object(
  {
    id: IdSchema,
    cid: IdSchema,
  },
  { additionalProperties: false, $id: 'PlanCandidateParams' },
);

export const PreviewEditRequestSchema = Type.Object(
  {
    blocks: Type.Array(PlanBlockSchema, { maxItems: 5_000 }),
  },
  { additionalProperties: false, $id: 'PreviewEditRequest' },
);

export const PreviewEditResponseSchema = Type.Object(
  {
    feasible: Type.Boolean(),
    violations: Type.Array(ViolationSchema, { maxItems: 1_000 }),
    deficitMin: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'PreviewEditResponse' },
);

export const ApprovePlanRequestSchema = Type.Object(
  {
    editedBlocks: Type.Optional(Type.Array(PlanBlockSchema, { maxItems: 5_000 })),
  },
  { additionalProperties: false, $id: 'ApprovePlanRequest' },
);

export const SCHEDULE_BLOCK_STATUSES = [
  'planned',
  'done',
  'skipped',
  'moved',
  'superseded',
] as const;

export type ScheduleBlockStatusName = (typeof SCHEDULE_BLOCK_STATUSES)[number];

export const ScheduleBlockStatusSchema = Type.Union(
  SCHEDULE_BLOCK_STATUSES.map((status) => Type.Literal(status)) as TLiteral<ScheduleBlockStatusName>[],
);

export const ScheduleBlockSchema = Type.Object(
  {
    id: IdSchema,
    planVersionId: IdSchema,
    taskId: IdSchema,
    startAt: InstantSchema,
    endAt: InstantSchema,
    locked: Type.Boolean(),
    status: ScheduleBlockStatusSchema,
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'ScheduleBlock' },
);

export const PLAN_VERSION_CREATORS = ['user', 'replan'] as const;

export type PlanVersionCreatorName = (typeof PLAN_VERSION_CREATORS)[number];

export const PlanVersionCreatorSchema = Type.Union(
  PLAN_VERSION_CREATORS.map((creator) => Type.Literal(creator)) as TLiteral<PlanVersionCreatorName>[],
);

export const PlanVersionSchema = Type.Object(
  {
    id: IdSchema,
    planId: IdSchema,
    seq: Type.Integer({ minimum: 1 }),
    candidateId: Type.Optional(IdSchema),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    createdBy: PlanVersionCreatorSchema,
    availabilityVersion: Type.Integer({ minimum: 1 }),
    blocks: Type.Array(ScheduleBlockSchema, { maxItems: 5_000 }),
    version: VersionSchema,
    createdAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'PlanVersion' },
);

export type AvailabilityRuleDto = Static<typeof AvailabilityRuleSchema>;
export type AvailabilityExceptionDto = Static<typeof AvailabilityExceptionSchema>;
export type AvailabilityPreferencesDto = Static<typeof AvailabilityPreferencesSchema>;
export type Availability = Static<typeof AvailabilitySchema>;
export type AvailabilityPut = Static<typeof AvailabilityPutSchema>;
export type CommitmentOccurrence = Static<typeof CommitmentOccurrenceSchema>;
export type Commitment = Static<typeof CommitmentSchema>;
export type CommitmentCreate = Static<typeof CommitmentCreateSchema>;
export type CommitmentPatch = Static<typeof CommitmentPatchSchema>;
export type CommitmentListQuery = Static<typeof CommitmentListQuerySchema>;
export type CommitmentPage = Static<typeof CommitmentPageSchema>;
export type PlanScope = Static<typeof PlanScopeSchema>;
export type PlanHorizon = Static<typeof PlanHorizonSchema>;
export type PlanCreate = Static<typeof PlanCreateSchema>;
export type PlanBlock = Static<typeof PlanBlockSchema>;
export type PlanMetricsDto = Static<typeof PlanMetricsSchema>;
export type PlanCandidateDto = Static<typeof PlanCandidateSchema>;
export type Plan = Static<typeof PlanSchema>;
export type PlanIdParams = Static<typeof PlanIdParamsSchema>;
export type PlanCandidateParams = Static<typeof PlanCandidateParamsSchema>;
export type PreviewEditRequest = Static<typeof PreviewEditRequestSchema>;
export type PreviewEditResponse = Static<typeof PreviewEditResponseSchema>;
export type ApprovePlanRequest = Static<typeof ApprovePlanRequestSchema>;
export type ScheduleBlockDto = Static<typeof ScheduleBlockSchema>;
export type PlanVersionDto = Static<typeof PlanVersionSchema>;
