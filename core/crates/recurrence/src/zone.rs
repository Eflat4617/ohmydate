//! Where a wall clock meets an instant: the only part of the crate that asks
//! the time zone database.

use jiff::Timestamp;
use jiff::civil;
use jiff::tz::TimeZone;

use crate::civil::Date;

/// A time of day to the millisecond (`Temporal.PlainTime` of an instant that
/// has whole milliseconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallTime {
    pub hour: i8,
    pub minute: i8,
    pub second: i8,
    pub millisecond: i16,
}

impl WallTime {
    /// 23:59:59.999, the last millisecond of a day.
    pub const END_OF_DAY: WallTime = WallTime {
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
    };
}

/// A time zone of the bundled tz database.
#[derive(Debug, Clone)]
pub struct Zone(TimeZone);

impl Zone {
    /// The zone with this IANA name. `None` for a name the database does not
    /// have.
    #[must_use]
    pub fn named(name: &str) -> Option<Self> {
        let zone = TimeZone::get(name).ok()?;
        // `Etc/Unknown` resolves to a placeholder that behaves like UTC.
        (!zone.is_unknown()).then_some(Self(zone))
    }

    /// The local date and time of an instant
    /// (`Temporal.Instant.toZonedDateTimeISO`). `None` when the instant is
    /// outside what the date library represents.
    #[must_use]
    pub fn local_at(&self, epoch_ms: i64) -> Option<(Date, WallTime)> {
        let zoned = Timestamp::from_millisecond(epoch_ms)
            .ok()?
            .to_zoned(self.0.clone());
        let date = Date {
            year: i64::from(zoned.year()),
            month: i64::from(zoned.month()),
            day: i64::from(zoned.day()),
        };
        let time = WallTime {
            hour: zoned.hour(),
            minute: zoned.minute(),
            second: zoned.second(),
            millisecond: zoned.millisecond(),
        };
        Some((date, time))
    }

    /// The instant of a wall-clock time in this zone
    /// (`PlainDateTime.toZonedDateTime`, disambiguation `compatible`).
    ///
    /// A time that a clock change skipped moves forward by the length of the
    /// gap; a time that happened twice is its first occurrence. `None` when
    /// the date is outside what the date library represents.
    #[must_use]
    pub fn instant_of(&self, date: Date, time: WallTime) -> Option<i64> {
        let local = civil::DateTime::new(
            i16::try_from(date.year).ok()?,
            i8::try_from(date.month).ok()?,
            i8::try_from(date.day).ok()?,
            time.hour,
            time.minute,
            time.second,
            i32::from(time.millisecond) * 1_000_000,
        )
        .ok()?;
        let timestamp = self.0.to_ambiguous_timestamp(local).compatible().ok()?;
        Some(timestamp.as_millisecond())
    }
}

/// An instant as `Temporal.Instant.prototype.toString` prints it: seconds
/// always, a fraction only when it is not zero and without trailing zeros
/// (`2026-11-11T09:00:00Z`, `2026-11-11T09:00:00.5Z`). `None` outside what
/// the date library represents.
#[must_use]
pub fn print_shortest(epoch_ms: i64) -> Option<String> {
    Timestamp::from_millisecond(epoch_ms)
        .ok()
        .map(|timestamp| timestamp.to_string())
}

