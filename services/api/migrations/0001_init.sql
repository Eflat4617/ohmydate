-- 0001_init.sql — M1 planner schema.
--
-- Conventions (docs/blueprint/04-DOMAIN-AND-DATABASE.md §1):
--   * uuid primary keys, supplied by the application (UUIDv7); no DB default.
--   * owner_id NOT NULL referencing "user"(id) on every user-data table.
--   * created_at/updated_at are timestamptz (UTC); user-facing time zone lives
--     in "user".time_zone as an IANA identifier validated by the app layer.
--   * optimistic concurrency via version integer NOT NULL DEFAULT 1 CHECK (> 0).
--   * soft delete via deleted_at where the row is soft-deletable.
--
-- This file is forward-only. The matching rollback lives in 0001_init.down.sql.

CREATE TABLE "user" (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  time_zone text NOT NULL DEFAULT 'UTC',
  locale text NOT NULL DEFAULT 'en',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  llm_consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT user_email_unique UNIQUE (email),
  CONSTRAINT user_version_positive CHECK (version > 0)
);

CREATE TABLE project (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  title text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT project_version_positive CHECK (version > 0),
  -- Composite key so task can enforce "project belongs to the same owner".
  CONSTRAINT project_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX project_owner_id_idx ON project (owner_id);

CREATE TABLE task (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  project_id uuid,
  title_cache text,
  status_cache text NOT NULL DEFAULT 'todo',
  due_at timestamptz,
  splittable boolean NOT NULL DEFAULT true,
  min_session_min integer,
  max_session_min integer,
  priority integer NOT NULL DEFAULT 2,
  earliest_start_at timestamptz,
  provider_etag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT task_status_cache_valid CHECK (status_cache IN ('todo', 'in_progress', 'done')),
  CONSTRAINT task_priority_valid CHECK (priority BETWEEN 1 AND 4),
  CONSTRAINT task_min_session_positive CHECK (min_session_min IS NULL OR min_session_min > 0),
  CONSTRAINT task_max_session_positive CHECK (max_session_min IS NULL OR max_session_min > 0),
  CONSTRAINT task_session_window_valid CHECK (
    min_session_min IS NULL
    OR max_session_min IS NULL
    OR min_session_min <= max_session_min
  ),
  CONSTRAINT task_version_positive CHECK (version > 0),
  -- Composite key used by task_dependency to bind both endpoints to one owner.
  CONSTRAINT task_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT task_project_owner_fk FOREIGN KEY (project_id, owner_id)
    REFERENCES project (id, owner_id)
);

CREATE INDEX task_owner_status_idx ON task (owner_id, status_cache);
CREATE INDEX task_due_at_idx ON task (due_at);

-- The dependency edge stores owner_id once and references task through two
-- composite foreign keys (task_id, owner_id) and (depends_on_task_id, owner_id).
-- Because both FKs share the same owner_id column, a dependency can only link
-- tasks owned by the same user. This is stronger than two plain FKs plus a
-- trigger: PostgreSQL checks it for every INSERT/UPDATE, including bulk loads.
CREATE TABLE task_dependency (
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  kind text NOT NULL DEFAULT 'finish_to_start',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT task_dependency_no_self CHECK (task_id <> depends_on_task_id),
  CONSTRAINT task_dependency_kind_valid CHECK (kind IN ('finish_to_start')),
  CONSTRAINT task_dependency_version_positive CHECK (version > 0),
  CONSTRAINT task_dependency_task_fk FOREIGN KEY (task_id, owner_id)
    REFERENCES task (id, owner_id) ON DELETE CASCADE,
  CONSTRAINT task_dependency_depends_on_fk FOREIGN KEY (depends_on_task_id, owner_id)
    REFERENCES task (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX task_dependency_depends_on_idx ON task_dependency (depends_on_task_id);

CREATE TABLE external_provider_mapping (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  -- ADR-016: the planner owns the version; these mirror the external provider.
  external_etag text,
  external_updated_at timestamptz,
  local_version integer NOT NULL DEFAULT 1,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT external_provider_mapping_entity_type_valid
    CHECK (entity_type IN ('task', 'project')),
  CONSTRAINT external_provider_mapping_provider_valid CHECK (provider IN ('vikunja')),
  CONSTRAINT external_provider_mapping_local_version_positive CHECK (local_version > 0),
  CONSTRAINT external_provider_mapping_version_positive CHECK (version > 0),
  -- One provider object <-> one local entity globally (04 §3). owner_id stays
  -- for scoping and FK integrity but is deliberately not part of these keys.
  CONSTRAINT external_provider_mapping_external_unique
    UNIQUE (provider, entity_type, external_id),
  CONSTRAINT external_provider_mapping_entity_unique
    UNIQUE (entity_type, entity_id, provider)
);

CREATE INDEX external_provider_mapping_entity_idx
  ON external_provider_mapping (entity_type, entity_id);

CREATE TABLE idempotency_record (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  key text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT idempotency_record_status_valid CHECK (status IN ('pending', 'completed')),
  CONSTRAINT idempotency_record_version_positive CHECK (version > 0),
  CONSTRAINT idempotency_record_owner_key_unique UNIQUE (owner_id, key)
);

CREATE INDEX idempotency_record_expires_at_idx ON idempotency_record (expires_at);

CREATE TABLE outbox_event (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT outbox_event_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT outbox_event_version_positive CHECK (version > 0)
);

CREATE INDEX outbox_event_pending_idx ON outbox_event (available_at)
  WHERE processed_at IS NULL;

CREATE TABLE inbox_event (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  provider text NOT NULL,
  event_hash text NOT NULL,
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT inbox_event_provider_hash_unique UNIQUE (provider, event_hash),
  CONSTRAINT inbox_event_version_positive CHECK (version > 0)
);

CREATE TABLE audit_event (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  actor text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id uuid,
  diff_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT audit_event_actor_valid CHECK (actor IN ('user', 'system', 'agent')),
  CONSTRAINT audit_event_version_positive CHECK (version > 0)
);

CREATE INDEX audit_event_entity_idx ON audit_event (entity, entity_id);

CREATE TABLE job (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  kind text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  unique_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT job_status_valid CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT job_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT job_version_positive CHECK (version > 0)
);

CREATE UNIQUE INDEX job_unique_key_pending_idx ON job (unique_key)
  WHERE status = 'pending';

CREATE INDEX job_status_run_at_idx ON job (status, run_at);
