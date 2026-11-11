import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import {
  CursorSchema,
  IanaTimeZoneSchema,
  IdSchema,
  InstantSchema,
  VersionSchema,
  pageSchema,
} from './common.js';
import { MinuteSchema, ScheduleBlockStatusSchema } from './planning.js';

const LocalDateSchema = Type.String({ format: 'date' });

/**
 * Signed slack in whole minutes. Negative values mean the day is overbooked;
 * the Today view renders them as a deadline risk rather than clamping to zero.
 */
const SignedMinuteSchema = Type.Integer({ minimum: -100_000, maximum: 100_000 });

const LongTextSchema = Type.String({ maxLength: 500 });

export const TODAY_RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type TodayRiskLevelName = (typeof TODAY_RISK_LEVELS)[number];

export const TodayRiskLevelSchema = Type.Union(
  TODAY_RISK_LEVELS.map((level) => Type.Literal(level)) as TLiteral<TodayRiskLevelName>[],
);

export const TodayRiskSchema = Type.Object(
  {
    level: TodayRiskLevelSchema,
    reasons: Type.Array(LongTextSchema, { maxItems: 20 }),
  },
  { additionalProperties: false, $id: 'TodayRisk' },
);

/**
 * One recommended block for the day. `title` is the task summary the Today
 * view renders; the full task lives behind `GET /tasks/{id}`. The API returns
 * two to three blocks when the plan has them, and an empty list on a free day.
 */
export const TodayBlockSchema = Type.Object(
  {
    id: IdSchema,
    taskId: IdSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    startAt: InstantSchema,
    endAt: InstantSchema,
    status: ScheduleBlockStatusSchema,
  },
  { additionalProperties: false, $id: 'TodayBlock' },
);

export const TodaySchema = Type.Object(
  {
    date: LocalDateSchema,
    timeZone: IanaTimeZoneSchema,
    blocks: Type.Array(TodayBlockSchema, { maxItems: 3 }),
    slackMin: SignedMinuteSchema,
    risk: TodayRiskSchema,
    /** Revision of the underlying active plan; used for `If-Match` on actions. */
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'Today' },
);

export const TodayQuerySchema = Type.Object(
  {
    date: LocalDateSchema,
  },
  { additionalProperties: false, $id: 'TodayQuery' },
);

export const TodayAcceptRequestSchema = Type.Object(
  {
    date: LocalDateSchema,
    /** Omit to accept every recommended block for the day. */
    blockIds: Type.Optional(Type.Array(IdSchema, { minItems: 1, maxItems: 3 })),
  },
  { additionalProperties: false, $id: 'TodayAcceptRequest' },
);

export const TodayShrinkRequestSchema = Type.Object(
  {
    date: LocalDateSchema,
    blockId: IdSchema,
    /** New duration for the block; the server finds the next free start. */
    targetMin: Type.Integer({ minimum: 1, maximum: 100_000 }),
  },
  { additionalProperties: false, $id: 'TodayShrinkRequest' },
);

export const TodayRescheduleRequestSchema = Type.Object(
  {
    date: LocalDateSchema,
    blockIds: Type.Array(IdSchema, { minItems: 1, maxItems: 50 }),
    /** Omit to rearrange within `date`; set to move the blocks to another day. */
    toDate: Type.Optional(LocalDateSchema),
  },
  { additionalProperties: false, $id: 'TodayRescheduleRequest' },
);

export const TODAY_PROPOSAL_KINDS = ['shrink', 'reschedule'] as const;

export type TodayProposalKindName = (typeof TODAY_PROPOSAL_KINDS)[number];

export const TodayProposalKindSchema = Type.Union(
  TODAY_PROPOSAL_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<TodayProposalKindName>[],
);

export const TodayProposalBlockSchema = Type.Object(
  {
    blockId: IdSchema,
    taskId: IdSchema,
    startAt: InstantSchema,
    endAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'TodayProposalBlock' },
);

/**
 * A shrink/reschedule proposal returned by `POST /today:shrink|:reschedule`.
 * Nothing is applied until `POST /today/proposals/{id}:approve` with
 * `If-Match: W/"availability:<n>"`. The proposal persists the base plan
 * version and the availability snapshot it was computed against so approval
 * can repeat the 08 §2.4 atomic stale-snapshot check before creating a new
 * plan version. `version` is the proposal's own optimistic version.
 */
