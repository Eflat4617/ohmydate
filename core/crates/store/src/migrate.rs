use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::StoreError;

/// One forward-only schema change, embedded in the binary.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Every migration, in order. Versions are consecutive from 1.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "core",
        sql: include_str!("../migrations/0001_core.sql"),
    },
    Migration {
        version: 2,
        name: "owner_llm",
        sql: include_str!("../migrations/0002_owner_llm.sql"),
    },
    Migration {
        version: 3,
        name: "availability",
        sql: include_str!("../migrations/0003_availability.sql"),
    },
    Migration {
        version: 4,
        name: "commitments",
        sql: include_str!("../migrations/0004_commitments.sql"),
    },
];

/// What happened at open.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Versions applied by this open, in order.
    pub applied: Vec<i64>,
    /// Copy of the file taken before migrating existing data, if any.
    pub backup: Option<PathBuf>,
}

fn checksum(sql: &str) -> String {
    let digest = Sha256::digest(sql.as_bytes());
    let mut text = String::with_capacity(64);
    for byte in digest {
        // Writing to a String cannot fail.
        let _ = write!(text, "{byte:02x}");
    }
    text
}

pub(crate) fn run(
    connection: &mut Connection,
    path: Option<&Path>,
) -> Result<MigrationReport, StoreError> {
    run_list(connection, path, MIGRATIONS)
}

