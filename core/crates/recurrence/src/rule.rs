//! The recurrence rule: the bounded subset of RFC 5545 `RRULE` the planner
//! supports. A port of `parseRRule` in `services/api/src/application/rrule.ts`.
//!
//! The reference is written with JavaScript's string functions and the port
//! keeps their corners, because a rule that parses there must parse here to
//! the same thing: `split('=', 2)` drops what follows a second `=`,
//! `toUpperCase` is Unicode-aware, and `Number.parseInt` skips leading white
//! space and stops at the first character that is not a digit.

use std::fmt;

use crate::civil::{Date, days_in_month};

/// Most occurrences one expansion may return, and the largest `COUNT`.
pub const MAX_OCCURRENCES: usize = 2_000;

const MAX_INTERVAL: i64 = 1_000;
const DAY_MS: i64 = 86_400_000;

/// `FREQ`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Frequency {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Frequency::Daily => "DAILY",
            Frequency::Weekly => "WEEKLY",
            Frequency::Monthly => "MONTHLY",
            Frequency::Yearly => "YEARLY",
        }
    }
}

/// `UNTIL`: the last moment an occurrence may start (inclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Until {
    /// `UNTIL=20261113T090000Z`: that instant, in epoch milliseconds.
    Instant(i64),
    /// `UNTIL=20261113`: the end of that day on the appointment's own wall
    /// clock.
    Date(Date),
}

/// A parsed rule (`ParsedRule` of the reference).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub frequency: Frequency,
    /// 1 to 1,000.
    pub interval: i64,
    /// 1 to [`MAX_OCCURRENCES`]. Never together with `until`.
    pub count: Option<i64>,
    pub until: Option<Until>,
    /// `BYDAY` as written: 1 is Monday, 7 is Sunday. Only with
    /// [`Frequency::Weekly`]. May repeat a day and is not sorted.
    pub by_day: Vec<i64>,
    /// `BYMONTHDAY` as written: 1 to 31. Only with [`Frequency::Monthly`].
    pub by_month_day: Vec<i64>,
}

/// Why a text is not a rule the planner supports. One variant per rejection
/// of the reference, in the order it checks them.
///
/// The messages name the rule that was broken and never repeat the text that
/// broke it, so they are safe to return and to log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleError {
    /// A part is not `NAME=value`.
    MalformedPart,
    /// A part other than `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`,
    /// `BYMONTHDAY`, `WKST`.
    UnsupportedPart,
    /// The same part twice.
    DuplicatePart,
    /// `FREQ` missing or not `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`.
    UnsupportedFrequency,
    /// `INTERVAL` is not an integer from 1 to 1,000.
    Interval,
    /// Both `COUNT` and `UNTIL`.
    CountAndUntil,
    /// `COUNT` is not an integer from 1 to 2,000.
    Count,
    /// `UNTIL` has eight digits that are not a calendar date.
    UntilDate,
    /// `UNTIL` has the date-time form with a month or day of zero.
    UntilInstant,
    /// `UNTIL` is neither `YYYYMMDD` nor `YYYYMMDDTHHMMSSZ`.
    UntilValue,
    /// `BYDAY` without `FREQ=WEEKLY`.
    ByDayNeedsWeekly,
    /// A `BYDAY` entry is not one of `MO` … `SU`.
    ByDayValue,
    /// `BYMONTHDAY` without `FREQ=MONTHLY`.
    ByMonthDayNeedsMonthly,
    /// A `BYMONTHDAY` entry is not an integer from 1 to 31.
    ByMonthDayValue,
    /// `WKST` other than `MO`.
    WeekStart,
}

