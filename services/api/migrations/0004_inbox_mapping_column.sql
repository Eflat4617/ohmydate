-- 0004_inbox_mapping_column.sql — durable, single-valued Inbox marker.
--
-- FU-23R-2 reserved vikunja_mapping.content_fingerprint as an interim Inbox
-- identity, which has no at-most-one-per-owner invariant and collides with the
-- FU-16 reconcile tie-breaker. This migration moves the identity to a dedicated
-- column guarded by a partial unique index.
--
-- Forward-only; rollback lives in the sibling .down.sql file.

ALTER TABLE vikunja_mapping
  ADD COLUMN is_inbox boolean NOT NULL DEFAULT false;

-- Only project mappings can be an inbox. Task rows keep their content
-- fingerprint untouched.
ALTER TABLE vikunja_mapping
  ADD CONSTRAINT vikunja_mapping_inbox_project_only
    CHECK (NOT is_inbox OR entity_type = 'project');

-- At most one Inbox mapping per owner, including deleted rows: the adapter
-- clears the previous marker atomically when the identity moves, so a trashed
-- project can never pin the slot.
CREATE UNIQUE INDEX vikunja_mapping_owner_inbox_unique
  ON vikunja_mapping (owner_id)
  WHERE is_inbox;

-- Backfill from the interim marker. The current Vikunja default project is not
-- derivable from SQL (it lives in the provider), so pick the newest live
-- marked row per owner deterministically.
WITH chosen AS (
  SELECT DISTINCT ON (owner_id) entity_type, entity_id
    FROM vikunja_mapping
   WHERE entity_type = 'project'
     AND content_fingerprint = 'inbox'
     AND deleted_at IS NULL
   ORDER BY owner_id, updated_at DESC, created_at DESC, entity_id DESC
)
UPDATE vikunja_mapping AS m
   SET is_inbox = true
  FROM chosen
 WHERE m.entity_type = chosen.entity_type
   AND m.entity_id = chosen.entity_id;

-- Project fingerprints were only ever the interim Inbox marker; clear them so
-- the FU-16 tie-breaker stays task-only.
UPDATE vikunja_mapping
   SET content_fingerprint = NULL
 WHERE entity_type = 'project'
   AND content_fingerprint IS NOT NULL;
