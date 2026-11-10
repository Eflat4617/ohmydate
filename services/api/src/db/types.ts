import type { ColumnType } from 'kysely';

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
  | 'boolean';

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
            : never;

// A NOT NULL jsonb column still needs a non-null, non-undefined insert type so
// Kysely's Insertable keeps the key required (JSON null is not a SQL NULL).
type InsertScalar<K extends ColumnKind> = K extends 'timestamptz'
  ? Date | string
  : K extends 'jsonb'
    ? Exclude<JsonValue, null>
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
  archived: Col<'boolean', false, true>;
  created_at: Col<'timestamptz', false, true>;
  updated_at: Col<'timestamptz', false, true>;
  version: Col<'integer', false, true>;
  deleted_at: Col<'timestamptz', true, false>;
}

export interface TaskTable {
  id: Col<'uuid', false, false>;
  owner_id: Col<'uuid', false, false>;
  project_id: Col<'uuid', true, false>;
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
    archived: col('boolean', false, true),
    created_at: col('timestamptz', false, true),
    updated_at: col('timestamptz', false, true),
    version: col('integer', false, true),
    deleted_at: col('timestamptz', true, false),
  },
  task: {
    id: col('uuid', false, false),
    owner_id: col('uuid', false, false),
    project_id: col('uuid', true, false),
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
};

export type DatabaseTablesMatch = ExpectTrue<Equal<keyof Database, keyof typeof databaseTables>>;
export type DatabaseColumnsMatch = ExpectTrue<
  Equal<TableAssertions[keyof TableAssertions], true>
>;
