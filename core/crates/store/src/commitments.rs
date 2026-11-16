//! Appointment rows (`commitment_event`).

use ohmydate_domain::{Commitment, CommitmentSource, ExternalEvent, Id, Instant};
use rusqlite::{Connection, OptionalExtension, Row};

use crate::{StoreError, row};

const TABLE: &str = "commitment_event";

const COLUMNS: &str = "id, title, start_at, end_at, rrule, time_zone, source, version, \
     created_at, updated_at, external_calendar_id, external_event_id, external_etag";

struct RawCommitment {
    id: String,
    title: String,
    start_at: i64,
    end_at: i64,
    rrule: Option<String>,
    time_zone: String,
    source: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
    external: (Option<String>, Option<String>, Option<String>),
}

fn raw(row: &Row<'_>) -> rusqlite::Result<RawCommitment> {
    Ok(RawCommitment {
        id: row.get(0)?,
        title: row.get(1)?,
        start_at: row.get(2)?,
        end_at: row.get(3)?,
        rrule: row.get(4)?,
        time_zone: row.get(5)?,
        source: row.get(6)?,
        version: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        external: (row.get(10)?, row.get(11)?, row.get(12)?),
    })
}

fn corrupt(column: &'static str) -> StoreError {
    StoreError::Corrupt {
        table: TABLE,
        column,
    }
}

fn commitment(raw: RawCommitment) -> Result<Commitment, StoreError> {
    let source = CommitmentSource::parse(&raw.source).ok_or_else(|| corrupt("source"))?;
    // The schema ties the event reference to the source.
    let external = match raw.external {
        (Some(calendar_id), Some(event_id), etag) => Some(ExternalEvent {
            calendar_id,
            event_id,
            etag,
        }),
        (None, None, None) => None,
        _ => return Err(corrupt("external_calendar_id")),
    };
    Ok(Commitment {
        id: row::id(TABLE, "id", &raw.id)?,
        title: raw.title,
        start_at: row::instant(TABLE, "start_at", raw.start_at)?,
        end_at: row::instant(TABLE, "end_at", raw.end_at)?,
        time_zone: raw.time_zone,
        rrule: raw.rrule,
        source,
        external,
        version: row::version(TABLE, raw.version)?,
        created_at: row::instant(TABLE, "created_at", raw.created_at)?,
        updated_at: row::instant(TABLE, "updated_at", raw.updated_at)?,
    })
}

pub fn insert(connection: &Connection, commitment: &Commitment) -> Result<(), StoreError> {
    let external = commitment.external.as_ref();
    connection.execute(
        &format!(
            "INSERT INTO commitment_event ({COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
        ),
        (
            commitment.id.as_str(),
            &commitment.title,
            commitment.start_at.epoch_ms(),
            commitment.end_at.epoch_ms(),
            commitment.rrule.as_deref(),
            &commitment.time_zone,
            commitment.source.as_str(),
            commitment.version.get(),
            commitment.created_at.epoch_ms(),
            commitment.updated_at.epoch_ms(),
            external.map(|event| event.calendar_id.as_str()),
            external.map(|event| event.event_id.as_str()),
            external.and_then(|event| event.etag.as_deref()),
        ),
    )?;
    Ok(())
}

/// The appointment with this id, unless it was deleted.
pub fn get(connection: &Connection, id: &Id) -> Result<Option<Commitment>, StoreError> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM commitment_event WHERE id = ?1 AND deleted_at IS NULL"),
            [id.as_str()],
            raw,
        )
        .optional()?
        .map(commitment)
        .transpose()
}

