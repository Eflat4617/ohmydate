use std::fmt;

/// A point in time, stored as whole milliseconds since the Unix epoch (UTC).
///
/// The supported range is the same as the TypeScript core's `Instant`
/// (`packages/domain/src/brand.ts`): `1970-01-01T00:00:00.000Z` up to
/// `9999-12-31T23:59:59.999Z`. The wire and storage form is the 24-character
/// string `YYYY-MM-DDTHH:MM:SS.mmmZ` — exactly what JavaScript's
/// `Date.prototype.toISOString` prints — so strings compare in time order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Instant(i64);

/// Why a string is not an acceptable instant. The messages are the ones the
/// TypeScript core reports in `errors[].message`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstantParseError {
    /// Not `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`.
    Format,
    /// Offset hours above 23 or minutes above 59.
    InvalidOffset,
    /// The fields do not name a real calendar date and time.
    InvalidCalendar,
    /// A real instant, but outside the supported range.
    OutOfRange,
}

impl InstantParseError {
    #[must_use]
    pub fn message(self) -> &'static str {
        match self {
            InstantParseError::Format => "expected an ISO-8601 instant including a timezone offset",
            InstantParseError::InvalidOffset => "invalid timezone offset",
            InstantParseError::InvalidCalendar => "invalid calendar date-time",
            InstantParseError::OutOfRange => "instant outside the supported range",
        }
    }
}

impl fmt::Display for InstantParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for InstantParseError {}

const MS_PER_SECOND: i64 = 1_000;
const MS_PER_MINUTE: i64 = 60 * MS_PER_SECOND;
const MS_PER_HOUR: i64 = 60 * MS_PER_MINUTE;
const MS_PER_DAY: i64 = 24 * MS_PER_HOUR;

impl Instant {
    /// `1970-01-01T00:00:00.000Z`.
    pub const MIN: Instant = Instant(0);
    /// `9999-12-31T23:59:59.999Z`.
    pub const MAX: Instant = Instant(253_402_300_799_999);

    /// Returns `None` outside the supported range.
    #[must_use]
    pub fn from_epoch_ms(epoch_ms: i64) -> Option<Self> {
        if (Self::MIN.0..=Self::MAX.0).contains(&epoch_ms) {
            Some(Self(epoch_ms))
        } else {
            None
        }
    }

    #[must_use]
    pub fn epoch_ms(self) -> i64 {
        self.0
    }

    /// Adds a signed number of milliseconds; `None` when the result leaves the
    /// supported range.
    #[must_use]
    pub fn checked_add_ms(self, delta_ms: i64) -> Option<Self> {
        self.0.checked_add(delta_ms).and_then(Self::from_epoch_ms)
    }

