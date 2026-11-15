//! Scheduler time: a port of `packages/scheduler/src/time.ts`.
//!
//! Instants are epoch milliseconds (`i64`). Time zone rules come from the
//! IANA database compiled into `jiff`; the TypeScript reference reads the one
//! shipped with Node. The oracle packs record the reference's partitions, so
//! a database difference shows up as a failing partition, not as an
//! unexplained scheduling difference.
//!
//! What the reference gets from `Temporal` is reproduced here:
//!
//! * [`parse_instant`] and [`instant_to_utc`] are `Temporal.Instant.from`
//!   and `toString`;
//! * [`Zone`] is a time zone id as `Temporal` accepts it — an IANA name in
//!   any letter case, a `±HH[:MM]` offset, or an ISO date-time that names one;
//! * [`Zone::partition`] is the ADR-017 split into single-date pieces;
//! * [`LocalDate`] prints like `Temporal.PlainDate.toString`.
//!
//! Supported range: `jiff` covers the years −9999…9999, the reference
//! ±275760. An instant outside `jiff`'s range is reported as invalid here.

use std::fmt;

use jiff::Timestamp;
use jiff::fmt::temporal::{Pieces, PiecesOffset, TimeZoneAnnotationKind};
use jiff::tz::TimeZone;

pub const GRID_MINUTES: i64 = 5;
pub const MINUTE_MS: i64 = 60 * 1000;
pub const GRID_MS: i64 = GRID_MINUTES * MINUTE_MS;
pub const DAY_MS: i64 = 24 * 60 * MINUTE_MS;

/// Hard cap of the transition walk. A range holding this many offset
/// transitions is a programming error (about two happen per year), so the
/// walk stops with [`TimeError::TooManyTransitions`] instead of going on.
pub const MAX_TRANSITIONS: usize = 4096;

/// Why a time value could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeError {
    /// Not an ISO-8601 instant with an offset.
    InvalidInstant,
    /// The instant has a fraction finer than one millisecond.
    SubMillisecond,
    /// The time zone id is unknown.
    UnknownTimeZone,
    /// [`MAX_TRANSITIONS`] or more offset transitions in one range.
    TooManyTransitions,
    /// Not an `HH:mm` local clock value.
    InvalidClock,
}

impl fmt::Display for TimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            TimeError::InvalidInstant => "not a valid instant",
            TimeError::SubMillisecond => "the instant has sub-millisecond precision",
            TimeError::UnknownTimeZone => "unknown time zone",
            TimeError::TooManyTransitions => "the time zone transition walk exceeded its limit",
            TimeError::InvalidClock => "not a valid local clock value",
        })
    }
}

impl std::error::Error for TimeError {}

/// Epoch milliseconds of an ISO-8601 instant (`parseInstant`). Instants finer
/// than a millisecond are rejected rather than rounded.
pub fn parse_instant(text: &str) -> Result<i64, TimeError> {
    let timestamp: Timestamp = text.parse().map_err(|_| TimeError::InvalidInstant)?;
    if timestamp.subsec_nanosecond() % 1_000_000 != 0 {
        return Err(TimeError::SubMillisecond);
    }
    Ok(timestamp.as_millisecond())
}

/// Epoch nanoseconds of an ISO-8601 instant (`instantNanoseconds`). The
/// validators use it to tell a sub-millisecond instant from an unparsable
/// one and to test grid alignment before any rounding.
pub fn instant_nanoseconds(text: &str) -> Result<i128, TimeError> {
    let timestamp: Timestamp = text.parse().map_err(|_| TimeError::InvalidInstant)?;
    Ok(timestamp.as_nanosecond())
}

/// The UTC text of an instant as `Temporal.Instant.prototype.toString`
/// prints it (`instantToUtc`): seconds always, fraction only when non-zero
/// and without trailing zeros.
pub fn instant_to_utc(epoch_ms: i64) -> Result<String, TimeError> {
    Timestamp::from_millisecond(epoch_ms)
        .map(|timestamp| timestamp.to_string())
        .map_err(|_| TimeError::InvalidInstant)
}

/// A local calendar date, counted in days from 1970-01-01.
///
/// The reference keys its per-day maps by the `YYYY-MM-DD` text of
/// `Temporal.PlainDate`; the day number identifies the same date without
/// allocating, and [`fmt::Display`] prints that text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LocalDate(i64);