/// Rewrites what a request can change: title, interval, zone, rule, source,
/// version and `updated_at`. The event reference and `created_at` are never
/// written. The caller has already checked the version inside the same
/// transaction.
pub fn update(connection: &Connection, commitment: &Commitment) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE commitment_event
            SET title = ?2, start_at = ?3, end_at = ?4, rrule = ?5, time_zone = ?6,
                source = ?7, version = ?8, updated_at = ?9
          WHERE id = ?1 AND deleted_at IS NULL",
        (
            commitment.id.as_str(),
            &commitment.title,
            commitment.start_at.epoch_ms(),
            commitment.end_at.epoch_ms(),
            commitment.rrule.as_deref(),
            &commitment.time_zone,
            commitment.source.as_str(),
            commitment.version.get(),
            commitment.updated_at.epoch_ms(),
        ),
    )?;
    if changed != 1 {
        return Err(corrupt("id"));
    }
    Ok(())
}

/// Marks a live appointment deleted, as its next version. The row stays:
/// what referred to it keeps its meaning.
pub fn soft_delete(
    connection: &Connection,
    commitment: &Commitment,
    now: Instant,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE commitment_event
            SET deleted_at = ?2, updated_at = ?2, version = ?3
          WHERE id = ?1 AND deleted_at IS NULL",
        (
            commitment.id.as_str(),
            now.epoch_ms(),
            commitment.version.next().get(),
        ),
    )?;
    if changed != 1 {
        return Err(corrupt("id"));
    }
    Ok(())
}

