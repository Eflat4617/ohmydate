//! `services/api/test/rrule.test.ts`, moved: the same rules, windows and
//! expected instants, test for test and in its order.

// Helpers of an integration test are test code too.
#![allow(clippy::unwrap_used)]

use ohmydate_recurrence::{ExpandError, Rule, RuleError, Series, expand};

fn ms(text: &str) -> i64 {
    text.parse::<jiff::Timestamp>().unwrap().as_millisecond()
}

/// Start instants of the occurrences, as the reference prints them.
fn starts(
    start_at: &str,
    end_at: &str,
    rule: &str,
    time_zone: &str,
    from: &str,
    to: &str,
) -> Vec<String> {
    let series = Series {
        start_ms: ms(start_at),
        end_ms: ms(end_at),
        time_zone,
        rule: Some(rule),
    };
    expand(&series, ms(from), ms(to))
        .unwrap()
        .iter()
        .map(|occurrence| occurrence.start_at())
        .collect()
}

#[test]
fn rejects_unsupported_parts_and_combinations() {
    for rule in [
        "FREQ=DAILY;BYSETPOS=1",
        "FREQ=DAILY;BYMONTH=11",
        "FREQ=DAILY;BYHOUR=9",
        "FREQ=DAILY;BYDAY=MO",
        "FREQ=MONTHLY;BYDAY=1MO",
        "FREQ=MONTHLY;BYDAY=MO",
        "FREQ=WEEKLY;BYMONTHDAY=15",
        "FREQ=DAILY;WKST=SU",
        "FREQ=DAILY;COUNT=2;UNTIL=20261113T090000Z",
        "FREQ=HOURLY",
        "FREQ=WEEKLY;BYDAY=1MO",
    ] {
        assert!(Rule::parse(rule).is_err(), "{rule}");
    }
    // A rejected rule is a rejected expansion, not an empty one.
    let series = Series {
        start_ms: ms("2026-11-11T09:00:00Z"),
        end_ms: ms("2026-11-11T10:00:00Z"),
        time_zone: "UTC",
        rule: Some("FREQ=HOURLY"),
    };
    assert_eq!(
        expand(
            &series,
            ms("2026-11-11T00:00:00Z"),
            ms("2026-11-12T00:00:00Z")
        ),
        Err(ExpandError::Rule(RuleError::UnsupportedFrequency))
    );
}

#[test]
fn accepts_the_documented_subset() {
    for rule in [
        "FREQ=DAILY;INTERVAL=2;COUNT=5",
        "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;WKST=MO",
        "FREQ=MONTHLY;BYMONTHDAY=15",
        "FREQ=YEARLY;UNTIL=20261231T000000Z",
    ] {
        assert!(Rule::parse(rule).is_ok(), "{rule}");
    }
}

#[test]
fn until_is_inclusive_for_an_instant() {
    assert_eq!(
        starts(
            "2026-11-11T09:00:00Z",
            "2026-11-11T10:00:00Z",
            "FREQ=DAILY;UNTIL=20261113T090000Z",
            "UTC",
            "2026-11-11T00:00:00Z",
            "2026-11-15T00:00:00Z",
        ),
        [
            "2026-11-11T09:00:00Z",
            "2026-11-12T09:00:00Z",
            "2026-11-13T09:00:00Z",
        ]
    );
}

#[test]
fn date_form_until_means_the_end_of_that_local_day() {
    assert_eq!(
        starts(
            "2026-11-11T14:00:00Z",
            "2026-11-11T15:00:00Z",
            "FREQ=DAILY;UNTIL=20261113",
            "America/New_York",
            "2026-11-11T00:00:00Z",
            "2026-11-16T00:00:00Z",
        ),
        [
            "2026-11-11T14:00:00Z",
            "2026-11-12T14:00:00Z",
            "2026-11-13T14:00:00Z",
        ]
    );
}

#[test]
fn monthly_bymonthday_selects_the_requested_day() {
    assert_eq!(
        starts(
            "2026-11-02T09:00:00Z",
            "2026-11-02T10:00:00Z",
            "FREQ=MONTHLY;BYMONTHDAY=15",
            "UTC",
            "2026-11-01T00:00:00Z",
            "2027-02-01T00:00:00Z",
        ),
        [
            "2026-11-15T09:00:00Z",
            "2026-12-15T09:00:00Z",
            "2027-01-15T09:00:00Z",
        ]
    );
}

