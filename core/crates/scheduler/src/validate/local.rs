//! The validator's own view of local time (ADR-017, FU-12).
//!
//! `validate` must not share its date logic with the code it audits. The
//! partition here has the same shape as `time::Zone::partition` — split at
//! offset transitions, then at local midnights — but it is written
//! separately, and the date and weekday of every piece come from converting
//! the piece's start to civil time in the zone, not from the wall-clock
//! arithmetic that produced the split. H2 goes further and classifies single
//! instants by raw rule membership, without building availability intervals.

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

use crate::time::{LocalDate, MINUTE_MS, TimeError, clock_digits};
use crate::types::{AvailabilityRule, ExceptionKind, ExceptionRule};

const ORACLE_DAY_MS: i64 = 24 * 60 * MINUTE_MS;

/// Hard cap of the validator's transition walk. Unreachable for real zones
/// (about two transitions a year), so reaching it is a programming error
/// reported as [`TimeError::TooManyTransitions`], not a validation outcome
/// (FU-13).
pub const ORACLE_MAX_TRANSITIONS: usize = 4096;

/// A UTC interval on one local date under one offset.
#[derive(Debug, Clone, Copy)]
pub(super) struct OracleSegment {
    pub date: Date,
    pub weekday: u8,
    pub start_ms: i64,
    pub end_ms: i64,
    pub local_midnight_ms: i64,
}

/// Civil time of one instant in the zone.
pub(super) struct LocalInstant {
    pub date: Date,
    pub weekday: u8,
    /// Seconds since local midnight, with the fraction.
    pub seconds: f64,
}

fn timestamp(epoch_ms: i64) -> Result<Timestamp, TimeError> {
    Timestamp::from_millisecond(epoch_ms).map_err(|_| TimeError::InvalidInstant)
}

fn iso_weekday(date: Date) -> u8 {
    u8::try_from(date.weekday().to_monday_one_offset()).unwrap_or(1)
}

/// The zone as the validator sees it.
pub(super) struct OracleZone {
    zone: TimeZone,
}

impl OracleZone {
    pub fn new(zone: TimeZone) -> Self {
        Self { zone }
    }

    fn offset_ms_at(&self, epoch_ms: i64) -> Result<i64, TimeError> {
        Ok(i64::from(self.zone.to_offset(timestamp(epoch_ms)?).seconds()) * 1000)
    }

    /// The local calendar date of an instant.
    pub fn date_at(&self, epoch_ms: i64) -> Result<Date, TimeError> {
        let instant = timestamp(epoch_ms)?;
        Ok(self.zone.to_offset(instant).to_datetime(instant).date())
    }

    /// Local date, weekday and time of day of an instant.
    pub fn local_at(&self, epoch_ms: i64) -> Result<LocalInstant, TimeError> {
        let instant = timestamp(epoch_ms)?;
        let civil = self.zone.to_offset(instant).to_datetime(instant);
        // The reference adds the parts in this order.
        let seconds = f64::from(civil.hour()) * 3600.0
            + f64::from(civil.minute()) * 60.0
            + f64::from(civil.second())
            + f64::from(civil.millisecond()) / 1000.0
            + f64::from(civil.microsecond()) / 1_000_000.0
            + f64::from(civil.nanosecond()) / 1_000_000_000.0;
        Ok(LocalInstant {
            date: civil.date(),
            weekday: iso_weekday(civil.date()),
            seconds,
        })
    }

    /// The offset changes of the zone strictly inside `(start_ms, end_ms)`.
    fn transitions(&self, start_ms: i64, end_ms: i64) -> Result<Vec<i64>, TimeError> {
        let start = timestamp(start_ms)?;
        walk_transitions(
            self.zone.to_offset(start).seconds(),
            self.zone.following(start).map(|transition| {
                (
                    transition.timestamp().as_millisecond(),
                    transition.offset().seconds(),
                )
            }),
            end_ms,
        )
    }

