-- Rollback for 0002_inbox_project.sql.
--
-- The Inbox projects created by the forward migration remain as normal
-- projects; orphan tasks stay attached to them. Only the kind marker, the
-- partial unique index and the NOT NULL constraint are reverted.

ALTER TABLE task
  ALTER COLUMN project_id DROP NOT NULL;

DROP INDEX IF EXISTS project_owner_inbox_unique;

ALTER TABLE project
  DROP CONSTRAINT IF EXISTS project_kind_valid;

ALTER TABLE project
  DROP COLUMN IF EXISTS kind;
