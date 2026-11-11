import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import {
  CursorSchema,
  IdSchema,
  InstantSchema,
  VersionSchema,
  pageSchema,
} from './common.js';
import { ExplanationItemsSchema } from './explanation.js';
import { DecompositionStepKindSchema } from './intake.js';
import {
  MinuteSchema,
  PlanBlockSchema,
  PlanMetricsSchema,
  ScheduleBlockSchema,
} from './planning.js';
import { EstimationQualitySchema } from './today.js';

/**
 * M5 replanning and estimation-learning contracts (08 §2.6, §2.10, 05 §6/§10/§11,
 * 06 §7/§7.1). These are contract-only for M5-01: the routes are added to
 * `contractRoutes` (and therefore OpenAPI) while the handlers arrive in M5-02.
 */

export const REPLAN_TRIGGER_KINDS = [
  'deadline_risk',
  'commitment_conflict',
  'early_completion',
  'user_request',
] as const;

export type ReplanTriggerKindName = (typeof REPLAN_TRIGGER_KINDS)[number];

export const ReplanTriggerKindSchema = Type.Union(
  REPLAN_TRIGGER_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<ReplanTriggerKindName>[],
);

/**
 * Stable suppression key (05 §11: the same reason is suppressed for 24 h after
 * a rejection). More granular than the trigger kind so a dependency edit and a
 * deadline slip are counted independently.
 */
export const REPLAN_REASON_CODES = [
  'deadline_slack_negative',
  'commitment_overlap',
  'early_completion_capacity',
  'dependency_change',
  'user_request',
] as const;

export type ReplanReasonCodeName = (typeof REPLAN_REASON_CODES)[number];

export const ReplanReasonCodeSchema = Type.Union(
  REPLAN_REASON_CODES.map((reason) => Type.Literal(reason)) as TLiteral<ReplanReasonCodeName>[],
);

export const REPLAN_PROPOSAL_STATES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
] as const;

export type ReplanProposalStateName = (typeof REPLAN_PROPOSAL_STATES)[number];

export const ReplanProposalStateSchema = Type.Union(
  REPLAN_PROPOSAL_STATES.map((state) => Type.Literal(state)) as TLiteral<ReplanProposalStateName>[],
);

export const REPLAN_CANDIDATE_FLAGS = [
  'infeasible',
  'bound_exceeded',
  'scope_extended',
  'capacity_deficit',
] as const;

export type ReplanCandidateFlagName = (typeof REPLAN_CANDIDATE_FLAGS)[number];

export const ReplanCandidateFlagSchema = Type.Union(
  REPLAN_CANDIDATE_FLAGS.map((flag) => Type.Literal(flag)) as TLiteral<ReplanCandidateFlagName>[],
);

/**
 * Which tasks the replan is allowed to move (06 §7.1, FU-59). The scheduler
 * cannot infer removed or already-ordered dependency edges from `ScheduleInput`,
 * so the caller must pass the affected set explicitly.
 */
export const ReplanTriggerSchema = Type.Object(
  {
    kind: ReplanTriggerKindSchema,
    reason: ReplanReasonCodeSchema,
    detectedAt: InstantSchema,
    affectedTaskIds: Type.Array(IdSchema, { maxItems: 500 }),
  },
  {
    additionalProperties: false,
    $id: 'ReplanTrigger',
    description:
      'Replan trigger plus the caller-supplied affected task scope (06 §7.1). Non-affected future blocks stay fixed.',
  },
);

/**
 * Minimal-change candidate. `changedBlocks` is the symmetric block difference,
 * `bound` is the 2×(affected blocks)+2 limit, and `flags` records whether the
 * candidate extended the scope or exceeded the bound instead of hiding it.
 */
export const ReplanCandidateSchema = Type.Object(
  {
    blocks: Type.Array(PlanBlockSchema, { maxItems: 5_000 }),
    metrics: PlanMetricsSchema,
    changedBlocks: Type.Integer({ minimum: 0 }),
    bound: Type.Integer({ minimum: 0 }),
    flags: Type.Array(ReplanCandidateFlagSchema, { maxItems: 20, uniqueItems: true }),
    explanation: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 }),
    /** FU-62: `explanationItems[i]` codes `explanation[i]`; `[]` for legacy rows. */
    explanationItems: Type.Optional(ExplanationItemsSchema),
  },
  { additionalProperties: false, $id: 'ReplanCandidate' },
);

/** Slack of one deadline task in the before snapshot (06 §6 `minSlackMin` rule). */
export const ReplanTaskSlackSchema = Type.Object(
  {
    taskId: IdSchema,
    dueAt: InstantSchema,
    /** due − buffer − end of the task's last occupied interval; signed, unrounded. */
    slackMin: Type.Number(),
  },
  { additionalProperties: false, $id: 'ReplanTaskSlack' },
);

/**
 * Metrics of the before side, computed by the server with the same rules as
 * `candidate.metrics` (06 §6): `totalFocusMin` sums every interval the
 * scheduler would count (locked/other live blocks, history and the plan's
 * movable blocks), `minSlackMin` is the smallest deadline slack (or horizon
 * end − last end without deadlines).
 */
