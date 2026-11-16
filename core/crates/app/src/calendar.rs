//! All-day events of a connected calendar, for the calendar screen.
//!
//! A port of `listDayEvents` and `validateDayEventRange` of the reference.
//! Until the calendar sync exists (RC-90) nothing writes such an event, so
//! the list is empty; the range rules are already the final ones.

use ohmydate_domain::{CalendarDate, CalendarDayEvent, DomainError};
use ohmydate_store::day_events;

use crate::{AppError, Unit};

/// Longest range one read accepts, in days between its first and last day
/// (`CALENDAR_DAY_EVENT_MAX_RANGE_DAYS` of the contract).
pub const MAX_DAY_EVENT_RANGE_DAYS: i64 = 92;

/// The all-day events that touch the days `from` to `to` (`YYYY-MM-DD`,
/// both included), by start date.
///
/// `to` before `from` and a range of more than 92 days are 422, reported
/// under `/to`.
pub fn list_day_events(
    unit: &Unit<'_>,
    from: &str,
    to: &str,
) -> Result<Vec<CalendarDayEvent>, AppError> {
    let (Some(from), Some(to)) = (CalendarDate::parse(from), CalendarDate::parse(to)) else {
        return Err(DomainError::invalid("/from", "invalid date").into());
    };
    if to < from {
        return Err(DomainError::invalid("/to", "to must not be before from").into());
    }
    if to.days_since_epoch() - from.days_since_epoch() > MAX_DAY_EVENT_RANGE_DAYS {
        return Err(DomainError::invalid("/to", "range exceeds 92 days").into());
    }
    Ok(day_events::list(unit.connection, from, to)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestApp;

    fn list(test: &TestApp, from: &str, to: &str) -> Result<Vec<CalendarDayEvent>, AppError> {
        test.app.read(|unit| list_day_events(unit, from, to))
    }

    fn refused_at(result: Result<Vec<CalendarDayEvent>, AppError>) -> (String, String) {
        match result {
            Err(AppError::Domain(DomainError::ValidationFailed(issues))) => {
                (issues[0].path.clone(), issues[0].message.clone())
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn without_a_connected_calendar_every_range_is_empty() {
        let test = TestApp::new();
        assert!(list(&test, "2026-11-01", "2026-11-30").unwrap().is_empty());
        // One day is a range; 92 days between the ends is the longest.
        assert!(list(&test, "2026-11-16", "2026-11-16").unwrap().is_empty());
        assert!(list(&test, "2026-01-01", "2026-04-03").unwrap().is_empty());
    }

    #[test]
    fn an_event_the_sync_stored_is_listed() {
        let test = TestApp::new();
        test.app
            .store()
            .write(|transaction| {
                transaction
                    .execute(
                        "INSERT INTO calendar_day_event
                           (id, title, start_date, end_date, source, external_calendar_id,
                            external_event_id, created_at, updated_at, version)
                         VALUES ('0193a8f2-6c1e-7b41-9a2e-000000000001', 'Holiday',
                                 '2026-12-25', '2026-12-26', 'google', 'primary', 'e', 1, 1, 1)",
                        [],
                    )
                    .map_err(ohmydate_store::StoreError::from)
            })
            .unwrap();
        let events = list(&test, "2026-12-01", "2026-12-31").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Holiday");
        assert_eq!(events[0].start_date.to_string(), "2026-12-25");
        assert_eq!(events[0].end_date.to_string(), "2026-12-26");
        assert!(list(&test, "2026-12-26", "2026-12-31").unwrap().is_empty());
    }

    #[test]
    fn a_backwards_or_too_long_range_is_refused_under_to() {
        let test = TestApp::new();
        assert_eq!(
            refused_at(list(&test, "2026-11-02", "2026-11-01")),
            ("/to".to_owned(), "to must not be before from".to_owned())
        );
        // 2026-01-01 to 2026-04-04 is 93 days apart.
        assert_eq!(
            refused_at(list(&test, "2026-01-01", "2026-04-04")),
            ("/to".to_owned(), "range exceeds 92 days".to_owned())
        );
        assert_eq!(refused_at(list(&test, "2026-01-01", "2027-01-01")).0, "/to");
    }

    #[test]
    fn dates_the_calendar_does_not_have_are_refused_under_from() {
        let test = TestApp::new();
        for (from, to) in [
            ("2026-02-30", "2026-03-01"),
            ("2026-02-01", "2026-02-30"),
            ("yesterday", "2026-03-01"),
            ("", ""),
        ] {
            assert_eq!(
                refused_at(list(&test, from, to)),
                ("/from".to_owned(), "invalid date".to_owned()),
                "{from}..{to}"
            );
        }
    }
}
