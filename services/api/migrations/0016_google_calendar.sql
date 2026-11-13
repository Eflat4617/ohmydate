-- 0016_google_calendar.sql — CAL-03 Google Calendar sync (ADR-024).
--
-- 1. commitment_event gains source 'google' and the external reference of the
--    imported event instance (calendar id, instance event id, etag). Imported
--    rows are one row per instance (`singleEvents=true`), never repeating, and
--    the reference is unique per owner among live rows.
-- 2. google_calendar_connection: one row per owner. The refresh token is only
--    stored as an AES-256-GCM envelope (iv || tag || ciphertext) under the
--    dedicated GOOGLE_TOKEN_KEY_FILE key, with the key id; access tokens are
--    never stored. The row survives a disconnect (token removed) so settings
--    and the version stay monotonic.
-- 3. google_calendar: the owner's calendars as last listed and whether each is
--    selected for import. The app's own export calendar is never listed here.
-- 4. calendar_day_event: imported all-day events. They block no time.
-- 5. google_export_mapping: what was pushed to the "OhMyDate" calendar
--    (local kind + key -> Google event id + fingerprint of the pushed body).
--
-- Owner scoping follows 04 §1: owner_id on every table, (id, owner_id)
-- uniqueness, owner-scoped composite FKs. No token, auth code or event body is
-- stored beyond the fields listed here (titles are cut to 200 characters;
-- descriptions, attendees and locations are never stored).
--
-- Forward-only; rollback in 0016_google_calendar.down.sql.

ALTER TABLE commitment_event DROP CONSTRAINT commitment_event_source_valid;
ALTER TABLE commitment_event ADD CONSTRAINT commitment_event_source_valid
  CHECK (source IN ('manual', 'caldav', 'vikunja', 'google'));

ALTER TABLE commitment_event
  ADD COLUMN external_calendar_id text,
  ADD COLUMN external_event_id text,
  ADD COLUMN external_etag text;

ALTER TABLE commitment_event ADD CONSTRAINT commitment_event_external_ref_valid CHECK (
  (source = 'google'
    AND external_calendar_id IS NOT NULL
    AND external_event_id IS NOT NULL
    AND rrule IS NULL
    AND char_length(external_calendar_id) BETWEEN 1 AND 1024
    AND char_length(external_event_id) BETWEEN 1 AND 1024
    AND (external_etag IS NULL OR char_length(external_etag) BETWEEN 1 AND 256))
  OR
  (source <> 'google'
    AND external_calendar_id IS NULL
    AND external_event_id IS NULL
    AND external_etag IS NULL)
);

CREATE UNIQUE INDEX commitment_event_google_ref_unique
  ON commitment_event (owner_id, external_calendar_id, external_event_id)
  WHERE source = 'google' AND deleted_at IS NULL;

CREATE TABLE google_calendar_connection (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  status text NOT NULL,
  refresh_token_ciphertext bytea,
  token_key_id text,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  export_calendar_id text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT google_calendar_connection_status_valid
    CHECK (status IN ('connected', 'needs_reauth', 'disconnected')),
  -- A grant exists exactly while connected or waiting for re-consent.
  CONSTRAINT google_calendar_connection_token_matches_status CHECK (
    (status = 'disconnected') = (refresh_token_ciphertext IS NULL)
  ),
  CONSTRAINT google_calendar_connection_token_key_present CHECK (
    (refresh_token_ciphertext IS NULL) = (token_key_id IS NULL)
  ),
  CONSTRAINT google_calendar_connection_ciphertext_present
    CHECK (refresh_token_ciphertext IS NULL OR octet_length(refresh_token_ciphertext) > 28),
  CONSTRAINT google_calendar_connection_key_id_bounded
    CHECK (token_key_id IS NULL OR char_length(token_key_id) BETWEEN 1 AND 64),
  CONSTRAINT google_calendar_connection_export_calendar_bounded
    CHECK (export_calendar_id IS NULL OR char_length(export_calendar_id) BETWEEN 1 AND 1024),
  CONSTRAINT google_calendar_connection_settings_object CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT google_calendar_connection_last_error_valid CHECK (
    last_error IS NULL OR last_error IN (
      'auth_revoked', 'rate_limited', 'google_unavailable', 'google_rejected',
      'too_many_events', 'run_deadline', 'internal_error'
    )
  ),
  CONSTRAINT google_calendar_connection_version_positive CHECK (version > 0),
  CONSTRAINT google_calendar_connection_owner_unique UNIQUE (owner_id),
  CONSTRAINT google_calendar_connection_id_owner_unique UNIQUE (id, owner_id)
);

