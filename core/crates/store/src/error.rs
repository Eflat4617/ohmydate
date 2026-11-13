use std::fmt;

/// A storage failure. These are infrastructure errors (the HTTP layer maps
/// them to a 500 `internal_error` and logs the variant name), not domain
/// outcomes.
#[derive(Debug)]
pub enum StoreError {
    /// SQLite reported an error.
    Sqlite(rusqlite::Error),
    /// A stored value does not have the shape the schema promises.
    Corrupt { table: &'static str, column: &'static str },
    /// The data file was written by a newer version of the app.
    NewerSchema { found: i64, supported: i64 },
    /// An applied migration differs from the one this build embeds.
    MigrationChanged { version: i64 },
    /// A file path is not valid UTF-8.
    InvalidPath,
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Sqlite(error) => write!(formatter, "sqlite error: {error}"),
            StoreError::Corrupt { table, column } => {
                write!(formatter, "stored value is malformed: {table}.{column}")
            }
            StoreError::NewerSchema { found, supported } => write!(
                formatter,
                "the data file has schema version {found}, but this build supports up to {supported}"
            ),
            StoreError::MigrationChanged { version } => {
                write!(formatter, "applied migration {version} does not match this build")
            }
            StoreError::InvalidPath => formatter.write_str("the file path is not valid UTF-8"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Sqlite(error)
    }
}