impl LocalDate {
    /// The date `days` after 1970-01-01 (before it when negative).
    #[must_use]
    pub const fn from_days(days: i64) -> Self {
        Self(days)
    }

    /// Days since 1970-01-01.
    #[must_use]
    pub const fn days(self) -> i64 {
        self.0
    }

    /// ISO weekday: Monday = 1 … Sunday = 7.
    #[must_use]
    pub fn weekday(self) -> u8 {
        // 1970-01-01 was a Thursday (ISO weekday 4).
        u8::try_from((self.0 + 3).rem_euclid(7) + 1).unwrap_or(1)
    }

    /// Year, month (1–12) and day (1–31).
    #[must_use]
    pub fn civil(self) -> (i64, u8, u8) {
        let shifted = self.0 + 719_468;
        let era = shifted.div_euclid(146_097);
        let day_of_era = shifted.rem_euclid(146_097);
        let year_of_era =
            (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let shifted_month = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
        let month = if shifted_month < 10 {
            shifted_month + 3
        } else {
            shifted_month - 9
        };
        let year = year_of_era + era * 400 + i64::from(month <= 2);
        (
            year,
            u8::try_from(month).unwrap_or(1),
            u8::try_from(day).unwrap_or(1),
        )
    }

    fn from_civil(year: i64, month: i64, day: i64) -> Self {
        let shifted_year = if month <= 2 { year - 1 } else { year };
        let era = shifted_year.div_euclid(400);
        let year_of_era = shifted_year.rem_euclid(400);
        let shifted_month = if month > 2 { month - 3 } else { month + 9 };
        let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        Self(era * 146_097 + day_of_era - 719_468)
    }

    /// The date whose printed form is exactly `text`, if there is one.
    ///
    /// The reference compares date strings, so `2026-11-13` names a date but
    /// `20261113` or `2026-11-13T00:00` (which `Temporal.PlainDate.from`
    /// would also accept) never equals a date it prints.
    #[must_use]
    pub fn from_printed(text: &str) -> Option<Self> {
        let (year_text, rest) = match text.as_bytes().first()? {
            b'+' | b'-' => text.split_at_checked(7)?,
            _ => text.split_at_checked(4)?,
        };
        let bytes = rest.as_bytes();
        if bytes.len() != 6 || bytes[0] != b'-' || bytes[3] != b'-' {
            return None;
        }
        let digits = |part: &str| -> Option<i64> {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        };
        let year = match year_text.as_bytes().first()? {
            b'+' => digits(&year_text[1..])?,
            b'-' => -digits(&year_text[1..])?,
            _ => digits(year_text)?,
        };
        let month = digits(rest.get(1..3)?)?;
        let day = digits(rest.get(4..6)?)?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let date = Self::from_civil(year, month, day);
        // Printing back rejects days that do not exist (2026-02-30) and
        // spellings the reference would not print (`+002026-11-13`).
        (date.to_string() == text).then_some(date)
    }
}

impl fmt::Display for LocalDate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (year, month, day) = self.civil();
        if (0..=9999).contains(&year) {
            write!(formatter, "{year:04}-{month:02}-{day:02}")
        } else {
            let sign = if year < 0 { '-' } else { '+' };
            write!(formatter, "{sign}{:06}-{month:02}-{day:02}", year.abs())
        }
    }
}

/// `true` when `text` is a date `Temporal.PlainDate.from` accepts
/// (`isValidDate` of the input validator). Unlike [`LocalDate::from_printed`]
/// this takes every ISO spelling: a time part, an offset (but not `Z`),
/// annotations.
#[must_use]
pub fn is_plain_date(text: &str) -> bool {
    text.parse::<jiff::civil::Date>().is_ok()
}

/// A local wall-clock time of day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    pub hour: u8,
    pub minute: u8,
}

impl Clock {
    /// Minutes since local midnight; 1440 for `24:00`.
    #[must_use]
    pub fn minutes(self) -> i64 {
        i64::from(self.hour) * 60 + i64::from(self.minute)
    }
}

