-- 0008_plan_api_persistence.sql — persistence required by the M3-04 handlers.
--
-- Why this migration is needed (M3-04 packet allows 0008 only for a strict
-- requirement):
--   1. Availability PUT must persist the user's availability time zone and
--      scheduling preferences. 0007 only stored the monotonic version; rules
--      and exceptions were rows, but there was no place for the wall-clock
--      zone or `prefs`. Both are columns on the existing version row, so GET
--      and PUT can read/write them in the same transaction as the bump.
--   2. `POST /plans` accepts `scope.goalId`. 04 §2/§3 describes `project.goal_id`
--      but 0001/0005 never created it, so a goal-scoped plan has no way to
--      resolve its tasks. The index is partial because most projects are not
--      attached to a goal.
--
-- Forward-only; rollback lives in 0008_plan_api_persistence.down.sql.

ALTER TABLE user_availability_version
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN prefs jsonb NOT NULL DEFAULT
    '{"maxDailyFocusMin":240,"breakAfterMin":60,"breakMin":15,"dayStartLocal":"08:00","dayEndLocal":"18:00","riskLevel":"p50"}'::jsonb;

ALTER TABLE user_availability_version
  ADD CONSTRAINT user_availability_version_time_zone_present
    CHECK (char_length(time_zone) > 0),
  ADD CONSTRAINT user_availability_version_prefs_object
    CHECK (jsonb_typeof(prefs) = 'object');

ALTER TABLE project ADD COLUMN goal_id uuid;

ALTER TABLE project
  ADD CONSTRAINT project_goal_fk FOREIGN KEY (goal_id, owner_id)
    REFERENCES goal (id, owner_id);

CREATE INDEX project_owner_goal_idx ON project (owner_id, goal_id)
  WHERE goal_id IS NOT NULL;
