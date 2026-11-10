-- 0001_init.down.sql — rollback for 0001_init.sql.
--
-- Drops only the M1 tables created by 0001_init.sql, in reverse dependency
-- order. schema_migrations is owned by the migration runner and is kept so a
-- subsequent `db:migrate` can re-apply this migration cleanly.

DROP TABLE IF EXISTS job;
DROP TABLE IF EXISTS audit_event;
DROP TABLE IF EXISTS inbox_event;
DROP TABLE IF EXISTS outbox_event;
DROP TABLE IF EXISTS idempotency_record;
DROP TABLE IF EXISTS external_provider_mapping;
DROP TABLE IF EXISTS task_dependency;
DROP TABLE IF EXISTS task;
DROP TABLE IF EXISTS project;
DROP TABLE IF EXISTS "user";
