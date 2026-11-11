-- 0013_context_documents.sql — M6 notes (ContextDocument), links and AI usage audit.
--
-- Conventions follow 0007–0012: application-supplied uuid v7 primary keys,
-- owner_id on every user-data row, owner-scoped composite FKs, UTC timestamptz,
-- version > 0, soft delete via deleted_at, forward-only with a separate down
-- script.
--
-- `context_document` is planner-owned Markdown (07 §7): it is never synced to
-- the task provider. `body_md` is the raw Markdown; the API never renders HTML.
-- `llm_allowed` is an explicit per-note opt-in for AI context and defaults to
-- false (05 §12). `source = 'task_description'` marks the one-time "promote the
-- task description to a note" copy; at most one live promoted note per task.
--
-- `body_tsv` uses the built-in `simple` text-search configuration on purpose:
-- PostgreSQL ships no Korean stemmer/dictionary, and `simple` lower-cases and
-- splits on the default parser without language-specific stemming, so Korean
-- and English tokens are indexed verbatim. The API searches with per-token
-- prefix queries (`token:*`), which also matches Korean words with attached
-- particles (e.g. 논문 -> 논문을). Infix/morphological matches are not supported.
--
-- `document_link` targets are polymorphic (goal | project | task). Tasks and
-- projects may live in the task provider, so the target is validated by the
-- application against the owner's repositories (404 otherwise), not by an FK.
-- The link row itself is owner-scoped through the document's (id, owner_id).
--
-- `note_ai_usage` records which note sections were sent to which agent run:
-- ids, hashes and byte counts only — never note text (05 §12).
--
-- Forward-only; rollback lives in 0013_context_documents.down.sql.

CREATE TABLE context_document (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  title text NOT NULL,
  body_md text NOT NULL DEFAULT '',
  body_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, title), 'A')
      || setweight(to_tsvector('simple'::regconfig, body_md), 'B')
  ) STORED,
  sensitivity text NOT NULL DEFAULT 'P2',
  llm_allowed boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual',
  source_task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT context_document_title_length
    CHECK (char_length(title) BETWEEN 1 AND 200 AND btrim(title) <> ''),
  -- 65 536 code points (the contract limit) never exceed 262 144 UTF-8 bytes.
  CONSTRAINT context_document_body_size CHECK (octet_length(body_md) <= 262144),
  CONSTRAINT context_document_sensitivity_valid CHECK (sensitivity IN ('P1', 'P2')),
  CONSTRAINT context_document_source_valid CHECK (source IN ('manual', 'task_description')),
  CONSTRAINT context_document_source_task_consistent
    CHECK ((source = 'task_description') = (source_task_id IS NOT NULL)),
  CONSTRAINT context_document_version_positive CHECK (version > 0),
  CONSTRAINT context_document_deleted_after_created
    CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT context_document_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX context_document_body_tsv_idx ON context_document USING gin (body_tsv);

-- Default listing (newest first) over live notes.
CREATE INDEX context_document_owner_updated_idx
  ON context_document (owner_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- 07 §7: a task description is promoted at most once while the copy is live.
CREATE UNIQUE INDEX context_document_promoted_task_unique
  ON context_document (owner_id, source_task_id)
  WHERE source = 'task_description' AND deleted_at IS NULL;

CREATE TABLE document_link (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  document_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT document_link_target_kind_valid
    CHECK (target_kind IN ('goal', 'project', 'task')),
  CONSTRAINT document_link_version_positive CHECK (version > 0),
  CONSTRAINT document_link_unique UNIQUE (owner_id, document_id, target_kind, target_id),
  CONSTRAINT document_link_document_fk FOREIGN KEY (document_id, owner_id)
    REFERENCES context_document (id, owner_id) ON DELETE CASCADE
);

-- Context assembly: "notes linked to this goal/project/task".
CREATE INDEX document_link_owner_target_idx
  ON document_link (owner_id, target_kind, target_id);

CREATE TABLE note_ai_usage (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  document_id uuid NOT NULL,
  agent_run_id uuid NOT NULL,
  purpose text NOT NULL,
  document_version integer NOT NULL,
  body_hash text NOT NULL,
  section_hashes text[] NOT NULL,
  sent_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT note_ai_usage_purpose_format CHECK (purpose ~ '^[a-z_]{1,64}$'),
  CONSTRAINT note_ai_usage_document_version_positive CHECK (document_version > 0),
  CONSTRAINT note_ai_usage_body_hash_format CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  -- Hashes only: 1..64 non-NULL entries of exactly 16 lower-case hex characters.
  -- CHECK cannot iterate elements, so the joined string must match n groups AND
  -- have length 17n - 1: an element containing ',' would need an empty sibling,
  -- which yields a leading/trailing/double comma and fails the pattern.
  CONSTRAINT note_ai_usage_section_hashes_format CHECK (
    cardinality(section_hashes) BETWEEN 1 AND 64
    AND array_position(section_hashes, NULL) IS NULL
    AND array_to_string(section_hashes, ',') ~ '^[0-9a-f]{16}(,[0-9a-f]{16})*$'
    AND char_length(array_to_string(section_hashes, ',')) = 17 * cardinality(section_hashes) - 1
  ),
  CONSTRAINT note_ai_usage_sent_bytes_non_negative CHECK (sent_bytes >= 0),
  CONSTRAINT note_ai_usage_version_positive CHECK (version > 0),
  CONSTRAINT note_ai_usage_run_document_unique UNIQUE (agent_run_id, document_id),
  CONSTRAINT note_ai_usage_document_fk FOREIGN KEY (document_id, owner_id)
    REFERENCES context_document (id, owner_id) ON DELETE CASCADE,
  CONSTRAINT note_ai_usage_run_fk FOREIGN KEY (agent_run_id, owner_id)
    REFERENCES agent_run (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX note_ai_usage_owner_document_created_idx
  ON note_ai_usage (owner_id, document_id, created_at DESC, id DESC);