#[test]
fn dst_gap_shifts_forward_and_overlap_chooses_the_first_occurrence() {
    // 02:30 in New York. On 14 March 2027 the clocks skip 02:00–03:00: the
    // occurrence keeps its instant (07:30Z, now 03:30 local), and from the
    // 15th the wall time is back, one hour earlier in UTC.
    assert_eq!(
        starts(
            "2027-03-13T07:30:00Z",
            "2027-03-13T08:30:00Z",
            "FREQ=DAILY",
            "America/New_York",
            "2027-03-13T00:00:00Z",
            "2027-03-16T00:00:00Z",
        ),
        [
            "2027-03-13T07:30:00Z",
            "2027-03-14T07:30:00Z",
            "2027-03-15T06:30:00Z",
        ]
    );
    // 01:30 in New York. On 1 November 2026 that time happens twice; the
    // first one (still daylight time, 05:30Z) is taken.
    assert_eq!(
        starts(
            "2026-10-31T05:30:00Z",
            "2026-10-31T06:30:00Z",
            "FREQ=DAILY",
            "America/New_York",
            "2026-10-31T00:00:00Z",
            "2026-11-03T00:00:00Z",
        ),
        [
            "2026-10-31T05:30:00Z",
            "2026-11-01T05:30:00Z",
            "2026-11-02T06:30:00Z",
        ]
    );
}

#[test]
fn fast_forwards_a_recurrence_that_starts_more_than_ten_years_before_the_range() {
    assert_eq!(
        starts(
            "2000-01-01T09:00:00Z",
            "2000-01-01T10:00:00Z",
            "FREQ=YEARLY",
            "UTC",
            "2026-01-01T00:00:00Z",
            "2026-12-01T00:00:00Z",
        ),
        ["2026-01-01T09:00:00Z"]
    );
    assert_eq!(
        starts(
            "2010-03-03T09:00:00Z",
            "2010-03-03T10:00:00Z",
            "FREQ=WEEKLY;BYDAY=WE",
            "UTC",
            "2026-11-11T00:00:00Z",
            "2026-11-14T00:00:00Z",
        ),
        ["2026-11-11T09:00:00Z"]
    );
}

#[test]
fn skips_a_recurrence_whose_until_ends_before_the_range_without_expanding() {
    assert!(
        starts(
            "2010-03-01T09:00:00Z",
            "2010-03-01T10:00:00Z",
            "FREQ=WEEKLY;UNTIL=20110301T000000Z",
            "UTC",
            "2026-11-11T00:00:00Z",
            "2026-11-14T00:00:00Z",
        )
        .is_empty()
    );
}

#[test]
fn count_still_works_after_a_fast_forward() {
    assert_eq!(
        starts(
            "2000-01-01T09:00:00Z",
            "2000-01-01T10:00:00Z",
            "FREQ=YEARLY;COUNT=30",
            "UTC",
            "2026-01-01T00:00:00Z",
            "2026-12-01T00:00:00Z",
        ),
        ["2026-01-01T09:00:00Z"]
    );
}

#[test]
fn an_exhausted_yearly_count_does_not_emit_the_first_year_of_the_range() {
    assert!(
        starts(
            "2000-01-01T09:00:00Z",
            "2000-01-01T10:00:00Z",
            "FREQ=YEARLY;COUNT=26",
            "UTC",
            "2026-01-01T00:00:00Z",
            "2026-12-01T00:00:00Z",
        )
        .is_empty()
    );
}

#[test]
fn yearly_count_on_a_leap_day_start_skips_non_leap_years_without_constraining() {
    assert_eq!(
        starts(
            "2000-02-29T09:00:00Z",
            "2000-02-29T10:00:00Z",
            "FREQ=YEARLY;COUNT=10",
            "UTC",
            "2028-02-28T00:00:00Z",
            "2028-03-01T00:00:00Z",
        ),
        ["2028-02-29T09:00:00Z"]
    );
}

#[test]
fn monthly_bymonthday_31_count_skips_short_months_without_consuming_the_count() {
    assert_eq!(
        starts(
            "2026-01-31T09:00:00Z",
            "2026-01-31T10:00:00Z",
            "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=5",
            "UTC",
            "2026-01-01T00:00:00Z",
            "2026-09-01T00:00:00Z",
        ),
        [
            "2026-01-31T09:00:00Z",
            "2026-03-31T09:00:00Z",
            "2026-05-31T09:00:00Z",
            "2026-07-31T09:00:00Z",
            "2026-08-31T09:00:00Z",
        ]
    );
}

