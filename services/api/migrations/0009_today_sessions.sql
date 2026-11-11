-- 0009_today_sessions.sql — M4 today view, focus sessions, reviews,
-- notifications, push subscriptions and export jobs.
--
-- Conventions follow 0007/0008: application-supplied uuid v7 primary keys,
-- owner_id on every user-data row, owner-scoped composite FKs so a child can
-- never point at another owner's data, UTC timestamptz, version > 0, and
-- forward-only with a separate down script.
--
-- `push_subscription` stores only ciphertext: the browser key material is
-- encrypted by the application before insert. `key_id` names the KMS/secret
-- version used, so a rotation can re-encrypt without guessing. Plaintext key
-- columns are intentionally absent.
--
-- Forward-only; rollback lives in 0009_today_sessions.down.sql.

CREATE TABLE work_session (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  task_id uuid NOT NULL,
  block_id uuid,
  state text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  focused_sec integer NOT NULL DEFAULT 0,
  paused_sec integer NOT NULL DEFAULT 0,
  client_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT work_session_state_valid
    CHECK (state IN ('active', 'paused', 'completed', 'abandoned')),
  CONSTRAINT work_session_ended_consistent
    CHECK ((state IN ('completed', 'abandoned')) = (ended_at IS NOT NULL)),
  CONSTRAINT work_session_ended_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT work_session_focused_sec_non_negative CHECK (focused_sec >= 0),
  CONSTRAINT work_session_paused_sec_non_negative CHECK (paused_sec >= 0),
  CONSTRAINT work_session_client_id_present CHECK (char_length(client_id) BETWEEN 1 AND 200),
  CONSTRAINT work_session_version_positive CHECK (version > 0),
  CONSTRAINT work_session_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT work_session_task_fk FOREIGN KEY (task_id, owner_id)
    REFERENCES task (id, owner_id),
  CONSTRAINT work_session_block_fk FOREIGN KEY (block_id, owner_id)
    REFERENCES schedule_block (id, owner_id)
);

-- 04 §3 and 04 §6.5: at most one active work session per owner. A partial
-- unique index expresses the invariant without blocking historical rows.
CREATE UNIQUE INDEX work_session_one_active_per_owner
  ON work_session (owner_id) WHERE state = 'active';

CREATE INDEX work_session_owner_start_idx ON work_session (owner_id, started_at);
CREATE INDEX work_session_task_idx ON work_session (task_id);
CREATE INDEX work_session_block_idx ON work_session (block_id);