export const TodayProposalSchema = Type.Object(
  {
    id: IdSchema,
    kind: TodayProposalKindSchema,
    date: LocalDateSchema,
    timeZone: IanaTimeZoneSchema,
    /** Plan version the proposal was computed from. */
    basePlanVersionId: IdSchema,
    /** Availability snapshot used for the stale-snapshot check at approval. */
    availabilityVersion: Type.Integer({ minimum: 1 }),
    blocks: Type.Array(TodayProposalBlockSchema, { maxItems: 50 }),
    version: VersionSchema,
    createdAt: InstantSchema,
    expiresAt: Type.Optional(InstantSchema),
  },
  {
    additionalProperties: false,
    $id: 'TodayProposal',
    description:
      'Persisted shrink/reschedule proposal with its base plan version and availability snapshot. Approval re-validates availability atomically (08 §2.4).',
  },
);

export const TodayProposalParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'TodayProposalParams' },
);

export const WORK_SESSION_STATES = ['active', 'paused', 'completed', 'abandoned'] as const;

export type WorkSessionStateName = (typeof WORK_SESSION_STATES)[number];

export const WorkSessionStateSchema = Type.Union(
  WORK_SESSION_STATES.map((state) => Type.Literal(state)) as TLiteral<WorkSessionStateName>[],
);

export const WorkSessionSchema = Type.Object(
  {
    id: IdSchema,
    taskId: IdSchema,
    blockId: Type.Optional(IdSchema),
    state: WorkSessionStateSchema,
    startedAt: InstantSchema,
    endedAt: Type.Optional(InstantSchema),
    focusedSec: Type.Integer({ minimum: 0 }),
    pausedSec: Type.Integer({ minimum: 0 }),
    clientId: Type.String({ minLength: 1, maxLength: 200 }),
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'WorkSession' },
);

export const SessionCreateSchema = Type.Object(
  {
    taskId: IdSchema,
    blockId: Type.Optional(IdSchema),
    clientStartedAt: Type.String({
      format: 'date-time',
      description:
        'Device clock at session start. The server accepts it within [serverNow - 24 h, serverNow + 2 min] and clamps values outside that window, recording the clamp.',
    }),
    clientId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  {
    additionalProperties: false,
    $id: 'SessionCreate',
    description:
      'Starts a focus session. clientStartedAt is clamped to [serverNow - 24 h, serverNow + 2 min]; the clamp is recorded so offline replay is exactly-once but observable.',
  },
);

export const SessionIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'SessionIdParams' },
);

/**
 * Offline replay body for :pause/:resume/:complete. `clientAt` is the device
 * clock at the event. It is accepted within [session.startedAt,
 * serverNow + 2 min] and must be monotonic per session. Out-of-range and
 * out-of-order values are clamped to the nearest accepted bound and the clamp
 * is recorded, so a flapping offline clock can still upload a completed session
 * exactly once. Illegal state transitions remain 409 `session_state_conflict`.
 */
export const SessionEventRequestSchema = Type.Object(
  {
    clientAt: Type.String({
      format: 'date-time',
      description:
        'Device clock at the event. Accepted within [session.startedAt, serverNow + 2 min] and monotonic per session; out-of-range or out-of-order values are clamped to the nearest bound and the clamp is recorded.',
    }),
  },
  {
    additionalProperties: false,
    $id: 'SessionEventRequest',
    description:
      'Session event with its client timestamp. Clamping rules are [session.startedAt, serverNow + 2 min] plus per-session monotonicity; clamped values are recorded.',
  },
);

export const SESSION_OUTCOMES = ['done', 'partial', 'blocked'] as const;

export type SessionOutcomeName = (typeof SESSION_OUTCOMES)[number];

export const SessionOutcomeSchema = Type.Union(
  SESSION_OUTCOMES.map((outcome) => Type.Literal(outcome)) as TLiteral<SessionOutcomeName>[],
);

export const SESSION_REASON_CHIPS = [
  'focus_lost',
  'interrupted',
  'task_larger',
  'task_smaller',
  'blocked_dependency',
  'low_energy',
  'other',
] as const;

