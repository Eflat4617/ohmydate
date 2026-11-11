-- 0008_plan_api_persistence.sql — persistence required by the M3-04 handlers.
--
-- Why this migration is needed (M3-04 packet allows 0008 only for a strict
-- requirement): Availability PUT must persist the user's availability time
-- zone and scheduling preferences. 0007 only stored the monotonic version;
-- rules and exceptions were rows, but there was no place for the wall-clock
-- zone or `prefs`. Both are columns on the existing version row, so GET and
-- PUT can read/write them in the same transaction as the bump.
--
-- Goal scope does not use project.goal_id: it resolves tasks through
-- intake_approval_step.task_id of sessions with that goal_id (M3-04R-1 H1).
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