    /// ADR-017 steps 1–2 for the validator: `[start_ms, end_ms)` in pieces
    /// that each lie on one local date. A date can reappear after a backward
    /// transition.
    pub fn partition(&self, start_ms: i64, end_ms: i64) -> Result<Vec<OracleSegment>, TimeError> {
        if end_ms <= start_ms {
            return Ok(Vec::new());
        }
        let mut boundaries = vec![start_ms];
        boundaries.extend(self.transitions(start_ms, end_ms)?);
        boundaries.push(end_ms);

        let mut segments = Vec::new();
        for piece in boundaries.windows(2) {
            let (piece_start, piece_end) = (piece[0], piece[1]);
            if piece_end <= piece_start {
                continue;
            }
            let offset_ms = self.offset_ms_at(piece_start)?;
            let mut piece_boundaries = vec![piece_start];
            let mut next_local_midnight_ms =
                ((piece_start + offset_ms).div_euclid(ORACLE_DAY_MS) + 1) * ORACLE_DAY_MS;
            while next_local_midnight_ms - offset_ms < piece_end {
                let midnight_ms = next_local_midnight_ms - offset_ms;
                if midnight_ms > piece_start {
                    piece_boundaries.push(midnight_ms);
                }
                next_local_midnight_ms += ORACLE_DAY_MS;
            }
            piece_boundaries.push(piece_end);

            for segment in piece_boundaries.windows(2) {
                let (segment_start, segment_end) = (segment[0], segment[1]);
                if segment_end <= segment_start {
                    continue;
                }
                let date = self.date_at(segment_start)?;
                segments.push(OracleSegment {
                    date,
                    weekday: iso_weekday(date),
                    start_ms: segment_start,
                    end_ms: segment_end,
                    local_midnight_ms: (segment_start + offset_ms).div_euclid(ORACLE_DAY_MS)
                        * ORACLE_DAY_MS
                        - offset_ms,
                });
            }
        }
        Ok(segments)
    }
}

/// The offset-changing transitions before `end_ms`, given the zone's
/// transitions `(instant, offset after it)` that follow the start in order.
fn walk_transitions(
    offset_at_start: i32,
    following: impl Iterator<Item = (i64, i32)>,
    end_ms: i64,
) -> Result<Vec<i64>, TimeError> {
    let mut found = Vec::new();
    let mut offset = offset_at_start;
    for (transition_ms, offset_after) in following {
        // The reference gives up when it has to look for a transition after
        // the 4096th.
        if found.len() >= ORACLE_MAX_TRANSITIONS {
            return Err(TimeError::TooManyTransitions);
        }
        if transition_ms >= end_ms {
            return Ok(found);
        }
        if offset_after != offset {
            found.push(transition_ms);
        }
        offset = offset_after;
    }
    if found.len() >= ORACLE_MAX_TRANSITIONS {
        return Err(TimeError::TooManyTransitions);
    }
    Ok(found)
}

/// Hour and minute of a rule's clock value, or `None` when it is not one
/// (`oracleClockParts`): `H:mm` or `HH:mm` up to `24:00`.
fn oracle_clock_parts(value: &str) -> Option<(i64, i64)> {
    let (hour, minute) = clock_digits(value)?;
    if minute > 59 || hour > 24 || (hour == 24 && minute != 0) {
        return None;
    }
    Some((i64::from(hour), i64::from(minute)))
}

fn oracle_range_contains(start_local: &str, end_local: &str, seconds: f64) -> bool {
    let (Some(start), Some(end)) = (
        oracle_clock_parts(start_local),
        oracle_clock_parts(end_local),
    ) else {
        return false;
    };
    let start_seconds = start.0 * 3600 + start.1 * 60;
    let end_seconds = end.0 * 3600 + end.1 * 60;
    // Seconds of a day are small integers: exact as floats.
    #[allow(clippy::cast_precision_loss)]
    let (start_seconds_f, end_seconds_f) = (start_seconds as f64, end_seconds as f64);
    end_seconds > start_seconds && seconds >= start_seconds_f && seconds < end_seconds_f
}

fn oracle_exception_contains(exception: &ExceptionRule, seconds: f64) -> bool {
    match (&exception.start_local, &exception.end_local) {
        (None, None) => true,
        (Some(start_local), Some(end_local)) => {
            oracle_range_contains(start_local, end_local, seconds)
        }
        _ => false,
    }
}

/// The availability rules and exceptions of an input, read once.
pub(super) struct Availability<'a> {
    rules: &'a [AvailabilityRule],
    /// Each exception with the date it names. The reference compares date
    /// strings, so a date that is not spelled the way dates print names no
    /// day at all.
    exceptions: Vec<(&'a ExceptionRule, Option<Date>)>,
}

