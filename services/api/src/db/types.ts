import { sql, type ColumnType, type RawBuilder } from 'kysely';
import pg from 'pg';

/**
 * PostgreSQL `date` (OID 1082) has no timezone. node-postgres' default parser
 * builds a local-midnight `Date`, which shifts the calendar day when the host
 * timezone is not UTC. The Kysely schema types `date` columns as `string`, so
 * keep the raw `YYYY-MM-DD` text instead.
 */
pg.types.setTypeParser(1082, (value: string) => value);

/**
 * Hand-written Kysely view of the M1 planner schema
 * (services/api/migrations/0001_init.sql).
 *
 * Every column is expressed through `Col<kind, nullable, hasDefault>`. The
 * runtime `databaseTables` manifest carries the same three flags, is checked
 * against information_schema in test/db/types.test.ts, and is type-linked to
 * the interfaces below through `AssertTableColumns`. If an interface column
 * drifts from the manifest (or the manifest drifts from PostgreSQL), either
 * tsc or the schema test fails.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ColumnKind =
  | 'uuid'
  | 'text'
  | 'jsonb'
  | 'timestamptz'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'real'
  | 'numeric'
  | 'tsvector'
  | 'text_array'
  | 'bytea';

declare const jsonbParamBrand: unique symbol;

/**
 * Branded JSONB write parameter. Only `jsonb()` can produce it, so raw
 * objects/arrays/scalars are compile errors for every JSONB insert/update.
 */
export interface JsonbParam extends RawBuilder<JsonValue> {
  readonly [jsonbParamBrand]: true;
}

/**
 * Serializes a JsonValue exactly once and casts the text parameter to jsonb.
 * node-pg would otherwise send top-level arrays as PostgreSQL array literals
 * and scalar strings unchanged, causing 22P02 or silent type changes.
 */
export function jsonb(value: JsonValue): JsonbParam {
  return sql`${JSON.stringify(value)}::jsonb` as unknown as JsonbParam;
}

type Scalar<K extends ColumnKind> = K extends 'uuid'
  ? string
  : K extends 'text'
    ? string
    : K extends 'integer'
      ? number
      : K extends 'boolean'
        ? boolean
        : K extends 'jsonb'
          ? JsonValue
          : K extends 'timestamptz'
            ? Date
            : K extends 'date'
              ? string
              : K extends 'real'
                ? number
                : K extends 'numeric'
                  ? string
                  : K extends 'tsvector'
                    ? string
                    : K extends 'text_array'
                      ? string[]
                      : K extends 'bytea'
                        ? Buffer
                        : never;

// A NOT NULL jsonb column still needs a non-null, non-undefined insert type so
// Kysely's Insertable keeps the key required (JSON null is not a SQL NULL).
// JSONB writes always go through JsonbParam so node-pg receives valid JSON text.
type InsertScalar<K extends ColumnKind> = K extends 'timestamptz'
  ? Date | string
  : K extends 'jsonb'
    ? JsonbParam
    : Scalar<K>;

type Selected<K extends ColumnKind, N extends boolean> = N extends true
  ? Scalar<K> | null
  : Scalar<K>;

type Written<K extends ColumnKind, N extends boolean, D extends boolean> = N extends true
  ? InsertScalar<K> | null | undefined
  : D extends true
    ? InsertScalar<K> | undefined
    : InsertScalar<K>;

/**
 * Canonical Kysely column type for one column shape.
 * `N` = nullable, `D` = has a database default (insert may omit it).
 */
export type Col<K extends ColumnKind, N extends boolean, D extends boolean> = ColumnType<
  Selected<K, N>,
  Written<K, N, D>,
  Written<K, N, D>
>;