/// The hour and minute digits of `H:mm` or `HH:mm` (ASCII digits only, and
/// nothing before or after), without any range check.
pub(crate) fn clock_digits(text: &str) -> Option<(u8, u8)> {
    let (hour, minute) = text.split_once(':')?;
    let number = |part: &str, lengths: std::ops::RangeInclusive<usize>| -> Option<u8> {
        if !lengths.contains(&part.len()) || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    Some((number(hour, 1..=2)?, number(minute, 2..=2)?))
}

/// Parses `HH:mm` (`parseClock`). `24:00` is accepted and reported as hour
/// 24; callers decide whether that means the following midnight.
pub fn parse_clock(text: &str) -> Result<Clock, TimeError> {
    let (hour, minute) = clock_digits(text).ok_or(TimeError::InvalidClock)?;
    if minute > 59 || hour > 24 || (hour == 24 && minute != 0) {
        return Err(TimeError::InvalidClock);
    }
    Ok(Clock { hour, minute })
}

/// A UTC interval that lies on exactly one local calendar date under one UTC
/// offset (ADR-017).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalDaySegment {
    /// The local calendar date.
    pub date: LocalDate,
    /// ISO weekday of `date`: Monday = 1 … Sunday = 7.
    pub weekday: u8,
    /// UTC offset in effect for the whole segment.
    pub offset_ms: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    /// UTC instant of this local date's midnight under `offset_ms` (virtual
    /// when that midnight was skipped by a transition).
    pub local_midnight_ms: i64,
}

/// Projects a local wall-clock window on a segment's own date into UTC and
/// intersects it with the segment (`projectWindowOnSegment`). Local clock
/// arithmetic is linear because the segment has one offset.
pub fn project_window_on_segment(
    segment: &LocalDaySegment,
    start_local: &str,
    end_local: &str,
) -> Result<Option<(i64, i64)>, TimeError> {
    let start_minute = parse_clock(start_local)?.minutes();
    let end_minute = parse_clock(end_local)?.minutes();
    if end_minute <= start_minute {
        return Ok(None);
    }
    let start_ms = segment
        .start_ms
        .max(segment.local_midnight_ms + start_minute * MINUTE_MS);
    let end_ms = segment
        .end_ms
        .min(segment.local_midnight_ms + end_minute * MINUTE_MS);
    Ok((end_ms > start_ms).then_some((start_ms, end_ms)))
}

/// The first grid instant at or after `epoch_ms`.
#[must_use]
pub fn align_up_to_grid(epoch_ms: i64) -> i64 {
    -(-epoch_ms).div_euclid(GRID_MS) * GRID_MS
}

/// The last grid instant at or before `epoch_ms`.
#[must_use]
pub fn align_down_to_grid(epoch_ms: i64) -> i64 {
    epoch_ms.div_euclid(GRID_MS) * GRID_MS
}

#[must_use]
pub fn is_grid_aligned(epoch_ms: i64) -> bool {
    epoch_ms % GRID_MS == 0
}

/// Length of the overlap of `[a_start, a_end)` and `[b_start, b_end)`.
#[must_use]
pub fn overlap_ms(a_start: i64, a_end: i64, b_start: i64, b_end: i64) -> i64 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0)
}

#[derive(Debug, Clone)]
enum ZoneRules {
    /// A `±HH:MM` zone: one offset, no transitions.
    Fixed(i64),
    Named(TimeZone),
}

/// A resolved time zone.
///
/// Resolving once and passing the zone around keeps the database lookup out
/// of the scheduler's inner loops.
#[derive(Debug, Clone)]
pub struct Zone {
    rules: ZoneRules,
}

/// `±HH`, `±HHMM` or `±HH:MM` with hours 00–23 and minutes 00–59: the offset
/// spellings `Temporal` takes as a time zone id (no seconds).
fn offset_id_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let sign = match bytes.first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits: Vec<u8> = match bytes.len() {
        3 => bytes[1..3].to_vec(),
        5 => bytes[1..5].to_vec(),
        6 if bytes[3] == b':' => [&bytes[1..3], &bytes[4..6]].concat(),
        _ => return None,
    };
    if !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let number = |pair: &[u8]| i64::from(pair[0] - b'0') * 10 + i64::from(pair[1] - b'0');
    let hours = number(&digits[0..2]);
    let minutes = if digits.len() == 4 {
        number(&digits[2..4])
    } else {
        0
    };
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 60 + minutes) * MINUTE_MS)
}

impl Zone {
    /// Resolves a time zone id the way `Temporal` does.
    pub fn get(id: &str) -> Result<Self, TimeError> {
        Self::from_name(id)
            .or_else(|| Self::from_iso_string(id))
            .ok_or(TimeError::UnknownTimeZone)
    }

