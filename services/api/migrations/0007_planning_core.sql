-- 0007_planning_core.sql — M3 availability, commitments and plan approval tables.
--
-- Conventions (04 §1): application-supplied uuid v7 primary keys, owner_id on
-- every user-data table, UTC timestamptz timestamps, version > 0, soft delete
-- only where the table specification lists it. All parent references are
-- owner-scoped composite FKs so a row can never point at another owner's data.
--
-- `btree_gist` is installed in `public` and its uuid operator class is
-- schema-qualified in the EXCLUDE constraint because the migration runner sets
-- `search_path` to the target schema (tests use one schema per suite).
--
-- Privilege note: CREATE EXTENSION requires a superuser or a role holding
-- trusted-extension rights. Deployments whose application role is not a
-- superuser must bootstrap btree_gist once (as a superuser or database owner)
-- before applying 0007; this migration then finds it in public and only
-- schema-qualifies the operator class. If the extension is already installed,
-- the CREATE EXTENSION IF NOT EXISTS step is a no-op.
--
-- Forward-only; rollback lives in 0007_planning_core.down.sql.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE commitment_event (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  title text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  rrule text,
  time_zone text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT commitment_event_source_valid
    CHECK (source IN ('manual', 'caldav', 'vikunja')),
  CONSTRAINT commitment_event_interval_valid CHECK (end_at > start_at),
  CONSTRAINT commitment_event_rrule_bounded
    CHECK (rrule IS NULL OR char_length(rrule) BETWEEN 5 AND 500),
  CONSTRAINT commitment_event_title_present CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT commitment_event_version_positive CHECK (version > 0),
  CONSTRAINT commitment_event_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX commitment_event_owner_start_idx ON commitment_event (owner_id, start_at);
CREATE INDEX commitment_event_range_idx ON commitment_event USING gist (tstzrange(start_at, end_at));

CREATE TABLE availability_rule (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  weekday integer NOT NULL,
  start_local text NOT NULL,
  end_local text NOT NULL,
  time_zone text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT availability_rule_weekday_valid CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT availability_rule_start_local_valid
    CHECK (start_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT availability_rule_end_local_valid
    CHECK (end_local ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'),
  CONSTRAINT availability_rule_kind_valid CHECK (kind IN ('work', 'focus', 'rest')),
  CONSTRAINT availability_rule_window_ordered CHECK (start_local < end_local),
  CONSTRAINT availability_rule_version_positive CHECK (version > 0),
  CONSTRAINT availability_rule_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX availability_rule_owner_weekday_idx ON availability_rule (owner_id, weekday);

CREATE TABLE availability_exception (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  date date NOT NULL,
  kind text NOT NULL,
  start_local text,
  end_local text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT availability_exception_kind_valid CHECK (kind IN ('off', 'extra')),
  CONSTRAINT availability_exception_extra_window
    CHECK (kind <> 'extra' OR (start_local IS NOT NULL AND end_local IS NOT NULL)),
  CONSTRAINT availability_exception_start_local_valid
    CHECK (start_local IS NULL OR start_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT availability_exception_end_local_valid
    CHECK (end_local IS NULL OR end_local ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'),
  CONSTRAINT availability_exception_window_ordered
    CHECK (start_local IS NULL OR end_local IS NULL OR start_local < end_local),
  CONSTRAINT availability_exception_version_positive CHECK (version > 0),
  CONSTRAINT availability_exception_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX availability_exception_owner_date_idx ON availability_exception (owner_id, date);

-- User-wide monotonic availability version. Every availability/commitment write
-- increments it; plan approval compares `If-Match: W/"availability:<n>"`.
CREATE TABLE user_availability_version (
  owner_id uuid PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_availability_version_positive CHECK (version > 0)
);

CREATE FUNCTION user_availability_version_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'availability_version must increase monotonically'
      USING ERRCODE = '23514',
            CONSTRAINT = 'user_availability_version_monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_availability_version_monotonic
  BEFORE UPDATE ON user_availability_version
  FOR EACH ROW EXECUTE FUNCTION user_availability_version_monotonic();

CREATE TABLE plan (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  scope jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  availability_version integer NOT NULL DEFAULT 1,
  horizon_start timestamptz NOT NULL,
  horizon_end timestamptz NOT NULL,
  time_zone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT plan_scope_object CHECK (jsonb_typeof(scope) = 'object'),
  CONSTRAINT plan_status_valid CHECK (status IN ('draft', 'active', 'superseded')),
  CONSTRAINT plan_availability_version_positive CHECK (availability_version > 0),
  CONSTRAINT plan_horizon_ordered CHECK (horizon_end > horizon_start),
  CONSTRAINT plan_time_zone_present CHECK (char_length(time_zone) > 0),
  CONSTRAINT plan_version_positive CHECK (version > 0),
  CONSTRAINT plan_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX plan_owner_status_idx ON plan (owner_id, status);

CREATE TABLE plan_candidate (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  plan_id uuid NOT NULL,
  policy text NOT NULL,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation jsonb NOT NULL DEFAULT '[]'::jsonb,
  diversity_note text,
  feasible boolean NOT NULL,
  deficit_min integer NOT NULL DEFAULT 0,
  input_hash text NOT NULL,
  generator_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT plan_candidate_policy_valid
    CHECK (policy IN ('front_loaded', 'balanced', 'focus_blocked')),
  CONSTRAINT plan_candidate_blocks_array CHECK (jsonb_typeof(blocks) = 'array'),
  CONSTRAINT plan_candidate_explanation_array CHECK (jsonb_typeof(explanation) = 'array'),
  CONSTRAINT plan_candidate_deficit_non_negative CHECK (deficit_min >= 0),
  CONSTRAINT plan_candidate_version_positive CHECK (version > 0),
  CONSTRAINT plan_candidate_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT plan_candidate_plan_fk FOREIGN KEY (plan_id, owner_id)
    REFERENCES plan (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX plan_candidate_plan_idx ON plan_candidate (plan_id);

CREATE TABLE plan_version (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  plan_id uuid NOT NULL,
  seq integer NOT NULL,
  candidate_id uuid,
  reason text,
  created_by text NOT NULL DEFAULT 'user',
  availability_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT plan_version_seq_positive CHECK (seq > 0),
  CONSTRAINT plan_version_created_by_valid CHECK (created_by IN ('user', 'replan')),
  CONSTRAINT plan_version_availability_version_positive CHECK (availability_version > 0),
  CONSTRAINT plan_version_version_positive CHECK (version > 0),
  CONSTRAINT plan_version_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT plan_version_id_plan_owner_unique UNIQUE (id, plan_id, owner_id),
  CONSTRAINT plan_version_plan_seq_unique UNIQUE (plan_id, seq),
  CONSTRAINT plan_version_plan_fk FOREIGN KEY (plan_id, owner_id)
    REFERENCES plan (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX plan_version_plan_idx ON plan_version (plan_id);
CREATE INDEX plan_version_candidate_idx ON plan_version (candidate_id);

-- plan.current_version_id is a composite FK that pins the version to the same
-- plan AND owner; (id, owner_id) alone would let one of the owner's plans point
-- at a sibling plan's version. DEFERRABLE lets approval insert the version and
-- update the plan in either order inside one transaction. Candidate deletion
-- (30-day retention) must not remove approved history, so
-- plan_version.candidate_id intentionally has no FK.
ALTER TABLE plan ADD CONSTRAINT plan_current_version_fk
  FOREIGN KEY (current_version_id, id, owner_id)
  REFERENCES plan_version (id, plan_id, owner_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE schedule_block (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  plan_version_id uuid NOT NULL,
  task_id uuid NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT schedule_block_interval_valid CHECK (end_at > start_at),
  CONSTRAINT schedule_block_status_valid
    CHECK (status IN ('planned', 'done', 'skipped', 'moved', 'superseded')),
  CONSTRAINT schedule_block_version_positive CHECK (version > 0),
  CONSTRAINT schedule_block_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT schedule_block_plan_version_fk FOREIGN KEY (plan_version_id, owner_id)
    REFERENCES plan_version (id, owner_id) ON DELETE CASCADE,
  CONSTRAINT schedule_block_task_fk FOREIGN KEY (task_id, owner_id)
    REFERENCES task (id, owner_id),
  -- Active means not superseded. Superseded blocks are history and may overlap
  -- the replacement version.
  CONSTRAINT schedule_block_no_overlap EXCLUDE USING gist (
    owner_id public.gist_uuid_ops WITH =,
    tstzrange(start_at, end_at) WITH &&
  ) WHERE (status <> 'superseded')
);

CREATE INDEX schedule_block_owner_start_idx ON schedule_block (owner_id, start_at);
CREATE INDEX schedule_block_plan_version_idx ON schedule_block (plan_version_id);
CREATE INDEX schedule_block_task_idx ON schedule_block (task_id);

CREATE TABLE schedule_approval (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  plan_version_id uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL,
  availability_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT schedule_approval_idempotency_key_present CHECK (char_length(idempotency_key) > 0),
  CONSTRAINT schedule_approval_availability_version_positive CHECK (availability_version > 0),
  CONSTRAINT schedule_approval_version_positive CHECK (version > 0),
  CONSTRAINT schedule_approval_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT schedule_approval_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT schedule_approval_plan_version_fk FOREIGN KEY (plan_version_id, owner_id)
    REFERENCES plan_version (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX schedule_approval_plan_version_idx ON schedule_approval (plan_version_id);
