-- 0001_core.sql — owner, projects, tasks, dependencies, idempotency.
--
-- Conventions (docs/blueprint/15-DESKTOP-RUST-CORE.md §3):
--   * One data file belongs to one owner, so no table has an owner_id column.
--   * Ids are UUIDv7 text in canonical lowercase form, supplied by the app.
--   * Instants are INTEGER milliseconds since the Unix epoch (UTC).
--   * Booleans are INTEGER 0/1; enums are TEXT with a CHECK list.
--   * Optimistic concurrency: version INTEGER, starting at 1.
--   * Every table is STRICT. No SQL defaults for time: the app supplies it.
--
-- Migrations are forward-only. The runner records a checksum of this file;
-- never edit a migration that has shipped — add a new one.

CREATE TABLE owner (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  -- Exactly one row: the unique constant makes a second insert fail.
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  time_zone TEXT NOT NULL CHECK (length(time_zone) > 0),
  locale TEXT NOT NULL CHECK (length(locale) BETWEEN 2 AND 35),
  settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 253402300799999),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

CREATE TABLE project (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('inbox', 'normal')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 253402300799999),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at INTEGER CHECK (deleted_at BETWEEN 0 AND 253402300799999)
) STRICT;

-- ADR-018: at most one live Inbox.
CREATE UNIQUE INDEX project_inbox_unique ON project (kind)
  WHERE kind = 'inbox' AND deleted_at IS NULL;
CREATE INDEX project_created_idx ON project (created_at, id);

CREATE TABLE task (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT NOT NULL REFERENCES project (id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT CHECK (length(description) <= 20000),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  due_at INTEGER CHECK (due_at BETWEEN 0 AND 253402300799999),
  splittable INTEGER NOT NULL DEFAULT 0 CHECK (splittable IN (0, 1)),
  min_session_min INTEGER CHECK (min_session_min BETWEEN 1 AND 1440),
  max_session_min INTEGER CHECK (max_session_min BETWEEN 1 AND 1440),
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 253402300799999),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at INTEGER CHECK (deleted_at BETWEEN 0 AND 253402300799999),
  -- A session window is stored whole or not at all.
  CHECK ((min_session_min IS NULL) = (max_session_min IS NULL)),
  CHECK (min_session_min IS NULL OR min_session_min <= max_session_min)
) STRICT;

CREATE INDEX task_created_idx ON task (created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX task_project_idx ON task (project_id) WHERE deleted_at IS NULL;
CREATE INDEX task_due_idx ON task (due_at) WHERE deleted_at IS NULL AND due_at IS NOT NULL;

-- "task_id cannot start before depends_on_task_id finishes." `position`
-- keeps the order in which a task's dependencies were listed. The graph must
-- stay acyclic; that is checked in code (domain::assert_acyclic) inside the
-- writing transaction.
CREATE TABLE task_dependency (
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX task_dependency_reverse_idx ON task_dependency (depends_on_task_id);

-- One row per Idempotency-Key (08 §1). `completed` rows hold the response to
-- replay; `pending` rows exist only while a long-running operation (an LLM
-- call) is in flight. Synchronous mutations write the completed row in the
-- same transaction as their effect.
CREATE TABLE idempotency_record (
  key TEXT PRIMARY KEY CHECK (length(key) = 36),
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  -- Response headers to replay, one "Name: value" per line.
  response_headers TEXT,
  -- JSON text of the response body; NULL for an empty body (204).
  response_body TEXT,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK ((status = 'completed') = (response_status IS NOT NULL)),
  CHECK ((status = 'completed') = (response_headers IS NOT NULL))
) STRICT;

CREATE INDEX idempotency_record_expires_idx ON idempotency_record (expires_at);
