-- 0007_planning_core.down.sql — rollback for 0007_planning_core.sql.
--
-- Drops only the M3 tables created by 0007, in reverse dependency order. The
-- btree_gist extension is shared and intentionally left installed; the M1/M2
-- tables are untouched.

ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_current_version_fk;

DROP TABLE IF EXISTS schedule_approval;
DROP TABLE IF EXISTS schedule_block;
DROP TABLE IF EXISTS plan_version;
DROP TABLE IF EXISTS plan_candidate;
DROP TABLE IF EXISTS plan;
DROP TABLE IF EXISTS user_availability_version;
DROP FUNCTION IF EXISTS user_availability_version_monotonic();
DROP TABLE IF EXISTS availability_exception;
DROP TABLE IF EXISTS availability_rule;
DROP TABLE IF EXISTS commitment_event;
