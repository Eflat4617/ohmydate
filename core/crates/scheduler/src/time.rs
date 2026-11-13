//! Scheduler time: a port of `packages/scheduler/src/time.ts`.
//!
//! All arithmetic is on epoch milliseconds. Time zone rules come from the
//! IANA database compiled into `jiff`; the TypeScript reference reads the one
//! shipped with Node. The oracle packs record the reference's partitions, so
//! a database difference shows up as a failing partition, not as an
//! unexplained scheduling difference.

use std::fmt;

use jiff::Timestamp;
use jiff::tz::TimeZone;

pub const GRID_MINUTES: i64 = 5;
pub const MINUTE_MS: i64 = 60 * 1000;
pub const GRID_MS: i64 = GRID_MINUTES * MINUTE_MS;
pub const DAY_MS: i64 = 24 * 60 * MINUTE_MS;

/// Hard cap of the transition walk (far above any real horizon).
pub const MAX_TRANSITIONS: usize = 4096;

/// Why a time value could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeError {
    /// Not an ISO-8601 instant with an offset.
    InvalidInstant,
    /// The instant has a fraction finer than one millisecond.
    SubMillisecond,
    /// The IANA time zone is unknown.
    UnknownTimeZone,
    /// More than [`MAX_TRANSITIONS`] offset transitions in one range.
    TooManyTransitions,
}

impl fmt::Display for TimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            TimeError::InvalidInstant => "not a valid instant",
            TimeError::SubMillisecond => "the instant has sub-millisecond precision",
            TimeError::UnknownTimeZone => "unknown time zone",
            TimeError::TooManyTransitions => "the time zone transition walk exceeded its limit",
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

/// The UTC text of an instant as `Temporal.Instant.prototype.toString`
/// prints it (`instantToUtc`): seconds always, fraction only when non-zero
/// and without trailing zeros.
pub fn instant_to_utc(epoch_ms: i64) -> Result<String, TimeError> {
    Timestamp::from_millisecond(epoch_ms)
        .map(|timestamp| timestamp.to_string())
        .map_err(|_| TimeError::InvalidInstant)
}

/// A UTC interval that lies on exactly one local calendar date under one UTC
/// offset (ADR-017).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDaySegment {
    /// Local calendar date, `YYYY-MM-DD`.
    pub date: String,
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

fn offset_ms_at(zone: &TimeZone, epoch_ms: i64) -> Result<i64, TimeError> {
    let timestamp = Timestamp::from_millisecond(epoch_ms).map_err(|_| TimeError::InvalidInstant)?;
    Ok(i64::from(zone.to_offset(timestamp).seconds()) * 1000)
}

/// Calendar date and ISO weekday of a day number (days since 1970-01-01).
fn civil(days: i64) -> (String, u8) {
    let shifted = days + 719_468;
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
    // 1970-01-01 was a Thursday (ISO weekday 4).
    let weekday = u8::try_from((days + 3).rem_euclid(7) + 1).unwrap_or(1);
    (format!("{year:04}-{month:02}-{day:02}"), weekday)
}

/// ADR-017 steps 1–2: splits `[start_ms, end_ms)` at every offset transition
/// of the zone, then splits each constant-offset piece at the local midnights
/// of that offset. The same date can appear in several segments after a
/// backward transition.
pub fn partition_by_local_date(
    start_ms: i64,
    end_ms: i64,
    time_zone: &str,
) -> Result<Vec<LocalDaySegment>, TimeError> {
    if end_ms <= start_ms {
        return Ok(Vec::new());
    }
    let zone = TimeZone::get(time_zone).map_err(|_| TimeError::UnknownTimeZone)?;
    let start = Timestamp::from_millisecond(start_ms).map_err(|_| TimeError::InvalidInstant)?;

    let mut boundaries = vec![start_ms];
    let mut offset = zone.to_offset(start);
    for (count, transition) in zone.following(start).enumerate() {
        if count >= MAX_TRANSITIONS {
            return Err(TimeError::TooManyTransitions);
        }
        let transition_ms = transition.timestamp().as_millisecond();
        if transition_ms >= end_ms {
            break;
        }
        // The reference only sees transitions that change the offset; the
        // database also records changes of abbreviation or DST flag alone.
        if transition.offset() != offset && transition_ms > start_ms {
            boundaries.push(transition_ms);
        }
        offset = transition.offset();
    }
    boundaries.push(end_ms);

    let mut segments = Vec::new();
    for piece in boundaries.windows(2) {
        let (piece_start, piece_end) = (piece[0], piece[1]);
        if piece_end <= piece_start {
            continue;
        }
        let offset_ms = offset_ms_at(&zone, piece_start)?;
        let mut cuts = vec![piece_start];
        let mut next_local_midnight = ((piece_start + offset_ms).div_euclid(DAY_MS) + 1) * DAY_MS;
        while next_local_midnight - offset_ms < piece_end {
            cuts.push(next_local_midnight - offset_ms);
            next_local_midnight += DAY_MS;
        }
        cuts.push(piece_end);
        for cut in cuts.windows(2) {
            let (segment_start, segment_end) = (cut[0], cut[1]);
            if segment_end <= segment_start {
                continue;
            }
            let local_day = (segment_start + offset_ms).div_euclid(DAY_MS);
            let (date, weekday) = civil(local_day);
            segments.push(LocalDaySegment {
                date,
                weekday,
                offset_ms,
                start_ms: segment_start,
                end_ms: segment_end,
                local_midnight_ms: local_day * DAY_MS - offset_ms,
            });
        }
    }
    Ok(segments)
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
        }
        assert_eq!(
            parse_instant("2026-11-13T00:00:00.123456Z"),
            Err(TimeError::SubMillisecond)
        );
        assert!(instant_to_utc(i64::MAX).is_err());
    }

    #[test]
    fn a_zone_without_transitions_splits_at_local_midnight_only() {
        let segments = partition_by_local_date(
            ms("2026-11-12T10:00:00Z"),
            ms("2026-11-14T10:00:00Z"),
            "Asia/Seoul",
        )
        .unwrap();
        let dates: Vec<(&str, u8)> = segments
            .iter()
            .map(|segment| (segment.date.as_str(), segment.weekday))
            .collect();
        assert_eq!(
            dates,
            [("2026-11-12", 4), ("2026-11-13", 5), ("2026-11-14", 6)]
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
        let view: Vec<(&str, i64)> = segments
            .iter()
            .map(|segment| (segment.date.as_str(), segment.offset_ms / (60 * MINUTE_MS)))
            .collect();
        assert_eq!(view, [("2026-11-01", -4), ("2026-11-01", -5)]);
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
        assert_eq!(
            partition_by_local_date(0, DAY_MS, "Mars/Olympus_Mons"),
            Err(TimeError::UnknownTimeZone)
        );
    }

    #[test]
    fn civil_dates_and_weekdays_are_correct_around_epoch_and_leap_days() {
        assert_eq!(civil(0), ("1970-01-01".to_owned(), 4));
        assert_eq!(civil(-1), ("1969-12-31".to_owned(), 3));
        assert_eq!(civil(19_782), ("2024-02-29".to_owned(), 4));
        assert_eq!(civil(20_770), ("2026-11-13".to_owned(), 5));
    }
}
