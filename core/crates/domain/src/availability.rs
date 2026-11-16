//! Available hours: when the owner can work, week by week, with the
//! exceptions of single days and the limits of a day.
//!
//! The contract checks the shape of each value (`HH:MM`, a date, a weekday
//! from 1 to 7). The rules *between* values are checked here: a window ends
//! after it starts, an extra day has a window. The TypeScript core leaves
//! those to CHECK constraints of its database, so a request that breaks one
//! ends as a storage error (500) there; here it is 422 `validation_failed`.

use std::fmt;

use crate::instant::{days_from_civil, days_in_month};
use crate::{DomainError, ValidationIssue, Version};

/// A wall-clock time of day in whole minutes, `00:00` to `24:00`.
///
/// `24:00` is the end of a day and only an end: a window may run until
/// midnight, nothing starts at it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LocalTime(u16);

impl LocalTime {
    /// `24:00`.
    pub const END_OF_DAY: LocalTime = LocalTime(24 * 60);

    /// Parses `HH:MM` exactly as the contract's patterns accept it: two
    /// digits each, hours 00–23 and minutes 00–59, or `24:00`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        if bytes.len() != 5 || bytes[2] != b':' {
            return None;
        }
        let digit = |index: usize| -> Option<u16> {
            let byte = bytes[index];
            byte.is_ascii_digit().then(|| u16::from(byte - b'0'))
        };
        let hour = digit(0)? * 10 + digit(1)?;
        let minute = digit(3)? * 10 + digit(4)?;
        let valid = (hour <= 23 && minute <= 59) || (hour == 24 && minute == 0);
        valid.then_some(Self(hour * 60 + minute))
    }

    /// Minutes since the start of the day, 0 to 1440.
    #[must_use]
    pub fn minutes(self) -> u16 {
        self.0
    }

    /// True for `24:00`.
    #[must_use]
    pub fn is_end_of_day(self) -> bool {
        self == Self::END_OF_DAY
    }
}

impl fmt::Display for LocalTime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:02}:{:02}", self.0 / 60, self.0 % 60)
    }
}

/// A calendar date without a time or a zone, `YYYY-MM-DD`. Dates order by
/// year, month, day — the order of their text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CalendarDate {
    year: u16,
    month: u8,
    day: u8,
}

impl CalendarDate {
    /// Parses `YYYY-MM-DD` (years 0000–9999). `None` for another shape and
    /// for a date the calendar does not have (`2026-02-30`).
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let number = |range: std::ops::Range<usize>| -> Option<u16> {
            bytes[range].iter().try_fold(0_u16, |value, byte| {
                byte.is_ascii_digit()
                    .then(|| value * 10 + u16::from(byte - b'0'))
            })
        };
        let year = number(0..4)?;
        let month = number(5..7)?;
        let day = number(8..10)?;
        let real = (1..=12).contains(&month)
            && day >= 1
            && i64::from(day) <= days_in_month(i64::from(year), i64::from(month));
        real.then_some(Self {
            year,
            month: u8::try_from(month).ok()?,
            day: u8::try_from(day).ok()?,
        })
    }

    #[must_use]
    pub fn year(self) -> u16 {
        self.year
    }

    #[must_use]
    pub fn month(self) -> u8 {
        self.month
    }

    #[must_use]
    pub fn day(self) -> u8 {
        self.day
    }

    /// Days since 1970-01-01 (negative before it): the difference of two
    /// dates is the difference of these.
    #[must_use]
    pub fn days_since_epoch(self) -> i64 {
        days_from_civil(
            i64::from(self.year),
            i64::from(self.month),
            i64::from(self.day),
        )
    }
}

impl fmt::Display for CalendarDate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{:04}-{:02}-{:02}",
            self.year, self.month, self.day
        )
    }
}

/// What a weekly window is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AvailabilityKind {
    Work,
    Focus,
}

impl AvailabilityKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            AvailabilityKind::Work => "work",
            AvailabilityKind::Focus => "focus",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "work" => Some(AvailabilityKind::Work),
            "focus" => Some(AvailabilityKind::Focus),
            _ => None,
        }
    }
}

