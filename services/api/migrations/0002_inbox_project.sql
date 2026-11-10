-- 0002_inbox_project.sql — ADR-018 inbox project.
--
-- * Every project is either the owner's single Inbox or a normal project.
-- * The partial unique index guarantees one live Inbox per owner.
-- * Existing users get an Inbox and orphan tasks are attached to it before
--   task.project_id becomes NOT NULL.
--
-- The backfill uses gen_random_uuid() because there is no application process
-- in a migration; runtime UUIDs remain application-supplied UUIDv7.

ALTER TABLE project
  ADD COLUMN kind text NOT NULL DEFAULT 'normal';

ALTER TABLE project
  ADD CONSTRAINT project_kind_valid CHECK (kind IN ('inbox', 'normal'));

CREATE UNIQUE INDEX project_owner_inbox_unique
  ON project (owner_id)
  WHERE kind = 'inbox' AND deleted_at IS NULL;

INSERT INTO project (id, owner_id, title, kind)
SELECT gen_random_uuid(), u.id, 'Inbox', 'inbox'
  FROM "user" AS u
 WHERE NOT EXISTS (
   SELECT 1
     FROM project AS p
    WHERE p.owner_id = u.id
      AND p.kind = 'inbox'
      AND p.deleted_at IS NULL
 );

UPDATE task AS t
   SET project_id = p.id
  FROM project AS p
 WHERE t.project_id IS NULL
   AND p.owner_id = t.owner_id
   AND p.kind = 'inbox'
   AND p.deleted_at IS NULL;

ALTER TABLE task
  ALTER COLUMN project_id SET NOT NULL;
