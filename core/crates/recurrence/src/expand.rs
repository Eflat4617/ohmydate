//! Expansion of an appointment into the occurrences that overlap a window.
//! A port of `expandOccurrences` and `clipOccurrence` in
//! `services/api/src/application/rrule.ts`; the control flow is kept line
//! for line, limits and guards included, because the same input must give
//! the same occurrences.

use std::fmt;
use std::ops::ControlFlow;

use crate::civil::{Date, days_in_month};
use crate::rule::{Frequency, MAX_OCCURRENCES, Rule, RuleError, Until};
use crate::zone::{WallTime, Zone, print_milliseconds, print_shortest};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Longest window one expansion accepts: 366 days.
pub const MAX_RANGE_MS: i64 = 366 * DAY_MS;

/// A rule without `COUNT` that started longer ago than this is not walked
/// from its start: the walk jumps to the window (`MAX_LOOKBACK_MS`).
pub const MAX_LOOKBACK_MS: i64 = 10 * 366 * DAY_MS;

/// Days the walk of a rule without `COUNT` may visit.
const MAX_DAY_STEPS: u32 = 40_000;

/// Periods the walk of a rule with `COUNT` may visit
/// (`MAX_PERIOD_ITERATIONS`).
const MAX_PERIOD_STEPS: u32 = 200_000;

/// An appointment as the expansion needs it (`RecurringCommitment`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Series<'a> {
    /// Start of the first occurrence, epoch milliseconds.
    pub start_ms: i64,
    /// End of the first occurrence. Every occurrence has the same length in
    /// elapsed time, also across a clock change.
    pub end_ms: i64,
    /// IANA name of the zone whose wall clock the rule repeats on.
    pub time_zone: &'a str,
    /// The `RRULE` text; `None` for an appointment that happens once.
    pub rule: Option<&'a str>,
}

/// How the reference prints the instants of an occurrence. It differs by
/// where the occurrence comes from, and the API returns the text as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Form {
    /// The appointment's own stored instants (`Date.toISOString`): always
    /// three fraction digits.
    Stored,
    /// An instant the expansion computed (`Temporal.Instant.toString`): no
    /// fraction when it is zero.
    Computed,
}

/// One occurrence: `[start_ms, end_ms)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Occurrence {
    pub start_ms: i64,
    pub end_ms: i64,
    form: Form,
}

impl Occurrence {
    fn print(self, epoch_ms: i64) -> String {
        match self.form {
            Form::Stored => print_milliseconds(epoch_ms),
            // An occurrence is only built from instants the date library
            // produced or accepted, so the fallback is not reached.
            Form::Computed => {
                print_shortest(epoch_ms).unwrap_or_else(|| print_milliseconds(epoch_ms))
            }
        }
    }

    /// `startAt` exactly as the reference returns it: an appointment without
    /// a rule keeps its stored text (`2026-11-11T09:00:00.000Z`), an expanded
    /// occurrence is printed without a zero fraction (`2026-11-11T09:00:00Z`).
    #[must_use]
    pub fn start_at(&self) -> String {
        self.print(self.start_ms)
    }

    /// `endAt`, printed like [`Occurrence::start_at`].
    #[must_use]
    pub fn end_at(&self) -> String {
        self.print(self.end_ms)
    }
}

/// Why an expansion gives no list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpandError {
    /// The rule text is not a supported rule.
    Rule(RuleError),
    /// The window ends at or before its start.
    InvalidRange,
    /// The window is longer than [`MAX_RANGE_MS`].
    RangeTooLong,
    /// The appointment ends at or before its start.
    InvalidInterval,
    /// More than [`MAX_OCCURRENCES`] occurrences overlap the window.
    TooManyOccurrences,
    /// The walk did not reach the end of the window within its step limit
    /// (an appointment that lasts for decades and started long ago).
    SafetyBound,
    /// The time zone is not in the tz database. The reference has no such
    /// case — a stored zone was checked by the contract — and fails with an
    /// internal error there.
    UnknownTimeZone,
    /// A date of the walk is outside what the date library represents
    /// (years −9999 to 9999). The reference computes with a wider range;
    /// the port refuses instead of answering something else.
    OutOfRange,
}