CREATE TABLE task_completion_review (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  session_id uuid NOT NULL,
  outcome text NOT NULL,
  reason_chips text[] NOT NULL DEFAULT '{}'::text[],
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT task_completion_review_outcome_valid
    CHECK (outcome IN ('done', 'partial', 'blocked')),
  CONSTRAINT task_completion_review_reason_chips_valid CHECK (
    reason_chips <@ ARRAY[
      'focus_lost',
      'interrupted',
      'task_larger',
      'task_smaller',
      'blocked_dependency',
      'low_energy',
      'other'
    ]::text[]
  ),
  CONSTRAINT task_completion_review_note_bounded
    CHECK (note IS NULL OR char_length(note) <= 2000),
  CONSTRAINT task_completion_review_version_positive CHECK (version > 0),
  CONSTRAINT task_completion_review_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT task_completion_review_session_unique UNIQUE (session_id, owner_id),
  CONSTRAINT task_completion_review_session_fk FOREIGN KEY (session_id, owner_id)
    REFERENCES work_session (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX task_completion_review_owner_created_idx
  ON task_completion_review (owner_id, created_at);

CREATE TABLE estimation_feedback (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  task_id uuid NOT NULL,
  estimated_p50 integer NOT NULL,
  actual_focus_min integer NOT NULL,
  quality text NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT estimation_feedback_estimated_p50_non_negative CHECK (estimated_p50 >= 0),
  CONSTRAINT estimation_feedback_actual_focus_min_non_negative CHECK (actual_focus_min >= 0),
  CONSTRAINT estimation_feedback_quality_valid
    CHECK (quality IN ('ok', 'outlier', 'excluded')),
  CONSTRAINT estimation_feedback_version_positive CHECK (version > 0),
  CONSTRAINT estimation_feedback_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT estimation_feedback_task_fk FOREIGN KEY (task_id, owner_id)
    REFERENCES task (id, owner_id)
);

-- 04 §3: learning feedback is read newest-first per owner and can be reset.
CREATE INDEX estimation_feedback_owner_created_idx
  ON estimation_feedback (owner_id, created_at);
CREATE INDEX estimation_feedback_task_idx ON estimation_feedback (task_id);

CREATE TABLE notification (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  sent_at timestamptz,
  channel text NOT NULL DEFAULT 'in_app',
  state text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT notification_kind_valid CHECK (
    kind IN (
      'due_soon',
      'deadline_risk',
      'schedule_conflict',
      'session_reminder',
      'daily_summary',
      'replan_proposal'
    )
  ),
  CONSTRAINT notification_dedupe_key_present
    CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT notification_channel_valid CHECK (channel IN ('in_app', 'push')),
  CONSTRAINT notification_state_valid
    CHECK (state IN ('scheduled', 'sent', 'dismissed', 'failed', 'expired')),
  -- A sent notification must record its delivery time. Dismissal is a later
  -- state transition, so it may keep the original sent_at as history (or be
  -- NULL when a never-sent notification was dismissed). States that were never
  -- sent must not carry a delivery timestamp.
  CONSTRAINT notification_sent_consistent CHECK (
    (state = 'sent' AND sent_at IS NOT NULL)
    OR (state IN ('scheduled', 'failed', 'expired') AND sent_at IS NULL)
    OR state = 'dismissed'
  ),
  CONSTRAINT notification_version_positive CHECK (version > 0),
  CONSTRAINT notification_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT notification_owner_dedupe_unique UNIQUE (owner_id, dedupe_key)
);

CREATE INDEX notification_owner_scheduled_idx ON notification (owner_id, scheduled_at);
CREATE INDEX notification_owner_state_idx ON notification (owner_id, state);

CREATE TABLE push_subscription (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  endpoint text NOT NULL,
  p256dh_ciphertext bytea NOT NULL,
  auth_ciphertext bytea NOT NULL,
  key_id text NOT NULL,
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT push_subscription_endpoint_https CHECK (endpoint ~ '^https://'),
  CONSTRAINT push_subscription_endpoint_bounded
    CHECK (char_length(endpoint) BETWEEN 9 AND 2048),
  CONSTRAINT push_subscription_p256dh_ciphertext_present
    CHECK (octet_length(p256dh_ciphertext) > 0),
  CONSTRAINT push_subscription_auth_ciphertext_present
    CHECK (octet_length(auth_ciphertext) > 0),
  CONSTRAINT push_subscription_key_id_present CHECK (char_length(key_id) > 0),
  CONSTRAINT push_subscription_device_label_bounded
    CHECK (device_label IS NULL OR char_length(device_label) BETWEEN 1 AND 100),
  CONSTRAINT push_subscription_version_positive CHECK (version > 0),
  CONSTRAINT push_subscription_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT push_subscription_endpoint_unique UNIQUE (endpoint)
);

CREATE INDEX push_subscription_owner_idx ON push_subscription (owner_id);

CREATE TABLE export_job (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  state text NOT NULL DEFAULT 'queued',
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  artifact_key text,
  size_bytes integer,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT export_job_state_valid
    CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  CONSTRAINT export_job_size_non_negative CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT export_job_artifact_key_bounded
    CHECK (artifact_key IS NULL OR char_length(artifact_key) BETWEEN 1 AND 500),
  CONSTRAINT export_job_failure_code_bounded
    CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 100),
  CONSTRAINT export_job_ready_has_artifact
    CHECK (state <> 'ready' OR artifact_key IS NOT NULL),
  CONSTRAINT export_job_failed_has_code
    CHECK (state <> 'failed' OR failure_code IS NOT NULL),
  CONSTRAINT export_job_version_positive CHECK (version > 0),
  CONSTRAINT export_job_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX export_job_owner_created_idx ON export_job (owner_id, created_at);
CREATE INDEX export_job_state_idx ON export_job (state);