/// What a day's exception does: take time away or add some.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExceptionKind {
    Off,
    Extra,
}

impl ExceptionKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ExceptionKind::Off => "off",
            ExceptionKind::Extra => "extra",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "off" => Some(ExceptionKind::Off),
            "extra" => Some(ExceptionKind::Extra),
            _ => None,
        }
    }
}

/// Which estimate of a task a plan reserves time for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RiskLevel {
    P50,
    P90,
}

impl RiskLevel {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            RiskLevel::P50 => "p50",
            RiskLevel::P90 => "p90",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "p50" => Some(RiskLevel::P50),
            "p90" => Some(RiskLevel::P90),
            _ => None,
        }
    }
}

/// A window that repeats every week on one weekday.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvailabilityRule {
    /// ISO weekday: 1 is Monday, 7 is Sunday.
    pub weekday: u8,
    pub start: LocalTime,
    pub end: LocalTime,
    pub kind: AvailabilityKind,
}

/// One day that differs from its weekday's rules. Without a window an `off`
/// day is off entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvailabilityException {
    pub date: CalendarDate,
    pub kind: ExceptionKind,
    pub start: Option<LocalTime>,
    pub end: Option<LocalTime>,
}

/// Limits of a working day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvailabilityPrefs {
    pub max_daily_focus_min: u32,
    pub break_after_min: u32,
    pub break_min: u32,
    pub day_start: LocalTime,
    pub day_end: LocalTime,
    pub risk_level: RiskLevel,
}

/// The largest value of a minutes preference (the contract's `maximum`).
pub const MAX_PREFERENCE_MINUTES: u32 = 100_000;
/// Most weekly windows one availability holds (the contract's `maxItems`).
pub const MAX_AVAILABILITY_RULES: usize = 50;
/// Most exceptions one availability holds.
pub const MAX_AVAILABILITY_EXCEPTIONS: usize = 400;

impl Default for AvailabilityPrefs {
    /// What an owner who never set anything gets (`DEFAULT_PREFS` of the
    /// reference): four hours of focus a day, a 15-minute break after an
    /// hour, days from 08:00 to 18:00, median estimates.
    fn default() -> Self {
        Self {
            max_daily_focus_min: 240,
            break_after_min: 60,
            break_min: 15,
            day_start: LocalTime(8 * 60),
            day_end: LocalTime(18 * 60),
            risk_level: RiskLevel::P50,
        }
    }
}

/// What `PUT /availability` replaces: everything but the version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvailabilityPut {
    pub time_zone: String,
    pub rules: Vec<AvailabilityRule>,
    pub exceptions: Vec<AvailabilityException>,
    pub prefs: AvailabilityPrefs,
}

/// The owner's available hours.
///
/// `version` is the *availability version*: it moves with every change of
/// the hours and with every change of an appointment, because both change
/// what time a plan may use. A plan is approved against the version it was
/// made for (`If-Match: W/"availability:<n>"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Availability {
    pub version: Version,
    pub time_zone: String,
    pub rules: Vec<AvailabilityRule>,
    pub exceptions: Vec<AvailabilityException>,
    pub prefs: AvailabilityPrefs,
}

