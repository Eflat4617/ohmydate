-- 0010_daily_storage.sql — M4-02R: durable Today proposal payloads and
-- export artifacts.
--
-- Why 0010 is required: storing proposal JSON in job.unique_key put large
-- payloads into an indexed deduplication key, and export bytes lived in the
-- same unindexed text column with no expiry enforcement. This migration adds a
-- dedicated owner-scoped proposal table and bytea artifact storage bounded to
-- 50 MB. `job.unique_key` stays a bounded identifier/hash only.
--
-- Forward-only; rollback lives in 0010_daily_storage.down.sql.

CREATE TABLE today_proposal (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  base_plan_version_id uuid NOT NULL,
  availability_version integer NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT today_proposal_state_valid
    CHECK (state IN ('pending', 'approved', 'expired')),
  CONSTRAINT today_proposal_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT today_proposal_availability_version_positive
    CHECK (availability_version > 0),
  CONSTRAINT today_proposal_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT today_proposal_plan_version_fk
    FOREIGN KEY (base_plan_version_id, owner_id)
    REFERENCES plan_version (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX today_proposal_owner_created_idx
  ON today_proposal (owner_id, created_at);
CREATE INDEX today_proposal_owner_expires_idx
  ON today_proposal (owner_id, expires_at);

ALTER TABLE export_job
  ADD COLUMN artifact bytea,
  ADD COLUMN content_type text;

ALTER TABLE export_job
  ADD CONSTRAINT export_job_size_max
    CHECK (size_bytes IS NULL OR size_bytes <= 52_428_800),
  ADD CONSTRAINT export_job_content_type_bounded
    CHECK (content_type IS NULL OR char_length(content_type) BETWEEN 1 AND 200);
