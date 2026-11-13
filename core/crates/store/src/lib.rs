//! SQLite storage of the OhMyDate core.
//!
//! One data file holds everything one owner has. The file is opened in WAL
//! mode with foreign keys on; schema changes are embedded, forward-only
//! migrations applied at open. Constraints PostgreSQL enforced with features
//! SQLite lacks (exclusion constraints, ranges) are enforced by the calling
//! code inside the same write transaction.
//!
//! This crate knows SQL and domain entities. It does not know HTTP, JSON wire
//! formats or business rules.

mod error;
pub mod idempotency;
mod migrate;
pub mod owner;
pub mod projects;
mod row;
pub mod tasks;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::{OpenFlags, TransactionBehavior};

pub use error::StoreError;
pub use migrate::{MIGRATIONS, Migration, MigrationReport};
pub use rusqlite::{Connection, Transaction};

/// A page position: rows strictly after `(created_at, id)` in ascending order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageAfter {
    pub created_at: ohmydate_domain::Instant,
    pub id: ohmydate_domain::Id,
}

/// The open data file.
///
/// A single connection serialises all access. That is the right size for one
/// user on one machine: every write transaction is `BEGIN IMMEDIATE`, so there
/// are no writer conflicts to retry, and reads are short. If read latency ever
/// matters, WAL allows adding read-only connections without changing callers.
#[derive(Debug)]
pub struct Store {
    connection: Mutex<Connection>,
    path: Option<PathBuf>,
    report: MigrationReport,
}

impl Store {
    /// Opens (creating if needed) the data file and applies pending
    /// migrations. Before migrating a file that already has data, a copy is
    /// written next to it (`<file>.pre-v<N>`), so a failed upgrade can be
    /// rolled back by hand.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let mut connection = Connection::open_with_flags(path, flags)?;
        configure(&connection)?;
        // WAL survives a crash of the process and keeps readers unblocked.
        // `synchronous = NORMAL` is durable across application crashes; after
        // an OS crash or power loss the last transactions may roll back, but
        // the file stays consistent.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        let report = migrate::run(&mut connection, Some(path))?;
        Ok(Self { connection: Mutex::new(connection), path: Some(path.to_path_buf()), report })
    }

    /// A private in-memory database with the full schema. For tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let mut connection = Connection::open_in_memory()?;
        configure(&connection)?;
        let report = migrate::run(&mut connection, None)?;
        Ok(Self { connection: Mutex::new(connection), path: None, report })
    }

    /// Location of the data file; `None` for an in-memory store.
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// What the migration runner did when this store was opened.
    #[must_use]
    pub fn migration_report(&self) -> &MigrationReport {
        &self.report
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic while the lock was held cannot leave a half-applied write:
        // the transaction is rolled back when it is dropped during unwinding.
        self.connection.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs read-only queries.
    pub fn read<T, E>(&self, work: impl FnOnce(&Connection) -> Result<T, E>) -> Result<T, E> {
        work(&self.lock())
    }

    /// Runs `work` in one `BEGIN IMMEDIATE` transaction. `Ok` commits, `Err`
    /// rolls everything back.
    pub fn write<T, E>(&self, work: impl FnOnce(&Transaction<'_>) -> Result<T, E>) -> Result<T, E>
    where
        E: From<StoreError>,
    {
        let mut connection = self.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::from)?;
        let value = work(&transaction)?;
        transaction.commit().map_err(StoreError::from)?;
        Ok(value)
    }

    /// True when the file answers a trivial query. Used by `/readyz`.
    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.read(|connection| connection.query_row("SELECT 1", [], |row| row.get::<_, i64>(0)))
            .is_ok_and(|value| value == 1)
    }

    /// Writes a consistent, compacted copy of the data file to `target`
    /// (`VACUUM INTO`). Safe while the app is running. Fails if `target`
    /// exists.
    pub fn backup_to(&self, target: &Path) -> Result<(), StoreError> {
        let target = target.to_str().ok_or(StoreError::InvalidPath)?;
        self.read(|connection| connection.execute("VACUUM INTO ?1", [target]))?;
        Ok(())
    }
}

/// Runs `work` inside a savepoint of an open transaction and reports its
/// result. When `work` fails, everything it wrote is undone but the enclosing
/// transaction stays usable — the caller can still record the failure.
pub fn savepoint<T, E>(
    transaction: &Transaction<'_>,
    work: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
) -> Result<Result<T, E>, StoreError> {
    transaction.execute_batch("SAVEPOINT step")?;
    let result = work(transaction);
    if result.is_err() {
        transaction.execute_batch("ROLLBACK TO step")?;
    }
    transaction.execute_batch("RELEASE step")?;
    Ok(result)
}

