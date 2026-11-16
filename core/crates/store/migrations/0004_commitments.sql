-- 0004_commitments.sql — appointments (the contract's commitments) and the
-- all-day events of a connected calendar.
--
-- Conventions as in 0001 (docs/blueprint/15-DESKTOP-RUST-CORE.md §3): no
-- owner_id, STRICT tables, instants as INTEGER milliseconds, no SQL
-- defaults for time.

-- One appointment: its first (or only) occurrence and, when it repeats, the
-- rule. Occurrences are not stored; they are expanded on reading
-- (crate ohmydate-recurrence), on the wall clock of `time_zone`.
CREATE TABLE commitment_event (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  start_at INTEGER NOT NULL CHECK (start_at BETWEEN 0 AND 253402300799999),
  end_at INTEGER NOT NULL CHECK (end_at BETWEEN 0 AND 253402300799999),
  rrule TEXT CHECK (length(rrule) BETWEEN 5 AND 500),
  time_zone TEXT NOT NULL CHECK (length(time_zone) > 0),
  source TEXT NOT NULL CHECK (source IN ('manual', 'caldav', 'vikunja', 'google')),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 253402300799999),
  version INTEGER NOT NULL CHECK (version > 0),
  deleted_at INTEGER CHECK (deleted_at BETWEEN 0 AND 253402300799999),
  -- The event an imported appointment mirrors (source 'google', RC-90).
  external_calendar_id TEXT,
  external_event_id TEXT,
  external_etag TEXT,
  CHECK (end_at > start_at),
  -- An imported appointment names its event and never repeats by a rule of
  -- its own (the calendar sends each occurrence); any other appointment
  -- names no event.
  CHECK (
    (source = 'google'
      AND external_calendar_id IS NOT NULL
      AND external_event_id IS NOT NULL
      AND rrule IS NULL
      AND length(external_calendar_id) BETWEEN 1 AND 1024
      AND length(external_event_id) BETWEEN 1 AND 1024
      AND (external_etag IS NULL OR length(external_etag) BETWEEN 1 AND 256))
    OR
    (source <> 'google'
      AND external_calendar_id IS NULL
      AND external_event_id IS NULL
      AND external_etag IS NULL)
  )
) STRICT;

-- A window query is `start_at < :to AND end_at > :from` for the
-- appointments that happen once, plus every appointment with a rule (its
-- occurrences can lie anywhere after its start).
CREATE INDEX commitment_event_start_idx ON commitment_event (start_at)
  WHERE deleted_at IS NULL;
CREATE INDEX commitment_event_recurring_idx ON commitment_event (id)
  WHERE deleted_at IS NULL AND rrule IS NOT NULL;
-- One live appointment per imported event.
CREATE UNIQUE INDEX commitment_event_google_ref_unique
  ON commitment_event (external_calendar_id, external_event_id)
  WHERE source = 'google' AND deleted_at IS NULL;

-- All-day events of a connected calendar: `start_date` up to, not
-- including, `end_date`. They are shown on the calendar and block no time.
-- Nothing writes this table before the calendar sync (RC-90); it exists now
-- so the calendar screen's read has its final shape.
CREATE TABLE calendar_day_event (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  start_date TEXT NOT NULL
    CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  end_date TEXT NOT NULL
    CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  source TEXT NOT NULL CHECK (source = 'google'),
  external_calendar_id TEXT NOT NULL CHECK (length(external_calendar_id) BETWEEN 1 AND 1024),
  external_event_id TEXT NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 1024),
  external_etag TEXT CHECK (length(external_etag) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 253402300799999),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 253402300799999),
  version INTEGER NOT NULL CHECK (version > 0),
  deleted_at INTEGER CHECK (deleted_at BETWEEN 0 AND 253402300799999),
  CHECK (end_date > start_date)
) STRICT;

CREATE UNIQUE INDEX calendar_day_event_external_ref_unique
  ON calendar_day_event (external_calendar_id, external_event_id)
  WHERE deleted_at IS NULL;
CREATE INDEX calendar_day_event_dates_idx ON calendar_day_event (start_date, end_date)
  WHERE deleted_at IS NULL;
