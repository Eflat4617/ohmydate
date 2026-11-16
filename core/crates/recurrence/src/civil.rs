//! Calendar dates as plain numbers.
//!
//! The expansion walks dates by the day, the week, the month and the year.
//! Doing that on day numbers keeps the walk free of a date library's range
//! and error handling; the time zone database is asked only where a wall
//! clock meets an instant ([`crate::zone`]).

/// A date of the proleptic Gregorian calendar, as `Temporal.PlainDate` has
/// it. Dates order by year, month, day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    pub year: i64,
    /// 1 to 12.
    pub month: i64,
    /// 1 to the length of the month.
    pub day: i64,
}

impl Date {
    /// The date `year-month-day` when the calendar has it: February 30 and
    /// month 13 are not dates.
    #[must_use]
    pub fn new(year: i64, month: i64, day: i64) -> Option<Self> {
        let real = (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month);
        real.then_some(Self { year, month, day })
    }

    /// The date `days` after 1970-01-01 (Hinnant's `civil_from_days`).
    #[must_use]
    pub fn from_days(days: i64) -> Self {
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
        Self {
            year: year_of_era + era * 400 + i64::from(month <= 2),
            month,
            day,
        }
    }

    /// Days since 1970-01-01 (`dayNumber` of the reference).
    #[must_use]
    pub fn days(self) -> i64 {
        let shifted_year = if self.month <= 2 {
            self.year - 1
        } else {
            self.year
        };
        let era = shifted_year.div_euclid(400);
        let year_of_era = shifted_year.rem_euclid(400);
        let shifted_month = (self.month + 9) % 12;
        let day_of_year = (153 * shifted_month + 2) / 5 + self.day - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    /// The date `days` later (earlier when negative).
    #[must_use]
    pub fn plus_days(self, days: i64) -> Self {
        Self::from_days(self.days() + days)
    }

    /// ISO weekday: 1 is Monday, 7 is Sunday (`Temporal`'s `dayOfWeek`).
    #[must_use]
    pub fn weekday(self) -> i64 {
        // 1970-01-01 was a Thursday.
        (self.days() + 3).rem_euclid(7) + 1
    }
}

#[must_use]
pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Length of a month; `month` is 1 to 12.
#[must_use]
pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(year: i64, month: i64, day: i64) -> Date {
        Date::new(year, month, day).unwrap()
    }

    #[test]
    fn day_numbers_and_dates_agree_in_both_directions() {
        assert_eq!(date(1970, 1, 1).days(), 0);
        assert_eq!(date(1969, 12, 31).days(), -1);
        assert_eq!(date(2000, 3, 1).days(), 11_017);
        assert_eq!(Date::from_days(20_773), date(2026, 11, 16));
        // Every day of eight centuries, across both kinds of century year.
        let mut days = date(1600, 1, 1).days();
        let end = date(2400, 12, 31).days();
        let mut previous = Date::from_days(days - 1);
        while days <= end {
            let current = Date::from_days(days);
            assert_eq!(current.days(), days);
            assert!(current > previous, "{current:?} after {previous:?}");
            previous = current;
            days += 1;
        }
    }

    #[test]
    fn weekdays_count_from_monday() {
        assert_eq!(date(1970, 1, 1).weekday(), 4);
        assert_eq!(date(2026, 11, 16).weekday(), 1);
        assert_eq!(date(2026, 11, 22).weekday(), 7);
        assert_eq!(date(1969, 12, 28).weekday(), 7);
        assert_eq!(date(2024, 2, 29).weekday(), 4);
    }

    #[test]
    fn months_have_their_lengths_and_leap_days_follow_the_gregorian_rule() {
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(1900, 2), 28);
        assert_eq!(days_in_month(2000, 2), 29);
        assert_eq!(days_in_month(2026, 4), 30);
        assert_eq!(days_in_month(2026, 12), 31);
        assert!(
            is_leap_year(0),
            "year 0 is a leap year of the proleptic calendar"
        );
    }

    #[test]
    fn dates_the_calendar_does_not_have_are_refused() {
        assert_eq!(Date::new(2026, 2, 29), None);
        assert_eq!(Date::new(2026, 4, 31), None);
        assert_eq!(Date::new(2026, 13, 1), None);
        assert_eq!(Date::new(2026, 0, 1), None);
        assert_eq!(Date::new(2026, 1, 0), None);
        assert!(Date::new(2024, 2, 29).is_some());
    }

    #[test]
    fn adding_days_crosses_months_and_years() {
        assert_eq!(date(2026, 12, 31).plus_days(1), date(2027, 1, 1));
        assert_eq!(date(2024, 2, 28).plus_days(1), date(2024, 2, 29));
        assert_eq!(date(2026, 3, 1).plus_days(-1), date(2026, 2, 28));
        assert_eq!(date(2026, 1, 1).plus_days(0), date(2026, 1, 1));
    }
}