impl ExpandError {
    /// A stable name, for tests and the differential check.
    #[must_use]
    pub fn kind(self) -> &'static str {
        match self {
            ExpandError::Rule(error) => error.kind(),
            ExpandError::InvalidRange => "invalid_range",
            ExpandError::RangeTooLong => "range_too_long",
            ExpandError::InvalidInterval => "invalid_interval",
            ExpandError::TooManyOccurrences => "too_many_occurrences",
            ExpandError::SafetyBound => "safety_bound",
            ExpandError::UnknownTimeZone => "unknown_time_zone",
            ExpandError::OutOfRange => "out_of_range",
        }
    }

    /// Text of the rejection. It never repeats the rule or the title.
    #[must_use]
    pub fn message(self) -> &'static str {
        match self {
            ExpandError::Rule(error) => error.message(),
            ExpandError::InvalidRange => "occurrence range is not a valid interval",
            ExpandError::RangeTooLong => "occurrence range exceeds 366 days",
            ExpandError::InvalidInterval => "commitment interval is invalid",
            ExpandError::TooManyOccurrences => "commitment expands to more than 2000 occurrences",
            ExpandError::SafetyBound => "commitment recurrence expansion exceeded its safety bound",
            ExpandError::UnknownTimeZone => "commitment time zone is not in the tz database",
            ExpandError::OutOfRange => "commitment recurrence leaves the supported date range",
        }
    }
}

impl fmt::Display for ExpandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for ExpandError {}

impl From<RuleError> for ExpandError {
    fn from(error: RuleError) -> Self {
        ExpandError::Rule(error)
    }
}

/// `matches()`: does the rule select `date`, for a series starting on
/// `start`? Used by the day-by-day walk of a rule without `COUNT`.
fn selects(rule: &Rule, start: Date, date: Date) -> bool {
    let days = date.days() - start.days();
    if days < 0 {
        return false;
    }
    match rule.frequency {
        Frequency::Daily => days % rule.interval == 0,
        Frequency::Weekly => {
            let week = (days + (start.weekday() - 1)).div_euclid(7);
            if week % rule.interval != 0 {
                return false;
            }
            if rule.by_day.is_empty() {
                date.weekday() == start.weekday()
            } else {
                rule.by_day.contains(&date.weekday())
            }
        }
        Frequency::Monthly => {
            let months = (date.year - start.year) * 12 + (date.month - start.month);
            if months < 0 || months % rule.interval != 0 {
                return false;
            }
            if rule.by_month_day.is_empty() {
                date.day == start.day
            } else {
                rule.by_month_day.contains(&date.day)
            }
        }
        Frequency::Yearly => {
            let years = date.year - start.year;
            years % rule.interval == 0 && date.month == start.month && date.day == start.day
        }
    }
}

fn sorted_unique(values: &[i64], fallback: i64) -> Vec<i64> {
    let mut allowed = if values.is_empty() {
        vec![fallback]
    } else {
        values.to_vec()
    };
    allowed.sort_unstable();
    allowed.dedup();
    allowed
}

/// `matchDates()`: the dates the rule selects, in order, walking whole
/// periods from `start` and giving each to `visit` until it breaks or a
/// date after `stop` comes up.
///
/// A date the calendar does not have (February 29 outside a leap year, day
/// 31 of a short month) is skipped, never moved to a nearby day.
fn walk_periods(
    rule: &Rule,
    start: Date,
    stop: Date,
    mut visit: impl FnMut(Date) -> Result<ControlFlow<()>, ExpandError>,
) -> Result<(), ExpandError> {
    let mut steps = 0_u32;
    let mut tick = || {
        steps += 1;
        if steps > MAX_PERIOD_STEPS {
            Err(ExpandError::SafetyBound)
        } else {
            Ok(())
        }
    };
    match rule.frequency {
        Frequency::Daily => {
            let mut date = start;
            loop {
                tick()?;
                if date > stop || visit(date)?.is_break() {
                    return Ok(());
                }
                date = date.plus_days(rule.interval);
            }
        }
        Frequency::Weekly => {
            let allowed = sorted_unique(&rule.by_day, start.weekday());
            let mut week = 0_i64;
            loop {
                tick()?;
                for weekday in &allowed {
                    let offset = week * 7 - (start.weekday() - 1) + (weekday - 1);
                    if offset < 0 {
                        continue;
                    }
                    let date = start.plus_days(offset);
                    if date > stop || visit(date)?.is_break() {
                        return Ok(());
                    }
                }
                week += rule.interval;
            }
        }
        Frequency::Monthly => {
            let allowed = sorted_unique(&rule.by_month_day, start.day);
            // Months since year 0, so adding an interval is one addition.
            let mut month_index = start.year * 12 + (start.month - 1);
            loop {
                tick()?;
                let year = month_index.div_euclid(12);
                let month = month_index.rem_euclid(12) + 1;
                if (Date {
                    year,
                    month,
                    day: 1,
                }) > stop
                {
                    return Ok(());
                }
                for &day in &allowed {
                    if day > days_in_month(year, month) {
                        continue;
                    }
                    let date = Date { year, month, day };
                    if date < start {
                        continue;
                    }
                    if date > stop || visit(date)?.is_break() {
                        return Ok(());
                    }
                }
                month_index += rule.interval;
            }
        }
        Frequency::Yearly => {
            let mut year = start.year;
            loop {
                tick()?;
                let first = Date {
                    year,
                    month: start.month,
                    day: 1,
                };
                if first > stop {
                    return Ok(());
                }
                if start.day <= days_in_month(year, start.month) {
                    let date = Date {
                        year,
                        month: start.month,
                        day: start.day,
                    };
                    if date > stop || visit(date)?.is_break() {
                        return Ok(());
                    }
                }
                year += rule.interval;
            }
        }
    }
}