impl<'a> Availability<'a> {
    pub fn new(rules: &'a [AvailabilityRule], exceptions: &'a [ExceptionRule]) -> Self {
        let exceptions = exceptions
            .iter()
            .map(|exception| {
                let date = LocalDate::from_printed(&exception.date).and_then(|date| {
                    let (year, month, day) = date.civil();
                    Date::new(
                        i16::try_from(year).ok()?,
                        i8::try_from(month).ok()?,
                        i8::try_from(day).ok()?,
                    )
                    .ok()
                });
                (exception, date)
            })
            .collect();
        Self { rules, exceptions }
    }

    fn exceptions_on(&self, date: Date) -> impl Iterator<Item = &'a ExceptionRule> + '_ {
        self.exceptions
            .iter()
            .filter(move |(_, known)| *known == Some(date))
            .map(|(exception, _)| *exception)
    }

    /// Raw membership of one instant in local availability
    /// (`isInstantLocallyAvailable`).
    fn is_instant_available(&self, zone: &OracleZone, epoch_ms: i64) -> Result<bool, TimeError> {
        let local = zone.local_at(epoch_ms)?;
        if self.exceptions_on(local.date).any(|exception| {
            exception.kind == ExceptionKind::Off
                && exception.start_local.is_none()
                && exception.end_local.is_none()
        }) {
            return Ok(false);
        }
        let from_rule = self.rules.iter().any(|rule| {
            rule.weekday == f64::from(local.weekday)
                && oracle_range_contains(&rule.start_local, &rule.end_local, local.seconds)
        });
        let from_extra = self.exceptions_on(local.date).any(|exception| {
            exception.kind == ExceptionKind::Extra
                && oracle_exception_contains(exception, local.seconds)
        });
        let from_off = self.exceptions_on(local.date).any(|exception| {
            exception.kind == ExceptionKind::Off
                && oracle_exception_contains(exception, local.seconds)
        });
        Ok((from_rule || from_extra) && !from_off)
    }

