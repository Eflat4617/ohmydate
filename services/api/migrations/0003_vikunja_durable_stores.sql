-- 0003_vikunja_durable_stores.sql — durable Vikunja adapter stores.
--
-- The in-memory stores in packages/provider-vikunja are the contract reference;
-- these tables persist the same state so cursors and mappings survive an API
-- restart (ADR-004 / ADR-016 §3). Forward-only; rollback lives in the sibling
-- .down.sql file.
--
-- owner_id is intentionally not a foreign key to "user": the adapter contract
-- suite also exercises the durable stores with synthetic owner ids. The API
-- composition root only ever creates rows for authenticated users.

-- One provider object <-> one local entity, globally (ADR-016 §1). The planner
-- owns local_version; the provider columns are a best-effort conflict cache.
CREATE TABLE vikunja_mapping (
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  external_id text NOT NULL,
  external_etag text,
  external_updated_at timestamptz,
  local_version integer NOT NULL DEFAULT 1,
  -- FU-16: same-second writes can share a Vikunja ETag; the fingerprint is the
  -- tie-breaker used by live reconciliation.
  content_fingerprint text,
  needs_reconcile boolean NOT NULL DEFAULT false,
  -- PendingCompletion jsonb (expectedVersion, at, dueAtBefore), persisted before
  -- a completion PATCH whose outcome may be unknown.
  pending_completion jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (entity_type, entity_id),
  CONSTRAINT vikunja_mapping_entity_type_valid
    CHECK (entity_type IN ('task', 'project')),
  CONSTRAINT vikunja_mapping_local_version_positive CHECK (local_version > 0),
  CONSTRAINT vikunja_mapping_external_unique UNIQUE (entity_type, external_id)
);

CREATE INDEX vikunja_mapping_owner_idx ON vikunja_mapping (owner_id);
CREATE INDEX vikunja_mapping_needs_reconcile_idx
  ON vikunja_mapping (owner_id)
  WHERE needs_reconcile;

-- Planner-only task fields that have no Vikunja representation (ADR-004).
-- owner_id is resolved from the task mapping on write so every row stays
-- owner-scoped even though the store interface keys by task id alone.
CREATE TABLE vikunja_planner_fields (
  task_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  fields jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vikunja_planner_fields_owner_idx ON vikunja_planner_fields (owner_id);

-- Append-only planner change feed. `seq` is monotonic per (owner, epoch) and is
-- owned by the store; cursors carry epoch + seq so a repository restart on the
-- same database keeps old cursors valid (ADR-016 §3).
CREATE TABLE vikunja_change_journal (
  owner_id uuid NOT NULL,
  epoch text NOT NULL,
  seq integer NOT NULL,
  task_id uuid NOT NULL,
  external_id text NOT NULL,
  version integer NOT NULL,
  deleted_at timestamptz,
  completed_occurrence_at timestamptz,
  at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, epoch, seq),
  CONSTRAINT vikunja_change_journal_seq_positive CHECK (seq > 0),
  CONSTRAINT vikunja_change_journal_version_positive CHECK (version > 0)
);

CREATE INDEX vikunja_change_journal_task_idx
  ON vikunja_change_journal (owner_id, task_id);

-- One journal generation per owner (also used as the lock row serializing
-- appends). The all-zero owner id is reserved for the database-wide epoch
-- marker so ChangeJournalStore.epoch() can stay owner-independent while every
-- owner row shares the same generation; a fresh database therefore starts with
-- a fresh epoch and every existing cursor is rejected exactly once.
CREATE TABLE vikunja_journal_epoch (
  owner_id uuid PRIMARY KEY,
  epoch text NOT NULL,
  snapshot_done boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vikunja_journal_epoch_epoch_idx ON vikunja_journal_epoch (epoch);

-- Owner -> Vikunja account mapping. Secrets are NEVER stored here: only a
-- reference such as `file:/run/secrets/vikunja-tokens.json` (a JSON object of
-- ownerId -> token) or `env:VIKUNJA_TOKEN_<OWNER_ID>`. The composition root
-- resolves the reference and keeps the cleartext token in memory only.
CREATE TABLE vikunja_owner_account (
  owner_id uuid PRIMARY KEY,
  vikunja_user_id integer NOT NULL,
  token_secret_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vikunja_owner_account_user_id_positive CHECK (vikunja_user_id > 0),
  CONSTRAINT vikunja_owner_account_token_ref_present CHECK (length(token_secret_ref) > 0)
);