export interface UserTable {
  id: Col<'uuid', false, false>;
  email: Col<'text', false, false>;
  password_hash: Col<'text', false, false>;
  time_zone: Col<'text', false, true>;
  locale: Col<'text', false, true>;
  settings: Col<'jsonb', false, true>;
  llm_consent: Col<'jsonb', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface ProjectTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  title: Col<'text', false, false>;
  kind: Col<'text', false, true>;
  archived: Col<'boolean', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface TaskTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  project_id: Col<'uuid', false, false>;
  title_cache: Col<'text', true, false>;
  status_cache: Col<'text', false, true>;
  due_at: Col<'timestamptz', true, false>;
  splittable: Col<'boolean', false, true>;
  min_session_min: Col<'integer', true, false>;
  max_session_min: Col<'integer', true, false>;
  priority: Col<'integer', false, true>;
  earliest_start_at: Col<'timestamptz', true, false>;
  provider_etag: Col<'text', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface TaskDependencyTable {
  task_id: Col<'uuid', false, false>;
  depends_on_task_id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  kind: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface ExternalProviderMappingTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  entity_type: Col<'text', false, false>;
  entity_id: Col<'uuid', false, false>;
  provider: Col<'text', false, false>;
  external_id: Col<'text', false, false>;
  external_etag: Col<'text', true, false>;
  external_updated_at: Col<'timestamptz', true, false>;
  local_version: Col<'integer', false, true>;
  last_synced_at: Col<'timestamptz', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface IdempotencyRecordTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  key: Col<'text', false, false>;
  route: Col<'text', false, false>;
  request_hash: Col<'text', false, false>;
  response: Col<'jsonb', true, false>;
  status: Col<'text', false, true>;
  expires_at: Col<'timestamptz', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface OutboxEventTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  topic: Col<'text', false, false>;
  /** NOT NULL without a default: producers must always supply the payload. */
  payload: Col<'jsonb', false, false>;
  available_at: Col<'timestamptz', false, true>;
  attempts: Col<'integer', false, true>;
  processed_at: Col<'timestamptz', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface InboxEventTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  provider: Col<'text', false, false>;
  event_hash: Col<'text', false, false>;
  payload: Col<'jsonb', true, false>;
  received_at: Col<'timestamptz', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface AuditEventTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  actor: Col<'text', false, false>;
  action: Col<'text', false, false>;
  entity: Col<'text', false, false>;
  entity_id: Col<'uuid', true, false>;
  diff_summary: Col<'jsonb', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface JobTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  kind: Col<'text', false, false>;
  run_at: Col<'timestamptz', false, true>;
  lease_until: Col<'timestamptz', true, false>;
  attempts: Col<'integer', false, true>;
  unique_key: Col<'text', false, false>;
  status: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface GoalTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  title: Col<'text', false, false>;
  target_date: Col<'date', true, false>;
  status: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface TaskTemplateTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  name: Col<'text', false, false>;
  steps: Col<'jsonb', false, true>;
  stats: Col<'jsonb', false, true>;
  source: Col<'text', false, true>;
  confidence: Col<'real', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface TaskTypeFingerprintTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  template_id: Col<'uuid', false, false>;
  tags: Col<'text_array', false, true>;
  keywords: Col<'tsvector', false, true>;
  meta: Col<'jsonb', false, true>;
  false_positive_count: Col<'integer', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface IntakeSessionTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  goal_id: Col<'uuid', true, false>;
  state: Col<'text', false, true>;
  input: Col<'jsonb', false, true>;
  detected_type: Col<'jsonb', true, false>;
  template_id: Col<'uuid', true, false>;
  round: Col<'integer', false, true>;
  manual: Col<'boolean', false, true>;
  error: Col<'jsonb', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface IntakeAnswerTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  session_id: Col<'uuid', false, false>;
  question_key: Col<'text', false, false>;
  question_text: Col<'text', false, false>;
  answer: Col<'jsonb', true, false>;
  skipped: Col<'boolean', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface IntakeApprovalTable {
  session_id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  draft_version: Col<'integer', false, false>;
  state: Col<'text', false, true>;
  lease_expires_at: Col<'timestamptz', false, false>;
  idempotency_key: Col<'text', false, false>;
  holder_token: Col<'text', true, false>;
  last_call_started_at: Col<'timestamptz', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
}

export interface IntakeApprovalStepTable {
  session_id: Col<'uuid', false, false>;
  step_key: Col<'text', false, false>;
  planned_task_id: Col<'uuid', false, false>;
  state: Col<'text', false, true>;
  task_id: Col<'uuid', true, false>;
  dependency_state: Col<'text', true, false>;
}

export interface EstimateTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  task_id: Col<'uuid', false, false>;
  p50_min: Col<'integer', false, false>;
  p90_min: Col<'integer', false, false>;
  method: Col<'text', false, false>;
  confidence: Col<'real', false, false>;
  is_current: Col<'boolean', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface EstimateEvidenceTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  estimate_id: Col<'uuid', false, false>;
  kind: Col<'text', false, false>;
  ref: Col<'text', true, false>;
  summary: Col<'text', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface AgentRunTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  purpose: Col<'text', false, false>;
  prompt_id_version: Col<'text', false, false>;
  model: Col<'text', false, false>;
  provider: Col<'text', false, false>;
  tokens_in: Col<'integer', false, true>;
  tokens_out: Col<'integer', false, true>;
  cost_usd: Col<'numeric', false, true>;
  latency_ms: Col<'integer', false, true>;
  status: Col<'text', false, false>;
  redaction_report: Col<'jsonb', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface AgentProposalTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  run_id: Col<'uuid', false, false>;
  kind: Col<'text', false, false>;
  payload: Col<'jsonb', false, false>;
  schema_ok: Col<'boolean', false, true>;
  policy_ok: Col<'boolean', false, true>;
  constraint_ok: Col<'boolean', false, true>;
  decision: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface CommitmentEventTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  title: Col<'text', false, false>;
  start_at: Col<'timestamptz', false, false>;
  end_at: Col<'timestamptz', false, false>;
  rrule: Col<'text', true, false>;
  time_zone: Col<'text', false, false>;
  source: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface AvailabilityRuleTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  weekday: Col<'integer', false, false>;
  start_local: Col<'text', false, false>;
  end_local: Col<'text', false, false>;
  time_zone: Col<'text', false, false>;
  kind: Col<'text', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface AvailabilityExceptionTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  date: Col<'date', false, false>;
  kind: Col<'text', false, false>;
  start_local: Col<'text', true, false>;
  end_local: Col<'text', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface UserAvailabilityVersionTable {
  owner_id: Col<'uuid', false, false>;
  version: Col<'integer', false, true>;
  time_zone: Col<'text', false, true>;
  prefs: Col<'jsonb', false, true>;
  updated_at: Col<'timestamptz', false, true>;
}

export interface PlanTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  scope: Col<'jsonb', false, false>;
  status: Col<'text', false, true>;
  current_version_id: Col<'uuid', true, false>;
  availability_version: Col<'integer', false, true>;
  horizon_start: Col<'timestamptz', false, false>;
  horizon_end: Col<'timestamptz', false, false>;
  time_zone: Col<'text', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface PlanCandidateTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  plan_id: Col<'uuid', false, false>;
  policy: Col<'text', false, false>;
  blocks: Col<'jsonb', false, true>;
  metrics: Col<'jsonb', false, true>;
  explanation: Col<'jsonb', false, true>;
  diversity_note: Col<'text', true, false>;
  feasible: Col<'boolean', false, false>;
  deficit_min: Col<'integer', false, true>;
  input_hash: Col<'text', false, false>;
  generator_version: Col<'text', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface PlanVersionTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  plan_id: Col<'uuid', false, false>;
  seq: Col<'integer', false, false>;
  candidate_id: Col<'uuid', true, false>;
  reason: Col<'text', true, false>;
  created_by: Col<'text', false, true>;
  availability_version: Col<'integer', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface ScheduleBlockTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  plan_version_id: Col<'uuid', false, false>;
  task_id: Col<'uuid', false, false>;
  start_at: Col<'timestamptz', false, false>;
  end_at: Col<'timestamptz', false, false>;
  locked: Col<'boolean', false, true>;
  status: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface ScheduleApprovalTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  plan_version_id: Col<'uuid', false, false>;
  approved_at: Col<'timestamptz', false, true>;
  idempotency_key: Col<'text', false, false>;
  availability_version: Col<'integer', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface VikunjaMappingTable {
  entity_type: Col<'text', false, false>;
  entity_id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  external_id: Col<'text', false, false>;
  external_etag: Col<'text', true, false>;
  external_updated_at: Col<'timestamptz', true, false>;
  local_version: Col<'integer', false, true>;
  content_fingerprint: Col<'text', true, false>;
  is_inbox: Col<'boolean', false, true>;
  needs_reconcile: Col<'boolean', false, true>;
  pending_completion: Col<'jsonb', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface VikunjaPlannerFieldsTable {
  task_id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  fields: Col<'jsonb', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
}

export interface VikunjaChangeJournalTable {
  owner_id: Col<'uuid', false, false>;
  epoch: Col<'text', false, false>;
  seq: Col<'integer', false, false>;
  task_id: Col<'uuid', false, false>;
  external_id: Col<'text', false, false>;
  version: Col<'integer', false, false>;
  deleted_at: Col<'timestamptz', true, false>;
  completed_occurrence_at: Col<'timestamptz', true, false>;
  at: Col<'timestamptz', false, false>;
}

export interface VikunjaJournalEpochTable {
  owner_id: Col<'uuid', false, false>;
  epoch: Col<'text', false, false>;
  snapshot_done: Col<'boolean', false, true>;
  updated_at: Col<'timestamptz', false, true>;
}

export interface VikunjaOwnerAccountTable {
  owner_id: Col<'uuid', false, false>;
  vikunja_user_id: Col<'integer', false, false>;
  token_secret_ref: Col<'text', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
}

export interface WorkSessionTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  task_id: Col<'uuid', false, false>;
  block_id: Col<'uuid', true, false>;
  state: Col<'text', false, true>;
  started_at: Col<'timestamptz', false, false>;
  ended_at: Col<'timestamptz', true, false>;
  focused_sec: Col<'integer', false, true>;
  paused_sec: Col<'integer', false, true>;
  client_id: Col<'text', false, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface TaskCompletionReviewTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  session_id: Col<'uuid', false, false>;
  outcome: Col<'text', false, false>;
  reason_chips: Col<'text_array', false, true>;
  note: Col<'text', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface EstimationFeedbackTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  task_id: Col<'uuid', false, false>;
  estimated_p50: Col<'integer', false, false>;
  actual_focus_min: Col<'integer', false, false>;
  quality: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface NotificationTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  kind: Col<'text', false, false>;
  dedupe_key: Col<'text', false, false>;
  scheduled_at: Col<'timestamptz', false, false>;
  sent_at: Col<'timestamptz', true, false>;
  channel: Col<'text', false, true>;
  state: Col<'text', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface PushSubscriptionTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  endpoint: Col<'text', false, false>;
  p256dh_ciphertext: Col<'bytea', false, false>;
  auth_ciphertext: Col<'bytea', false, false>;
  key_id: Col<'text', false, false>;
  device_label: Col<'text', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface ExportJobTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  state: Col<'text', false, true>;
  requested_at: Col<'timestamptz', false, true>;
  started_at: Col<'timestamptz', true, false>;
  completed_at: Col<'timestamptz', true, false>;
  expires_at: Col<'timestamptz', true, false>;
  artifact_key: Col<'text', true, false>;
  size_bytes: Col<'integer', true, false>;
  failure_code: Col<'text', true, false>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
}

export interface Database {
  user: UserTable;
  project: ProjectTable;
  task: TaskTable;
  task_dependency: TaskDependencyTable;
  external_provider_mapping: ExternalProviderMappingTable;
  idempotency_record: IdempotencyRecordTable;
  outbox_event: OutboxEventTable;
  inbox_event: InboxEventTable;
  audit_event: AuditEventTable;
  job: JobTable;
  goal: GoalTable;
  task_template: TaskTemplateTable;
  task_type_fingerprint: TaskTypeFingerprintTable;
  intake_session: IntakeSessionTable;
  intake_answer: IntakeAnswerTable;
  intake_approval: IntakeApprovalTable;
  intake_approval_step: IntakeApprovalStepTable;
  estimate: EstimateTable;
  estimate_evidence: EstimateEvidenceTable;
  agent_run: AgentRunTable;
  agent_proposal: AgentProposalTable;
  commitment_event: CommitmentEventTable;
  availability_rule: AvailabilityRuleTable;
  availability_exception: AvailabilityExceptionTable;
  user_availability_version: UserAvailabilityVersionTable;
  plan: PlanTable;
  plan_candidate: PlanCandidateTable;
  plan_version: PlanVersionTable;
  schedule_block: ScheduleBlockTable;
  schedule_approval: ScheduleApprovalTable;
  work_session: WorkSessionTable;
  task_completion_review: TaskCompletionReviewTable;
  estimation_feedback: EstimationFeedbackTable;
  notification: NotificationTable;
  push_subscription: PushSubscriptionTable;
  export_job: ExportJobTable;
  vikunja_mapping: VikunjaMappingTable;
  vikunja_planner_fields: VikunjaPlannerFieldsTable;
  vikunja_change_journal: VikunjaChangeJournalTable;
  vikunja_journal_epoch: VikunjaJournalEpochTable;
  vikunja_owner_account: VikunjaOwnerAccountTable;
}

export interface ColumnSpec {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
}

function col<K extends ColumnKind, N extends boolean, D extends boolean>(
  kind: K,
  nullable: N,
  hasDefault: D,
): { readonly kind: K; readonly nullable: N; readonly hasDefault: D } {
  return { kind, nullable, hasDefault };
}

/**
 * Runtime mirror of `Database`, consumed by the information_schema parity test.
 * `kind` maps to information_schema.columns.data_type, `nullable` to
 * is_nullable, and `hasDefault` to "column_default IS NOT NULL".
 */
export const databaseTables = {
  user: {
    id: col('uuid', false, false),
    email: col('text', false, false),
    password_hash: col('text', false, false),
    time_zone: col('text', false, true),
    locale: col('text', false, true),
    settings: col('jsonb', false, true),
    llm_consent: col('jsonb', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  project: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    title: col('text', false, false),
    kind: col('text', false, true),
    archived: col('boolean', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  task: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    project_id: col('uuid', false, false),
    title_cache: col('text', true, false),
    status_cache: col('text', false, true),
    due_at: col('timestamptz', true, false),
    splittable: col('boolean', false, true),
    min_session_min: col('integer', true, false),
    max_session_min: col('integer', true, false),
    priority: col('integer', false, true),
    earliest_start_at: col('timestamptz', true, false),
    provider_etag: col('text', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  task_dependency: {
    task_id: col('uuid', false, false),
    depends_on_task_id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    kind: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  external_provider_mapping: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    entity_type: col('text', false, false),
    entity_id: col('uuid', false, false),
    provider: col('text', false, false),
    external_id: col('text', false, false),
    external_etag: col('text', true, false),
    external_updated_at: col('timestamptz', true, false),
    local_version: col('integer', false, true),
    last_synced_at: col('timestamptz', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  idempotency_record: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    key: col('text', false, false),
    route: col('text', false, false),
    request_hash: col('text', false, false),
    response: col('jsonb', true, false),
    status: col('text', false, true),
    expires_at: col('timestamptz', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  outbox_event: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    topic: col('text', false, false),
    payload: col('jsonb', false, false),
    available_at: col('timestamptz', false, true),
    attempts: col('integer', false, true),
    processed_at: col('timestamptz', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  inbox_event: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    provider: col('text', false, false),
    event_hash: col('text', false, false),
    payload: col('jsonb', true, false),
    received_at: col('timestamptz', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  audit_event: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    actor: col('text', false, false),
    action: col('text', false, false),
    entity: col('text', false, false),
    entity_id: col('uuid', true, false),
    diff_summary: col('jsonb', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  job: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    kind: col('text', false, false),
    run_at: col('timestamptz', false, true),
    lease_until: col('timestamptz', true, false),
    attempts: col('integer', false, true),
    unique_key: col('text', false, false),
    status: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  goal: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    title: col('text', false, false),
    target_date: col('date', true, false),
    status: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  task_template: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    name: col('text', false, false),
    steps: col('jsonb', false, true),
    stats: col('jsonb', false, true),
    source: col('text', false, true),
    confidence: col('real', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  task_type_fingerprint: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    template_id: col('uuid', false, false),
    tags: col('text_array', false, true),
    keywords: col('tsvector', false, true),
    meta: col('jsonb', false, true),
    false_positive_count: col('integer', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  intake_session: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    goal_id: col('uuid', true, false),
    state: col('text', false, true),
    input: col('jsonb', false, true),
    detected_type: col('jsonb', true, false),
    template_id: col('uuid', true, false),
    round: col('integer', false, true),
    manual: col('boolean', false, true),
    error: col('jsonb', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  intake_approval: {
    session_id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    draft_version: col('integer', false, false),
    state: col('text', false, true),
    lease_expires_at: col('timestamptz', false, false),
    idempotency_key: col('text', false, false),
    holder_token: col('text', true, false),
    last_call_started_at: col('timestamptz', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
  },
  intake_approval_step: {
    session_id: col('uuid', false, false),
    step_key: col('text', false, false),
    planned_task_id: col('uuid', false, false),
    state: col('text', false, true),
    task_id: col('uuid', true, false),
    dependency_state: col('text', true, false),
  },
  intake_answer: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    session_id: col('uuid', false, false),
    question_key: col('text', false, false),
    question_text: col('text', false, false),
    answer: col('jsonb', true, false),
    skipped: col('boolean', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  estimate: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    task_id: col('uuid', false, false),
    p50_min: col('integer', false, false),
    p90_min: col('integer', false, false),
    method: col('text', false, false),
    confidence: col('real', false, false),
    is_current: col('boolean', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  estimate_evidence: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    estimate_id: col('uuid', false, false),
    kind: col('text', false, false),
    ref: col('text', true, false),
    summary: col('text', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  agent_run: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    purpose: col('text', false, false),
    prompt_id_version: col('text', false, false),
    model: col('text', false, false),
    provider: col('text', false, false),
    tokens_in: col('integer', false, true),
    tokens_out: col('integer', false, true),
    cost_usd: col('numeric', false, true),
    latency_ms: col('integer', false, true),
    status: col('text', false, false),
    redaction_report: col('jsonb', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  agent_proposal: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    run_id: col('uuid', false, false),
    kind: col('text', false, false),
    payload: col('jsonb', false, false),
    schema_ok: col('boolean', false, true),
    policy_ok: col('boolean', false, true),
    constraint_ok: col('boolean', false, true),
    decision: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  commitment_event: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    title: col('text', false, false),
    start_at: col('timestamptz', false, false),
    end_at: col('timestamptz', false, false),
    rrule: col('text', true, false),
    time_zone: col('text', false, false),
    source: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  availability_rule: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    weekday: col('integer', false, false),
    start_local: col('text', false, false),
    end_local: col('text', false, false),
    time_zone: col('text', false, false),
    kind: col('text', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  availability_exception: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    date: col('date', false, false),
    kind: col('text', false, false),
    start_local: col('text', true, false),
    end_local: col('text', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  user_availability_version: {
    owner_id: col('uuid', false, false),
    version: col('integer', false, true),
    time_zone: col('text', false, true),
    prefs: col('jsonb', false, true),
    updated_at: col('timestamptz', false, true),
  },
  plan: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    scope: col('jsonb', false, false),
    status: col('text', false, true),
    current_version_id: col('uuid', true, false),
    availability_version: col('integer', false, true),
    horizon_start: col('timestamptz', false, false),
    horizon_end: col('timestamptz', false, false),
    time_zone: col('text', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  plan_candidate: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    plan_id: col('uuid', false, false),
    policy: col('text', false, false),
    blocks: col('jsonb', false, true),
    metrics: col('jsonb', false, true),
    explanation: col('jsonb', false, true),
    diversity_note: col('text', true, false),
    feasible: col('boolean', false, false),
    deficit_min: col('integer', false, true),
    input_hash: col('text', false, false),
    generator_version: col('text', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  plan_version: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    plan_id: col('uuid', false, false),
    seq: col('integer', false, false),
    candidate_id: col('uuid', true, false),
    reason: col('text', true, false),
    created_by: col('text', false, true),
    availability_version: col('integer', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  schedule_block: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    plan_version_id: col('uuid', false, false),
    task_id: col('uuid', false, false),
    start_at: col('timestamptz', false, false),
    end_at: col('timestamptz', false, false),
    locked: col('boolean', false, true),
    status: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  schedule_approval: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    plan_version_id: col('uuid', false, false),
    approved_at: col('timestamptz', false, true),
    idempotency_key: col('text', false, false),
    availability_version: col('integer', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  work_session: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    task_id: col('uuid', false, false),
    block_id: col('uuid', true, false),
    state: col('text', false, true),
    started_at: col('timestamptz', false, false),
    ended_at: col('timestamptz', true, false),
    focused_sec: col('integer', false, true),
    paused_sec: col('integer', false, true),
    client_id: col('text', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  task_completion_review: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    session_id: col('uuid', false, false),
    outcome: col('text', false, false),
    reason_chips: col('text_array', false, true),
    note: col('text', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  estimation_feedback: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    task_id: col('uuid', false, false),
    estimated_p50: col('integer', false, false),
    actual_focus_min: col('integer', false, false),
    quality: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  notification: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    kind: col('text', false, false),
    dedupe_key: col('text', false, false),
    scheduled_at: col('timestamptz', false, false),
    sent_at: col('timestamptz', true, false),
    channel: col('text', false, true),
    state: col('text', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  push_subscription: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    endpoint: col('text', false, false),
    p256dh_ciphertext: col('bytea', false, false),
    auth_ciphertext: col('bytea', false, false),
    key_id: col('text', false, false),
    device_label: col('text', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  export_job: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    state: col('text', false, true),
    requested_at: col('timestamptz', false, true),
    started_at: col('timestamptz', true, false),
    completed_at: col('timestamptz', true, false),
    expires_at: col('timestamptz', true, false),
    artifact_key: col('text', true, false),
    size_bytes: col('integer', true, false),
    failure_code: col('text', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
  },
  vikunja_mapping: {
    entity_type: col('text', false, false),
    entity_id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    external_id: col('text', false, false),
    external_etag: col('text', true, false),
    external_updated_at: col('timestamptz', true, false),
    local_version: col('integer', false, true),
    content_fingerprint: col('text', true, false),
    is_inbox: col('boolean', false, true),
    needs_reconcile: col('boolean', false, true),
    pending_completion: col('jsonb', true, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  vikunja_planner_fields: {
    task_id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    fields: col('jsonb', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
  },
  vikunja_change_journal: {
    owner_id: col('uuid', false, false),
    epoch: col('text', false, false),
    seq: col('integer', false, false),
    task_id: col('uuid', false, false),
    external_id: col('text', false, false),
    version: col('integer', false, false),
    deleted_at: col('timestamptz', true, false),
    completed_occurrence_at: col('timestamptz', true, false),
    at: col('timestamptz', false, false),
  },
  vikunja_journal_epoch: {
    owner_id: col('uuid', false, false),
    epoch: col('text', false, false),
    snapshot_done: col('boolean', false, true),
    updated_at: col('timestamptz', false, true),
  },
  vikunja_owner_account: {
    owner_id: col('uuid', false, false),
    vikunja_user_id: col('integer', false, false),
    token_secret_ref: col('text', false, false),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
  },
} as const satisfies Record<keyof Database, Record<string, ColumnSpec>>;

export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type ExpectTrue<T extends true> = T;

/**
 * Compares every column of `Table` with the corresponding manifest spec,
 * including key sets, selected types, insert/update types, nullability and
 * default-ness (via `Col`). Resolves to `true` only when everything matches.
 */
export type AssertTableColumns<
  Table,
  Specs extends Record<string, ColumnSpec>,
> = Equal<keyof Table, keyof Specs> extends true
  ? Equal<
      {
        [C in keyof Table]: Equal<
          Table[C],
          Col<
            Specs[C & keyof Specs]['kind'],
            Specs[C & keyof Specs]['nullable'],
            Specs[C & keyof Specs]['hasDefault']
          >
        >;
      },
      { [C in keyof Table]: true }
    >
  : false;

type TableAssertions = {
  user: AssertTableColumns<UserTable, typeof databaseTables.user>;
  project: AssertTableColumns<ProjectTable, typeof databaseTables.project>;
  task: AssertTableColumns<TaskTable, typeof databaseTables.task>;
  task_dependency: AssertTableColumns<TaskDependencyTable, typeof databaseTables.task_dependency>;
  external_provider_mapping: AssertTableColumns<
    ExternalProviderMappingTable,
    typeof databaseTables.external_provider_mapping
  >;
  idempotency_record: AssertTableColumns<
    IdempotencyRecordTable,
    typeof databaseTables.idempotency_record
  >;
  outbox_event: AssertTableColumns<OutboxEventTable, typeof databaseTables.outbox_event>;
  inbox_event: AssertTableColumns<InboxEventTable, typeof databaseTables.inbox_event>;
  audit_event: AssertTableColumns<AuditEventTable, typeof databaseTables.audit_event>;
  job: AssertTableColumns<JobTable, typeof databaseTables.job>;
  goal: AssertTableColumns<GoalTable, typeof databaseTables.goal>;
  task_template: AssertTableColumns<TaskTemplateTable, typeof databaseTables.task_template>;
  task_type_fingerprint: AssertTableColumns<
    TaskTypeFingerprintTable,
    typeof databaseTables.task_type_fingerprint
  >;
  intake_session: AssertTableColumns<IntakeSessionTable, typeof databaseTables.intake_session>;
  intake_answer: AssertTableColumns<IntakeAnswerTable, typeof databaseTables.intake_answer>;
  intake_approval: AssertTableColumns<IntakeApprovalTable, typeof databaseTables.intake_approval>;
  intake_approval_step: AssertTableColumns<IntakeApprovalStepTable, typeof databaseTables.intake_approval_step>;
  estimate: AssertTableColumns<EstimateTable, typeof databaseTables.estimate>;
  estimate_evidence: AssertTableColumns<EstimateEvidenceTable, typeof databaseTables.estimate_evidence>;
  agent_run: AssertTableColumns<AgentRunTable, typeof databaseTables.agent_run>;
  agent_proposal: AssertTableColumns<AgentProposalTable, typeof databaseTables.agent_proposal>;
  commitment_event: AssertTableColumns<
    CommitmentEventTable,
    typeof databaseTables.commitment_event
  >;
  availability_rule: AssertTableColumns<
    AvailabilityRuleTable,
    typeof databaseTables.availability_rule
  >;
  availability_exception: AssertTableColumns<
    AvailabilityExceptionTable,
    typeof databaseTables.availability_exception
  >;
  user_availability_version: AssertTableColumns<
    UserAvailabilityVersionTable,
    typeof databaseTables.user_availability_version
  >;
  plan: AssertTableColumns<PlanTable, typeof databaseTables.plan>;
  plan_candidate: AssertTableColumns<PlanCandidateTable, typeof databaseTables.plan_candidate>;
  plan_version: AssertTableColumns<PlanVersionTable, typeof databaseTables.plan_version>;
  schedule_block: AssertTableColumns<ScheduleBlockTable, typeof databaseTables.schedule_block>;
  schedule_approval: AssertTableColumns<
    ScheduleApprovalTable,
    typeof databaseTables.schedule_approval
  >;
  work_session: AssertTableColumns<WorkSessionTable, typeof databaseTables.work_session>;
  task_completion_review: AssertTableColumns<
    TaskCompletionReviewTable,
    typeof databaseTables.task_completion_review
  >;
  estimation_feedback: AssertTableColumns<
    EstimationFeedbackTable,
    typeof databaseTables.estimation_feedback
  >;
  notification: AssertTableColumns<NotificationTable, typeof databaseTables.notification>;
  push_subscription: AssertTableColumns<
    PushSubscriptionTable,
    typeof databaseTables.push_subscription
  >;
  export_job: AssertTableColumns<ExportJobTable, typeof databaseTables.export_job>;
  vikunja_mapping: AssertTableColumns<
    VikunjaMappingTable,
    typeof databaseTables.vikunja_mapping
  >;
  vikunja_planner_fields: AssertTableColumns<
    VikunjaPlannerFieldsTable,
    typeof databaseTables.vikunja_planner_fields
  >;
  vikunja_change_journal: AssertTableColumns<
    VikunjaChangeJournalTable,
    typeof databaseTables.vikunja_change_journal
  >;
  vikunja_journal_epoch: AssertTableColumns<
    VikunjaJournalEpochTable,
    typeof databaseTables.vikunja_journal_epoch
  >;
  vikunja_owner_account: AssertTableColumns<
    VikunjaOwnerAccountTable,
    typeof databaseTables.vikunja_owner_account
  >;
};

export type DatabaseTablesMatch = ExpectTrue<Equal<keyof Database, keyof typeof databaseTables>>;
export type DatabaseColumnsMatch = ExpectTrue<
  Equal<TableAssertions[keyof TableAssertions], true>
>;