    fn from_name(id: &str) -> Option<Self> {
        if let Some(offset_ms) = offset_id_ms(id) {
            return Some(Self {
                rules: ZoneRules::Fixed(offset_ms),
            });
        }
        let zone = TimeZone::get(id).ok()?;
        // `Etc/Unknown` resolves to jiff's "unknown" zone and `Factory` is a
        // placeholder of the database; the reference knows neither.
        if zone.is_unknown() || id.eq_ignore_ascii_case("Factory") {
            return None;
        }
        Some(Self {
            rules: ZoneRules::Named(zone),
        })
    }

    /// `Temporal` also takes an ISO date-time as a zone id and uses the zone
    /// it names: the bracketed annotation, else `Z`, else its offset.
    fn from_iso_string(id: &str) -> Option<Self> {
        let pieces = Pieces::parse(id).ok()?;
        if let Some(annotation) = pieces.time_zone_annotation() {
            return match annotation.kind() {
                TimeZoneAnnotationKind::Named(name) => Self::from_name(name.as_str()),
                TimeZoneAnnotationKind::Offset(offset) => {
                    let seconds = i64::from(offset.seconds());
                    (seconds % 60 == 0).then_some(Self {
                        rules: ZoneRules::Fixed(seconds * 1000),
                    })
                }
                _ => None,
            };
        }
        match pieces.offset()? {
            PiecesOffset::Zulu => Some(Self {
                rules: ZoneRules::Named(TimeZone::UTC),
            }),
            PiecesOffset::Numeric(numeric) => {
                let seconds = i64::from(numeric.offset().seconds());
                (seconds % 60 == 0).then_some(Self {
                    rules: ZoneRules::Fixed(seconds * 1000),
                })
            }
            _ => None,
        }
    }

    /// The UTC offset in effect at an instant, in milliseconds.
    pub fn offset_ms_at(&self, epoch_ms: i64) -> Result<i64, TimeError> {
        match &self.rules {
            ZoneRules::Fixed(offset_ms) => Ok(*offset_ms),
            ZoneRules::Named(zone) => {
                let timestamp =
                    Timestamp::from_millisecond(epoch_ms).map_err(|_| TimeError::InvalidInstant)?;
                Ok(i64::from(zone.to_offset(timestamp).seconds()) * 1000)
            }
        }
    }

    /// The local calendar date at an instant (`localDateOf`).
    pub fn local_date_at(&self, epoch_ms: i64) -> Result<LocalDate, TimeError> {
        let offset_ms = self.offset_ms_at(epoch_ms)?;
        Ok(LocalDate::from_days(
            (epoch_ms + offset_ms).div_euclid(DAY_MS),
        ))
    }

    /// The local wall-clock hour (0–23) at an instant.
    pub fn local_hour_at(&self, epoch_ms: i64) -> Result<i64, TimeError> {
        let offset_ms = self.offset_ms_at(epoch_ms)?;
        Ok((epoch_ms + offset_ms).rem_euclid(DAY_MS) / (60 * MINUTE_MS))
    }

    /// The instants in `(start_ms, end_ms)` at which the UTC offset changes,
    /// in order.
    fn offset_changes(&self, start_ms: i64, end_ms: i64) -> Result<Vec<i64>, TimeError> {
        let ZoneRules::Named(zone) = &self.rules else {
            return Ok(Vec::new());
        };
        let start = Timestamp::from_millisecond(start_ms).map_err(|_| TimeError::InvalidInstant)?;
        offset_changes_among(
            zone.to_offset(start).seconds(),
            zone.following(start).map(|transition| {
                (
                    transition.timestamp().as_millisecond(),
                    transition.offset().seconds(),
                )
            }),
            start_ms,
            end_ms,
        )
    }

    /// ADR-017 steps 1–2 (`partitionByLocalDate`): splits `[start_ms, end_ms)`
    /// at every offset transition of the zone, then splits each
    /// constant-offset piece at the local midnights of that offset. Every
    /// segment lies on one local date; the same date can appear in several
    /// segments after a backward transition.
    pub fn partition(&self, start_ms: i64, end_ms: i64) -> Result<Vec<LocalDaySegment>, TimeError> {
        let mut segments = Vec::new();
        self.for_each_segment(start_ms, end_ms, |segment| segments.push(segment))?;
        Ok(segments)
    }