fn configure(connection: &Connection) -> Result<(), StoreError> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_file_gets_the_schema_wal_mode_and_foreign_keys() {
        let directory = TempDir::new("open");
        let store = Store::open(&directory.file("data.db")).unwrap();
        assert!(store.is_ready());
        assert_eq!(store.migration_report().applied.len(), MIGRATIONS.len());
        let (journal, foreign_keys): (String, i64) = store
            .read(|connection| {
                Ok::<_, rusqlite::Error>((
                    connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?,
                    connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?,
                ))
            })
            .unwrap();
        assert_eq!(journal, "wal");
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn opening_a_path_that_cannot_be_a_file_fails() {
        let directory = TempDir::new("open-negative");
        let error = Store::open(&directory.file("missing-dir/data.db")).unwrap_err();
        assert!(matches!(error, StoreError::Sqlite(_)), "{error:?}");
    }

    #[test]
    fn a_failed_write_rolls_back_and_a_successful_one_commits() {
        let store = Store::open_in_memory().unwrap();
        let insert = "INSERT INTO project (id, title, created_at, updated_at) \
                      VALUES ('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55', 'p', 1, 1)";
        let failed: Result<(), StoreError> = store.write(|transaction| {
            transaction.execute(insert, [])?;
            Err(StoreError::InvalidPath)
        });
        assert!(failed.is_err());
        assert_eq!(count(&store, "project"), 0);

        store
            .write(|transaction| {
                transaction.execute(insert, [])?;
                Ok::<_, StoreError>(())
            })
            .unwrap();
        assert_eq!(count(&store, "project"), 1);
    }

    #[test]
    fn a_failed_savepoint_undoes_only_its_own_writes() {
        let store = Store::open_in_memory().unwrap();
        let insert = |id: char| {
            format!(
                "INSERT INTO project (id, title, created_at, updated_at) \
                 VALUES ('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c5{id}', 'p', 1, 1)"
            )
        };
        store
            .write(|transaction| {
                transaction.execute(&insert('1'), [])?;
                let failed: Result<(), &str> = savepoint(transaction, |inner| {
                    inner.execute(&insert('2'), []).map_err(|_| "sql")?;
                    Err("domain rule")
                })?;
                assert_eq!(failed, Err("domain rule"));
                let kept: Result<(), &str> = savepoint(transaction, |inner| {
                    inner.execute(&insert('3'), []).map_err(|_| "sql")?;
                    Ok(())
                })?;
                assert_eq!(kept, Ok(()));
                Ok::<_, StoreError>(())
            })
            .unwrap();
        assert_eq!(count(&store, "project"), 2);
    }

    #[test]
    fn a_backup_is_a_complete_copy_and_never_overwrites() {
        let directory = TempDir::new("backup");
        let store = Store::open(&directory.file("data.db")).unwrap();
        store
            .write(|transaction| {
                transaction.execute(
                    "INSERT INTO project (id, title, created_at, updated_at) \
                     VALUES ('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55', 'p', 1, 1)",
                    [],
                )?;
                Ok::<_, StoreError>(())
            })
            .unwrap();
        let target = directory.file("copy.db");
        store.backup_to(&target).unwrap();
        let copy = Store::open(&target).unwrap();
        assert_eq!(count(&copy, "project"), 1);
        assert!(copy.migration_report().applied.is_empty());

        assert!(store.backup_to(&target).is_err(), "an existing backup must not be overwritten");
    }

    #[test]
    fn the_bundled_sqlite_has_the_features_later_slices_need() {
        // FTS5 replaces PostgreSQL tsvector for note search; JSON functions
        // replace jsonb operators. Fail here, not in a later slice.
        let store = Store::open_in_memory().unwrap();
        store
            .read(|connection| {
                connection.execute_batch(
                    "CREATE VIRTUAL TABLE temp.probe USING fts5(title, body, tokenize = 'unicode61');
                     INSERT INTO temp.probe (title, body) VALUES ('논문 요약', '관련 논문을 읽는다');",
                )?;
                let hits: i64 = connection.query_row(
                    "SELECT count(*) FROM temp.probe WHERE probe MATCH '논문*'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(hits, 1);
                let extracted: i64 =
                    connection.query_row("SELECT json_extract('{\"a\":{\"b\":7}}', '$.a.b')", [], |row| {
                        row.get(0)
                    })?;
                assert_eq!(extracted, 7);
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
    }

    fn count(store: &Store, table: &str) -> i64 {
        store
            .read(|connection| {
                connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
            })
            .unwrap()
    }

    /// A directory under the system temp dir, removed on drop.
    pub(crate) struct TempDir(PathBuf);

    impl TempDir {
        pub(crate) fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "ohmydate-store-{label}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        pub(crate) fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