impl RuleError {
    /// A stable name of the rejection, for tests and the differential check.
    #[must_use]
    pub fn kind(self) -> &'static str {
        match self {
            RuleError::MalformedPart => "malformed_part",
            RuleError::UnsupportedPart => "unsupported_part",
            RuleError::DuplicatePart => "duplicate_part",
            RuleError::UnsupportedFrequency => "unsupported_freq",
            RuleError::Interval => "interval",
            RuleError::CountAndUntil => "count_and_until",
            RuleError::Count => "count",
            RuleError::UntilDate => "until_date",
            RuleError::UntilInstant => "until_instant",
            RuleError::UntilValue => "until_value",
            RuleError::ByDayNeedsWeekly => "byday_needs_weekly",
            RuleError::ByDayValue => "byday_value",
            RuleError::ByMonthDayNeedsMonthly => "bymonthday_needs_monthly",
            RuleError::ByMonthDayValue => "bymonthday_value",
            RuleError::WeekStart => "wkst",
        }
    }

    #[must_use]
    pub fn message(self) -> &'static str {
        match self {
            RuleError::MalformedPart => "Malformed RRULE part",
            RuleError::UnsupportedPart => "Unsupported RRULE part",
            RuleError::DuplicatePart => "Duplicate RRULE part",
            RuleError::UnsupportedFrequency => "Unsupported RRULE FREQ",
            RuleError::Interval => "RRULE INTERVAL must be an integer between 1 and 1000",
            RuleError::CountAndUntil => "RRULE COUNT and UNTIL are mutually exclusive",
            RuleError::Count => "RRULE COUNT must be between 1 and 2000",
            RuleError::UntilDate => "Unsupported RRULE UNTIL date",
            RuleError::UntilInstant => "Unsupported RRULE UNTIL instant",
            RuleError::UntilValue => "Unsupported RRULE UNTIL value",
            RuleError::ByDayNeedsWeekly => "RRULE BYDAY is only supported with FREQ=WEEKLY",
            RuleError::ByDayValue => "Unsupported RRULE BYDAY value",
            RuleError::ByMonthDayNeedsMonthly => {
                "RRULE BYMONTHDAY is only supported with FREQ=MONTHLY"
            }
            RuleError::ByMonthDayValue => "Unsupported RRULE BYMONTHDAY value",
            RuleError::WeekStart => "RRULE WKST only supports MO",
        }
    }
}

impl fmt::Display for RuleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for RuleError {}