    /// [`Zone::partition`] without the allocation of the result.
    pub fn for_each_segment(
        &self,
        start_ms: i64,
        end_ms: i64,
        mut visit: impl FnMut(LocalDaySegment),
    ) -> Result<(), TimeError> {
        if end_ms <= start_ms {
            return Ok(());
        }
        let changes = self.offset_changes(start_ms, end_ms)?;
        let mut piece_start = start_ms;
        for piece_end in changes.into_iter().chain(std::iter::once(end_ms)) {
            if piece_end <= piece_start {
                continue;
            }
            let offset_ms = self.offset_ms_at(piece_start)?;
            let mut segment_start = piece_start;
            let mut next_local_midnight =
                ((piece_start + offset_ms).div_euclid(DAY_MS) + 1) * DAY_MS;
            loop {
                let midnight_ms = next_local_midnight - offset_ms;
                let segment_end = midnight_ms.min(piece_end);
                if segment_end > segment_start {
                    let local_day = (segment_start + offset_ms).div_euclid(DAY_MS);
                    let date = LocalDate::from_days(local_day);
                    visit(LocalDaySegment {
                        date,
                        weekday: date.weekday(),
                        offset_ms,
                        start_ms: segment_start,
                        end_ms: segment_end,
                        local_midnight_ms: local_day * DAY_MS - offset_ms,
                    });
                    segment_start = segment_end;
                }
                if midnight_ms >= piece_end {
                    break;
                }
                next_local_midnight += DAY_MS;
            }
            piece_start = piece_end;
        }
        Ok(())
    }
}