fn run_list(
    connection: &mut Connection,
    path: Option<&Path>,
    migrations: &[Migration],
) -> Result<MigrationReport, StoreError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migration (
           version INTEGER PRIMARY KEY,
           name TEXT NOT NULL,
           checksum TEXT NOT NULL,
           applied_at_ms INTEGER NOT NULL
         ) STRICT;",
    )?;

    let supported = migrations.last().map_or(0, |migration| migration.version);
    let current: i64 = connection
        .query_row("SELECT max(version) FROM schema_migration", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?
        .unwrap_or(0);
    if current > supported {
        return Err(StoreError::NewerSchema {
            found: current,
            supported,
        });
    }

    // History must match what this build embeds: an edited or missing applied
    // migration means the file and the code disagree about the schema.
    for migration in migrations
        .iter()
        .filter(|migration| migration.version <= current)
    {
        let recorded: Option<String> = connection
            .query_row(
                "SELECT checksum FROM schema_migration WHERE version = ?1",
                [migration.version],
                |row| row.get(0),
            )
            .optional()?;
        if recorded.as_deref() != Some(checksum(migration.sql).as_str()) {
            return Err(StoreError::MigrationChanged {
                version: migration.version,
            });
        }
    }

    let pending: Vec<&Migration> = migrations
        .iter()
        .filter(|migration| migration.version > current)
        .collect();
    let mut report = MigrationReport::default();
    if pending.is_empty() {
        return Ok(report);
    }

    if let (Some(path), true) = (path, current > 0) {
        let backup = backup_path(path, current);
        if !backup.exists() {
            let target = backup.to_str().ok_or(StoreError::InvalidPath)?;
            connection.execute("VACUUM INTO ?1", [target])?;
        }
        report.backup = Some(backup);
    }

    for migration in pending {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(migration.sql)?;
        transaction.execute(
            "INSERT INTO schema_migration (version, name, checksum, applied_at_ms)
             VALUES (?1, ?2, ?3, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
            (migration.version, migration.name, checksum(migration.sql)),
        )?;
        transaction.commit()?;
        report.applied.push(migration.version);
    }
    Ok(report)
}

fn backup_path(path: &Path, from_version: i64) -> PathBuf {
    let mut name = path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    name.push(format!(".pre-v{}", from_version + 1));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::TempDir;

    const FIRST: Migration = Migration {
        version: 1,
        name: "first",
        sql: "CREATE TABLE a (x INTEGER) STRICT;",
    };
    const SECOND: Migration = Migration {
        version: 2,
        name: "second",
        sql: "CREATE TABLE b (y INTEGER) STRICT;",
    };

    fn tables(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn embedded_migrations_are_consecutive_from_one() {
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            assert_eq!(migration.version, i64::try_from(index).unwrap() + 1);
            assert!(!migration.name.is_empty());
        }
    }

    #[test]
    fn a_data_file_of_the_first_schema_keeps_its_owner_through_the_upgrade() {
        let mut connection = Connection::open_in_memory().unwrap();
        run_list(&mut connection, None, &MIGRATIONS[..1]).unwrap();
        connection
            .execute(
                "INSERT INTO owner (id, email, time_zone, locale, created_at, updated_at, version) \
                 VALUES ('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55', 'owner@ohmydate.local', \
                         'Asia/Seoul', 'ko-KR', 1800000000000, 1800000000001, 3)",
                [],
            )
            .unwrap();

        let upgraded = run_list(&mut connection, None, MIGRATIONS).unwrap();
        assert_eq!(upgraded.applied.first(), Some(&2));
        let owner = crate::owner::get(&connection).unwrap().unwrap();
        assert_eq!(owner.time_zone, "Asia/Seoul");
        assert_eq!(owner.version.get(), 3);
        assert_eq!(owner.updated_at.epoch_ms(), 1_800_000_000_001);
        assert!(owner.llm.is_empty());
        // The JSON column of the first schema is gone.
        let columns: Vec<String> = connection
            .prepare("SELECT name FROM pragma_table_info('owner')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            !columns.iter().any(|name| name == "settings"),
            "{columns:?}"
        );
        assert!(columns.iter().any(|name| name == "llm_consent_granted"));
    }

    #[test]
    fn pending_migrations_apply_once_and_in_order() {
        let mut connection = Connection::open_in_memory().unwrap();
        let first = run_list(&mut connection, None, &[FIRST]).unwrap();
        assert_eq!(first.applied, vec![1]);
        let second = run_list(&mut connection, None, &[FIRST, SECOND]).unwrap();
        assert_eq!(second.applied, vec![2]);
        let third = run_list(&mut connection, None, &[FIRST, SECOND]).unwrap();
        assert!(third.applied.is_empty());
        assert_eq!(tables(&connection), vec!["a", "b", "schema_migration"]);
    }

    #[test]
    fn a_failing_migration_leaves_no_trace() {
        let mut connection = Connection::open_in_memory().unwrap();
        let broken = Migration {
            version: 2,
            name: "broken",
            sql: "CREATE TABLE b (y INTEGER) STRICT; CREATE TABLE b (z INTEGER) STRICT;",
        };
        let error = run_list(&mut connection, None, &[FIRST, broken]).unwrap_err();
        assert!(matches!(error, StoreError::Sqlite(_)));
        assert_eq!(tables(&connection), vec!["a", "schema_migration"]);
        let version: i64 = connection
            .query_row("SELECT max(version) FROM schema_migration", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn a_file_from_a_newer_build_is_refused() {
        let mut connection = Connection::open_in_memory().unwrap();
        run_list(&mut connection, None, &[FIRST, SECOND]).unwrap();
        let error = run_list(&mut connection, None, &[FIRST]).unwrap_err();
        assert!(
            matches!(
                error,
                StoreError::NewerSchema {
                    found: 2,
                    supported: 1
                }
            ),
            "{error:?}"
        );
    }

    #[test]
    fn an_edited_applied_migration_is_refused() {
        let mut connection = Connection::open_in_memory().unwrap();
        run_list(&mut connection, None, &[FIRST]).unwrap();
        let edited = Migration {
            sql: "CREATE TABLE a (x TEXT) STRICT;",
            ..FIRST
        };
        let error = run_list(&mut connection, None, &[edited]).unwrap_err();
        assert!(
            matches!(error, StoreError::MigrationChanged { version: 1 }),
            "{error:?}"
        );
    }

    #[test]
    fn existing_data_is_copied_before_an_upgrade_but_a_new_file_is_not() {
        let directory = TempDir::new("migrate");
        let path = directory.file("data.db");
        let mut connection = Connection::open(&path).unwrap();
        let fresh = run_list(&mut connection, Some(&path), &[FIRST]).unwrap();
        assert_eq!(fresh.backup, None);
        connection
            .execute("INSERT INTO a (x) VALUES (42)", [])
            .unwrap();

        let upgraded = run_list(&mut connection, Some(&path), &[FIRST, SECOND]).unwrap();
        let backup = upgraded.backup.unwrap();
        assert_eq!(backup, directory.file("data.db.pre-v2"));
        let copy = Connection::open(&backup).unwrap();
        assert_eq!(tables(&copy), vec!["a", "schema_migration"]);
        let value: i64 = copy
            .query_row("SELECT x FROM a", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, 42);
    }
}