// What the differential check found about clock changes, pinned here so it
// reads without a pack.

#[test]
fn a_calendar_day_the_zone_skipped_gives_the_next_days_instant_twice() {
    // Samoa went from UTC−10 to UTC+14 at the end of 29 December 2011: there
    // was no 30 December. The reference resolves 10:00 on the 30th forward
    // by the 24 hours that are missing — to 10:00 on the 31st — and the 31st
    // gives the same instant again.
    assert_eq!(
        starts(
            "2011-12-27T20:00:00Z",
            "2011-12-27T21:00:00Z",
            "FREQ=DAILY",
            "Pacific/Apia",
            "2011-12-29T00:00:00Z",
            "2012-01-02T00:00:00Z",
        ),
        [
            "2011-12-29T20:00:00Z",
            "2011-12-30T20:00:00Z",
            "2011-12-30T20:00:00Z",
            "2011-12-31T20:00:00Z",
            "2012-01-01T20:00:00Z",
        ]
    );
    // With COUNT the doubled instant spends two of the count.
    assert_eq!(
        starts(
            "2011-12-27T20:00:00Z",
            "2011-12-27T21:00:00Z",
            "FREQ=DAILY;COUNT=5",
            "Pacific/Apia",
            "2011-12-27T00:00:00Z",
            "2012-01-03T00:00:00Z",
        )
        .len(),
        5
    );
}

#[test]
fn a_clock_change_at_midnight_and_a_half_hour_change_keep_the_wall_time_afterwards() {
    // Havana, 8 March 2026: 00:00 → 01:00. An appointment at 00:00 keeps its
    // instant that day (05:00Z, read as 01:00) and is at 04:00Z afterwards.
    assert_eq!(
        starts(
            "2026-03-06T05:00:00Z",
            "2026-03-06T06:00:00Z",
            "FREQ=DAILY",
            "America/Havana",
            "2026-03-07T00:00:00Z",
            "2026-03-10T00:00:00Z",
        ),
        [
            "2026-03-07T05:00:00Z",
            "2026-03-08T05:00:00Z",
            "2026-03-09T04:00:00Z",
        ]
    );
    // Lord Howe Island, 4 October 2026: 02:00 → 02:30. That day 02:15 does
    // not exist: the occurrence keeps its instant (15:45Z the evening
    // before, read as 02:45). From the 5th it is 02:15 again, half an hour
    // earlier in UTC.
    assert_eq!(
        starts(
            "2026-10-02T15:45:00Z",
            "2026-10-02T16:45:00Z",
            "FREQ=DAILY",
            "Australia/Lord_Howe",
            "2026-10-02T00:00:00Z",
            "2026-10-06T00:00:00Z",
        ),
        [
            "2026-10-02T15:45:00Z",
            "2026-10-03T15:45:00Z",
            "2026-10-04T15:15:00Z",
            "2026-10-05T15:15:00Z",
        ]
    );
}

#[test]
fn every_occurrence_has_the_length_of_the_first_in_elapsed_time() {
    // 01:30–03:30 in Berlin across the night the clocks go back
    // (25 October 2026): still two hours of elapsed time, so it ends at
    // 02:30 on the wall clock that night.
    let series = Series {
        start_ms: ms("2026-10-23T23:30:00Z"),
        end_ms: ms("2026-10-24T01:30:00Z"),
        time_zone: "Europe/Berlin",
        rule: Some("FREQ=DAILY"),
    };
    let found = expand(
        &series,
        ms("2026-10-24T12:00:00Z"),
        ms("2026-10-26T12:00:00Z"),
    )
    .unwrap();
    let printed: Vec<(String, String)> = found
        .iter()
        .map(|occurrence| (occurrence.start_at(), occurrence.end_at()))
        .collect();
    assert_eq!(
        printed,
        [
            (
                "2026-10-24T23:30:00Z".to_owned(),
                "2026-10-25T01:30:00Z".to_owned()
            ),
            (
                "2026-10-26T00:30:00Z".to_owned(),
                "2026-10-26T02:30:00Z".to_owned()
            ),
        ]
    );
    assert!(
        found
            .iter()
            .all(|occurrence| occurrence.end_ms - occurrence.start_ms == 7_200_000)
    );
}