/// Picks the offset changes inside `(start_ms, end_ms)` out of a zone's
/// transitions `(instant, offset after it)`, which follow `start_ms` in
/// order. Changes of abbreviation or DST flag alone are skipped: the
/// reference only sees transitions that change the offset.
fn offset_changes_among(
    offset_at_start: i32,
    transitions: impl Iterator<Item = (i64, i32)>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<i64>, TimeError> {
    let mut changes = Vec::new();
    let mut offset = offset_at_start;
    for (transition_ms, offset_after) in transitions {
        if transition_ms >= end_ms {
            break;
        }
        if offset_after != offset && transition_ms > start_ms {
            if changes.len() >= MAX_TRANSITIONS {
                return Err(TimeError::TooManyTransitions);
            }
            changes.push(transition_ms);
        }
        offset = offset_after;
    }
    // The reference looks for one more transition after the last one it
    // took, and that look-up is what trips its guard.
    if changes.len() >= MAX_TRANSITIONS {
        return Err(TimeError::TooManyTransitions);
    }
    Ok(changes)
}

/// `true` when `id` names a time zone (`isValidTimeZone`).
#[must_use]
pub fn is_valid_time_zone(id: &str) -> bool {
    Zone::get(id).is_ok()
}

/// [`Zone::partition`] for a zone id.
pub fn partition_by_local_date(
    start_ms: i64,
    end_ms: i64,
    time_zone: &str,
) -> Result<Vec<LocalDaySegment>, TimeError> {
    if end_ms <= start_ms {
        return Ok(Vec::new());
    }
    Zone::get(time_zone)?.partition(start_ms, end_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(text: &str) -> i64 {
        parse_instant(text).unwrap()
    }

    #[test]
    fn instants_parse_with_any_offset_and_print_in_utc() {
        assert_eq!(ms("2026-11-13T00:00:00Z"), 1_794_528_000_000);
        assert_eq!(ms("2026-11-13T09:00:00+09:00"), 1_794_528_000_000);
        assert_eq!(ms("1970-01-01T00:00:00Z"), 0);
        assert_eq!(
            instant_to_utc(1_794_528_000_000).unwrap(),
            "2026-11-13T00:00:00Z"
        );
        assert_eq!(
            instant_to_utc(1_794_528_000_500).unwrap(),
            "2026-11-13T00:00:00.5Z"
        );
        assert_eq!(
            instant_to_utc(1_794_528_000_120).unwrap(),
            "2026-11-13T00:00:00.12Z"
        );
    }

    #[test]
    fn non_instants_and_sub_millisecond_instants_are_rejected() {
        for text in ["", "not an instant", "2026-11-13", "2026-11-13T00:00:00"] {
            assert_eq!(
                parse_instant(text),
                Err(TimeError::InvalidInstant),
                "{text}"
            );
            assert_eq!(instant_nanoseconds(text), Err(TimeError::InvalidInstant));
        }
        assert_eq!(
            parse_instant("2026-11-13T00:00:00.123456Z"),
            Err(TimeError::SubMillisecond)
        );
        assert_eq!(
            instant_nanoseconds("2026-11-13T00:00:00.123456Z"),
            Ok(1_794_528_000_123_456_000)
        );
        assert!(instant_to_utc(i64::MAX).is_err());
    }

    #[test]
    fn known_differences_from_the_reference_are_refusals_not_other_answers() {
        // Blueprint 15 §5.2. The reference (Temporal) takes these; `jiff`
        // does not, so they are invalid instants here. None of them is
        // written by the application, and none is answered differently:
        // years beyond 9999 (Temporal reaches ±275760) …
        for text in [
            "+010000-01-01T00:00:00Z",
            "+275760-09-13T00:00:00Z",
            "9999-12-31T23:59:59.999Z",
        ] {
            assert_eq!(
                parse_instant(text),
                Err(TimeError::InvalidInstant),
                "{text}"
            );
        }
        // … and an annotation marked critical.
        assert_eq!(
            parse_instant("2026-11-13T00:00:00Z[!u-ca=iso8601]"),
            Err(TimeError::InvalidInstant)
        );
        // The last instant both sides agree on.
        assert_eq!(
            parse_instant("9999-12-30T21:59:59.999Z"),
            Ok(253_402_207_199_999)
        );
    }

    #[test]
    fn a_zone_without_transitions_splits_at_local_midnight_only() {
        let segments = partition_by_local_date(
            ms("2026-11-12T10:00:00Z"),
            ms("2026-11-14T10:00:00Z"),
            "Asia/Seoul",
        )
        .unwrap();
        let dates: Vec<(String, u8)> = segments
            .iter()
            .map(|segment| (segment.date.to_string(), segment.weekday))
            .collect();
        assert_eq!(
            dates,
            [
                ("2026-11-12".to_owned(), 4),
                ("2026-11-13".to_owned(), 5),
                ("2026-11-14".to_owned(), 6)
            ]
        );
        assert!(
            segments
                .iter()
                .all(|segment| segment.offset_ms == 9 * 60 * MINUTE_MS)
        );
        assert_eq!(segments[1].start_ms, ms("2026-11-12T15:00:00Z"));
        assert_eq!(segments[1].local_midnight_ms, segments[1].start_ms);
        // Segments tile the range without gaps or overlaps.
        for pair in segments.windows(2) {
            assert_eq!(pair[0].end_ms, pair[1].start_ms);
        }
    }

    #[test]
    fn the_repeated_hour_of_a_dst_end_stays_on_one_date_in_two_segments() {
        // America/New_York, 2026-11-01: 01:00–02:00 local happens twice.
        let segments = partition_by_local_date(
            ms("2026-11-01T04:00:00Z"),
            ms("2026-11-02T05:00:00Z"),
            "America/New_York",
        )
        .unwrap();
        let view: Vec<(String, i64)> = segments
            .iter()
            .map(|segment| {
                (
                    segment.date.to_string(),
                    segment.offset_ms / (60 * MINUTE_MS),
                )
            })
            .collect();
        assert_eq!(
            view,
            [("2026-11-01".to_owned(), -4), ("2026-11-01".to_owned(), -5)]
        );
        assert_eq!(segments[0].end_ms, ms("2026-11-01T06:00:00Z"));
        // The local day is 25 hours long.
        assert_eq!(
            segments[1].end_ms - segments[0].start_ms,
            25 * 60 * MINUTE_MS
        );
    }

    #[test]
    fn empty_ranges_and_unknown_zones_are_handled() {
        assert_eq!(
            partition_by_local_date(10, 10, "Asia/Seoul"),
            Ok(Vec::new())
        );
        assert_eq!(
            partition_by_local_date(20, 10, "Asia/Seoul"),
            Ok(Vec::new())
        );
        // Like the reference, an empty range is answered before the zone is
        // looked at.
        assert_eq!(
            partition_by_local_date(20, 10, "Mars/Olympus_Mons"),
            Ok(Vec::new())
        );
        assert_eq!(
            partition_by_local_date(0, DAY_MS, "Mars/Olympus_Mons"),
            Err(TimeError::UnknownTimeZone)
        );
    }

    #[test]
    fn a_runaway_transition_walk_stops_at_the_guard() {
        // No real zone has thousands of transitions in a range; feed the
        // walk synthetic ones, one a second, alternating between two offsets.
        let transitions = |count: usize| {
            (1..=count).map(|index| {
                (
                    i64::try_from(index).unwrap() * 1000,
                    if index % 2 == 0 { 0 } else { 3600 },
                )
            })
        };
        let end_ms = 10 * DAY_MS;
        assert_eq!(MAX_TRANSITIONS, 4096);
        assert_eq!(
            offset_changes_among(0, transitions(5000), 0, end_ms),
            Err(TimeError::TooManyTransitions)
        );
        assert_eq!(
            offset_changes_among(0, transitions(MAX_TRANSITIONS), 0, end_ms),
            Err(TimeError::TooManyTransitions)
        );
        // One fewer is an ordinary, if absurd, result.
        let changes = offset_changes_among(0, transitions(MAX_TRANSITIONS - 1), 0, end_ms).unwrap();
        assert_eq!(changes.len(), MAX_TRANSITIONS - 1);
        assert_eq!(changes[0], 1000);
        // Transitions that keep the offset, lie at the start or reach the end
        // are not changes.
        assert_eq!(
            offset_changes_among(
                3600,
                [(0, 0), (5, 0), (7, 3600), (9, 3600), (20, 0)].into_iter(),
                0,
                20
            ),
            Ok(vec![7])
        );
    }

    #[test]
    fn dates_print_like_temporal_and_know_their_weekday() {
        let cases = [
            (0, "1970-01-01", 4),
            (-1, "1969-12-31", 3),
            (19_782, "2024-02-29", 4),
            (20_770, "2026-11-13", 5),
            (-719_528, "0000-01-01", 6),
            (-719_529, "-000001-12-31", 5),
            (2_932_897, "+010000-01-01", 6),
        ];
        for (days, text, weekday) in cases {
            let date = LocalDate::from_days(days);
            assert_eq!(date.to_string(), text);
            assert_eq!(date.weekday(), weekday, "{text}");
            assert_eq!(LocalDate::from_printed(text), Some(date), "{text}");
        }
    }

    #[test]
    fn only_the_printed_spelling_of_a_date_names_it() {
        for text in [
            "",
            "2026-11-13T00:00",
            "20261113",
            "2026-1-3",
            "2026-02-30",
            "2026-13-01",
            "2026-00-10",
            "2026-11-00",
            "+002026-11-13",
            "2026-11-13 ",
            " 2026-11-13",
            "2026/11/13",
            "２０２６-11-13",
            "-000000-01-01",
        ] {
            assert_eq!(LocalDate::from_printed(text), None, "{text:?}");
        }
        // The validator's check is the wider `Temporal.PlainDate.from`.
        for text in [
            "2026-11-13",
            "2026-11-13T10:00",
            "20261113",
            "+002026-11-13",
        ] {
            assert!(is_plain_date(text), "{text}");
        }
        for text in ["", "2026-02-30", "2026-11-13Z", "2026-11", "2026-1-3"] {
            assert!(!is_plain_date(text), "{text}");
        }
    }

    #[test]
    fn clocks_are_strict_hh_mm() {
        assert_eq!(parse_clock("09:00"), Ok(Clock { hour: 9, minute: 0 }));
        assert_eq!(parse_clock("9:05"), Ok(Clock { hour: 9, minute: 5 }));
        assert_eq!(parse_clock("23:59").map(Clock::minutes), Ok(23 * 60 + 59));
        assert_eq!(parse_clock("24:00").map(Clock::minutes), Ok(1440));
        for text in [
            "",
            "24:01",
            "25:00",
            "9:5",
            "09:60",
            " 09:00",
            "09:00 ",
            "09:00\n",
            "099:00",
            "-1:00",
            "09:00:00",
            "0900",
            "٠٩:٠٠",
            "+9:00",
        ] {
            assert_eq!(parse_clock(text), Err(TimeError::InvalidClock), "{text:?}");
        }
    }

    #[test]
    fn windows_are_projected_with_the_segment_offset_and_clipped() {
        let segments = partition_by_local_date(
            ms("2026-11-12T20:00:00Z"),
            ms("2026-11-13T05:00:00Z"),
            "Asia/Seoul",
        )
        .unwrap();
        // 2026-11-13 in Seoul starts at 15:00Z; the range covers 05:00–14:00
        // local of that date.
        let friday = &segments[0];
        assert_eq!(friday.date.to_string(), "2026-11-13");
        assert_eq!(
            project_window_on_segment(friday, "09:00", "12:00"),
            Ok(Some((
                ms("2026-11-13T00:00:00Z"),
                ms("2026-11-13T03:00:00Z")
            )))
        );
        // Clipped to the segment on both sides.
        assert_eq!(
            project_window_on_segment(friday, "00:00", "24:00"),
            Ok(Some((friday.start_ms, friday.end_ms)))
        );
        // Outside the segment, empty or backwards windows give nothing.
        assert_eq!(
            project_window_on_segment(friday, "15:00", "16:00"),
            Ok(None)
        );
        assert_eq!(
            project_window_on_segment(friday, "10:00", "10:00"),
            Ok(None)
        );
        assert_eq!(
            project_window_on_segment(friday, "12:00", "09:00"),
            Ok(None)
        );
        assert_eq!(
            project_window_on_segment(friday, "9am", "12:00"),
            Err(TimeError::InvalidClock)
        );
    }

    #[test]
    fn grid_alignment_rounds_inwards_also_before_the_epoch() {
        assert_eq!(align_up_to_grid(0), 0);
        assert_eq!(align_up_to_grid(1), GRID_MS);
        assert_eq!(align_up_to_grid(GRID_MS), GRID_MS);
        assert_eq!(align_up_to_grid(-1), 0);
        assert_eq!(align_up_to_grid(-GRID_MS - 1), -GRID_MS);
        assert_eq!(align_down_to_grid(GRID_MS - 1), 0);
        assert_eq!(align_down_to_grid(-1), -GRID_MS);
        assert!(is_grid_aligned(3 * GRID_MS));
        assert!(is_grid_aligned(-GRID_MS));
        assert!(!is_grid_aligned(GRID_MS + MINUTE_MS));
        assert_eq!(overlap_ms(0, 10, 5, 20), 5);
        assert_eq!(overlap_ms(0, 10, 10, 20), 0);
        assert_eq!(overlap_ms(0, 10, 30, 40), 0);
    }

    #[test]
    fn zone_ids_follow_temporal() {
        for id in [
            "Asia/Seoul",
            "asia/seoul",
            "UTC",
            "utc",
            "GMT",
            "Etc/GMT+5",
            "US/Eastern",
            "EST",
            "+09:00",
            "+0900",
            "+09",
            "-05:30",
            "-00:00",
            "+23:59",
            "2026-11-13T00:00:00+09:00[Asia/Seoul]",
            "2026-11-13T00:00:00Z",
        ] {
            assert!(is_valid_time_zone(id), "{id}");
        }
        for id in [
            "",
            "Z",
            " Asia/Seoul",
            "Mars/Olympus_Mons",
            "+09:00:00",
            "+24:00",
            "+09:60",
            "UTC+9",
            "GMT+9",
            "Etc/Unknown",
            "Factory",
            "local",
            "2026-11-13T00:00:00",
            "2026-11-13T00:00:00+09:00[Mars/Olympus_Mons]",
        ] {
            assert!(!is_valid_time_zone(id), "{id}");
        }
    }

    #[test]
    fn offset_zones_have_one_offset_and_no_transitions() {
        let zone = Zone::get("-05:30").unwrap();
        let start = ms("2026-11-13T00:00:00Z");
        let segments = zone.partition(start, start + 36 * 60 * MINUTE_MS).unwrap();
        let view: Vec<(String, i64)> = segments
            .iter()
            .map(|segment| (segment.date.to_string(), segment.offset_ms))
            .collect();
        let offset = -(5 * 60 + 30) * MINUTE_MS;
        assert_eq!(
            view,
            [
                ("2026-11-12".to_owned(), offset),
                ("2026-11-13".to_owned(), offset),
                ("2026-11-14".to_owned(), offset)
            ]
        );
        assert_eq!(zone.local_hour_at(start), Ok(18));
        assert_eq!(
            zone.local_date_at(start).map(|date| date.to_string()),
            Ok("2026-11-12".to_owned())
        );
        // A named zone answers the same questions from its rules.
        let seoul = Zone::get("Asia/Seoul").unwrap();
        assert_eq!(seoul.local_hour_at(start), Ok(9));
        assert_eq!(seoul.offset_ms_at(i64::MAX), Err(TimeError::InvalidInstant));
    }
}
