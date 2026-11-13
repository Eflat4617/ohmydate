-- 0016_google_calendar.down.sql — rollback for 0016.
--
-- Drops the Google connection (and with it the encrypted refresh token), the
-- calendar list, imported day events and the export mappings. Imported 약속
-- (source 'google') are copies of Google data that cannot exist without their
-- external reference: their owners' availability_version is bumped (approval
-- 412 semantics, as for any commitment change) and the rows are deleted.
-- Manual commitments are untouched. Events already pushed to the "OhMyDate"
-- calendar stay in the owner's Google account.

DROP TABLE IF EXISTS google_export_mapping;
DROP TABLE IF EXISTS calendar_day_event;
DROP TABLE IF EXISTS google_calendar;
DROP TABLE IF EXISTS google_calendar_connection;

DROP INDEX IF EXISTS commitment_event_google_ref_unique;

UPDATE user_availability_version
   SET version = version + 1, updated_at = now()
 WHERE owner_id IN (SELECT DISTINCT owner_id FROM commitment_event WHERE source = 'google');

DELETE FROM commitment_event WHERE source = 'google';

ALTER TABLE commitment_event DROP CONSTRAINT IF EXISTS commitment_event_external_ref_valid;
ALTER TABLE commitment_event
  DROP COLUMN IF EXISTS external_etag,
  DROP COLUMN IF EXISTS external_event_id,
  DROP COLUMN IF EXISTS external_calendar_id;

ALTER TABLE commitment_event DROP CONSTRAINT commitment_event_source_valid;
ALTER TABLE commitment_event ADD CONSTRAINT commitment_event_source_valid
  CHECK (source IN ('manual', 'caldav', 'vikunja'));
