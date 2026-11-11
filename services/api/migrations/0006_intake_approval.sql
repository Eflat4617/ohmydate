-- 0006_intake_approval.sql — exactly-once intake draft approval ledger.
--
-- A per-session approval row plus per-step rows make draft approval resumable
-- across provider failures and process crashes. The session version is the CAS
-- token; provider calls never run inside a PostgreSQL transaction.

CREATE TABLE intake_approval (
  session_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  draft_version integer NOT NULL,
  state text NOT NULL DEFAULT 'in_progress',
  lease_expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  -- ADR-020 §7: fencing token for the current approver and the start time of
  -- the most recent provider call (null until a call starts). A successor waits
  -- one provider budget after this timestamp before resolving unknown steps.
  holder_token text,
  last_call_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intake_approval_state_valid CHECK (state IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT intake_approval_draft_version_positive CHECK (draft_version > 0),
  CONSTRAINT intake_approval_session_fk FOREIGN KEY (session_id, owner_id)
    REFERENCES intake_session (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX intake_approval_owner_state_idx ON intake_approval (owner_id, state);

CREATE TABLE intake_approval_step (
  session_id uuid NOT NULL,
  step_key text NOT NULL,
  planned_task_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  task_id uuid,
  dependency_state text,
  PRIMARY KEY (session_id, step_key),
  CONSTRAINT intake_approval_step_state_valid CHECK (state IN ('pending', 'created', 'unknown')),
  CONSTRAINT intake_approval_step_session_fk FOREIGN KEY (session_id)
    REFERENCES intake_approval (session_id) ON DELETE CASCADE
);