    /// Parses an RFC 3339 date-time with a `Z` or `±HH:MM` offset and returns
    /// the instant it names. Fractional seconds beyond milliseconds are
    /// truncated, as the TypeScript core does.
    pub fn parse_rfc3339(text: &str) -> Result<Self, InstantParseError> {
        let bytes = text.as_bytes();
        // Shortest form: 2026-01-02T03:04:05Z (20 bytes).
        if bytes.len() < 20 {
            return Err(InstantParseError::Format);
        }
        let year = digits(bytes, 0, 4)?;
        expect(bytes, 4, b'-')?;
        let month = digits(bytes, 5, 2)?;
        expect(bytes, 7, b'-')?;
        let day = digits(bytes, 8, 2)?;
        expect(bytes, 10, b'T')?;
        let hour = digits(bytes, 11, 2)?;
        expect(bytes, 13, b':')?;
        let minute = digits(bytes, 14, 2)?;
        expect(bytes, 16, b':')?;
        let second = digits(bytes, 17, 2)?;

        let mut position = 19;
        let mut millisecond = 0_i64;
        if bytes.get(position) == Some(&b'.') {
            position += 1;
            let start = position;
            while bytes.get(position).is_some_and(u8::is_ascii_digit) {
                position += 1;
            }
            let count = position - start;
            if count == 0 || count > 9 {
                return Err(InstantParseError::Format);
            }
            for index in 0..3 {
                let digit = bytes
                    .get(start + index)
                    .filter(|_| index < count)
                    .map_or(0, |byte| i64::from(byte - b'0'));
                millisecond = millisecond * 10 + digit;
            }
        }

        let offset_minutes = match bytes.get(position) {
            Some(b'Z') if position + 1 == bytes.len() => 0,
            Some(sign @ (b'+' | b'-')) if position + 6 == bytes.len() => {
                let offset_hour = digits(bytes, position + 1, 2)?;
                expect(bytes, position + 3, b':')?;
                let offset_minute = digits(bytes, position + 4, 2)?;
                if offset_hour > 23 || offset_minute > 59 {
                    return Err(InstantParseError::InvalidOffset);
                }
                let magnitude = offset_hour * 60 + offset_minute;
                if *sign == b'-' { -magnitude } else { magnitude }
            }
            _ => return Err(InstantParseError::Format),
        };

        if !(1..=12).contains(&month)
            || day < 1
            || day > days_in_month(year, month)
            || hour > 23
            || minute > 59
            || second > 59
        {
            return Err(InstantParseError::InvalidCalendar);
        }

        let local_ms = days_from_civil(year, month, day) * MS_PER_DAY
            + hour * MS_PER_HOUR
            + minute * MS_PER_MINUTE
            + second * MS_PER_SECOND
            + millisecond;
        Self::from_epoch_ms(local_ms - offset_minutes * MS_PER_MINUTE)
            .ok_or(InstantParseError::OutOfRange)
    }

    /// `YYYY-MM-DDTHH:MM:SS.mmmZ`, the canonical wire and storage form.
    #[must_use]
    pub fn to_rfc3339(self) -> String {
        let days = self.0.div_euclid(MS_PER_DAY);
        let within_day = self.0.rem_euclid(MS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        let hour = within_day / MS_PER_HOUR;
        let minute = within_day % MS_PER_HOUR / MS_PER_MINUTE;
        let second = within_day % MS_PER_MINUTE / MS_PER_SECOND;
        let millisecond = within_day % MS_PER_SECOND;
        format!(
            "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z"
        )
    }
}

impl fmt::Display for Instant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_rfc3339())
    }
}

fn expect(bytes: &[u8], position: usize, expected: u8) -> Result<(), InstantParseError> {
    if bytes.get(position) == Some(&expected) { Ok(()) } else { Err(InstantParseError::Format) }
}

