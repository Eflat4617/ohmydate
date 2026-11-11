-- 0010_daily_storage.down.sql — rollback for 0010.
--
-- Removes only M4-02R storage; 0009 objects are untouched.

ALTER TABLE export_job
  DROP CONSTRAINT IF EXISTS export_job_content_type_bounded,
  DROP CONSTRAINT IF EXISTS export_job_size_max,
  DROP COLUMN IF EXISTS content_type,
  DROP COLUMN IF EXISTS artifact;

DROP TABLE IF EXISTS today_proposal;
