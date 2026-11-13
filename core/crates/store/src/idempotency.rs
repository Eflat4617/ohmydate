//! Idempotency records (08 §1): one row per `Idempotency-Key`.

use ohmydate_domain::Instant;
use rusqlite::{Connection, OptionalExtension};

use crate::StoreError;

/// A response kept for replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredResponse {
    pub status: u16,
    /// Headers to replay, e.g. `ETag`. Names and values hold no line breaks.
    pub headers: Vec<(String, String)>,
    /// JSON text; `None` for an empty body.
    pub body: Option<String>,
}

/// State of a key that has been seen and has not expired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Record {
    /// A long-running operation with this key is still in flight.
    Pending { request_hash: String },
    /// The operation finished; replay `response`.
    Completed {
        request_hash: String,
        response: StoredResponse,
    },
}

fn encode_headers(headers: &[(String, String)]) -> String {
    headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_headers(text: &str) -> Result<Vec<(String, String)>, StoreError> {
    text.lines()
        .map(|line| {
            line.split_once(": ")
                .map(|(name, value)| (name.to_owned(), value.to_owned()))
                .ok_or(StoreError::Corrupt {
                    table: "idempotency_record",
                    column: "response_headers",
                })
        })
        .collect()
}

/// The unexpired record for `key`, if any.
pub fn find(
    connection: &Connection,
    key: &str,
    now: Instant,
) -> Result<Option<Record>, StoreError> {
    let found = connection
        .query_row(
            "SELECT request_hash, status, response_status, response_headers, response_body
               FROM idempotency_record
              WHERE key = ?1 AND expires_at > ?2",
            (key, now.epoch_ms()),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<u16>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((request_hash, status, response_status, headers, body)) = found else {
        return Ok(None);
    };
    match (status.as_str(), response_status, headers) {
        ("pending", None, None) => Ok(Some(Record::Pending { request_hash })),
        ("completed", Some(status), Some(headers)) => Ok(Some(Record::Completed {
            request_hash,
            response: StoredResponse {
                status,
                headers: decode_headers(&headers)?,
                body,
            },
        })),
        _ => Err(StoreError::Corrupt {
            table: "idempotency_record",
            column: "status",
        }),
    }
}

/// What to remember about a request, apart from its outcome.
#[derive(Debug, Clone, Copy)]
pub struct Reservation<'a> {
    pub key: &'a str,
    pub route: &'a str,
    pub request_hash: &'a str,
    pub now: Instant,
    pub expires_at: Instant,
}

/// Records a finished operation. Replaces an expired row with the same key.
pub fn insert_completed(
    connection: &Connection,
    reservation: Reservation<'_>,
    response: &StoredResponse,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT OR REPLACE INTO idempotency_record
           (key, route, request_hash, status, response_status, response_headers, response_body,
            created_at, expires_at)
         VALUES (?1, ?2, ?3, 'completed', ?4, ?5, ?6, ?7, ?8)",
        (
            reservation.key,
            reservation.route,
            reservation.request_hash,
            response.status,
            encode_headers(&response.headers),
            response.body.as_deref(),
            reservation.now.epoch_ms(),
            reservation.expires_at.epoch_ms(),
        ),
    )?;
    Ok(())
}

/// Marks a key as in flight before a long-running operation starts.
pub fn insert_pending(
    connection: &Connection,
    reservation: Reservation<'_>,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT OR REPLACE INTO idempotency_record
           (key, route, request_hash, status, created_at, expires_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?5)",
        (
            reservation.key,
            reservation.route,
            reservation.request_hash,
            reservation.now.epoch_ms(),
            reservation.expires_at.epoch_ms(),
        ),
    )?;
    Ok(())
}

/// Turns a pending row into a completed one. Returns false when no pending
/// row exists (it expired or was released).
pub fn complete(
    connection: &Connection,
    key: &str,
    response: &StoredResponse,
) -> Result<bool, StoreError> {
    let changed = connection.execute(
        "UPDATE idempotency_record
            SET status = 'completed', response_status = ?2, response_headers = ?3,
                response_body = ?4
          WHERE key = ?1 AND status = 'pending'",
        (
            key,
            response.status,
            encode_headers(&response.headers),
            response.body.as_deref(),
        ),
    )?;
    Ok(changed == 1)
}

/// Frees a pending key so the same key can be retried.
pub fn release(connection: &Connection, key: &str) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM idempotency_record WHERE key = ?1 AND status = 'pending'",
        [key],
    )?;
    Ok(())
}

