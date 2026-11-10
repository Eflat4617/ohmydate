import type { ColumnType } from 'kysely';

/**
 * Hand-written Kysely view of the M1 planner schema
 * (services/api/migrations/0001_init.sql). Keep this file and the migration in
 * lockstep; test/db/types.test.ts compares `databaseTables` to
 * information_schema, and a type-level assertion keeps `Database` aligned with
 * the runtime manifest.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string | undefined>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null | undefined
>;
type Jsonb = ColumnType<JsonValue, JsonValue | undefined, JsonValue | undefined>;
type NullableJsonb = ColumnType<
  JsonValue | null,
  JsonValue | null | undefined,
  JsonValue | null | undefined
>;
type DefaultedInteger = ColumnType<number, number | undefined, number | undefined>;
type NullableInteger = ColumnType<number | null, number | null | undefined, number | null | undefined>;
type DefaultedBoolean = ColumnType<boolean, boolean | undefined, boolean | undefined>;

export interface UserTable {
  id: string;
  email: string;
  password_hash: string;
  time_zone: ColumnType<string, string | undefined, string | undefined>;
  locale: ColumnType<string, string | undefined, string | undefined>;
  settings: Jsonb;
  llm_consent: Jsonb;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
}

export interface ProjectTable {
  id: string;
  owner_id: string;
  title: string;
  archived: DefaultedBoolean;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
  deleted_at: NullableTimestamp;
}

export interface TaskTable {
  id: string;
  owner_id: string;
  project_id: string | null;
  title_cache: string | null;
  status_cache: ColumnType<string, string | undefined, string | undefined>;
  due_at: NullableTimestamp;
  splittable: DefaultedBoolean;
  min_session_min: NullableInteger;
  max_session_min: NullableInteger;
  priority: DefaultedInteger;
  earliest_start_at: NullableTimestamp;
  provider_etag: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
  deleted_at: NullableTimestamp;
}

export interface TaskDependencyTable {
  task_id: string;
  depends_on_task_id: string;
  owner_id: string;
  kind: ColumnType<string, string | undefined, string | undefined>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
}

export interface ExternalProviderMappingTable {
  id: string;
  owner_id: string;
  entity_type: string;
  entity_id: string;
  provider: string;
  external_id: string;
  external_etag: string | null;
  external_updated_at: NullableTimestamp;
  local_version: DefaultedInteger;
  last_synced_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
}

export interface IdempotencyRecordTable {
  id: string;
  owner_id: string;
  key: string;
  route: string;
  request_hash: string;
  response: NullableJsonb;
  status: ColumnType<string, string | undefined, string | undefined>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
}

export interface OutboxEventTable {
  id: string;
  owner_id: string;
  topic: string;
  payload: Jsonb;
  available_at: Timestamp;
  attempts: DefaultedInteger;
  processed_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
}

export interface InboxEventTable {
  id: string;
  owner_id: string;
  provider: string;
  event_hash: string;
  payload: NullableJsonb;
  received_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
}

export interface AuditEventTable {
  id: string;
  owner_id: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  diff_summary: NullableJsonb;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
}

export interface JobTable {
  id: string;
  owner_id: string;
  kind: string;
  run_at: Timestamp;
  lease_until: NullableTimestamp;
  attempts: DefaultedInteger;
  unique_key: string;
  status: ColumnType<string, string | undefined, string | undefined>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: DefaultedInteger;
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
}

export type ColumnKind =
  | 'uuid'
  | 'text'
  | 'jsonb'
  | 'timestamptz'
  | 'integer'
  | 'boolean';

/**
 * Runtime mirror of `Database`, consumed by the information_schema parity test.
 * Table keys are type-checked against `Database` below.
 */
export const databaseTables = {
  user: {
    id: 'uuid',
    email: 'text',
    password_hash: 'text',
    time_zone: 'text',
    locale: 'text',
    settings: 'jsonb',
    llm_consent: 'jsonb',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
  project: {
    id: 'uuid',
    owner_id: 'uuid',
    title: 'text',
    archived: 'boolean',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
    deleted_at: 'timestamptz',
  },
  task: {
    id: 'uuid',
    owner_id: 'uuid',
    project_id: 'uuid',
    title_cache: 'text',
    status_cache: 'text',
    due_at: 'timestamptz',
    splittable: 'boolean',
    min_session_min: 'integer',
    max_session_min: 'integer',
    priority: 'integer',
    earliest_start_at: 'timestamptz',
    provider_etag: 'text',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
    deleted_at: 'timestamptz',
  },
  task_dependency: {
    task_id: 'uuid',
    depends_on_task_id: 'uuid',
    owner_id: 'uuid',
    kind: 'text',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
  external_provider_mapping: {
    id: 'uuid',
    owner_id: 'uuid',
    entity_type: 'text',
    entity_id: 'uuid',
    provider: 'text',
    external_id: 'text',
    external_etag: 'text',
    external_updated_at: 'timestamptz',
    local_version: 'integer',
    last_synced_at: 'timestamptz',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
  idempotency_record: {
    id: 'uuid',
    owner_id: 'uuid',
    key: 'text',
    route: 'text',
    request_hash: 'text',
    response: 'jsonb',
    status: 'text',
    expires_at: 'timestamptz',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
  outbox_event: {
    id: 'uuid',
    owner_id: 'uuid',
    topic: 'text',
    payload: 'jsonb',
    available_at: 'timestamptz',
    attempts: 'integer',
    processed_at: 'timestamptz',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
  inbox_event: {
    id: 'uuid',
    owner_id: 'uuid',
    provider: 'text',
    event_hash: 'text',
    payload: 'jsonb',
    received_at: 'timestamptz',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
  audit_event: {
    id: 'uuid',
    owner_id: 'uuid',
    actor: 'text',
    action: 'text',
    entity: 'text',
    entity_id: 'uuid',
    diff_summary: 'jsonb',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
  job: {
    id: 'uuid',
    owner_id: 'uuid',
    kind: 'text',
    run_at: 'timestamptz',
    lease_until: 'timestamptz',
    attempts: 'integer',
    unique_key: 'text',
    status: 'text',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    version: 'integer',
  },
} as const satisfies Record<keyof Database, Record<string, ColumnKind>>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type DatabaseTablesMatch = Equal<keyof Database, keyof typeof databaseTables>;

type AllTableColumnsMatch = {
  [K in keyof Database]: Equal<keyof Database[K], keyof (typeof databaseTables)[K]>;
};

export type DatabaseColumnsMatch = Equal<AllTableColumnsMatch[keyof Database], true>;
