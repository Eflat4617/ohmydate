-- 0012_replanning.down.sql — rollback for 0012.
--
-- Drops only the M5 objects added by 0012 and removes the feedback exclusion
-- column/index. Estimation feedback rows themselves stay (0009 owns them).

DROP TABLE IF EXISTS replan_suppression;
DROP TABLE IF EXISTS replan_proposal;

DROP INDEX IF EXISTS estimation_feedback_owner_excluded_idx;
ALTER TABLE estimation_feedback DROP COLUMN IF EXISTS excluded;