/// Frees every pending key. Called at start: an operation that was in flight
/// when the previous process ended can no longer complete.
pub fn release_all_pending(connection: &Connection) -> Result<usize, StoreError> {
    Ok(connection.execute(
        "DELETE FROM idempotency_record WHERE status = 'pending'",
        [],
    )?)
}

/// Deletes expired rows and returns how many were removed.
pub fn delete_expired(connection: &Connection, now: Instant) -> Result<usize, StoreError> {
    Ok(connection.execute(
        "DELETE FROM idempotency_record WHERE expires_at <= ?1",
        [now.epoch_ms()],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    const KEY: &str = "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55";
    const HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn at(epoch_ms: i64) -> Instant {
        Instant::from_epoch_ms(epoch_ms).unwrap()
    }

    fn reservation(now: i64, expires: i64) -> Reservation<'static> {
        Reservation {
            key: KEY,
            route: "/tasks",
            request_hash: HASH,
            now: at(now),
            expires_at: at(expires),
        }
    }

    fn response() -> StoredResponse {
        StoredResponse {
            status: 201,
            headers: vec![("ETag".into(), "W/\"1\"".into())],
            body: Some("{\"id\":\"x\"}".into()),
        }
    }

    #[test]
    fn a_completed_record_is_replayed_until_it_expires() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| insert_completed(transaction, reservation(100, 200), &response()))
            .unwrap();
        let found = store
            .read(|connection| find(connection, KEY, at(150)))
            .unwrap();
        assert_eq!(
            found,
            Some(Record::Completed {
                request_hash: HASH.into(),
                response: response()
            })
        );
        assert_eq!(
            store
                .read(|connection| find(connection, KEY, at(200)))
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .read(|connection| find(connection, "other", at(150)))
                .unwrap(),
            None
        );
    }

    #[test]
    fn an_empty_response_round_trips() {
        let store = Store::open_in_memory().unwrap();
        let empty = StoredResponse {
            status: 204,
            headers: Vec::new(),
            body: None,
        };
        store
            .write(|transaction| insert_completed(transaction, reservation(100, 200), &empty))
            .unwrap();
        let found = store
            .read(|connection| find(connection, KEY, at(150)))
            .unwrap();
        assert_eq!(
            found,
            Some(Record::Completed {
                request_hash: HASH.into(),
                response: empty
            })
        );
    }

    #[test]
    fn a_pending_record_completes_once_or_is_released() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| insert_pending(transaction, reservation(100, 200)))
            .unwrap();
        assert_eq!(
            store
                .read(|connection| find(connection, KEY, at(150)))
                .unwrap(),
            Some(Record::Pending {
                request_hash: HASH.into()
            })
        );
        assert!(
            store
                .write(|transaction| complete(transaction, KEY, &response()))
                .unwrap()
        );
        assert!(
            !store
                .write(|transaction| complete(transaction, KEY, &response()))
                .unwrap(),
            "a completed record cannot be completed again"
        );

        // Releasing only removes pending rows.
        store
            .write(|transaction| release(transaction, KEY))
            .unwrap();
        assert!(
            store
                .read(|connection| find(connection, KEY, at(150)))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_restart_frees_pending_keys_but_keeps_completed_ones() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| insert_pending(transaction, reservation(100, 200)))
            .unwrap();
        let other = Reservation {
            key: "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56",
            ..reservation(100, 200)
        };
        store
            .write(|transaction| insert_completed(transaction, other, &response()))
            .unwrap();
        assert_eq!(
            store
                .write(|transaction| release_all_pending(transaction))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .read(|connection| find(connection, KEY, at(150)))
                .unwrap(),
            None
        );
        assert!(
            store
                .read(|connection| find(connection, other.key, at(150)))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn release_frees_a_pending_key_and_expired_rows_are_swept() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| insert_pending(transaction, reservation(100, 200)))
            .unwrap();
        store
            .write(|transaction| release(transaction, KEY))
            .unwrap();
        assert_eq!(
            store
                .read(|connection| find(connection, KEY, at(150)))
                .unwrap(),
            None
        );

        store
            .write(|transaction| insert_completed(transaction, reservation(100, 200), &response()))
            .unwrap();
        assert_eq!(
            store
                .write(|transaction| delete_expired(transaction, at(199)))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .write(|transaction| delete_expired(transaction, at(200)))
                .unwrap(),
            1
        );
    }
}
