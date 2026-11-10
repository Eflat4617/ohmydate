-- Rollback for 0004_inbox_mapping_column.sql.
--
-- Restore the interim content_fingerprint marker for the current Inbox so a
-- rolled-back API still resolves the same project, then drop the column,
-- constraint and index. Task fingerprints were never touched by 0004.

UPDATE vikunja_mapping
   SET content_fingerprint = 'inbox'
 WHERE entity_type = 'project'
   AND is_inbox;

DROP INDEX IF EXISTS vikunja_mapping_owner_inbox_unique;

ALTER TABLE vikunja_mapping
  DROP CONSTRAINT IF EXISTS vikunja_mapping_inbox_project_only;

ALTER TABLE vikunja_mapping
  DROP COLUMN IF EXISTS is_inbox;