export const ReplanBeforeMetricsSchema = Type.Object(
  {
    totalFocusMin: Type.Number({ minimum: 0 }),
    minSlackMin: Type.Number(),
    taskSlack: Type.Array(ReplanTaskSlackSchema, { maxItems: 500 }),
  },
  { additionalProperties: false, $id: 'ReplanBeforeMetrics' },
);

/**
 * FU-70 / M5-03R-1 H1: authoritative before side of a proposal, captured when
 * the proposal was computed. `blocks` is every block of the base plan that the
 * candidate replaces (unlocked, not done, starting at or after `capturedAt`)
 * or keeps (locked future blocks, `locked = true`), across the whole plan
 * horizon. Clients diff `candidate.blocks` against exactly this set and never
 * query a calendar window to reconstruct it.
 */
export const ReplanBeforeSchema = Type.Object(
  {
    capturedAt: InstantSchema,
    blocks: Type.Array(ScheduleBlockSchema, { maxItems: 5_000 }),
    metrics: ReplanBeforeMetricsSchema,
  },
  { additionalProperties: false, $id: 'ReplanBefore' },
);

/**
 * Persisted replan proposal. Nothing is applied until
 * `POST /replan-proposals/{id}:approve`, which reuses the plan-approval
 * atomicity contract (08 §2.4): `If-Match: W/"availability:<n>"` and a
 * transactional stale-snapshot re-check before creating a plan version with
 * `createdBy = "replan"`.
 */
export const ReplanProposalSchema = Type.Object(
  {
    id: IdSchema,
    state: ReplanProposalStateSchema,
    /** Plan the proposal replans (`POST /replan-proposals:request` takes it back). */
    planId: IdSchema,
    trigger: ReplanTriggerSchema,
    basePlanVersionId: IdSchema,
    /** Plan resource version (`W/"<n>"` of `GET /plans/{id}`) the proposal was computed from. */
    basePlanVersion: Type.Integer({ minimum: 1 }),
    availabilityVersion: Type.Integer({ minimum: 1 }),
    candidate: ReplanCandidateSchema,
    /** Absent only for proposals persisted before FU-70: clients must not guess a diff then. */
    before: Type.Optional(ReplanBeforeSchema),
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'ReplanProposal' },
);

export const ReplanProposalPageSchema = pageSchema(ReplanProposalSchema, {
  id: 'ReplanProposalPage',
});

export const ReplanProposalListQuerySchema = Type.Object(
  {
    state: Type.Optional(ReplanProposalStateSchema),
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'ReplanProposalListQuery' },
);

export const ReplanProposalIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'ReplanProposalIdParams' },
);

export const ReplanApproveRequestSchema = Type.Object(
  {
    editedBlocks: Type.Optional(Type.Array(PlanBlockSchema, { maxItems: 5_000 })),
  },
  { additionalProperties: false, $id: 'ReplanApproveRequest' },
);

/**
 * Rejection body. `reason` is optional personal text and follows the same
 * never-log rule as session notes.
 */
export const ReplanRejectSchema = Type.Object(
  {
    reason: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false, $id: 'ReplanReject' },
);

/**
 * User-initiated replan request (`POST /replan-proposals:request`). The server
 * forces trigger kind `user_request`; `reason` only overrides the suppression
 * key. `affectedTaskIds` follows the FU-59 caller contract when known.
 */
export const ReplanRequestSchema = Type.Object(
  {
    planId: IdSchema,
    reason: Type.Optional(ReplanReasonCodeSchema),
    affectedTaskIds: Type.Optional(Type.Array(IdSchema, { minItems: 1, maxItems: 500 })),
  },
  { additionalProperties: false, $id: 'ReplanRequest' },
);

export const ESTIMATION_PROFILE_DIMENSIONS = ['template', 'kind'] as const;

export type EstimationProfileDimensionName = (typeof ESTIMATION_PROFILE_DIMENSIONS)[number];

export const EstimationProfileDimensionSchema = Type.Union(
  ESTIMATION_PROFILE_DIMENSIONS.map((dimension) =>
    Type.Literal(dimension),
  ) as TLiteral<EstimationProfileDimensionName>[],
);

/**
 * Personal log-ratio correction (05 §6): ratio = actual/estimated P50, shrunk
 * toward the template prior with weight `shrinkageK` (k = 5). `logRatioStdDev`
 * drives the |z| > 2.5 outlier test.
 */
export const EstimationRatioStatsSchema = Type.Object(
  {
    sampleCount: Type.Integer({ minimum: 0 }),
    logRatioMean: Type.Number(),
    logRatioStdDev: Type.Number({ minimum: 0 }),
    p50Ratio: Type.Number({ minimum: 0 }),
    p90Ratio: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'EstimationRatioStats' },
);

