-- 0012_replanning.sql — M5 replan proposals, rejection suppression and
-- per-feedback exclusion.
--
-- Conventions follow 0007–0011: application-supplied uuid v7 primary keys,
-- owner_id on every user-data row, owner-scoped composite FKs, UTC timestamptz,
-- version > 0, forward-only with a separate down script.
--
-- `replan_proposal` stores the immutable candidate payload as jsonb and the
-- queryable trigger/reason/state columns as text for the partial unique and
-- daily-cap indexes. Approval reuses the plan-approval transaction (08 §2.4)
-- and records the produced plan version in `result_plan_version_id`; the payload
-- is never trusted in place of a fresh availability/validator re-check.
--
-- 05 §11 / 06 §7: at most one pending proposal per owner and reason, at most two
-- proposals per owner per day (counted on created_at), and a rejection suppresses
-- the same reason for 24 h through `replan_suppression`.
--
-- Forward-only; rollback lives in 0012_replanning.down.sql.

CREATE TABLE replan_proposal (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  plan_id uuid NOT NULL,
  base_plan_version_id uuid NOT NULL,
  result_plan_version_id uuid,
  trigger_kind text NOT NULL,
  reason_code text NOT NULL,
  detected_at timestamptz NOT NULL,
  availability_version integer NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT replan_proposal_trigger_valid CHECK (
    trigger_kind IN (
      'deadline_risk',
      'commitment_conflict',
      'early_completion',
      'user_request'
    )
  ),
  CONSTRAINT replan_proposal_reason_valid CHECK (
    reason_code IN (
      'deadline_slack_negative',
      'commitment_overlap',
      'early_completion_capacity',
      'dependency_change',
      'user_request'
    )
  ),
  CONSTRAINT replan_proposal_state_valid
    CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  CONSTRAINT replan_proposal_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT replan_proposal_availability_version_positive
    CHECK (availability_version > 0),
  CONSTRAINT replan_proposal_version_positive CHECK (version > 0),
  CONSTRAINT replan_proposal_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT replan_proposal_approved_has_result
    CHECK ((state = 'approved') = (result_plan_version_id IS NOT NULL)),
  CONSTRAINT replan_proposal_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT replan_proposal_plan_fk FOREIGN KEY (plan_id, owner_id)
    REFERENCES plan (id, owner_id) ON DELETE CASCADE,
  -- Both the base and the produced plan version must belong to the same plan
  -- and owner; the triple FK uses 0007's (id, plan_id, owner_id) unique key.
  CONSTRAINT replan_proposal_base_version_fk
    FOREIGN KEY (base_plan_version_id, plan_id, owner_id)
    REFERENCES plan_version (id, plan_id, owner_id) ON DELETE CASCADE,
  CONSTRAINT replan_proposal_result_version_fk
    FOREIGN KEY (result_plan_version_id, plan_id, owner_id)
    REFERENCES plan_version (id, plan_id, owner_id)
);

-- 05 §11: the same reason is proposed at most once while pending. Expired,
-- rejected, approved and superseded rows are history and may repeat.
CREATE UNIQUE INDEX replan_proposal_owner_reason_pending_unique
  ON replan_proposal (owner_id, reason_code) WHERE state = 'pending';

-- Daily-cap query (≤2 proposals/day, 05 §11) and pending/state listing.
CREATE INDEX replan_proposal_owner_created_idx
  ON replan_proposal (owner_id, created_at);
CREATE INDEX replan_proposal_owner_state_created_idx
  ON replan_proposal (owner_id, state, created_at);
CREATE INDEX replan_proposal_owner_expires_idx
  ON replan_proposal (owner_id, expires_at);

CREATE TABLE replan_suppression (
  owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  reason_code text NOT NULL,
  until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT replan_suppression_pkey PRIMARY KEY (owner_id, reason_code),
  CONSTRAINT replan_suppression_reason_valid CHECK (
    reason_code IN (
      'deadline_slack_negative',
      'commitment_overlap',
      'early_completion_capacity',
      'dependency_change',
      'user_request'
    )
  ),
  CONSTRAINT replan_suppression_until_after_created CHECK (until > created_at),
  CONSTRAINT replan_suppression_version_positive CHECK (version > 0)
);

CREATE INDEX replan_suppression_owner_until_idx
  ON replan_suppression (owner_id, until);

-- 05 §6/§10: the owner can exclude or re-include a learning sample independently
-- of the automatic `quality = outlier` classification.
ALTER TABLE estimation_feedback
  ADD COLUMN excluded boolean NOT NULL DEFAULT false;

CREATE INDEX estimation_feedback_owner_excluded_idx
  ON estimation_feedback (owner_id, excluded);
