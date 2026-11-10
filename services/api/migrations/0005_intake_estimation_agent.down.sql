-- 0005_intake_estimation_agent.down.sql — rollback for 0005_intake_estimation_agent.sql.
--
-- Drops only the M2 tables created by 0005, in reverse dependency order.
-- Existing M1 tables are untouched.

DROP TABLE IF EXISTS agent_proposal;
DROP TABLE IF EXISTS agent_run;
DROP TABLE IF EXISTS estimate_evidence;
DROP TABLE IF EXISTS estimate;
DROP TABLE IF EXISTS intake_answer;
DROP TABLE IF EXISTS intake_session;
DROP TABLE IF EXISTS task_type_fingerprint;
DROP TABLE IF EXISTS task_template;
DROP TABLE IF EXISTS goal;