    /// Whether every instant of `[start_ms, end_ms)` is locally available
    /// (`isBlockLocallyCovered`): the block is cut at every rule or exception
    /// edge, local midnight and transition inside it, and the middle of each
    /// piece is classified on its own.
    pub fn covers(&self, zone: &OracleZone, start_ms: i64, end_ms: i64) -> Result<bool, TimeError> {
        let mut boundaries = vec![start_ms, end_ms];
        let mut add_edge = |segment: &OracleSegment, clock: &str| {
            if let Some((hour, minute)) = oracle_clock_parts(clock) {
                let edge_ms = segment.local_midnight_ms + (hour * 60 + minute) * MINUTE_MS;
                if edge_ms > start_ms && edge_ms < end_ms {
                    boundaries.push(edge_ms);
                }
            }
        };
        let segments = zone.partition(start_ms, end_ms)?;
        for segment in &segments {
            for rule in self.rules {
                if rule.weekday != f64::from(segment.weekday) {
                    continue;
                }
                add_edge(segment, &rule.start_local);
                add_edge(segment, &rule.end_local);
            }
            for exception in self.exceptions_on(segment.date) {
                if let (Some(start_local), Some(end_local)) =
                    (&exception.start_local, &exception.end_local)
                {
                    add_edge(segment, start_local);
                    add_edge(segment, end_local);
                }
            }
        }
        for segment in &segments {
            boundaries.push(segment.start_ms);
            boundaries.push(segment.end_ms);
        }
        boundaries.sort_by(i64::cmp);
        boundaries.dedup();
        for pair in boundaries.windows(2) {
            let midpoint = (pair[0] + pair[1]).div_euclid(2);
            if !self.is_instant_available(zone, midpoint)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::parse_instant;

    fn zone(name: &str) -> OracleZone {
        OracleZone::new(TimeZone::get(name).unwrap())
    }

    fn ms(text: &str) -> i64 {
        parse_instant(text).unwrap()
    }

    #[test]
    fn the_validator_partition_labels_pieces_by_civil_conversion() {
        // America/Goose_Bay, 2009-11-01: at 00:01 local the clock goes back
        // to 23:01 of the previous date.
        let segments = zone("America/Goose_Bay")
            .partition(ms("2009-11-01T02:30:00Z"), ms("2009-11-01T04:00:00Z"))
            .unwrap();
        let view: Vec<(String, u8, i64)> = segments
            .iter()
            .map(|segment| {
                (
                    segment.date.to_string(),
                    segment.weekday,
                    (segment.end_ms - segment.start_ms) / MINUTE_MS,
                )
            })
            .collect();
        assert_eq!(
            view,
            [
                ("2009-10-31".to_owned(), 6, 30),
                ("2009-11-01".to_owned(), 7, 1),
                ("2009-10-31".to_owned(), 6, 59),
            ]
        );
        assert!(zone("UTC").partition(10, 10).unwrap().is_empty());
        assert!(zone("UTC").partition(20, 10).unwrap().is_empty());
    }

    #[test]
    fn it_agrees_with_the_generator_side_partition_on_shape() {
        // Two separate implementations, one answer.
        for (name, start, end) in [
            (
                "America/New_York",
                "2026-10-31T00:00:00Z",
                "2026-11-03T00:00:00Z",
            ),
            (
                "America/Santiago",
                "2026-09-05T00:00:00Z",
                "2026-09-08T00:00:00Z",
            ),
            (
                "Australia/Lord_Howe",
                "2026-04-03T12:00:00Z",
                "2026-04-06T12:00:00Z",
            ),
            (
                "Pacific/Apia",
                "2011-12-29T00:00:00Z",
                "2012-01-01T00:00:00Z",
            ),
            ("Asia/Seoul", "1908-03-31T00:00:00Z", "1908-04-02T00:00:00Z"),
        ] {
            let ours = zone(name).partition(ms(start), ms(end)).unwrap();
            let theirs = crate::time::partition_by_local_date(ms(start), ms(end), name).unwrap();
            assert_eq!(ours.len(), theirs.len(), "{name}");
            for (left, right) in ours.iter().zip(&theirs) {
                assert_eq!(left.date.to_string(), right.date.to_string(), "{name}");
                assert_eq!(left.weekday, right.weekday, "{name}");
                assert_eq!(
                    (left.start_ms, left.end_ms, left.local_midnight_ms),
                    (right.start_ms, right.end_ms, right.local_midnight_ms),
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn a_runaway_transition_walk_stops_at_the_guard() {
        let transitions = |count: usize| {
            (1..=count).map(|index| {
                (
                    i64::try_from(index).unwrap() * 1000,
                    if index % 2 == 0 { 0 } else { 3600 },
                )
            })
        };
        assert_eq!(ORACLE_MAX_TRANSITIONS, 4096);
        assert_eq!(
            walk_transitions(0, transitions(5000), i64::MAX),
            Err(TimeError::TooManyTransitions)
        );
        assert_eq!(
            walk_transitions(0, transitions(ORACLE_MAX_TRANSITIONS), i64::MAX),
            Err(TimeError::TooManyTransitions)
        );
        assert_eq!(
            walk_transitions(0, transitions(ORACLE_MAX_TRANSITIONS - 1), i64::MAX)
                .unwrap()
                .len(),
            ORACLE_MAX_TRANSITIONS - 1
        );
        // Transitions that keep the offset or reach the end do not count.
        assert_eq!(
            walk_transitions(0, [(5, 0), (7, 3600), (9, 3600), (20, 0)].into_iter(), 20),
            Ok(vec![7])
        );
    }

    #[test]
    fn clock_ranges_take_the_same_values_as_the_input_rules() {
        assert_eq!(oracle_clock_parts("9:05"), Some((9, 5)));
        assert_eq!(oracle_clock_parts("24:00"), Some((24, 0)));
        for value in ["24:01", "25:00", "09:60", "9:5", "", "0900", " 09:00"] {
            assert_eq!(oracle_clock_parts(value), None, "{value:?}");
        }
        assert!(oracle_range_contains("09:00", "10:00", 9.0 * 3600.0));
        assert!(oracle_range_contains(
            "09:00",
            "10:00",
            10.0 * 3600.0 - 0.001
        ));
        assert!(!oracle_range_contains("09:00", "10:00", 10.0 * 3600.0));
        assert!(!oracle_range_contains("10:00", "09:00", 9.5 * 3600.0));
        assert!(!oracle_range_contains("09:00", "soon", 9.5 * 3600.0));
    }
}
