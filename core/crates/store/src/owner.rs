//! The single owner row.

use ohmydate_domain::Owner;
use rusqlite::{Connection, OptionalExtension};

use crate::{StoreError, row};

/// The owner, or `None` in a data file that has not been initialised yet.
pub fn get(connection: &Connection) -> Result<Option<Owner>, StoreError> {
    let found = connection
        .query_row(
            "SELECT id, email, time_zone, locale, version, created_at, updated_at FROM owner",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((id, email, time_zone, locale, version, created_at, updated_at)) = found else {
        return Ok(None);
    };
    Ok(Some(Owner {
        id: row::id("owner", "id", &id)?,
        email,
        time_zone,
        locale,
        version: row::version("owner", version)?,
        created_at: row::instant("owner", "created_at", created_at)?,
        updated_at: row::instant("owner", "updated_at", updated_at)?,
    }))
}

/// Creates the owner row. The schema allows exactly one; a second insert
/// fails with a constraint error.
pub fn insert(connection: &Connection, owner: &Owner) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO owner (id, email, time_zone, locale, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            owner.id.as_str(),
            &owner.email,
            &owner.time_zone,
            &owner.locale,
            owner.version.get(),
            owner.created_at.epoch_ms(),
            owner.updated_at.epoch_ms(),
        ),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{Id, Instant, Version};

    use super::*;
    use crate::Store;

    fn owner(id: &str) -> Owner {
        let now = Instant::from_epoch_ms(1_800_000_000_000).unwrap();
        Owner {
            id: Id::parse(id).unwrap(),
            email: "owner@ohmydate.local".into(),
            time_zone: "Asia/Seoul".into(),
            locale: "ko-KR".into(),
            version: Version::INITIAL,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn the_owner_round_trips() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.read(get).unwrap(), None);
        let expected = owner("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55");
        store
            .write(|transaction| insert(transaction, &expected))
            .unwrap();
        assert_eq!(store.read(get).unwrap(), Some(expected));
    }

    #[test]
    fn a_second_owner_is_refused() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| {
                insert(transaction, &owner("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55"))
            })
            .unwrap();
        let second = store.write(|transaction| {
            insert(transaction, &owner("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56"))
        });
        assert!(matches!(second, Err(StoreError::Sqlite(_))), "{second:?}");
    }
}
