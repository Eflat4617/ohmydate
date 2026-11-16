//! All-day events of a connected calendar (`calendar_day_event`). Nothing
//! writes them before the calendar sync (RC-90).

use ohmydate_domain::{CalendarDate, CalendarDayEvent};
use rusqlite::Connection;

use crate::{StoreError, row};

const TABLE: &str = "calendar_day_event";

/// Most events one read returns (the contract's `maxItems`).
pub const MAX_DAY_EVENTS: u32 = 2_000;

/// The events that touch the days `from` to `to`, both included, by start
/// date and id. An event covers `start_date` up to, not including,
/// `end_date`.
pub fn list(
    connection: &Connection,
    from: CalendarDate,
    to: CalendarDate,
) -> Result<Vec<CalendarDayEvent>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT id, title, start_date, end_date
           FROM calendar_day_event
          WHERE deleted_at IS NULL AND start_date <= ?2 AND end_date > ?1
          ORDER BY start_date, id
          LIMIT ?3",
    )?;
    let rows = statement.query_map((from.to_string(), to.to_string(), MAX_DAY_EVENTS), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let date = |column: &'static str, text: &str| {
        CalendarDate::parse(text).ok_or(StoreError::Corrupt {
            table: TABLE,
            column,
        })
    };
    let mut events = Vec::new();
    for raw in rows {
        let (id, title, start_date, end_date) = raw?;
        events.push(CalendarDayEvent {
            id: row::id(TABLE, "id", &id)?,
            title,
            start_date: date("start_date", &start_date)?,
            end_date: date("end_date", &end_date)?,
            // The calendar's name lives with the connection (RC-90).
            calendar_name: None,
        });
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    fn date(text: &str) -> CalendarDate {
        CalendarDate::parse(text).unwrap()
    }

    /// Writes an event the way the sync will; there is no writer yet.
    fn add(store: &Store, last: u8, start: &str, end: &str, deleted: bool) {
        store
            .write(|transaction| {
                transaction
                    .execute(
                        "INSERT INTO calendar_day_event
                           (id, title, start_date, end_date, source, external_calendar_id,
                            external_event_id, created_at, updated_at, version, deleted_at)
                         VALUES (?1, ?2, ?3, ?4, 'google', 'primary', ?5, 1, 1, 1, ?6)",
                        (
                            format!("0193a8f2-6c1e-7b41-9a2e-0000000000{last:02x}"),
                            format!("event {last}"),
                            start,
                            end,
                            format!("event-{last}"),
                            deleted.then_some(5_i64),
                        ),
                    )
                    .map_err(StoreError::from)
            })
            .unwrap();
    }

    fn listed(store: &Store, from: &str, to: &str) -> Vec<String> {
        store
            .read(|connection| list(connection, date(from), date(to)))
            .unwrap()
            .into_iter()
            .map(|event| event.title)
            .collect()
    }

    #[test]
    fn a_new_file_has_no_day_events() {
        let store = Store::open_in_memory().unwrap();
        assert!(listed(&store, "2026-01-01", "2026-12-31").is_empty());
    }

    #[test]
    fn events_touching_the_days_are_listed_by_start_date() {
        let store = Store::open_in_memory().unwrap();
        add(&store, 1, "2026-11-20", "2026-11-21", false); // the 20th only
        add(&store, 2, "2026-11-18", "2026-11-20", false); // the 18th and 19th
        add(&store, 3, "2026-11-10", "2026-11-25", false); // spans everything
        add(&store, 4, "2026-11-22", "2026-11-23", false); // after
        add(&store, 5, "2026-11-20", "2026-11-22", true); // deleted
        add(&store, 6, "2026-11-21", "2026-11-22", false); // the 21st
        // Both ends are included: the 20th to the 21st.
        assert_eq!(
            listed(&store, "2026-11-20", "2026-11-21"),
            ["event 3", "event 1", "event 6"]
        );
        // An event ends before its end date: the 20th is not in event 2.
        assert_eq!(
            listed(&store, "2026-11-19", "2026-11-19"),
            ["event 3", "event 2"]
        );
        assert_eq!(
            listed(&store, "2026-11-22", "2026-11-22"),
            ["event 3", "event 4"]
        );
        assert!(listed(&store, "2026-12-01", "2026-12-31").is_empty());
        let events = store
            .read(|connection| list(connection, date("2026-11-20"), date("2026-11-20")))
            .unwrap();
        assert_eq!(events[1].start_date, date("2026-11-20"));
        assert_eq!(events[1].end_date, date("2026-11-21"));
        assert_eq!(events[1].calendar_name, None);
    }

    #[test]
    fn the_schema_refuses_events_that_are_not_whole_days_of_an_imported_calendar() {
        let store = Store::open_in_memory().unwrap();
        for (start, end, source) in [
            ("2026-11-20", "2026-11-20", "google"),
            ("2026-11-21", "2026-11-20", "google"),
            ("2026-11-20T00:00", "2026-11-21", "google"),
            ("2026-11-20", "2026-11-21", "manual"),
        ] {
            let result = store.write(|transaction| {
                transaction
                    .execute(
                        "INSERT INTO calendar_day_event
                           (id, title, start_date, end_date, source, external_calendar_id,
                            external_event_id, created_at, updated_at, version)
                         VALUES ('0193a8f2-6c1e-7b41-9a2e-000000000001', 't', ?1, ?2, ?3,
                                 'primary', 'e', 1, 1, 1)",
                        (start, end, source),
                    )
                    .map_err(StoreError::from)
            });
            assert!(
                result.is_err(),
                "the schema accepted {start}..{end} from {source}"
            );
        }
    }
}
