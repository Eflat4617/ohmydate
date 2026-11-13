//! Conversions between SQLite values and domain types. A value that does not
//! convert means the file was edited outside the app or the schema and the
//! code disagree; it is reported as [`StoreError::Corrupt`], never ignored.

use ohmydate_domain::{Id, Instant, Version};

use crate::StoreError;

pub(crate) fn id(table: &'static str, column: &'static str, text: &str) -> Result<Id, StoreError> {
    Id::parse(text).ok_or(StoreError::Corrupt { table, column })
}

pub(crate) fn instant(
    table: &'static str,
    column: &'static str,
    epoch_ms: i64,
) -> Result<Instant, StoreError> {
    Instant::from_epoch_ms(epoch_ms).ok_or(StoreError::Corrupt { table, column })
}

pub(crate) fn optional_instant(
    table: &'static str,
    column: &'static str,
    epoch_ms: Option<i64>,
) -> Result<Option<Instant>, StoreError> {
    epoch_ms.map(|value| instant(table, column, value)).transpose()
}

pub(crate) fn version(table: &'static str, value: i64) -> Result<Version, StoreError> {
    u32::try_from(value)
        .ok()
        .and_then(Version::new)
        .ok_or(StoreError::Corrupt { table, column: "version" })
}