/// Expands an appointment into the occurrences that overlap `[from, to)`
/// (`expandOccurrences`).
///
/// The rule repeats on the appointment's wall clock in its own time zone. A
/// wall time that a clock change skips moves forward by the length of the
/// gap, and one that happens twice is its first occurrence (`Temporal`'s
/// `compatible`). `UNTIL` is inclusive; its date form means the end of that
/// day in the appointment's zone.
///
/// A rule with `COUNT` is walked period by period from its start, so the
/// count is exact however far the window is. Any other rule is walked day by
/// day, from its start or — when that is more than ten years before the
/// window — from just before the window.
pub fn expand(
    series: &Series<'_>,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<Occurrence>, ExpandError> {
    if to_ms <= from_ms {
        return Err(ExpandError::InvalidRange);
    }
    if to_ms - from_ms > MAX_RANGE_MS {
        return Err(ExpandError::RangeTooLong);
    }
    let (start_ms, end_ms) = (series.start_ms, series.end_ms);
    if end_ms <= start_ms {
        return Err(ExpandError::InvalidInterval);
    }
    let Some(rule_text) = series.rule else {
        let overlaps = end_ms > from_ms && start_ms < to_ms;
        return Ok(overlaps
            .then_some(Occurrence {
                start_ms,
                end_ms,
                form: Form::Stored,
            })
            .into_iter()
            .collect());
    };

    let rule = Rule::parse(rule_text)?;
    let duration_ms = end_ms - start_ms;
    // The recurrence ended before the window: nothing can overlap it. The
    // reference reaches this without touching the zone when `UNTIL` is an
    // instant, so the zone is resolved only afterwards.
    let ended = |until_ms: i64| until_ms + duration_ms <= from_ms;
    if let Some(Until::Instant(until_ms)) = rule.until
        && ended(until_ms)
    {
        return Ok(Vec::new());
    }
    let zone = Zone::named(series.time_zone).ok_or(ExpandError::UnknownTimeZone)?;
    let until_ms = match rule.until {
        None => None,
        Some(Until::Instant(until_ms)) => Some(until_ms),
        Some(Until::Date(date)) => Some(
            zone.instant_of(date, WallTime::END_OF_DAY)
                .ok_or(ExpandError::OutOfRange)?,
        ),
    };
    if until_ms.is_some_and(ended) {
        return Ok(Vec::new());
    }

    let (start_date, wall_time) = zone.local_at(start_ms).ok_or(ExpandError::OutOfRange)?;
    let mut occurrences: Vec<Occurrence> = Vec::new();
    // Keeps an occurrence when it overlaps the window.
    let push =
        |occurrences: &mut Vec<Occurrence>, occurrence_start: i64| -> Result<(), ExpandError> {
            let occurrence_end = occurrence_start + duration_ms;
            if occurrence_end > from_ms && occurrence_start < to_ms {
                // Both ends must be printable, or the occurrence is refused
                // rather than printed in another form.
                if print_shortest(occurrence_end).is_none() {
                    return Err(ExpandError::OutOfRange);
                }
                occurrences.push(Occurrence {
                    start_ms: occurrence_start,
                    end_ms: occurrence_end,
                    form: Form::Computed,
                });
                if occurrences.len() > MAX_OCCURRENCES {
                    return Err(ExpandError::TooManyOccurrences);
                }
            }
            Ok(())
        };

    if let Some(count) = rule.count {
        // COUNT is bounded by its own value: every selected date from the
        // start is counted, whether or not it overlaps the window.
        let (stop_date, _) = zone.local_at(to_ms).ok_or(ExpandError::OutOfRange)?;
        let mut matched = 0_i64;
        walk_periods(&rule, start_date, stop_date, |date| {
            let occurrence_start = zone
                .instant_of(date, wall_time)
                .ok_or(ExpandError::OutOfRange)?;
            if occurrence_start >= to_ms {
                return Ok(ControlFlow::Break(()));
            }
            if until_ms.is_some_and(|until_ms| occurrence_start > until_ms) {
                return Ok(ControlFlow::Break(()));
            }
            matched += 1;
            push(&mut occurrences, occurrence_start)?;
            Ok(if matched >= count {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            })
        })?;
        return Ok(occurrences);
    }

    let mut cursor = start_date;
    if from_ms - start_ms > MAX_LOOKBACK_MS {
        // Jump whole periods instead of walking years of days. One day of
        // margin keeps an occurrence that starts before the window and
        // reaches into it.
        let jump_to = start_ms.max(from_ms - duration_ms - DAY_MS);
        let (target, _) = zone.local_at(jump_to).ok_or(ExpandError::OutOfRange)?;
        if target > start_date {
            cursor = target;
        }
    }
    let mut steps = 0_u32;
    while steps < MAX_DAY_STEPS {
        steps += 1;
        let occurrence_start = zone
            .instant_of(cursor, wall_time)
            .ok_or(ExpandError::OutOfRange)?;
        if occurrence_start >= to_ms {
            break;
        }
        if until_ms.is_some_and(|until_ms| occurrence_start > until_ms) {
            break;
        }
        if selects(&rule, start_date, cursor) {
            push(&mut occurrences, occurrence_start)?;
        }
        cursor = cursor.plus_days(1);
    }
    // As in the reference, a walk that ends on its last allowed step is
    // refused even when that step reached the end of the window.
    if steps >= MAX_DAY_STEPS {
        return Err(ExpandError::SafetyBound);
    }
    Ok(occurrences)
}