export const EstimationProfileGroupSchema = Type.Object(
  {
    dimension: EstimationProfileDimensionSchema,
    /** Human-readable group key (template id or decomposition task kind). */
    key: Type.String({ minLength: 1, maxLength: 200 }),
    templateId: Type.Optional(IdSchema),
    taskKind: Type.Optional(DecompositionStepKindSchema),
    stats: EstimationRatioStatsSchema,
    sampleCount: Type.Integer({ minimum: 0 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    method: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false, $id: 'EstimationProfileGroup' },
);

/**
 * "내 패턴" (05 §10) line item. `excluded` is the owner override applied through
 * `PATCH /estimation/feedback/{id}`; `zScore` and `quality` expose the automatic
 * outlier classification so an excluded item can be re-included.
 */
export const EstimationProfileItemSchema = Type.Object(
  {
    feedbackId: IdSchema,
    taskId: IdSchema,
    templateId: Type.Optional(IdSchema),
    taskKind: Type.Optional(DecompositionStepKindSchema),
    estimatedP50: MinuteSchema,
    actualFocusMin: MinuteSchema,
    ratio: Type.Number({ minimum: 0 }),
    zScore: Type.Number(),
    quality: EstimationQualitySchema,
    excluded: Type.Boolean(),
    createdAt: InstantSchema,
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'EstimationProfileItem' },
);

/**
 * Estimation learning profile. Priors are always accompanied by their evidence
 * (method, sample count, confidence) so the UI never shows an unexplained P50.
 */
export const EstimationProfileSchema = Type.Object(
  {
    generatedAt: InstantSchema,
    sampleCount: Type.Integer({ minimum: 0 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    method: Type.String({ minLength: 1, maxLength: 100 }),
    shrinkageK: Type.Integer({ minimum: 0 }),
    outlierZThreshold: Type.Number({ minimum: 0 }),
    groups: Type.Array(EstimationProfileGroupSchema, { maxItems: 200 }),
    items: Type.Array(EstimationProfileItemSchema, { maxItems: 2_000 }),
  },
  { additionalProperties: false, $id: 'EstimationProfile' },
);

export const ESTIMATION_RESET_SCOPES = ['template', 'all'] as const;

export type EstimationResetScopeName = (typeof ESTIMATION_RESET_SCOPES)[number];

export const EstimationResetScopeSchema = Type.Union(
  ESTIMATION_RESET_SCOPES.map((scope) => Type.Literal(scope)) as TLiteral<EstimationResetScopeName>[],
);

/**
 * Reset learned corrections (05 §6). `templateId` is required when scope is
 * `template`; the handler rejects the missing id with 422 validation_failed.
 */
export const EstimationResetSchema = Type.Object(
  {
    scope: EstimationResetScopeSchema,
    templateId: Type.Optional(IdSchema),
  },
  {
    additionalProperties: false,
    $id: 'EstimationReset',
    description:
      'Reset personal estimation corrections for one template or all. templateId is required when scope is "template" (422 validation_failed otherwise).',
  },
);

export const EstimationFeedbackPatchSchema = Type.Object(
  {
    excluded: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'EstimationFeedbackPatch' },
);

export const EstimationFeedbackIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'EstimationFeedbackIdParams' },
);

export type ReplanTriggerKind = Static<typeof ReplanTriggerKindSchema>;
export type ReplanReasonCode = Static<typeof ReplanReasonCodeSchema>;
export type ReplanProposalState = Static<typeof ReplanProposalStateSchema>;
export type ReplanCandidateFlag = Static<typeof ReplanCandidateFlagSchema>;
export type ReplanTriggerDto = Static<typeof ReplanTriggerSchema>;
export type ReplanCandidateDto = Static<typeof ReplanCandidateSchema>;
export type ReplanTaskSlack = Static<typeof ReplanTaskSlackSchema>;
export type ReplanBeforeMetrics = Static<typeof ReplanBeforeMetricsSchema>;
export type ReplanBefore = Static<typeof ReplanBeforeSchema>;
export type ReplanProposal = Static<typeof ReplanProposalSchema>;
export type ReplanProposalPage = Static<typeof ReplanProposalPageSchema>;
export type ReplanProposalListQuery = Static<typeof ReplanProposalListQuerySchema>;
export type ReplanProposalIdParams = Static<typeof ReplanProposalIdParamsSchema>;
export type ReplanApproveRequest = Static<typeof ReplanApproveRequestSchema>;
export type ReplanReject = Static<typeof ReplanRejectSchema>;
export type ReplanRequest = Static<typeof ReplanRequestSchema>;
export type EstimationProfileDimension = Static<typeof EstimationProfileDimensionSchema>;
export type EstimationRatioStats = Static<typeof EstimationRatioStatsSchema>;
export type EstimationProfileGroup = Static<typeof EstimationProfileGroupSchema>;
export type EstimationProfileItem = Static<typeof EstimationProfileItemSchema>;
export type EstimationProfile = Static<typeof EstimationProfileSchema>;
export type EstimationResetScope = Static<typeof EstimationResetScopeSchema>;
export type EstimationReset = Static<typeof EstimationResetSchema>;
export type EstimationFeedbackPatch = Static<typeof EstimationFeedbackPatchSchema>;
export type EstimationFeedbackIdParams = Static<typeof EstimationFeedbackIdParamsSchema>;
