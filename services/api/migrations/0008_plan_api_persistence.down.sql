-- 0008_plan_api_persistence.down.sql — rollback for 0008.
--
-- Removes only the columns/constraints added by 0008. Dropping the M3 planning
-- tables themselves remains 0007's responsibility.

ALTER TABLE user_availability_version
  DROP CONSTRAINT IF EXISTS user_availability_version_prefs_object,
  DROP CONSTRAINT IF EXISTS user_availability_version_time_zone_present,
  DROP COLUMN IF EXISTS prefs,
  DROP COLUMN IF EXISTS time_zone;
