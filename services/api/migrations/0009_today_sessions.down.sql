-- 0009_today_sessions.down.sql — rollback for 0009.
--
-- Drops only the M4 tables added by 0009; 0007/0008 objects are untouched.
-- Children are dropped before parents so the down script works with seeded
-- rows and with FK checks enabled.

DROP TABLE IF EXISTS task_completion_review;
DROP TABLE IF EXISTS estimation_feedback;
DROP TABLE IF EXISTS work_session;
DROP TABLE IF EXISTS notification;
DROP TABLE IF EXISTS push_subscription;
DROP TABLE IF EXISTS export_job;