CREATE INDEX google_calendar_connection_status_idx ON google_calendar_connection (status);

CREATE TABLE google_calendar (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  google_calendar_id text NOT NULL,
  name text NOT NULL,
  access_role text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  selected boolean NOT NULL DEFAULT false,
  time_zone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT google_calendar_google_id_bounded
    CHECK (char_length(google_calendar_id) BETWEEN 1 AND 1024),
  CONSTRAINT google_calendar_name_bounded CHECK (char_length(name) <= 200),
  CONSTRAINT google_calendar_access_role_valid CHECK (
    access_role IN ('freeBusyReader', 'reader', 'writerWithoutPrivateAccess', 'writer', 'owner')
  ),
  CONSTRAINT google_calendar_time_zone_bounded
    CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 100),
  CONSTRAINT google_calendar_version_positive CHECK (version > 0),
  CONSTRAINT google_calendar_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT google_calendar_owner_google_id_unique UNIQUE (owner_id, google_calendar_id),
  CONSTRAINT google_calendar_connection_fk FOREIGN KEY (connection_id, owner_id)
    REFERENCES google_calendar_connection (id, owner_id) ON DELETE CASCADE
);

CREATE TABLE calendar_day_event (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  title text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  source text NOT NULL DEFAULT 'google',
  external_calendar_id text NOT NULL,
  external_event_id text NOT NULL,
  external_etag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT calendar_day_event_source_valid CHECK (source = 'google'),
  CONSTRAINT calendar_day_event_dates_ordered CHECK (end_date > start_date),
  CONSTRAINT calendar_day_event_title_present CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT calendar_day_event_external_bounded CHECK (
    char_length(external_calendar_id) BETWEEN 1 AND 1024
    AND char_length(external_event_id) BETWEEN 1 AND 1024
    AND (external_etag IS NULL OR char_length(external_etag) BETWEEN 1 AND 256)
  ),
  CONSTRAINT calendar_day_event_version_positive CHECK (version > 0),
  CONSTRAINT calendar_day_event_id_owner_unique UNIQUE (id, owner_id)
);

CREATE UNIQUE INDEX calendar_day_event_external_ref_unique
  ON calendar_day_event (owner_id, external_calendar_id, external_event_id)
  WHERE deleted_at IS NULL;
CREATE INDEX calendar_day_event_owner_dates_idx
  ON calendar_day_event (owner_id, start_date, end_date)
  WHERE deleted_at IS NULL;

CREATE TABLE google_export_mapping (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  local_kind text NOT NULL,
  local_key text NOT NULL,
  google_calendar_id text NOT NULL,
  google_event_id text NOT NULL,
  fingerprint text NOT NULL,
  -- End of the pushed event; null for a recurring event. A mapping whose
  -- event ended before the export window is retired without a Google delete.
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT google_export_mapping_kind_valid
    CHECK (local_kind IN ('block', 'commitment', 'summary')),
  CONSTRAINT google_export_mapping_key_bounded CHECK (char_length(local_key) BETWEEN 1 AND 64),
  CONSTRAINT google_export_mapping_calendar_bounded
    CHECK (char_length(google_calendar_id) BETWEEN 1 AND 1024),
  -- Our deterministic ids are base32hex (a-v, 0-9); a server-assigned
  -- fallback id is only bounded.
  CONSTRAINT google_export_mapping_event_id_bounded
    CHECK (char_length(google_event_id) BETWEEN 5 AND 1024),
  CONSTRAINT google_export_mapping_fingerprint_sha256 CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT google_export_mapping_version_positive CHECK (version > 0),
  CONSTRAINT google_export_mapping_id_owner_unique UNIQUE (id, owner_id),
  CONSTRAINT google_export_mapping_local_unique UNIQUE (owner_id, local_kind, local_key),
  CONSTRAINT google_export_mapping_event_unique
    UNIQUE (owner_id, google_calendar_id, google_event_id)
);
