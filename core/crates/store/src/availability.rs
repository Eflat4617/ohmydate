//! Available hours: the one state row (version, zone, limits of a day), the
//! weekly windows and the exceptions of single days.

use ohmydate_domain::{
    AvailabilityException, AvailabilityKind, AvailabilityPrefs, AvailabilityRule, CalendarDate,
    ExceptionKind, Instant, LocalTime, RiskLevel, Version,
};
use rusqlite::{Connection, OptionalExtension, Row};

use crate::{StoreError, row};

/// The state row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    /// The availability version (08 §2.4a).
    pub version: Version,
    pub time_zone: String,
    pub prefs: AvailabilityPrefs,
    pub updated_at: Instant,
}

fn corrupt(table: &'static str, column: &'static str) -> StoreError {
    StoreError::Corrupt { table, column }
}

fn time(table: &'static str, column: &'static str, text: &str) -> Result<LocalTime, StoreError> {
    LocalTime::parse(text).ok_or_else(|| corrupt(table, column))
}

fn minutes(column: &'static str, value: i64) -> Result<u32, StoreError> {
    u32::try_from(value).map_err(|_| corrupt("availability_state", column))
}

type RawState = (i64, String, i64, i64, i64, String, String, String, i64);

fn raw_state(row: &Row<'_>) -> rusqlite::Result<RawState> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

/// The state row, or `None` while neither the hours nor an appointment has
/// ever been changed.
pub fn state(connection: &Connection) -> Result<Option<State>, StoreError> {
    const TABLE: &str = "availability_state";
    let Some(raw) = connection
        .query_row(
            "SELECT version, time_zone, max_daily_focus_min, break_after_min, break_min,
                    day_start_local, day_end_local, risk_level, updated_at
               FROM availability_state",
            [],
            raw_state,
        )
        .optional()?
    else {
        return Ok(None);
    };
    let (version, time_zone, focus, break_after, break_min, day_start, day_end, risk, updated_at) =
        raw;
    Ok(Some(State {
        version: row::version(TABLE, version)?,
        time_zone,
        prefs: AvailabilityPrefs {
            max_daily_focus_min: minutes("max_daily_focus_min", focus)?,
            break_after_min: minutes("break_after_min", break_after)?,
            break_min: minutes("break_min", break_min)?,
            day_start: time(TABLE, "day_start_local", &day_start)?,
            day_end: time(TABLE, "day_end_local", &day_end)?,
            risk_level: RiskLevel::parse(&risk).ok_or_else(|| corrupt(TABLE, "risk_level"))?,
        },
        updated_at: row::instant(TABLE, "updated_at", updated_at)?,
    }))
}

/// Creates the state row. The schema allows exactly one.
pub fn insert_state(connection: &Connection, state: &State) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO availability_state
           (singleton, version, time_zone, max_daily_focus_min, break_after_min, break_min,
            day_start_local, day_end_local, risk_level, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        (
            state.version.get(),
            &state.time_zone,
            state.prefs.max_daily_focus_min,
            state.prefs.break_after_min,
            state.prefs.break_min,
            state.prefs.day_start.to_string(),
            state.prefs.day_end.to_string(),
            state.prefs.risk_level.as_str(),
            state.updated_at.epoch_ms(),
        ),
    )?;
    Ok(())
}

/// Rewrites the state row. The schema refuses a version that does not grow.
pub fn update_state(connection: &Connection, state: &State) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE availability_state
            SET version = ?1, time_zone = ?2, max_daily_focus_min = ?3, break_after_min = ?4,
                break_min = ?5, day_start_local = ?6, day_end_local = ?7, risk_level = ?8,
                updated_at = ?9",
        (
            state.version.get(),
            &state.time_zone,
            state.prefs.max_daily_focus_min,
            state.prefs.break_after_min,
            state.prefs.break_min,
            state.prefs.day_start.to_string(),
            state.prefs.day_end.to_string(),
            state.prefs.risk_level.as_str(),
            state.updated_at.epoch_ms(),
        ),
    )?;
    if changed != 1 {
        return Err(corrupt("availability_state", "singleton"));
    }
    Ok(())
}

/// Moves the availability version one forward and leaves the rest of the
/// row alone. The row must exist.
pub fn bump_version(connection: &Connection, now: Instant) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE availability_state SET version = version + 1, updated_at = ?1",
        [now.epoch_ms()],
    )?;
    if changed != 1 {
        return Err(corrupt("availability_state", "singleton"));
    }
    Ok(())
}

