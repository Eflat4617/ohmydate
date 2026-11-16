-- 0003_availability.sql — available hours (08 §2.4a) and the availability
-- version that plans are approved against.
--
-- Conventions as in 0001 (docs/blueprint/15-DESKTOP-RUST-CORE.md §3): no
-- owner_id, STRICT tables, no SQL defaults for time. Wall-clock times are
-- TEXT `HH:MM` and dates TEXT `YYYY-MM-DD`; both compare in time order as
-- text. The GLOB checks keep the shape, the app (domain::LocalTime,
-- domain::CalendarDate) checks the value.

-- One row: the availability version with the zone and the limits of a day.
-- It is created by the first change of the hours or of an appointment;
-- until then the answer is version 1, the owner's zone and the default
-- limits (app::availability).
CREATE TABLE availability_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  time_zone TEXT NOT NULL CHECK (length(time_zone) > 0),
  max_daily_focus_min INTEGER NOT NULL CHECK (max_daily_focus_min BETWEEN 0 AND 100000),
  break_after_min INTEGER NOT NULL CHECK (break_after_min BETWEEN 0 AND 100000),
  break_min INTEGER NOT NULL CHECK (break_min BETWEEN 0 AND 100000),
  day_start_local TEXT NOT NULL
    CHECK (day_start_local GLOB '[01][0-9]:[0-5][0-9]' OR day_start_local GLOB '2[0-3]:[0-5][0-9]'),
  day_end_local TEXT NOT NULL
    CHECK (day_end_local GLOB '[01][0-9]:[0-5][0-9]' OR day_end_local GLOB '2[0-3]:[0-5][0-9]'
           OR day_end_local = '24:00'),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('p50', 'p90')),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 253402300799999)
) STRICT;

-- The version only moves forward: every write of this row is a change of
-- the hours or of an appointment, and a plan approved against version n
-- must be able to tell that something changed since. An update that keeps
-- or lowers the version is a defect of the caller and is refused.
CREATE TRIGGER availability_state_version_monotonic
  BEFORE UPDATE ON availability_state
  FOR EACH ROW WHEN NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'availability version must increase');
END;

-- Weekly windows. A PUT replaces all of them, so a row has no identity of
-- its own: `position` is where the PUT listed it.
CREATE TABLE availability_rule (
  position INTEGER PRIMARY KEY CHECK (position >= 0),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_local TEXT NOT NULL
    CHECK (start_local GLOB '[01][0-9]:[0-5][0-9]' OR start_local GLOB '2[0-3]:[0-5][0-9]'),
  end_local TEXT NOT NULL
    CHECK (end_local GLOB '[01][0-9]:[0-5][0-9]' OR end_local GLOB '2[0-3]:[0-5][0-9]'
           OR end_local = '24:00'),
  kind TEXT NOT NULL CHECK (kind IN ('work', 'focus')),
  CHECK (start_local < end_local)
) STRICT;

CREATE INDEX availability_rule_weekday_idx ON availability_rule (weekday, start_local);

-- Single days that differ from their weekday. Without a window an `off` day
-- is off entirely; an `extra` day always has one.
CREATE TABLE availability_exception (
  position INTEGER PRIMARY KEY CHECK (position >= 0),
  date TEXT NOT NULL
    CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('off', 'extra')),
  start_local TEXT
    CHECK (start_local GLOB '[01][0-9]:[0-5][0-9]' OR start_local GLOB '2[0-3]:[0-5][0-9]'),
  end_local TEXT
    CHECK (end_local GLOB '[01][0-9]:[0-5][0-9]' OR end_local GLOB '2[0-3]:[0-5][0-9]'
           OR end_local = '24:00'),
  CHECK (kind <> 'extra' OR (start_local IS NOT NULL AND end_local IS NOT NULL)),
  CHECK (start_local IS NULL OR end_local IS NULL OR start_local < end_local)
) STRICT;

CREATE INDEX availability_exception_date_idx ON availability_exception (date);