/// Checks the rules between the values of a `PUT /availability`.
///
/// Every finding is reported, each under the JSON pointer of the field that
/// would have to change.
pub fn validate_availability_put(put: &AvailabilityPut) -> Result<(), DomainError> {
    let mut issues = Vec::new();
    let mut issue = |path: String, message: &str| issues.push(ValidationIssue::new(path, message));

    if put.time_zone.is_empty() || put.time_zone.contains('\0') {
        issue("/timeZone".into(), "timeZone must name a time zone");
    }
    if put.rules.len() > MAX_AVAILABILITY_RULES {
        issue("/rules".into(), "rules must not hold more than 50 windows");
    }
    if put.exceptions.len() > MAX_AVAILABILITY_EXCEPTIONS {
        issue(
            "/exceptions".into(),
            "exceptions must not hold more than 400 days",
        );
    }
    for (index, rule) in put.rules.iter().enumerate() {
        if !(1..=7).contains(&rule.weekday) {
            issue(
                format!("/rules/{index}/weekday"),
                "weekday must be between 1 and 7",
            );
        }
        if rule.start.is_end_of_day() {
            issue(
                format!("/rules/{index}/startLocal"),
                "startLocal must be before 24:00",
            );
        } else if rule.end <= rule.start {
            issue(
                format!("/rules/{index}/endLocal"),
                "endLocal must be after startLocal",
            );
        }
    }
    for (index, exception) in put.exceptions.iter().enumerate() {
        match (exception.start, exception.end) {
            (Some(start), _) if start.is_end_of_day() => issue(
                format!("/exceptions/{index}/startLocal"),
                "startLocal must be before 24:00",
            ),
            (Some(start), Some(end)) if end <= start => issue(
                format!("/exceptions/{index}/endLocal"),
                "endLocal must be after startLocal",
            ),
            (None, _) if exception.kind == ExceptionKind::Extra => issue(
                format!("/exceptions/{index}/startLocal"),
                "an extra day needs startLocal and endLocal",
            ),
            (_, None) if exception.kind == ExceptionKind::Extra => issue(
                format!("/exceptions/{index}/endLocal"),
                "an extra day needs startLocal and endLocal",
            ),
            _ => {}
        }
    }
    let prefs = &put.prefs;
    for (name, minutes) in [
        ("maxDailyFocusMin", prefs.max_daily_focus_min),
        ("breakAfterMin", prefs.break_after_min),
        ("breakMin", prefs.break_min),
    ] {
        if minutes > MAX_PREFERENCE_MINUTES {
            issue(
                format!("/prefs/{name}"),
                "a minutes preference must not exceed 100000",
            );
        }
    }
    if prefs.day_start.is_end_of_day() {
        issue(
            "/prefs/dayStartLocal".into(),
            "dayStartLocal must be before 24:00",
        );
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(DomainError::ValidationFailed(issues))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(text: &str) -> LocalTime {
        LocalTime::parse(text).unwrap()
    }

    fn date(text: &str) -> CalendarDate {
        CalendarDate::parse(text).unwrap()
    }

    fn rule(weekday: u8, start: &str, end: &str) -> AvailabilityRule {
        AvailabilityRule {
            weekday,
            start: time(start),
            end: time(end),
            kind: AvailabilityKind::Work,
        }
    }

    fn exception(
        kind: ExceptionKind,
        start: Option<&str>,
        end: Option<&str>,
    ) -> AvailabilityException {
        AvailabilityException {
            date: date("2026-11-20"),
            kind,
            start: start.map(time),
            end: end.map(time),
        }
    }

    fn put(
        rules: Vec<AvailabilityRule>,
        exceptions: Vec<AvailabilityException>,
    ) -> AvailabilityPut {
        AvailabilityPut {
            time_zone: "Asia/Seoul".into(),
            rules,
            exceptions,
            prefs: AvailabilityPrefs::default(),
        }
    }

    fn paths(put: &AvailabilityPut) -> Vec<String> {
        match validate_availability_put(put) {
            Ok(()) => Vec::new(),
            Err(DomainError::ValidationFailed(issues)) => {
                issues.into_iter().map(|issue| issue.path).collect()
            }
            Err(other) => panic!("{other:?}"),
        }
    }

    #[test]
    fn local_times_parse_and_print_as_the_contract_writes_them() {
        assert_eq!(time("00:00").minutes(), 0);
        assert_eq!(time("09:30").minutes(), 570);
        assert_eq!(time("23:59").minutes(), 1439);
        assert_eq!(time("24:00"), LocalTime::END_OF_DAY);
        assert!(time("24:00").is_end_of_day());
        for text in ["00:00", "09:05", "23:59", "24:00"] {
            assert_eq!(time(text).to_string(), text);
        }
        assert!(time("09:00") < time("09:01"));
        assert!(time("23:59") < time("24:00"));
    }

    #[test]
    fn texts_that_are_not_a_time_of_day_are_refused() {
        for text in [
            "",
            "9:00",
            "09:0",
            "0900",
            "09-00",
            "24:01",
            "25:00",
            "23:60",
            "09:00:00",
            " 09:00",
            "09:00 ",
            "ab:cd",
            "０９:００",
            "+9:00",
        ] {
            assert_eq!(LocalTime::parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn dates_parse_print_and_order() {
        let day = date("2026-11-20");
        assert_eq!((day.year(), day.month(), day.day()), (2026, 11, 20));
        assert_eq!(day.to_string(), "2026-11-20");
        assert_eq!(date("0001-01-01").to_string(), "0001-01-01");
        assert!(date("2024-02-29") < date("2024-03-01"));
        assert!(date("2025-12-31") < date("2026-01-01"));
        assert_eq!(date("1970-01-01").days_since_epoch(), 0);
        assert_eq!(date("1969-12-31").days_since_epoch(), -1);
        assert_eq!(
            date("2027-01-01").days_since_epoch() - date("2026-01-01").days_since_epoch(),
            365
        );
        assert_eq!(
            date("2024-03-01").days_since_epoch() - date("2024-02-28").days_since_epoch(),
            2,
            "a leap day lies between"
        );
    }

    #[test]
    fn dates_the_calendar_does_not_have_are_refused() {
        for text in [
            "2026-02-29",
            "2026-04-31",
            "2026-13-01",
            "2026-00-10",
            "2026-01-00",
            "2026-1-01",
            "26-01-01",
            "2026/01/01",
            "2026-01-01T00:00:00Z",
            "",
            "２０２６-01-01",
            "2026-01-0a",
        ] {
            assert_eq!(CalendarDate::parse(text), None, "{text:?}");
        }
        assert!(CalendarDate::parse("2024-02-29").is_some());
    }

    #[test]
    fn kinds_round_trip_and_unknown_names_are_refused() {
        for kind in [AvailabilityKind::Work, AvailabilityKind::Focus] {
            assert_eq!(AvailabilityKind::parse(kind.as_str()), Some(kind));
        }
        for kind in [ExceptionKind::Off, ExceptionKind::Extra] {
            assert_eq!(ExceptionKind::parse(kind.as_str()), Some(kind));
        }
        for level in [RiskLevel::P50, RiskLevel::P90] {
            assert_eq!(RiskLevel::parse(level.as_str()), Some(level));
        }
        // `rest` is a value of the reference's table that its API never wrote.
        assert_eq!(AvailabilityKind::parse("rest"), None);
        assert_eq!(ExceptionKind::parse("OFF"), None);
        assert_eq!(RiskLevel::parse("p95"), None);
    }

    #[test]
    fn the_default_preferences_are_the_references() {
        let prefs = AvailabilityPrefs::default();
        assert_eq!(
            (
                prefs.max_daily_focus_min,
                prefs.break_after_min,
                prefs.break_min
            ),
            (240, 60, 15)
        );
        assert_eq!(prefs.day_start.to_string(), "08:00");
        assert_eq!(prefs.day_end.to_string(), "18:00");
        assert_eq!(prefs.risk_level, RiskLevel::P50);
    }

    #[test]
    fn ordinary_hours_pass() {
        let hours = put(
            vec![
                rule(1, "09:00", "12:00"),
                rule(1, "13:00", "18:00"),
                rule(7, "00:00", "24:00"),
            ],
            vec![
                exception(ExceptionKind::Off, None, None),
                exception(ExceptionKind::Off, Some("09:00"), Some("12:00")),
                exception(ExceptionKind::Extra, Some("19:00"), Some("24:00")),
            ],
        );
        assert_eq!(validate_availability_put(&hours), Ok(()));
        assert_eq!(validate_availability_put(&put(vec![], vec![])), Ok(()));
    }

    #[test]
    fn a_window_must_end_after_it_starts() {
        assert_eq!(
            paths(&put(vec![rule(1, "09:00", "09:00")], vec![])),
            ["/rules/0/endLocal"]
        );
        assert_eq!(
            paths(&put(
                vec![rule(1, "09:00", "10:00"), rule(2, "18:00", "09:00")],
                vec![]
            )),
            ["/rules/1/endLocal"]
        );
        assert_eq!(
            paths(&put(
                vec![],
                vec![exception(ExceptionKind::Off, Some("12:00"), Some("09:00"))]
            )),
            ["/exceptions/0/endLocal"]
        );
    }

    #[test]
    fn an_extra_day_needs_its_window_and_an_off_day_does_not() {
        assert_eq!(
            paths(&put(
                vec![],
                vec![exception(ExceptionKind::Extra, None, None)]
            )),
            ["/exceptions/0/startLocal"]
        );
        assert_eq!(
            paths(&put(
                vec![],
                vec![exception(ExceptionKind::Extra, Some("09:00"), None)]
            )),
            ["/exceptions/0/endLocal"]
        );
        assert_eq!(
            paths(&put(
                vec![],
                vec![exception(ExceptionKind::Extra, None, Some("09:00"))]
            )),
            ["/exceptions/0/startLocal"]
        );
        // As in the reference's table: an off day may name one side only.
        assert_eq!(
            validate_availability_put(&put(
                vec![],
                vec![
                    exception(ExceptionKind::Off, Some("09:00"), None),
                    exception(ExceptionKind::Off, None, Some("12:00")),
                ]
            )),
            Ok(())
        );
    }

    #[test]
    fn nothing_starts_at_the_end_of_the_day_and_values_stay_in_range() {
        let mut hours = put(
            vec![
                AvailabilityRule {
                    weekday: 8,
                    ..rule(1, "09:00", "10:00")
                },
                AvailabilityRule {
                    start: LocalTime::END_OF_DAY,
                    ..rule(1, "09:00", "24:00")
                },
            ],
            vec![exception(ExceptionKind::Off, Some("24:00"), None)],
        );
        hours.prefs.break_min = MAX_PREFERENCE_MINUTES + 1;
        hours.prefs.day_start = LocalTime::END_OF_DAY;
        hours.time_zone = String::new();
        assert_eq!(
            paths(&hours),
            [
                "/timeZone",
                "/rules/0/weekday",
                "/rules/1/startLocal",
                "/exceptions/0/startLocal",
                "/prefs/breakMin",
                "/prefs/dayStartLocal",
            ]
        );
        let mut at_the_limit = put(vec![], vec![]);
        at_the_limit.prefs.max_daily_focus_min = MAX_PREFERENCE_MINUTES;
        assert_eq!(validate_availability_put(&at_the_limit), Ok(()));
    }

    #[test]
    fn the_lists_are_bounded_like_the_contract() {
        let full = put(
            vec![rule(1, "09:00", "10:00"); MAX_AVAILABILITY_RULES],
            vec![exception(ExceptionKind::Off, None, None); MAX_AVAILABILITY_EXCEPTIONS],
        );
        assert_eq!(validate_availability_put(&full), Ok(()));
        let over = put(
            vec![rule(1, "09:00", "10:00"); MAX_AVAILABILITY_RULES + 1],
            vec![exception(ExceptionKind::Off, None, None); MAX_AVAILABILITY_EXCEPTIONS + 1],
        );
        assert_eq!(paths(&over), ["/rules", "/exceptions"]);
    }

    #[test]
    fn messages_name_rules_and_never_repeat_values() {
        let Err(DomainError::ValidationFailed(issues)) =
            validate_availability_put(&put(vec![rule(1, "17:45", "03:15")], vec![]))
        else {
            panic!("an inverted window must be refused");
        };
        assert_eq!(issues[0].message, "endLocal must be after startLocal");
        assert!(!issues[0].message.contains("17:45"));
    }
}
