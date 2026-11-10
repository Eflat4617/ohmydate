-- 0005_intake_estimation_agent.sql — M2 intake, estimation and agent audit tables.
--
-- Conventions (04 §1): application-supplied uuid v7 primary keys, owner_id on
-- every user-data table, UTC timestamptz timestamps, version > 0, and soft
-- delete only where the table specification lists it.
--
-- Agent runs store metadata ONLY (05 §12): prompt/response text never lands in
-- this schema. Forward-only; rollback lives in 0005_intake_estimation_agent.down.sql.

CREATE TABLE goal (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  title text NOT NULL,
  target_date date,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT goal_status_valid CHECK (status IN ('active', 'completed', 'archived')),
  CONSTRAINT goal_version_positive CHECK (version > 0),
  CONSTRAINT goal_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX goal_owner_status_idx ON goal (owner_id, status);

CREATE TABLE task_template (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  name text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'user',
  confidence real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT task_template_source_valid CHECK (source IN ('user', 'system')),
  CONSTRAINT task_template_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT task_template_version_positive CHECK (version > 0),
  CONSTRAINT task_template_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX task_template_owner_idx ON task_template (owner_id);

CREATE TABLE task_type_fingerprint (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  template_id uuid NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  keywords tsvector NOT NULL DEFAULT ''::tsvector,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  false_positive_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT task_type_fingerprint_false_positive_non_negative CHECK (false_positive_count >= 0),
  CONSTRAINT task_type_fingerprint_version_positive CHECK (version > 0),
  CONSTRAINT task_type_fingerprint_template_fk FOREIGN KEY (template_id, owner_id)
    REFERENCES task_template (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX task_type_fingerprint_keywords_gin
  ON task_type_fingerprint USING gin (keywords);
CREATE INDEX task_type_fingerprint_template_idx ON task_type_fingerprint (template_id);

CREATE TABLE intake_session (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  goal_id uuid,
  state text NOT NULL DEFAULT 'created',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_type jsonb,
  template_id uuid,
  round integer NOT NULL DEFAULT 1,
  manual boolean NOT NULL DEFAULT false,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT intake_session_state_valid CHECK (state IN (
    'created',
    'type_detection',
    'clarification',
    'needs_input',
    'decomposition',
    'feasibility_check',
    'plan_proposals',
    'awaiting_approval',
    'scheduled',
    'cancelled',
    'failed'
  )),
  CONSTRAINT intake_session_round_positive CHECK (round > 0),
  CONSTRAINT intake_session_version_positive CHECK (version > 0),
  CONSTRAINT intake_session_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT intake_session_goal_fk FOREIGN KEY (goal_id, owner_id)
    REFERENCES goal (id, owner_id),
  CONSTRAINT intake_session_template_fk FOREIGN KEY (template_id, owner_id)
    REFERENCES task_template (id, owner_id)
);

CREATE INDEX intake_session_owner_state_idx ON intake_session (owner_id, state);

CREATE TABLE intake_answer (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  session_id uuid NOT NULL,
  question_key text NOT NULL,
  question_text text NOT NULL,
  answer jsonb,
  skipped boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT intake_answer_version_positive CHECK (version > 0),
  CONSTRAINT intake_answer_session_fk FOREIGN KEY (session_id, owner_id)
    REFERENCES intake_session (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX intake_answer_session_idx ON intake_answer (session_id);

CREATE TABLE estimate (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  task_id uuid NOT NULL,
  p50_min integer NOT NULL,
  p90_min integer NOT NULL,
  method text NOT NULL,
  confidence real NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT estimate_p50_non_negative CHECK (p50_min >= 0),
  CONSTRAINT estimate_p90_not_below_p50 CHECK (p90_min >= p50_min),
  CONSTRAINT estimate_method_valid CHECK (method IN ('prior', 'template', 'personal', 'llm')),
  CONSTRAINT estimate_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT estimate_version_positive CHECK (version > 0),
  CONSTRAINT estimate_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT estimate_task_fk FOREIGN KEY (task_id, owner_id)
    REFERENCES task (id, owner_id) ON DELETE CASCADE
);

-- At most one current estimate per task; history rows keep is_current = false.
CREATE UNIQUE INDEX estimate_current_per_task_idx ON estimate (task_id)
  WHERE is_current;
CREATE INDEX estimate_task_current_idx ON estimate (task_id, is_current);

CREATE TABLE estimate_evidence (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  estimate_id uuid NOT NULL,
  kind text NOT NULL,
  ref text,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT estimate_evidence_version_positive CHECK (version > 0),
  CONSTRAINT estimate_evidence_estimate_fk FOREIGN KEY (estimate_id, owner_id)
    REFERENCES estimate (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX estimate_evidence_estimate_idx ON estimate_evidence (estimate_id);

CREATE TABLE agent_run (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  purpose text NOT NULL,
  prompt_id_version text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  redaction_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT agent_run_tokens_in_non_negative CHECK (tokens_in >= 0),
  CONSTRAINT agent_run_tokens_out_non_negative CHECK (tokens_out >= 0),
  CONSTRAINT agent_run_cost_non_negative CHECK (cost_usd >= 0),
  CONSTRAINT agent_run_latency_non_negative CHECK (latency_ms >= 0),
  CONSTRAINT agent_run_status_valid CHECK (status IN ('pending', 'succeeded', 'failed', 'budget_exceeded')),
  CONSTRAINT agent_run_version_positive CHECK (version > 0),
  CONSTRAINT agent_run_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX agent_run_owner_created_idx ON agent_run (owner_id, created_at);

CREATE TABLE agent_proposal (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  run_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  schema_ok boolean NOT NULL DEFAULT false,
  policy_ok boolean NOT NULL DEFAULT false,
  constraint_ok boolean NOT NULL DEFAULT false,
  decision text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT agent_proposal_decision_valid
    CHECK (decision IN ('pending', 'approved', 'rejected', 'expired')),
  CONSTRAINT agent_proposal_version_positive CHECK (version > 0),
  CONSTRAINT agent_proposal_run_fk FOREIGN KEY (run_id, owner_id)
    REFERENCES agent_run (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX agent_proposal_decision_idx ON agent_proposal (decision);
CREATE INDEX agent_proposal_run_idx ON agent_proposal (run_id);