/// The part of `[start, end)` inside `[from, to)`, or `None` when they do
/// not overlap (`clipOccurrence`). The result prints with three fraction
/// digits, as the reference returns it.
#[must_use]
pub fn clip(start_ms: i64, end_ms: i64, from_ms: i64, to_ms: i64) -> Option<Occurrence> {
    let start = start_ms.max(from_ms);
    let end = end_ms.min(to_ms);
    (end > start).then_some(Occurrence {
        start_ms: start,
        end_ms: end,
        form: Form::Stored,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 3_600_000;
    /// 2026-11-11T09:00:00Z, a Wednesday.
    const START: i64 = 1_794_387_600_000;

    fn date(year: i64, month: i64, day: i64) -> Date {
        Date::new(year, month, day).unwrap()
    }

    fn rule(text: &str) -> Rule {
        Rule::parse(text).unwrap()
    }

    fn series(rule: Option<&'static str>) -> Series<'static> {
        Series {
            start_ms: START,
            end_ms: START + HOUR_MS,
            time_zone: "UTC",
            rule,
        }
    }

    fn starts(occurrences: &[Occurrence]) -> Vec<String> {
        occurrences.iter().map(Occurrence::start_at).collect()
    }

    fn walked(text: &str, start: Date, stop: Date, limit: usize) -> Vec<Date> {
        let mut dates = Vec::new();
        walk_periods(&rule(text), start, stop, |date| {
            dates.push(date);
            Ok(if dates.len() >= limit {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            })
        })
        .unwrap();
        dates
    }

    #[test]
    fn an_appointment_without_a_rule_is_itself_when_it_overlaps() {
        let once = series(None);
        let found = expand(&once, START - HOUR_MS, START + 1).unwrap();
        assert_eq!(found.len(), 1);
        // Its own stored text, with the fraction.
        assert_eq!(found[0].start_at(), "2026-11-11T09:00:00.000Z");
        assert_eq!(found[0].end_at(), "2026-11-11T10:00:00.000Z");
        // The window is half-open on both tests: touching is not overlap.
        assert!(
            expand(&once, START + HOUR_MS, START + 2 * HOUR_MS)
                .unwrap()
                .is_empty()
        );
        assert!(expand(&once, START - HOUR_MS, START).unwrap().is_empty());
        assert_eq!(
            expand(&once, START + HOUR_MS - 1, START + HOUR_MS)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn windows_and_intervals_are_checked_before_anything_else() {
        let daily = series(Some("FREQ=DAILY"));
        assert_eq!(expand(&daily, START, START), Err(ExpandError::InvalidRange));
        assert_eq!(
            expand(&daily, START, START - 1),
            Err(ExpandError::InvalidRange)
        );
        assert_eq!(
            expand(&daily, START, START + MAX_RANGE_MS + 1),
            Err(ExpandError::RangeTooLong)
        );
        assert!(expand(&daily, START, START + MAX_RANGE_MS).is_ok());
        let inverted = Series {
            end_ms: START,
            ..daily
        };
        assert_eq!(
            expand(&inverted, START, START + DAY_MS),
            Err(ExpandError::InvalidInterval)
        );
        // The window is judged first, then the interval, then the rule.
        let broken = Series {
            end_ms: START,
            rule: Some("FREQ=NEVER"),
            ..daily
        };
        assert_eq!(
            expand(&broken, START, START),
            Err(ExpandError::InvalidRange)
        );
        assert_eq!(
            expand(&series(Some("FREQ=NEVER")), START, START + DAY_MS),
            Err(ExpandError::Rule(RuleError::UnsupportedFrequency))
        );
    }

    #[test]
    fn computed_occurrences_print_without_a_zero_fraction() {
        let found = expand(
            &series(Some("FREQ=DAILY;COUNT=2")),
            START,
            START + 3 * DAY_MS,
        )
        .unwrap();
        assert_eq!(
            starts(&found),
            ["2026-11-11T09:00:00Z", "2026-11-12T09:00:00Z"]
        );
        assert_eq!(found[1].end_at(), "2026-11-12T10:00:00Z");
        let with_fraction = Series {
            start_ms: START + 250,
            end_ms: START + HOUR_MS + 250,
            ..series(Some("FREQ=DAILY"))
        };
        let found = expand(&with_fraction, START, START + DAY_MS).unwrap();
        assert_eq!(starts(&found), ["2026-11-11T09:00:00.25Z"]);
    }

    #[test]
    fn the_day_walk_selects_by_frequency_interval_and_lists() {
        let wednesday = date(2026, 11, 11);
        let daily = rule("FREQ=DAILY;INTERVAL=3");
        assert!(selects(&daily, wednesday, wednesday));
        assert!(!selects(&daily, wednesday, date(2026, 11, 12)));
        assert!(selects(&daily, wednesday, date(2026, 11, 14)));
        assert!(
            !selects(&daily, wednesday, date(2026, 11, 8)),
            "before the start"
        );

        // Weeks are counted from the Monday of the start's week.
        let weekly = rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
        assert!(
            selects(&weekly, wednesday, date(2026, 11, 13)),
            "Friday, week 0"
        );
        assert!(
            !selects(&weekly, wednesday, date(2026, 11, 16)),
            "Monday, week 1"
        );
        assert!(
            !selects(&weekly, wednesday, date(2026, 11, 20)),
            "Friday, week 1"
        );
        assert!(
            selects(&weekly, wednesday, date(2026, 11, 23)),
            "Monday, week 2"
        );
        assert!(
            !selects(&weekly, wednesday, date(2026, 11, 9)),
            "Monday before the start"
        );
        let plain_weekly = rule("FREQ=WEEKLY");
        assert!(selects(&plain_weekly, wednesday, date(2026, 11, 18)));
        assert!(!selects(&plain_weekly, wednesday, date(2026, 11, 17)));

        let monthly = rule("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,31");
        let start = date(2026, 1, 15);
        assert!(selects(&monthly, start, date(2026, 1, 31)));
        assert!(!selects(&monthly, start, date(2026, 2, 1)), "odd month");
        assert!(selects(&monthly, start, date(2026, 3, 1)));
        assert!(
            !selects(&monthly, start, date(2026, 1, 1)),
            "before the start"
        );
        let plain_monthly = rule("FREQ=MONTHLY");
        assert!(selects(&plain_monthly, start, date(2026, 2, 15)));
        assert!(!selects(&plain_monthly, start, date(2026, 2, 14)));

        let yearly = rule("FREQ=YEARLY;INTERVAL=4");
        let leap_day = date(2024, 2, 29);
        assert!(selects(&yearly, leap_day, date(2028, 2, 29)));
        assert!(!selects(&yearly, leap_day, date(2026, 2, 28)));
        assert!(!selects(&rule("FREQ=YEARLY"), leap_day, date(2025, 3, 1)));
    }

    #[test]
    fn the_period_walk_gives_the_same_dates_as_the_day_walk() {
        for (text, start) in [
            ("FREQ=DAILY;INTERVAL=3", date(2026, 11, 11)),
            ("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO,MO", date(2026, 11, 11)),
            ("FREQ=WEEKLY;BYDAY=SU,WE", date(2026, 11, 11)),
            ("FREQ=WEEKLY;INTERVAL=3", date(2026, 11, 15)),
            ("FREQ=MONTHLY;BYMONTHDAY=31,30,29,1", date(2026, 1, 30)),
            ("FREQ=MONTHLY;INTERVAL=5", date(2026, 8, 31)),
            ("FREQ=YEARLY", date(2024, 2, 29)),
            ("FREQ=YEARLY;INTERVAL=3", date(2026, 12, 31)),
        ] {
            let parsed = rule(text);
            let stop = start.plus_days(3_000);
            let by_period = walked(text, start, stop, usize::MAX);
            let by_day: Vec<Date> = (0..=3_000)
                .map(|offset| start.plus_days(offset))
                .filter(|date| selects(&parsed, start, *date))
                .collect();
            assert!(by_period.len() >= 3, "{text}");
            assert_eq!(by_period, by_day, "{text}");
        }
    }

    #[test]
    fn dates_the_calendar_lacks_are_skipped_not_moved() {
        assert_eq!(
            walked(
                "FREQ=MONTHLY",
                date(2026, 1, 31),
                date(2026, 6, 30),
                usize::MAX
            ),
            [date(2026, 1, 31), date(2026, 3, 31), date(2026, 5, 31)]
        );
        assert_eq!(
            walked(
                "FREQ=YEARLY",
                date(2024, 2, 29),
                date(2033, 1, 1),
                usize::MAX
            ),
            [date(2024, 2, 29), date(2028, 2, 29), date(2032, 2, 29)]
        );
        // The walk stops when the consumer has enough.
        assert_eq!(
            walked("FREQ=DAILY", date(2026, 1, 1), date(2099, 1, 1), 2).len(),
            2
        );
    }

    #[test]
    fn a_count_is_spent_on_every_date_from_the_start_not_only_on_the_window() {
        // Five Wednesdays from 11 November: the last is 9 December.
        let weekly = series(Some("FREQ=WEEKLY;COUNT=5"));
        let december = expand(
            &weekly,
            START + 21 * DAY_MS - 9 * HOUR_MS,
            START + 60 * DAY_MS,
        );
        assert_eq!(
            starts(&december.unwrap()),
            ["2026-12-02T09:00:00Z", "2026-12-09T09:00:00Z"]
        );
        assert!(
            expand(&weekly, START + 35 * DAY_MS, START + 60 * DAY_MS)
                .unwrap()
                .is_empty(),
            "the count ran out before the window"
        );
    }

    #[test]
    fn until_is_inclusive_and_an_ended_rule_gives_nothing() {
        // 2026-11-13T09:00:00Z, the start of the third occurrence.
        let through_third = series(Some("FREQ=DAILY;UNTIL=20261113T090000Z"));
        assert_eq!(
            expand(&through_third, START, START + 10 * DAY_MS)
                .unwrap()
                .len(),
            3
        );
        let before_third = series(Some("FREQ=DAILY;UNTIL=20261113T085959Z"));
        assert_eq!(
            expand(&before_third, START, START + 10 * DAY_MS)
                .unwrap()
                .len(),
            2
        );
        // Ended before the window: empty, and the zone is never consulted.
        let ended = Series {
            time_zone: "Not/A_Zone",
            ..through_third
        };
        assert_eq!(
            expand(&ended, START + 30 * DAY_MS, START + 31 * DAY_MS),
            Ok(Vec::new())
        );
        assert_eq!(
            expand(&ended, START, START + DAY_MS),
            Err(ExpandError::UnknownTimeZone)
        );
        // The last occurrence still reaches into a window that starts
        // inside it.
        let tail = expand(&through_third, START + 2 * DAY_MS + 1, START + 9 * DAY_MS).unwrap();
        assert_eq!(starts(&tail), ["2026-11-13T09:00:00Z"]);
    }

    #[test]
    fn more_than_two_thousand_overlapping_occurrences_are_refused() {
        // A daily appointment that lasts six years: every day's occurrence
        // is still running when the window opens.
        let long = Series {
            start_ms: START,
            end_ms: START + 6 * 366 * DAY_MS,
            time_zone: "UTC",
            rule: Some("FREQ=DAILY"),
        };
        let from = START + 5 * 366 * DAY_MS + 300 * DAY_MS;
        assert_eq!(
            expand(&long, from, from + DAY_MS),
            Err(ExpandError::TooManyOccurrences)
        );
        // Exactly 2,000 is allowed: day 0 to day 1,999 start before the end.
        let exactly = expand(&long, START + 1_999 * DAY_MS, START + 1_999 * DAY_MS + 1).unwrap();
        assert_eq!(exactly.len(), MAX_OCCURRENCES);
    }

    #[test]
    fn a_walk_that_cannot_reach_the_window_stops_at_its_guard() {
        // Started in 1975 and still running in 2090: the jump towards the
        // window cannot pass the start, and 40,000 days from it end in 2084.
        let start_ms = 157_766_400_000; // 1975-01-01T00:00:00Z
        let ancient = Series {
            start_ms,
            end_ms: start_ms + 116 * 366 * DAY_MS,
            time_zone: "UTC",
            rule: Some("FREQ=YEARLY"),
        };
        let from = 3_786_912_000_000; // 2090-01-01T00:00:00Z
        assert_eq!(
            expand(&ancient, from, from + DAY_MS),
            Err(ExpandError::SafetyBound)
        );
        // The same rule with a short appointment jumps and answers.
        let short = Series {
            end_ms: start_ms + HOUR_MS,
            ..ancient
        };
        assert_eq!(
            starts(&expand(&short, from, from + DAY_MS).unwrap()),
            ["2090-01-01T00:00:00Z"]
        );
    }

    #[test]
    fn dates_beyond_the_library_range_are_refused() {
        // 9999-12-30T12:00:00Z daily: the walk reaches 31 December, which
        // the date library does not convert in every zone.
        let start_ms = 253_402_171_200_000;
        let last_days = Series {
            start_ms,
            end_ms: start_ms + HOUR_MS,
            time_zone: "Asia/Seoul",
            rule: Some("FREQ=DAILY"),
        };
        assert_eq!(
            expand(&last_days, start_ms, start_ms + 2 * DAY_MS),
            Err(ExpandError::OutOfRange)
        );
    }

    #[test]
    fn clipping_keeps_the_part_inside_the_window() {
        let clipped = clip(START, START + HOUR_MS, START + 1_000, START + 2_000).unwrap();
        assert_eq!(clipped.start_at(), "2026-11-11T09:00:01.000Z");
        assert_eq!(clipped.end_at(), "2026-11-11T09:00:02.000Z");
        let whole = clip(START, START + HOUR_MS, START - 5, START + 2 * HOUR_MS).unwrap();
        assert_eq!((whole.start_ms, whole.end_ms), (START, START + HOUR_MS));
        assert_eq!(
            clip(START, START + HOUR_MS, START + HOUR_MS, START + 2 * HOUR_MS),
            None
        );
        assert_eq!(clip(START, START + HOUR_MS, START - HOUR_MS, START), None);
        assert_eq!(
            clip(START, START, START - 1, START + 1),
            None,
            "empty interval"
        );
    }

    #[test]
    fn every_rejection_has_a_name_and_a_message_without_user_text() {
        let all = [
            ExpandError::Rule(RuleError::UnsupportedPart),
            ExpandError::InvalidRange,
            ExpandError::RangeTooLong,
            ExpandError::InvalidInterval,
            ExpandError::TooManyOccurrences,
            ExpandError::SafetyBound,
            ExpandError::UnknownTimeZone,
            ExpandError::OutOfRange,
        ];
        let mut kinds: Vec<&str> = all.iter().map(|error| error.kind()).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), all.len());
        for error in all {
            assert_eq!(error.to_string(), error.message());
            assert!(!error.message().is_empty());
        }
    }
}