/// The appointments a window `[from, to)` can show, in id order: those that
/// happen once and overlap it, and **every** appointment with a rule — its
/// occurrences are found by expanding it, not by a query.
///
/// `after` continues behind that id; `limit` bounds the page.
pub fn list_for_window(
    connection: &Connection,
    from: Instant,
    to: Instant,
    after: Option<&Id>,
    limit: u32,
) -> Result<Vec<Commitment>, StoreError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS}
           FROM commitment_event
          WHERE deleted_at IS NULL
            AND (rrule IS NOT NULL OR (start_at < ?2 AND end_at > ?1))
            AND (?3 IS NULL OR id > ?3)
          ORDER BY id
          LIMIT ?4"
    ))?;
    let rows = statement.query_map(
        (from.epoch_ms(), to.epoch_ms(), after.map(Id::as_str), limit),
        raw,
    )?;
    let mut commitments = Vec::new();
    for row in rows {
        commitments.push(commitment(row?)?);
    }
    Ok(commitments)
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::Version;

    use super::*;
    use crate::Store;

    /// 2026-11-17T05:00:00.000Z.
    const START: i64 = 1_794_891_600_000;
    const HOUR: i64 = 3_600_000;

    fn at(epoch_ms: i64) -> Instant {
        Instant::from_epoch_ms(epoch_ms).unwrap()
    }

    fn id(last: u8) -> Id {
        Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-0000000000{last:02x}")).unwrap()
    }

    fn appointment(last: u8, start: i64, end: i64, rrule: Option<&str>) -> Commitment {
        Commitment {
            id: id(last),
            title: format!("appointment {last}"),
            start_at: at(start),
            end_at: at(end),
            time_zone: "Asia/Seoul".into(),
            rrule: rrule.map(str::to_owned),
            source: CommitmentSource::Manual,
            external: None,
            version: Version::INITIAL,
            created_at: at(1_800_000_000_000),
            updated_at: at(1_800_000_000_000),
        }
    }

    fn imported(last: u8, event: &str) -> Commitment {
        Commitment {
            source: CommitmentSource::Google,
            external: Some(ExternalEvent {
                calendar_id: "primary".into(),
                event_id: event.into(),
                etag: Some("\"etag-1\"".into()),
            }),
            ..appointment(last, START, START + HOUR, None)
        }
    }

    fn store_with(commitments: &[Commitment]) -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| {
                for commitment in commitments {
                    insert(transaction, commitment)?;
                }
                Ok::<_, StoreError>(())
            })
            .unwrap();
        store
    }

    fn listed(store: &Store, from: i64, to: i64, after: Option<&Id>, limit: u32) -> Vec<Id> {
        store
            .read(|connection| list_for_window(connection, at(from), at(to), after, limit))
            .unwrap()
            .into_iter()
            .map(|commitment| commitment.id)
            .collect()
    }

    #[test]
    fn an_appointment_round_trips_with_and_without_a_rule_and_an_event() {
        let once = appointment(1, START, START + HOUR, None);
        let weekly = appointment(2, START, START + 2 * HOUR, Some("FREQ=WEEKLY;BYDAY=TU"));
        let mirror = imported(3, "event-1");
        let no_etag = Commitment {
            external: Some(ExternalEvent {
                calendar_id: "work".into(),
                event_id: "event-2".into(),
                etag: None,
            }),
            ..imported(4, "event-2")
        };
        let store = store_with(&[
            once.clone(),
            weekly.clone(),
            mirror.clone(),
            no_etag.clone(),
        ]);
        for expected in [once, weekly, mirror, no_etag] {
            let read = store
                .read(|connection| get(connection, &expected.id))
                .unwrap();
            assert_eq!(read, Some(expected));
        }
        assert_eq!(
            store.read(|connection| get(connection, &id(9))).unwrap(),
            None
        );
    }

    #[test]
    fn an_update_rewrites_what_can_change_and_nothing_else() {
        let original = imported(1, "event-1");
        let manual = appointment(2, START, START + HOUR, Some("FREQ=DAILY"));
        let store = store_with(&[original, manual.clone()]);
        let changed = Commitment {
            title: "renamed".into(),
            start_at: at(START + HOUR),
            end_at: at(START + 3 * HOUR),
            time_zone: "Europe/Berlin".into(),
            rrule: None,
            source: CommitmentSource::Caldav,
            version: Version::INITIAL.next(),
            updated_at: at(1_800_000_000_500),
            // Not written: an update cannot move the creation time.
            created_at: at(1),
            ..manual.clone()
        };
        store
            .write(|transaction| update(transaction, &changed))
            .unwrap();
        let read = store
            .read(|connection| get(connection, &manual.id))
            .unwrap()
            .unwrap();
        assert_eq!(
            read,
            Commitment {
                created_at: manual.created_at,
                ..changed
            }
        );
        // An id that names nothing is refused, not ignored.
        let ghost = appointment(9, START, START + HOUR, None);
        assert!(matches!(
            store.write(|transaction| update(transaction, &ghost)),
            Err(StoreError::Corrupt { .. })
        ));
    }

    #[test]
    fn a_deleted_appointment_is_gone_from_reads_and_cannot_be_deleted_twice() {
        let once = appointment(1, START, START + HOUR, None);
        let store = store_with(std::slice::from_ref(&once));
        store
            .write(|transaction| soft_delete(transaction, &once, at(1_800_000_000_900)))
            .unwrap();
        assert_eq!(
            store.read(|connection| get(connection, &once.id)).unwrap(),
            None
        );
        assert!(listed(&store, START - HOUR, START + 2 * HOUR, None, 100).is_empty());
        // The row is still there, as the next version.
        let (version, deleted_at): (i64, i64) = store
            .read(|connection| {
                connection.query_row(
                    "SELECT version, deleted_at FROM commitment_event WHERE id = ?1",
                    [once.id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!((version, deleted_at), (2, 1_800_000_000_900));
        assert!(matches!(
            store.write(|transaction| soft_delete(transaction, &once, at(1_800_000_001_000))),
            Err(StoreError::Corrupt { .. })
        ));
    }

    #[test]
    fn a_window_lists_overlapping_single_appointments_and_every_recurring_one() {
        let store = store_with(&[
            appointment(1, START, START + HOUR, None),
            // Touches the window's start / end: not an overlap.
            appointment(2, START - 2 * HOUR, START, None),
            appointment(3, START + 4 * HOUR, START + 5 * HOUR, None),
            // Recurring: listed wherever its first occurrence lies.
            appointment(
                4,
                START - 1_000 * HOUR,
                START - 999 * HOUR,
                Some("FREQ=DAILY"),
            ),
            appointment(
                5,
                START + 1_000 * HOUR,
                START + 1_001 * HOUR,
                Some("FREQ=WEEKLY"),
            ),
            // Reaches into the window from before, and out of it.
            appointment(6, START - HOUR, START + 1, None),
            appointment(7, START + 4 * HOUR - 1, START + 9 * HOUR, None),
        ]);
        assert_eq!(
            listed(&store, START, START + 4 * HOUR, None, 100),
            vec![id(1), id(4), id(5), id(6), id(7)]
        );
        // Far from everything: only the recurring ones.
        assert_eq!(
            listed(
                &store,
                START + 50_000 * HOUR,
                START + 50_001 * HOUR,
                None,
                100
            ),
            vec![id(4), id(5)]
        );
    }

    #[test]
    fn pages_continue_behind_an_id_in_id_order() {
        let all: Vec<Commitment> = (1..=5)
            .rev()
            .map(|last| appointment(last, START, START + HOUR, None))
            .collect();
        let store = store_with(&all);
        let window = (START - HOUR, START + 2 * HOUR);
        assert_eq!(
            listed(&store, window.0, window.1, None, 2),
            vec![id(1), id(2)]
        );
        assert_eq!(
            listed(&store, window.0, window.1, Some(&id(2)), 2),
            vec![id(3), id(4)]
        );
        assert_eq!(
            listed(&store, window.0, window.1, Some(&id(4)), 2),
            vec![id(5)]
        );
        assert!(listed(&store, window.0, window.1, Some(&id(5)), 2).is_empty());
        assert!(listed(&store, window.0, window.1, None, 0).is_empty());
    }

    #[test]
    fn the_schema_ties_the_event_reference_to_the_source() {
        let store = Store::open_in_memory().unwrap();
        let refused = [
            // A manual appointment that names an event.
            Commitment {
                source: CommitmentSource::Manual,
                ..imported(1, "event-1")
            },
            // An imported one without an event.
            Commitment {
                external: None,
                ..imported(1, "event-1")
            },
            // An imported one with a rule of its own.
            Commitment {
                rrule: Some("FREQ=DAILY".into()),
                ..imported(1, "event-1")
            },
            // An interval that does not run forward.
            appointment(1, START, START, None),
            appointment(1, START + HOUR, START, None),
            // A title or a rule outside its length.
            Commitment {
                title: String::new(),
                ..appointment(1, START, START + HOUR, None)
            },
            Commitment {
                title: "x".repeat(201),
                ..appointment(1, START, START + HOUR, None)
            },
            appointment(1, START, START + HOUR, Some("FREQ")),
            Commitment {
                time_zone: String::new(),
                ..appointment(1, START, START + HOUR, None)
            },
        ];
        for commitment in refused {
            let result = store.write(|transaction| insert(transaction, &commitment));
            assert!(result.is_err(), "the schema accepted {commitment:?}");
        }
        // One live appointment per imported event; a deleted one frees it.
        let first = imported(1, "event-1");
        store
            .write(|transaction| insert(transaction, &first))
            .unwrap();
        assert!(
            store
                .write(|transaction| insert(transaction, &imported(2, "event-1")))
                .is_err()
        );
        store
            .write(|transaction| soft_delete(transaction, &first, at(1_800_000_000_900)))
            .unwrap();
        store
            .write(|transaction| insert(transaction, &imported(2, "event-1")))
            .unwrap();
    }

    #[test]
    fn a_row_the_code_cannot_read_is_reported_as_corrupt() {
        let store = store_with(&[appointment(1, START, START + HOUR, None)]);
        // A source the schema allows and this build would not know cannot be
        // written; an id of the wrong shape can.
        store
            .write(|transaction| {
                transaction
                    .execute(
                        "INSERT INTO commitment_event
                           (id, title, start_at, end_at, time_zone, source, version,
                            created_at, updated_at)
                         VALUES ('not-a-uuid-not-a-uuid-not-a-uuid-xxx', 't', 1, 2, 'UTC',
                                 'manual', 1, 1, 1)",
                        [],
                    )
                    .map_err(StoreError::from)
            })
            .unwrap();
        assert!(matches!(
            store.read(|connection| list_for_window(connection, at(0), at(10), None, 10)),
            Err(StoreError::Corrupt {
                table: "commitment_event",
                column: "id"
            })
        ));
    }
}