export type SessionReasonChipName = (typeof SESSION_REASON_CHIPS)[number];

export const SessionReasonChipSchema = Type.Union(
  SESSION_REASON_CHIPS.map((chip) => Type.Literal(chip)) as TLiteral<SessionReasonChipName>[],
);

/**
 * End-of-session feedback. `note` is P1 personal text: it must never be logged
 * and is only returned to its owner (04 §3, 08 §2.5).
 */
export const SessionReviewRequestSchema = Type.Object(
  {
    outcome: SessionOutcomeSchema,
    reasonChips: Type.Array(SessionReasonChipSchema, { maxItems: 10, uniqueItems: true }),
    note: Type.Optional(Type.String({ maxLength: 2_000 })),
  },
  { additionalProperties: false, $id: 'SessionReviewRequest' },
);

export const ESTIMATION_QUALITIES = ['ok', 'outlier', 'excluded'] as const;

export type EstimationQualityName = (typeof ESTIMATION_QUALITIES)[number];

export const EstimationQualitySchema = Type.Union(
  ESTIMATION_QUALITIES.map((quality) => Type.Literal(quality)) as TLiteral<EstimationQualityName>[],
);

export const EstimationFeedbackSchema = Type.Object(
  {
    taskId: IdSchema,
    estimatedP50: MinuteSchema,
    actualFocusMin: MinuteSchema,
    quality: EstimationQualitySchema,
  },
  { additionalProperties: false, $id: 'EstimationFeedback' },
);

export const NOTIFICATION_KINDS = [
  'due_soon',
  'deadline_risk',
  'schedule_conflict',
  'session_reminder',
  'daily_summary',
  'replan_proposal',
] as const;

export type NotificationKindName = (typeof NOTIFICATION_KINDS)[number];

export const NotificationKindSchema = Type.Union(
  NOTIFICATION_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<NotificationKindName>[],
);

export const NOTIFICATION_CHANNELS = ['in_app', 'push'] as const;

export type NotificationChannelName = (typeof NOTIFICATION_CHANNELS)[number];

export const NotificationChannelSchema = Type.Union(
  NOTIFICATION_CHANNELS.map((channel) => Type.Literal(channel)) as TLiteral<NotificationChannelName>[],
);

export const NOTIFICATION_STATES = ['scheduled', 'sent', 'dismissed', 'failed', 'expired'] as const;

export type NotificationStateName = (typeof NOTIFICATION_STATES)[number];

export const NotificationStateSchema = Type.Union(
  NOTIFICATION_STATES.map((state) => Type.Literal(state)) as TLiteral<NotificationStateName>[],
);

export const NotificationSchema = Type.Object(
  {
    id: IdSchema,
    kind: NotificationKindSchema,
    dedupeKey: Type.String({ minLength: 1, maxLength: 200 }),
    scheduledAt: InstantSchema,
    sentAt: Type.Optional(InstantSchema),
    channel: NotificationChannelSchema,
    state: NotificationStateSchema,
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'Notification' },
);

export const NotificationQuerySchema = Type.Object(
  {
    state: Type.Optional(NotificationStateSchema),
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'NotificationQuery' },
);

export const NotificationPageSchema = pageSchema(NotificationSchema, {
  id: 'NotificationPage',
});

export const NotificationIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'NotificationIdParams' },
);

const Base64UrlSchema = Type.String({
  minLength: 16,
  maxLength: 200,
  pattern: '^[A-Za-z0-9_-]+=*$',
});

export const PushSubscriptionKeysSchema = Type.Object(
  {
    p256dh: Base64UrlSchema,
    auth: Base64UrlSchema,
  },
  { additionalProperties: false, $id: 'PushSubscriptionKeys' },
);

/**
 * Browser push subscription. The endpoint must be HTTPS; the server encrypts
 * both key material before storage and never echoes it back (04 §3).
 */
export const PushSubscriptionCreateSchema = Type.Object(
  {
    endpoint: Type.String({
      format: 'uri',
      pattern: '^https://',
      maxLength: 2_048,
    }),
    keys: PushSubscriptionKeysSchema,
    deviceLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false, $id: 'PushSubscriptionCreate' },
);