/// The weekly windows by weekday and start; windows that share both keep
/// the order in which they were listed.
pub fn rules(connection: &Connection) -> Result<Vec<AvailabilityRule>, StoreError> {
    const TABLE: &str = "availability_rule";
    let mut statement = connection.prepare(
        "SELECT weekday, start_local, end_local, kind
           FROM availability_rule
          ORDER BY weekday, start_local, position",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut rules = Vec::new();
    for raw in rows {
        let (weekday, start, end, kind) = raw?;
        rules.push(AvailabilityRule {
            weekday: u8::try_from(weekday).map_err(|_| corrupt(TABLE, "weekday"))?,
            start: time(TABLE, "start_local", &start)?,
            end: time(TABLE, "end_local", &end)?,
            kind: AvailabilityKind::parse(&kind).ok_or_else(|| corrupt(TABLE, "kind"))?,
        });
    }
    Ok(rules)
}

/// The exceptions by date; exceptions of one day keep the order in which
/// they were listed.
pub fn exceptions(connection: &Connection) -> Result<Vec<AvailabilityException>, StoreError> {
    const TABLE: &str = "availability_exception";
    let mut statement = connection.prepare(
        "SELECT date, kind, start_local, end_local
           FROM availability_exception
          ORDER BY date, position",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut exceptions = Vec::new();
    for raw in rows {
        let (date, kind, start, end) = raw?;
        exceptions.push(AvailabilityException {
            date: CalendarDate::parse(&date).ok_or_else(|| corrupt(TABLE, "date"))?,
            kind: ExceptionKind::parse(&kind).ok_or_else(|| corrupt(TABLE, "kind"))?,
            start: start
                .map(|text| time(TABLE, "start_local", &text))
                .transpose()?,
            end: end
                .map(|text| time(TABLE, "end_local", &text))
                .transpose()?,
        });
    }
    Ok(exceptions)
}

/// Replaces every weekly window with `rules`, in their order.
pub fn replace_rules(
    connection: &Connection,
    rules: &[AvailabilityRule],
) -> Result<(), StoreError> {
    connection.execute("DELETE FROM availability_rule", [])?;
    let mut insert = connection.prepare(
        "INSERT INTO availability_rule (position, weekday, start_local, end_local, kind)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (position, rule) in rules.iter().enumerate() {
        insert.execute((
            i64::try_from(position).unwrap_or(i64::MAX),
            rule.weekday,
            rule.start.to_string(),
            rule.end.to_string(),
            rule.kind.as_str(),
        ))?;
    }
    Ok(())
}

/// Replaces every exception with `exceptions`, in their order.
pub fn replace_exceptions(
    connection: &Connection,
    exceptions: &[AvailabilityException],
) -> Result<(), StoreError> {
    connection.execute("DELETE FROM availability_exception", [])?;
    let mut insert = connection.prepare(
        "INSERT INTO availability_exception (position, date, kind, start_local, end_local)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (position, exception) in exceptions.iter().enumerate() {
        insert.execute((
            i64::try_from(position).unwrap_or(i64::MAX),
            exception.date.to_string(),
            exception.kind.as_str(),
            exception.start.map(|time| time.to_string()),
            exception.end.map(|time| time.to_string()),
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    fn at(epoch_ms: i64) -> Instant {
        Instant::from_epoch_ms(epoch_ms).unwrap()
    }

    fn version(value: u32) -> Version {
        Version::new(value).unwrap()
    }

    fn time(text: &str) -> LocalTime {
        LocalTime::parse(text).unwrap()
    }

    fn rule(weekday: u8, start: &str, end: &str, kind: AvailabilityKind) -> AvailabilityRule {
        AvailabilityRule {
            weekday,
            start: time(start),
            end: time(end),
            kind,
        }
    }

    fn exception(
        date: &str,
        kind: ExceptionKind,
        window: Option<(&str, &str)>,
    ) -> AvailabilityException {
        AvailabilityException {
            date: CalendarDate::parse(date).unwrap(),
            kind,
            start: window.map(|(start, _)| time(start)),
            end: window.map(|(_, end)| time(end)),
        }
    }

    fn first_state() -> State {
        State {
            version: version(2),
            time_zone: "Asia/Seoul".into(),
            prefs: AvailabilityPrefs::default(),
            updated_at: at(1_800_000_000_000),
        }
    }

    fn sqlite_message(error: &StoreError) -> String {
        match error {
            StoreError::Sqlite(error) => error.to_string(),
            other => panic!("expected a SQLite error, got {other:?}"),
        }
    }

    #[test]
    fn a_new_file_has_no_state_no_windows_and_no_exceptions() {
        let store = Store::open_in_memory().unwrap();
        store
            .read(|connection| {
                assert_eq!(state(connection)?, None);
                assert!(rules(connection)?.is_empty());
                assert!(exceptions(connection)?.is_empty());
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn the_state_row_round_trips_with_every_preference() {
        let store = Store::open_in_memory().unwrap();
        let written = State {
            prefs: AvailabilityPrefs {
                max_daily_focus_min: 0,
                break_after_min: 100_000,
                break_min: 5,
                day_start: time("00:00"),
                day_end: time("24:00"),
                risk_level: RiskLevel::P90,
            },
            ..first_state()
        };
        store
            .write(|transaction| {
                insert_state(transaction, &written)?;
                assert_eq!(state(transaction)?, Some(written.clone()));
                let changed = State {
                    version: version(3),
                    time_zone: "Europe/Berlin".into(),
                    prefs: AvailabilityPrefs::default(),
                    updated_at: at(1_800_000_000_500),
                };
                update_state(transaction, &changed)?;
                assert_eq!(state(transaction)?, Some(changed));
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn there_is_one_state_row() {
        let store = Store::open_in_memory().unwrap();
        let error = store
            .write(|transaction| {
                insert_state(transaction, &first_state())?;
                insert_state(transaction, &first_state())
            })
            .unwrap_err();
        assert_eq!(error.kind(), "sqlite");
        // Updating or bumping a row that is not there is refused, not ignored.
        let empty = Store::open_in_memory().unwrap();
        assert!(matches!(
            empty.write(|transaction| update_state(transaction, &first_state())),
            Err(StoreError::Corrupt { .. })
        ));
        assert!(matches!(
            empty.write(|transaction| bump_version(transaction, at(1))),
            Err(StoreError::Corrupt { .. })
        ));
    }

    #[test]
    fn the_version_moves_forward_only() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| insert_state(transaction, &first_state()))
            .unwrap();
        store
            .write(|transaction| bump_version(transaction, at(1_800_000_000_001)))
            .unwrap();
        let bumped = store.read(state).unwrap().unwrap();
        assert_eq!(bumped.version, version(3));
        assert_eq!(bumped.updated_at, at(1_800_000_000_001));
        assert_eq!(
            bumped.time_zone, "Asia/Seoul",
            "a bump leaves the rest alone"
        );

        // The same version again, and a lower one: the schema refuses both.
        for stale in [3, 2, 1] {
            let error = store
                .write(|transaction| {
                    update_state(
                        transaction,
                        &State {
                            version: version(stale),
                            ..first_state()
                        },
                    )
                })
                .unwrap_err();
            assert!(
                sqlite_message(&error).contains("availability version must increase"),
                "{error:?}"
            );
        }
        assert_eq!(store.read(state).unwrap().unwrap().version, version(3));
    }

    #[test]
    fn windows_come_back_by_weekday_and_start_and_keep_their_listed_order_within() {
        let store = Store::open_in_memory().unwrap();
        let listed = vec![
            rule(3, "13:00", "18:00", AvailabilityKind::Work),
            rule(1, "09:00", "12:00", AvailabilityKind::Focus),
            rule(3, "09:00", "12:00", AvailabilityKind::Work),
            rule(1, "09:00", "10:00", AvailabilityKind::Work),
            rule(7, "00:00", "24:00", AvailabilityKind::Work),
        ];
        store
            .write(|transaction| replace_rules(transaction, &listed))
            .unwrap();
        assert_eq!(
            store.read(rules).unwrap(),
            vec![listed[1], listed[3], listed[2], listed[0], listed[4]]
        );
        // A replacement leaves nothing of the old list.
        store
            .write(|transaction| replace_rules(transaction, &listed[4..]))
            .unwrap();
        assert_eq!(store.read(rules).unwrap(), vec![listed[4]]);
        store
            .write(|transaction| replace_rules(transaction, &[]))
            .unwrap();
        assert!(store.read(rules).unwrap().is_empty());
    }

    #[test]
    fn exceptions_come_back_by_date_with_or_without_a_window() {
        let store = Store::open_in_memory().unwrap();
        let listed = vec![
            exception("2026-12-25", ExceptionKind::Off, None),
            exception("2026-11-21", ExceptionKind::Extra, Some(("10:00", "14:00"))),
            exception("2026-12-25", ExceptionKind::Extra, Some(("20:00", "24:00"))),
            AvailabilityException {
                end: None,
                ..exception("2026-11-20", ExceptionKind::Off, Some(("09:00", "12:00")))
            },
        ];
        store
            .write(|transaction| replace_exceptions(transaction, &listed))
            .unwrap();
        assert_eq!(
            store.read(exceptions).unwrap(),
            vec![listed[3], listed[1], listed[0], listed[2]]
        );
    }

    #[test]
    fn the_schema_refuses_what_the_domain_rules_refuse() {
        let store = Store::open_in_memory().unwrap();
        // The rows are written past the domain here, as a defect would.
        for sql in [
            "INSERT INTO availability_rule VALUES (0, 1, '10:00', '09:00', 'work')",
            "INSERT INTO availability_rule VALUES (0, 1, '09:00', '09:00', 'work')",
            "INSERT INTO availability_rule VALUES (0, 8, '09:00', '10:00', 'work')",
            "INSERT INTO availability_rule VALUES (0, 1, '9:00', '10:00', 'work')",
            "INSERT INTO availability_rule VALUES (0, 1, '24:00', '24:00', 'work')",
            "INSERT INTO availability_rule VALUES (0, 1, '09:00', '24:01', 'work')",
            "INSERT INTO availability_rule VALUES (0, 1, '09:00', '10:00', 'rest')",
            "INSERT INTO availability_exception VALUES (0, '2026-11-20', 'extra', NULL, NULL)",
            "INSERT INTO availability_exception VALUES (0, '2026-11-20', 'extra', '09:00', NULL)",
            "INSERT INTO availability_exception VALUES (0, '2026-11-20', 'off', '12:00', '09:00')",
            "INSERT INTO availability_exception VALUES (0, '2026-11-2', 'off', NULL, NULL)",
            "INSERT INTO availability_exception VALUES (0, '20 Nov', 'off', NULL, NULL)",
            "INSERT INTO availability_exception VALUES (0, '2026-11-20', 'maybe', NULL, NULL)",
            "INSERT INTO availability_state VALUES (1, 0, 'UTC', 240, 60, 15, '08:00', '18:00', 'p50', 1)",
            "INSERT INTO availability_state VALUES (2, 1, 'UTC', 240, 60, 15, '08:00', '18:00', 'p50', 1)",
            "INSERT INTO availability_state VALUES (1, 1, '', 240, 60, 15, '08:00', '18:00', 'p50', 1)",
            "INSERT INTO availability_state VALUES (1, 1, 'UTC', 100001, 60, 15, '08:00', '18:00', 'p50', 1)",
            "INSERT INTO availability_state VALUES (1, 1, 'UTC', 240, 60, -1, '08:00', '18:00', 'p50', 1)",
            "INSERT INTO availability_state VALUES (1, 1, 'UTC', 240, 60, 15, '24:00', '18:00', 'p50', 1)",
            "INSERT INTO availability_state VALUES (1, 1, 'UTC', 240, 60, 15, '08:00', '18:00', 'p95', 1)",
        ] {
            let result =
                store.write(|transaction| transaction.execute(sql, []).map_err(StoreError::from));
            assert!(result.is_err(), "the schema accepted: {sql}");
        }
        // The same shapes with valid values pass, so the refusals above are
        // the checks and not a mistake in the statements.
        for sql in [
            "INSERT INTO availability_rule VALUES (0, 1, '09:00', '24:00', 'focus')",
            "INSERT INTO availability_exception VALUES (0, '2026-11-20', 'off', '09:00', NULL)",
            "INSERT INTO availability_exception VALUES (1, '2026-11-20', 'extra', '09:00', '24:00')",
            "INSERT INTO availability_state VALUES (1, 1, 'UTC', 240, 60, 15, '08:00', '24:00', 'p90', 1)",
        ] {
            store
                .write(|transaction| transaction.execute(sql, []).map_err(StoreError::from))
                .unwrap_or_else(|error| panic!("{sql}: {error}"));
        }
    }

    #[test]
    fn a_value_the_code_cannot_read_is_reported_as_corrupt() {
        let store = Store::open_in_memory().unwrap();
        // 30 February has the shape the schema checks and is not a date.
        store
            .write(|transaction| {
                transaction
                    .execute(
                        "INSERT INTO availability_exception \
                         VALUES (0, '2026-02-30', 'off', NULL, NULL)",
                        [],
                    )
                    .map_err(StoreError::from)
            })
            .unwrap();
        assert!(matches!(
            store.read(exceptions),
            Err(StoreError::Corrupt {
                table: "availability_exception",
                column: "date"
            })
        ));
    }
}