fn digits(bytes: &[u8], start: usize, count: usize) -> Result<i64, InstantParseError> {
    let mut value = 0_i64;
    for index in start..start + count {
        match bytes.get(index) {
            Some(byte) if byte.is_ascii_digit() => value = value * 10 + i64::from(byte - b'0'),
            _ => return Err(InstantParseError::Format),
        }
    }
    Ok(value)
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 31,
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year.rem_euclid(400);
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Inverse of [`days_from_civil`].
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<String, InstantParseError> {
        Instant::parse_rfc3339(text).map(Instant::to_rfc3339)
    }

    #[test]
    fn utc_instants_round_trip_in_the_canonical_form() {
        assert_eq!(parse("2026-11-20T14:59:00.000Z").unwrap(), "2026-11-20T14:59:00.000Z");
        assert_eq!(parse("2026-11-20T14:59:00Z").unwrap(), "2026-11-20T14:59:00.000Z");
        assert_eq!(parse("1970-01-01T00:00:00Z").unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(parse("9999-12-31T23:59:59.999Z").unwrap(), "9999-12-31T23:59:59.999Z");
        assert_eq!(parse("2024-02-29T12:00:00Z").unwrap(), "2024-02-29T12:00:00.000Z");
    }

    #[test]
    fn offsets_are_normalised_to_utc() {
        assert_eq!(parse("2026-11-20T23:59:00+09:00").unwrap(), "2026-11-20T14:59:00.000Z");
        assert_eq!(parse("2026-11-20T00:30:00-05:30").unwrap(), "2026-11-20T06:00:00.000Z");
        assert_eq!(parse("2026-01-01T00:00:00+00:00").unwrap(), "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn fractions_beyond_milliseconds_are_truncated() {
        assert_eq!(parse("2026-01-01T00:00:00.1Z").unwrap(), "2026-01-01T00:00:00.100Z");
        assert_eq!(parse("2026-01-01T00:00:00.123456789Z").unwrap(), "2026-01-01T00:00:00.123Z");
        assert_eq!(parse("2026-01-01T00:00:00.9999+09:00").unwrap(), "2025-12-31T15:00:00.999Z");
    }

    #[test]
    fn strings_without_the_required_shape_are_rejected() {
        for text in [
            "",
            "2026-11-20",
            "2026-11-20T14:59:00",
            "2026-11-20 14:59:00Z",
            "2026-11-20t14:59:00z",
            "2026-11-20T14:59:00+0900",
            "2026-11-20T14:59:00.Z",
            "2026-11-20T14:59:00.1234567890Z",
            "2026-11-20T14:59:00Zjunk",
            "２０２６-11-20T14:59:00Z",
        ] {
            assert_eq!(Instant::parse_rfc3339(text), Err(InstantParseError::Format), "{text}");
        }
    }

    #[test]
    fn impossible_calendar_fields_are_rejected() {
        for text in [
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-10T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T23:60:00Z",
            "2026-01-01T23:59:60Z",
        ] {
            assert_eq!(
                Instant::parse_rfc3339(text),
                Err(InstantParseError::InvalidCalendar),
                "{text}"
            );
        }
    }

    #[test]
    fn offsets_and_range_are_checked() {
        assert_eq!(
            Instant::parse_rfc3339("2026-01-01T00:00:00+24:00"),
            Err(InstantParseError::InvalidOffset)
        );
        assert_eq!(
            Instant::parse_rfc3339("2026-01-01T00:00:00+09:60"),
            Err(InstantParseError::InvalidOffset)
        );
        assert_eq!(
            Instant::parse_rfc3339("1969-12-31T23:59:59Z"),
            Err(InstantParseError::OutOfRange)
        );
        assert_eq!(
            Instant::parse_rfc3339("1970-01-01T00:00:00+00:01"),
            Err(InstantParseError::OutOfRange)
        );
        assert_eq!(
            Instant::parse_rfc3339("9999-12-31T23:59:59-00:01"),
            Err(InstantParseError::OutOfRange)
        );
    }

    #[test]
    fn epoch_milliseconds_are_range_checked() {
        assert_eq!(Instant::from_epoch_ms(0), Some(Instant::MIN));
        assert_eq!(Instant::from_epoch_ms(-1), None);
        assert_eq!(Instant::from_epoch_ms(Instant::MAX.epoch_ms() + 1), None);
        assert_eq!(Instant::MAX.checked_add_ms(1), None);
        assert_eq!(Instant::MIN.checked_add_ms(1_500).unwrap().to_rfc3339(), "1970-01-01T00:00:01.500Z");
    }

    #[test]
    fn canonical_strings_sort_in_time_order() {
        let mut instants = vec![
            Instant::parse_rfc3339("2026-11-20T14:59:00Z").unwrap(),
            Instant::parse_rfc3339("2026-02-01T00:00:00Z").unwrap(),
            Instant::parse_rfc3339("2026-11-20T14:58:59.999Z").unwrap(),
        ];
        instants.sort();
        let mut strings: Vec<String> = instants.iter().map(|instant| instant.to_rfc3339()).collect();
        let sorted_by_time = strings.clone();
        strings.sort();
        assert_eq!(strings, sorted_by_time);
    }

    #[test]
    fn every_day_from_1970_to_2100_round_trips() {
        let mut days = 0_i64;
        while days < 47_500 {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
            days += 1;
        }
    }
}