export const PushSubscriptionSchema = Type.Object(
  {
    id: IdSchema,
    endpoint: Type.String({ format: 'uri', pattern: '^https://', maxLength: 2_048 }),
    deviceLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    createdAt: InstantSchema,
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'PushSubscription' },
);

export const PushSubscriptionIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'PushSubscriptionIdParams' },
);

export const EXPORT_STATES = ['queued', 'running', 'ready', 'failed'] as const;

export type ExportStateName = (typeof EXPORT_STATES)[number];

export const ExportStateSchema = Type.Union(
  EXPORT_STATES.map((state) => Type.Literal(state)) as TLiteral<ExportStateName>[],
);

/**
 * Export job (08 §2.10 minimal subset). While `state` is `queued`/`running`
 * there is no `downloadUrl`; once `ready`, `downloadUrl` is a short-lived
 * signed URL with the same deadline as `expiresAt`. A `failed` export carries
 * `failureReason` and must be requested again with a new idempotency key.
 */
export const ExportSchema = Type.Object(
  {
    id: IdSchema,
    state: ExportStateSchema,
    createdAt: InstantSchema,
    expiresAt: Type.Optional(InstantSchema),
    downloadUrl: Type.Optional(
      Type.String({ format: 'uri', maxLength: 2_048 }),
    ),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    failureReason: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false, $id: 'Export' },
);

export const ExportStartResponseSchema = Type.Object(
  {
    exportId: IdSchema,
  },
  { additionalProperties: false, $id: 'ExportStartResponse' },
);

export const ExportIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'ExportIdParams' },
);

export type TodayRiskLevel = Static<typeof TodayRiskLevelSchema>;
export type TodayRisk = Static<typeof TodayRiskSchema>;
export type TodayBlock = Static<typeof TodayBlockSchema>;
export type Today = Static<typeof TodaySchema>;
export type TodayQuery = Static<typeof TodayQuerySchema>;
export type TodayAcceptRequest = Static<typeof TodayAcceptRequestSchema>;
export type TodayShrinkRequest = Static<typeof TodayShrinkRequestSchema>;
export type TodayRescheduleRequest = Static<typeof TodayRescheduleRequestSchema>;
export type TodayProposalBlock = Static<typeof TodayProposalBlockSchema>;
export type TodayProposal = Static<typeof TodayProposalSchema>;
export type TodayProposalParams = Static<typeof TodayProposalParamsSchema>;
export type WorkSessionState = Static<typeof WorkSessionStateSchema>;
export type WorkSession = Static<typeof WorkSessionSchema>;
export type SessionCreate = Static<typeof SessionCreateSchema>;
export type SessionIdParams = Static<typeof SessionIdParamsSchema>;
export type SessionEventRequest = Static<typeof SessionEventRequestSchema>;
export type SessionOutcome = Static<typeof SessionOutcomeSchema>;
export type SessionReasonChip = Static<typeof SessionReasonChipSchema>;
export type SessionReviewRequest = Static<typeof SessionReviewRequestSchema>;
export type EstimationQuality = Static<typeof EstimationQualitySchema>;
export type EstimationFeedback = Static<typeof EstimationFeedbackSchema>;
export type NotificationKind = Static<typeof NotificationKindSchema>;
export type NotificationChannel = Static<typeof NotificationChannelSchema>;
export type NotificationState = Static<typeof NotificationStateSchema>;
export type Notification = Static<typeof NotificationSchema>;
export type NotificationQuery = Static<typeof NotificationQuerySchema>;
export type NotificationPage = Static<typeof NotificationPageSchema>;
export type NotificationIdParams = Static<typeof NotificationIdParamsSchema>;
export type PushSubscriptionKeys = Static<typeof PushSubscriptionKeysSchema>;
export type PushSubscriptionCreate = Static<typeof PushSubscriptionCreateSchema>;
export type PushSubscription = Static<typeof PushSubscriptionSchema>;
export type PushSubscriptionIdParams = Static<typeof PushSubscriptionIdParamsSchema>;
export type ExportState = Static<typeof ExportStateSchema>;
export type Export = Static<typeof ExportSchema>;
export type ExportStartResponse = Static<typeof ExportStartResponseSchema>;
export type ExportIdParams = Static<typeof ExportIdParamsSchema>;