/// ECMAScript `WhiteSpace` and `LineTerminator`: what `Number.parseInt`
/// skips before a number.
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `Number.parseInt(text, 10)`: `None` is `NaN`.
///
/// Leading white space is skipped, one sign is read, then digits up to the
/// first other character (`"15x"` is 15, `"1e3"` is 1, `" +7"` is 7, `""`
/// and `"x1"` are `NaN`). The callers only ask whether the value lies in a
/// small range, so a number too long for an `i64` saturates.
fn parse_int(text: &str) -> Option<i64> {
    let rest = text.trim_start_matches(is_js_whitespace);
    let (negative, digits) = match rest.strip_prefix('-') {
        Some(after) => (true, after),
        None => (false, rest.strip_prefix('+').unwrap_or(rest)),
    };
    let mut value: Option<i64> = None;
    for byte in digits.bytes() {
        if !byte.is_ascii_digit() {
            break;
        }
        let digit = i64::from(byte - b'0');
        value = Some(value.unwrap_or(0).saturating_mul(10).saturating_add(digit));
    }
    value.map(|magnitude| if negative { -magnitude } else { magnitude })
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// The number written by ASCII digits (the callers checked that they are).
fn number(digits: &str) -> i64 {
    digits
        .bytes()
        .fold(0, |value, byte| value * 10 + i64::from(byte - b'0'))
}

/// `parseUntil`. The value arrives upper-cased.
fn parse_until(raw: &str) -> Result<Until, RuleError> {
    // /^\d{8}$/ then Temporal.PlainDate.from('YYYY-MM-DD'): a string names a
    // date exactly, so February 30 is refused.
    if raw.len() == 8 && all_digits(raw) {
        return Date::new(number(&raw[0..4]), number(&raw[4..6]), number(&raw[6..8]))
            .map(Until::Date)
            .ok_or(RuleError::UntilDate);
    }
    // /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
    // ASCII first: the slices below cut at byte positions.
    let bytes = raw.as_bytes();
    let shaped = raw.is_ascii()
        && bytes.len() == 16
        && all_digits(&raw[0..8])
        && bytes[8] == b'T'
        && all_digits(&raw[9..15])
        && bytes[15] == b'Z';
    if !shaped {
        return Err(RuleError::UntilValue);
    }
    // The reference builds the instant from a property bag, and Temporal
    // *constrains* a bag: month 13 becomes December, day 31 of a short month
    // its last day, hour 24 becomes 23, minute and second 60 become 59. Only
    // a month or day of zero is refused (fields must be positive).
    let year = number(&raw[0..4]);
    let month = number(&raw[4..6]);
    let day = number(&raw[6..8]);
    if month < 1 || day < 1 {
        return Err(RuleError::UntilInstant);
    }
    let month = month.min(12);
    let day = day.min(days_in_month(year, month));
    let hour = number(&raw[9..11]).min(23);
    let minute = number(&raw[11..13]).min(59);
    let second = number(&raw[13..15]).min(59);
    let days = Date { year, month, day }.days();
    Ok(Until::Instant(
        days * DAY_MS + hour * 3_600_000 + minute * 60_000 + second * 1_000,
    ))
}

/// `BYDAY_INDEX`: two capital letters to the ISO weekday.
fn weekday(code: &str) -> Option<i64> {
    match code {
        "MO" => Some(1),
        "TU" => Some(2),
        "WE" => Some(3),
        "TH" => Some(4),
        "FR" => Some(5),
        "SA" => Some(6),
        "SU" => Some(7),
        _ => None,
    }
}

const ALLOWED_PARTS: [&str; 7] = [
    "FREQ",
    "INTERVAL",
    "COUNT",
    "UNTIL",
    "BYDAY",
    "BYMONTHDAY",
    "WKST",
];

impl Rule {
    /// Parses a rule (`parseRRule`). Checks run in the reference's order, so
    /// a text with several faults reports the same one.
    pub fn parse(text: &str) -> Result<Self, RuleError> {
        // Insertion order is irrelevant: parts are looked up by name.
        let mut parts: Vec<(String, String)> = Vec::new();
        let value_of = |parts: &[(String, String)], name: &str| -> Option<String> {
            parts
                .iter()
                .find(|(part, _)| part == name)
                .map(|(_, value)| value.clone())
        };
        for entry in text.split(';') {
            // `entry.split('=', 2)`: the first two pieces; a third is dropped.
            let mut pieces = entry.split('=');
            let (Some(name), Some(value)) = (pieces.next(), pieces.next()) else {
                return Err(RuleError::MalformedPart);
            };
            if name.is_empty() {
                return Err(RuleError::MalformedPart);
            }
            let upper = name.to_uppercase();
            if !ALLOWED_PARTS.contains(&upper.as_str()) {
                return Err(RuleError::UnsupportedPart);
            }
            if value_of(&parts, &upper).is_some() {
                return Err(RuleError::DuplicatePart);
            }
            parts.push((upper, value.to_uppercase()));
        }

        let frequency = match value_of(&parts, "FREQ").as_deref() {
            Some("DAILY") => Frequency::Daily,
            Some("WEEKLY") => Frequency::Weekly,
            Some("MONTHLY") => Frequency::Monthly,
            Some("YEARLY") => Frequency::Yearly,
            _ => return Err(RuleError::UnsupportedFrequency),
        };

        let interval = match value_of(&parts, "INTERVAL") {
            Some(raw) => parse_int(&raw),
            None => Some(1),
        }
        .filter(|interval| (1..=MAX_INTERVAL).contains(interval))
        .ok_or(RuleError::Interval)?;

        let count_raw = value_of(&parts, "COUNT");
        let until_raw = value_of(&parts, "UNTIL");
        if count_raw.is_some() && until_raw.is_some() {
            return Err(RuleError::CountAndUntil);
        }
        let count = match count_raw {
            Some(raw) => Some(
                parse_int(&raw)
                    .filter(|count| (1..=MAX_OCCURRENCES as i64).contains(count))
                    .ok_or(RuleError::Count)?,
            ),
            None => None,
        };
        let until = until_raw.as_deref().map(parse_until).transpose()?;

        let by_day = match value_of(&parts, "BYDAY") {
            Some(_) if frequency != Frequency::Weekly => {
                return Err(RuleError::ByDayNeedsWeekly);
            }
            Some(raw) => raw
                .split(',')
                .map(|code| weekday(code).ok_or(RuleError::ByDayValue))
                .collect::<Result<Vec<i64>, RuleError>>()?,
            None => Vec::new(),
        };

        let by_month_day = match value_of(&parts, "BYMONTHDAY") {
            Some(_) if frequency != Frequency::Monthly => {
                return Err(RuleError::ByMonthDayNeedsMonthly);
            }
            Some(raw) => raw
                .split(',')
                .map(|day| {
                    parse_int(day)
                        .filter(|day| (1..=31).contains(day))
                        .ok_or(RuleError::ByMonthDayValue)
                })
                .collect::<Result<Vec<i64>, RuleError>>()?,
            None => Vec::new(),
        };

        if value_of(&parts, "WKST").is_some_and(|start| start != "MO") {
            return Err(RuleError::WeekStart);
        }

        Ok(Self {
            frequency,
            interval,
            count,
            until,
            by_day,
            by_month_day,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Rule, RuleError> {
        Rule::parse(text)
    }

    #[test]
    fn the_documented_subset_parses_to_its_fields() {
        assert_eq!(
            parse("FREQ=DAILY;INTERVAL=2;COUNT=5").unwrap(),
            Rule {
                frequency: Frequency::Daily,
                interval: 2,
                count: Some(5),
                until: None,
                by_day: vec![],
                by_month_day: vec![],
            }
        );
        let weekly = parse("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;WKST=MO").unwrap();
        assert_eq!(weekly.frequency, Frequency::Weekly);
        assert_eq!(weekly.by_day, vec![1, 3, 5]);
        let monthly = parse("FREQ=MONTHLY;BYMONTHDAY=15").unwrap();
        assert_eq!(monthly.by_month_day, vec![15]);
        let yearly = parse("FREQ=YEARLY;UNTIL=20261231T000000Z").unwrap();
        // 2026-12-31T00:00:00Z
        assert_eq!(yearly.until, Some(Until::Instant(1_798_675_200_000)));
        assert_eq!(yearly.interval, 1);
    }

    #[test]
    fn unsupported_parts_and_combinations_are_refused() {
        for (text, error) in [
            ("FREQ=DAILY;BYSETPOS=1", RuleError::UnsupportedPart),
            ("FREQ=DAILY;BYMONTH=11", RuleError::UnsupportedPart),
            ("FREQ=DAILY;BYHOUR=9", RuleError::UnsupportedPart),
            ("FREQ=DAILY;BYDAY=MO", RuleError::ByDayNeedsWeekly),
            ("FREQ=MONTHLY;BYDAY=1MO", RuleError::ByDayNeedsWeekly),
            ("FREQ=MONTHLY;BYDAY=MO", RuleError::ByDayNeedsWeekly),
            (
                "FREQ=WEEKLY;BYMONTHDAY=15",
                RuleError::ByMonthDayNeedsMonthly,
            ),
            ("FREQ=DAILY;WKST=SU", RuleError::WeekStart),
            (
                "FREQ=DAILY;COUNT=2;UNTIL=20261113T090000Z",
                RuleError::CountAndUntil,
            ),
            ("FREQ=HOURLY", RuleError::UnsupportedFrequency),
            ("FREQ=WEEKLY;BYDAY=1MO", RuleError::ByDayValue),
        ] {
            assert_eq!(parse(text), Err(error), "{text}");
        }
    }

    #[test]
    fn parts_must_be_name_value_pairs_and_appear_once() {
        for text in [
            "",
            "FREQ",
            "FREQ=DAILY;",
            ";FREQ=DAILY",
            "=DAILY",
            "FREQ=DAILY;COUNT",
        ] {
            assert_eq!(parse(text), Err(RuleError::MalformedPart), "{text:?}");
        }
        assert_eq!(
            parse("FREQ=DAILY;FREQ=WEEKLY"),
            Err(RuleError::DuplicatePart)
        );
        assert_eq!(
            parse("FREQ=DAILY;freq=DAILY"),
            Err(RuleError::DuplicatePart),
            "names compare upper-cased"
        );
        // Faults are reported in the order of the parts.
        assert_eq!(
            parse("FREQ=DAILY;X=1;COUNT"),
            Err(RuleError::UnsupportedPart)
        );
        assert_eq!(parse("INTERVAL=2"), Err(RuleError::UnsupportedFrequency));
        assert_eq!(parse("FREQ="), Err(RuleError::UnsupportedFrequency));
    }

    #[test]
    fn names_and_values_are_upper_cased_like_javascript_does() {
        let rule = parse("freq=weekly;byday=mo,su;wkst=mo;interval=3").unwrap();
        assert_eq!(rule.frequency, Frequency::Weekly);
        assert_eq!(rule.by_day, vec![1, 7]);
        assert_eq!(rule.interval, 3);
        // U+0131 (dotless i) and U+017F (long s) upper-case to I and S.
        assert_eq!(
            parse("FREQ=DA\u{0131}LY").unwrap().frequency,
            Frequency::Daily
        );
        assert_eq!(
            parse("FREQ=WEEKLY;BYDAY=\u{017F}A").unwrap().by_day,
            vec![6]
        );
        assert_eq!(
            parse("FREQ=DAILY;UNT\u{0131}L=20261113").unwrap().until,
            Some(Until::Date(Date::new(2026, 11, 13).unwrap()))
        );
        // The date-time form is matched after upper-casing.
        assert!(matches!(
            parse("FREQ=DAILY;UNTIL=20261113t090000z").unwrap().until,
            Some(Until::Instant(_))
        ));
    }

    #[test]
    fn what_follows_a_second_equals_sign_is_dropped() {
        assert_eq!(
            parse("FREQ=DAILY=WEEKLY").unwrap().frequency,
            Frequency::Daily
        );
        assert_eq!(parse("FREQ=DAILY;COUNT=3=9").unwrap().count, Some(3));
        assert_eq!(parse("FREQ=DAILY;COUNT==3"), Err(RuleError::Count));
    }

    #[test]
    fn numbers_are_read_the_way_parse_int_reads_them() {
        assert_eq!(parse("FREQ=DAILY;INTERVAL= 7").unwrap().interval, 7);
        assert_eq!(parse("FREQ=DAILY;INTERVAL=+7").unwrap().interval, 7);
        assert_eq!(parse("FREQ=DAILY;INTERVAL=7days").unwrap().interval, 7);
        assert_eq!(parse("FREQ=DAILY;INTERVAL=1e3").unwrap().interval, 1);
        assert_eq!(parse("FREQ=DAILY;INTERVAL=2.9").unwrap().interval, 2);
        assert_eq!(parse("FREQ=DAILY;INTERVAL=007").unwrap().interval, 7);
        assert_eq!(
            parse("FREQ=DAILY;INTERVAL=\u{3000}\u{00A0}12")
                .unwrap()
                .interval,
            12
        );
        assert_eq!(parse("FREQ=DAILY;INTERVAL=1000").unwrap().interval, 1000);
        for text in [
            "FREQ=DAILY;INTERVAL=",
            "FREQ=DAILY;INTERVAL=x",
            "FREQ=DAILY;INTERVAL=0",
            "FREQ=DAILY;INTERVAL=-1",
            "FREQ=DAILY;INTERVAL=1001",
            "FREQ=DAILY;INTERVAL=99999999999999999999999999",
            "FREQ=DAILY;INTERVAL=--1",
            "FREQ=DAILY;INTERVAL=+ 1",
            "FREQ=DAILY;INTERVAL=1 ;COUNT=x",
            // U+0085 is not white space for JavaScript.
            "FREQ=DAILY;INTERVAL=\u{0085}1",
            // Full-width digits are not digits.
            "FREQ=DAILY;INTERVAL=\u{FF11}",
        ] {
            let expected = if text.ends_with("COUNT=x") {
                RuleError::Count
            } else {
                RuleError::Interval
            };
            assert_eq!(parse(text), Err(expected), "{text:?}");
        }
    }

    #[test]
    fn count_is_bounded() {
        assert_eq!(parse("FREQ=DAILY;COUNT=1").unwrap().count, Some(1));
        assert_eq!(parse("FREQ=DAILY;COUNT=2000").unwrap().count, Some(2000));
        for text in [
            "FREQ=DAILY;COUNT=0",
            "FREQ=DAILY;COUNT=2001",
            "FREQ=DAILY;COUNT=-5",
            "FREQ=DAILY;COUNT=",
            "FREQ=DAILY;COUNT=many",
        ] {
            assert_eq!(parse(text), Err(RuleError::Count), "{text}");
        }
        // The two ends exclude each other before either is read.
        assert_eq!(
            parse("FREQ=DAILY;COUNT=0;UNTIL=nonsense"),
            Err(RuleError::CountAndUntil)
        );
    }

    #[test]
    fn until_is_a_date_or_an_instant() {
        assert_eq!(
            parse("FREQ=DAILY;UNTIL=20240229").unwrap().until,
            Some(Until::Date(Date::new(2024, 2, 29).unwrap()))
        );
        // 2026-11-13T09:00:00Z
        assert_eq!(
            parse("FREQ=DAILY;UNTIL=20261113T090000Z").unwrap().until,
            Some(Until::Instant(1_794_560_400_000))
        );
        for (text, error) in [
            ("FREQ=DAILY;UNTIL=20230229", RuleError::UntilDate),
            ("FREQ=DAILY;UNTIL=20261301", RuleError::UntilDate),
            ("FREQ=DAILY;UNTIL=20260100", RuleError::UntilDate),
            ("FREQ=DAILY;UNTIL=2026-11-13", RuleError::UntilValue),
            ("FREQ=DAILY;UNTIL=20261113T090000", RuleError::UntilValue),
            ("FREQ=DAILY;UNTIL=20261113T0900Z", RuleError::UntilValue),
            ("FREQ=DAILY;UNTIL=", RuleError::UntilValue),
            ("FREQ=DAILY;UNTIL=2026111", RuleError::UntilValue),
            ("FREQ=DAILY;UNTIL=20261113T090000Z ", RuleError::UntilValue),
            ("FREQ=DAILY;UNTIL=20260013T090000Z", RuleError::UntilInstant),
            ("FREQ=DAILY;UNTIL=20261100T090000Z", RuleError::UntilInstant),
        ] {
            assert_eq!(parse(text), Err(error), "{text}");
        }
    }

    #[test]
    fn an_instant_until_is_constrained_field_by_field() {
        let until = |text: &str| parse(&format!("FREQ=DAILY;UNTIL={text}")).unwrap().until;
        // 2026-12-31T23:59:59Z
        let end_of_2026 = Some(Until::Instant(1_798_761_599_000));
        assert_eq!(until("20261231T235959Z"), end_of_2026);
        assert_eq!(until("20261399T999999Z"), end_of_2026);
        assert_eq!(until("20261232T246060Z"), end_of_2026);
        // February 31 is the last day of February: the 28th, or the 29th.
        assert_eq!(until("20260231T000000Z"), until("20260228T000000Z"));
        assert_eq!(until("20240231T000000Z"), until("20240229T000000Z"));
    }

    #[test]
    fn weekdays_and_month_days_are_checked_one_by_one() {
        assert_eq!(
            parse("FREQ=WEEKLY;BYDAY=SU,MO,MO,TU").unwrap().by_day,
            vec![7, 1, 1, 2],
            "kept as written"
        );
        for text in [
            "FREQ=WEEKLY;BYDAY=",
            "FREQ=WEEKLY;BYDAY=MO,",
            "FREQ=WEEKLY;BYDAY=MON",
            "FREQ=WEEKLY;BYDAY=M",
            "FREQ=WEEKLY;BYDAY=MO TU",
            "FREQ=WEEKLY;BYDAY= MO",
            "FREQ=WEEKLY;BYDAY=-1SU",
            "FREQ=WEEKLY;BYDAY=XX",
        ] {
            assert_eq!(parse(text), Err(RuleError::ByDayValue), "{text:?}");
        }
        assert_eq!(
            parse("FREQ=MONTHLY;BYMONTHDAY=31,1, 15,07,29x")
                .unwrap()
                .by_month_day,
            vec![31, 1, 15, 7, 29]
        );
        for text in [
            "FREQ=MONTHLY;BYMONTHDAY=0",
            "FREQ=MONTHLY;BYMONTHDAY=32",
            "FREQ=MONTHLY;BYMONTHDAY=-1",
            "FREQ=MONTHLY;BYMONTHDAY=",
            "FREQ=MONTHLY;BYMONTHDAY=15,",
            "FREQ=MONTHLY;BYMONTHDAY=last",
        ] {
            assert_eq!(parse(text), Err(RuleError::ByMonthDayValue), "{text:?}");
        }
    }

    #[test]
    fn messages_never_repeat_the_text_that_was_refused() {
        let secret = "FREQ=DAILY;SECRETPART=hunter2";
        let error = parse(secret).unwrap_err();
        assert!(!error.to_string().contains("SECRETPART"));
        assert!(!error.to_string().contains("hunter2"));
        assert_eq!(error.kind(), "unsupported_part");
        assert_eq!(error.message(), "Unsupported RRULE part");
    }
}