/// An instant as `Date.prototype.toISOString` prints it: always three
/// fraction digits (`2026-11-11T09:00:00.000Z`).
#[must_use]
pub fn print_milliseconds(epoch_ms: i64) -> String {
    const DAY_MS: i64 = 86_400_000;
    let date = Date::from_days(epoch_ms.div_euclid(DAY_MS));
    let within_day = epoch_ms.rem_euclid(DAY_MS);
    let hour = within_day / 3_600_000;
    let minute = within_day % 3_600_000 / 60_000;
    let second = within_day % 60_000 / 1_000;
    let millisecond = within_day % 1_000;
    let Date { year, month, day } = date;
    // JavaScript prints years outside 0000–9999 with a sign and six digits.
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(year: i64, month: i64, day: i64) -> Date {
        Date::new(year, month, day).unwrap()
    }

    fn at(hour: i8, minute: i8) -> WallTime {
        WallTime {
            hour,
            minute,
            second: 0,
            millisecond: 0,
        }
    }

    fn zone(name: &str) -> Zone {
        Zone::named(name).unwrap()
    }

    #[test]
    fn an_instant_has_a_local_date_and_time_in_its_zone() {
        // 2026-11-11T15:00:00.250Z is midnight in Seoul.
        let ms = 1_794_409_200_250;
        assert_eq!(
            zone("Asia/Seoul").local_at(ms),
            Some((
                date(2026, 11, 12),
                WallTime {
                    hour: 0,
                    minute: 0,
                    second: 0,
                    millisecond: 250
                }
            ))
        );
        assert_eq!(zone("UTC").local_at(ms).unwrap().0, date(2026, 11, 11));
        assert_eq!(
            zone("America/New_York").local_at(ms).unwrap().1.hour,
            10,
            "EST is five hours behind"
        );
    }

    #[test]
    fn a_skipped_wall_time_moves_forward_by_the_gap() {
        // New York, 2027-03-14: 02:00 → 03:00. 02:30 does not exist; it is
        // read with the offset before the change: 07:30Z, which is 03:30 EDT.
        let new_york = zone("America/New_York");
        let skipped = new_york.instant_of(date(2027, 3, 14), at(2, 30)).unwrap();
        assert_eq!(print_shortest(skipped).unwrap(), "2027-03-14T07:30:00Z");
        // Lord Howe skips half an hour: 02:00 → 02:30 on 2026-10-04.
        let lord_howe = zone("Australia/Lord_Howe");
        let skipped = lord_howe.instant_of(date(2026, 10, 4), at(2, 15)).unwrap();
        let (_, wall) = lord_howe.local_at(skipped).unwrap();
        assert_eq!((wall.hour, wall.minute), (2, 45));
    }

    #[test]
    fn a_repeated_wall_time_is_its_first_occurrence() {
        // New York, 2026-11-01: 02:00 → 01:00. 01:30 happens at 05:30Z (EDT)
        // and again at 06:30Z (EST).
        let new_york = zone("America/New_York");
        let first = new_york.instant_of(date(2026, 11, 1), at(1, 30)).unwrap();
        assert_eq!(print_shortest(first).unwrap(), "2026-11-01T05:30:00Z");
    }

    #[test]
    fn names_outside_the_database_are_not_zones() {
        assert!(Zone::named("Mars/Olympus_Mons").is_none());
        assert!(Zone::named("").is_none());
        assert!(Zone::named("Etc/Unknown").is_none());
        assert!(Zone::named("Asia/Seoul").is_some());
    }

    #[test]
    fn dates_and_instants_outside_the_library_range_are_refused_not_wrapped() {
        let utc = zone("UTC");
        assert_eq!(utc.instant_of(date(10_000, 1, 1), at(0, 0)), None);
        assert_eq!(utc.instant_of(date(40_000, 1, 1), at(0, 0)), None);
        assert_eq!(utc.local_at(i64::MAX), None);
        assert_eq!(print_shortest(i64::MAX), None);
    }

    #[test]
    fn the_two_printed_forms_differ_only_in_the_fraction() {
        let whole = 1_794_387_600_000; // 2026-11-11T09:00:00Z
        assert_eq!(print_shortest(whole).unwrap(), "2026-11-11T09:00:00Z");
        assert_eq!(print_milliseconds(whole), "2026-11-11T09:00:00.000Z");
        assert_eq!(
            print_shortest(whole + 500).unwrap(),
            "2026-11-11T09:00:00.5Z"
        );
        assert_eq!(print_milliseconds(whole + 500), "2026-11-11T09:00:00.500Z");
        assert_eq!(
            print_shortest(whole + 123).unwrap(),
            "2026-11-11T09:00:00.123Z"
        );
        assert_eq!(
            print_shortest(whole + 120).unwrap(),
            "2026-11-11T09:00:00.12Z"
        );
        assert_eq!(print_milliseconds(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(print_milliseconds(-1), "1969-12-31T23:59:59.999Z");
    }
}
