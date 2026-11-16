//! The single owner row.

use ohmydate_domain::{LlmBudget, LlmConsent, LlmSettings, MicroUsd, Owner};
use rusqlite::{Connection, OptionalExtension, Row};

use crate::{StoreError, row};

const COLUMNS: &str = "id, email, time_zone, locale, version, created_at, updated_at, \
     llm_consent_granted, llm_consent_at, llm_consent_provider, \
     llm_budget_daily_micro_usd, llm_budget_monthly_micro_usd";

struct RawOwner {
    id: String,
    email: String,
    time_zone: String,
    locale: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
    consent: (Option<bool>, Option<i64>, Option<String>),
    budget: (Option<i64>, Option<i64>),
}

fn raw(row: &Row<'_>) -> rusqlite::Result<RawOwner> {
    Ok(RawOwner {
        id: row.get(0)?,
        email: row.get(1)?,
        time_zone: row.get(2)?,
        locale: row.get(3)?,
        version: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        consent: (row.get(7)?, row.get(8)?, row.get(9)?),
        budget: (row.get(10)?, row.get(11)?),
    })
}

fn corrupt(column: &'static str) -> StoreError {
    StoreError::Corrupt {
        table: "owner",
        column,
    }
}

fn amount(column: &'static str, micros: i64) -> Result<MicroUsd, StoreError> {
    MicroUsd::from_micros(micros).ok_or_else(|| corrupt(column))
}

fn owner(raw: RawOwner) -> Result<Owner, StoreError> {
    // The schema stores a consent record and a budget whole or not at all.
    let consent = match raw.consent {
        (None, None, None) => None,
        (Some(granted), Some(at), Some(provider)) => Some(LlmConsent {
            granted,
            at: row::instant("owner", "llm_consent_at", at)?,
            provider,
        }),
        _ => return Err(corrupt("llm_consent_granted")),
    };
    let budget = match raw.budget {
        (None, None) => None,
        (Some(daily), Some(monthly)) => Some(LlmBudget {
            daily: amount("llm_budget_daily_micro_usd", daily)?,
            monthly: amount("llm_budget_monthly_micro_usd", monthly)?,
        }),
        _ => return Err(corrupt("llm_budget_daily_micro_usd")),
    };
    Ok(Owner {
        id: row::id("owner", "id", &raw.id)?,
        email: raw.email,
        time_zone: raw.time_zone,
        locale: raw.locale,
        llm: LlmSettings { consent, budget },
        version: row::version("owner", raw.version)?,
        created_at: row::instant("owner", "created_at", raw.created_at)?,
        updated_at: row::instant("owner", "updated_at", raw.updated_at)?,
    })
}

/// The owner, or `None` in a data file that has not been initialised yet.
pub fn get(connection: &Connection) -> Result<Option<Owner>, StoreError> {
    connection
        .query_row(&format!("SELECT {COLUMNS} FROM owner"), [], raw)
        .optional()?
        .map(owner)
        .transpose()
}

/// Creates the owner row. The schema allows exactly one; a second insert
/// fails with a constraint error.
pub fn insert(connection: &Connection, owner: &Owner) -> Result<(), StoreError> {
    let consent = owner.llm.consent.as_ref();
    let budget = owner.llm.budget.as_ref();
    connection.execute(
        &format!(
            "INSERT INTO owner ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
        ),
        (
            owner.id.as_str(),
            &owner.email,
            &owner.time_zone,
            &owner.locale,
            owner.version.get(),
            owner.created_at.epoch_ms(),
            owner.updated_at.epoch_ms(),
            consent.map(|consent| consent.granted),
            consent.map(|consent| consent.at.epoch_ms()),
            consent.map(|consent| consent.provider.as_str()),
            budget.map(|budget| budget.daily.micros()),
            budget.map(|budget| budget.monthly.micros()),
        ),
    )?;
    Ok(())
}

/// Rewrites what the owner can change: time zone, locale, the AI settings,
/// version and `updated_at`. `id`, `email` and `created_at` are never
/// written. The caller has already checked the version inside the same
/// transaction.
pub fn update(connection: &Connection, owner: &Owner) -> Result<(), StoreError> {
    let consent = owner.llm.consent.as_ref();
    let budget = owner.llm.budget.as_ref();
    let changed = connection.execute(
        "UPDATE owner
            SET time_zone = ?2, locale = ?3, version = ?4, updated_at = ?5,
                llm_consent_granted = ?6, llm_consent_at = ?7, llm_consent_provider = ?8,
                llm_budget_daily_micro_usd = ?9, llm_budget_monthly_micro_usd = ?10
          WHERE id = ?1",
        (
            owner.id.as_str(),
            &owner.time_zone,
            &owner.locale,
            owner.version.get(),
            owner.updated_at.epoch_ms(),
            consent.map(|consent| consent.granted),
            consent.map(|consent| consent.at.epoch_ms()),
            consent.map(|consent| consent.provider.as_str()),
            budget.map(|budget| budget.daily.micros()),
            budget.map(|budget| budget.monthly.micros()),
        ),
    )?;
    if changed != 1 {
        return Err(corrupt("id"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{Id, Instant, Version};

    use super::*;
    use crate::Store;

    const OWNER_ID: &str = "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55";

    fn at(epoch_ms: i64) -> Instant {
        Instant::from_epoch_ms(epoch_ms).unwrap()
    }

    fn owner(id: &str) -> Owner {
        let now = at(1_800_000_000_000);
        Owner {
            id: Id::parse(id).unwrap(),
            email: "owner@ohmydate.local".into(),
            time_zone: "Asia/Seoul".into(),
            locale: "ko-KR".into(),
            llm: LlmSettings::default(),
            version: Version::INITIAL,
            created_at: now,
            updated_at: now,
        }
    }

    fn decided() -> LlmSettings {
        LlmSettings {
            consent: Some(LlmConsent {
                granted: true,
                at: at(1_800_000_050_000),
                provider: "deepseek".into(),
            }),
            budget: Some(LlmBudget {
                daily: MicroUsd::from_usd(1.5).unwrap(),
                monthly: MicroUsd::from_usd(20.0).unwrap(),
            }),
        }
    }

    fn stored(store: &Store) -> Owner {
        store.read(get).unwrap().unwrap()
    }

    #[test]
    fn the_owner_round_trips() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.read(get).unwrap(), None);
        let expected = owner(OWNER_ID);
        store
            .write(|transaction| insert(transaction, &expected))
            .unwrap();
        assert_eq!(stored(&store), expected);
    }

    #[test]
    fn an_owner_with_ai_settings_round_trips() {
        let store = Store::open_in_memory().unwrap();
        let expected = Owner {
            llm: decided(),
            ..owner(OWNER_ID)
        };
        store
            .write(|transaction| insert(transaction, &expected))
            .unwrap();
        assert_eq!(stored(&store), expected);
    }

    #[test]
    fn a_second_owner_is_refused() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| insert(transaction, &owner(OWNER_ID)))
            .unwrap();
        let second = store.write(|transaction| {
            insert(transaction, &owner("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56"))
        });
        assert!(matches!(second, Err(StoreError::Sqlite(_))), "{second:?}");
    }

    #[test]
    fn an_update_rewrites_the_settings_and_nothing_else() {
        let store = Store::open_in_memory().unwrap();
        let created = owner(OWNER_ID);
        store
            .write(|transaction| insert(transaction, &created))
            .unwrap();

        let changed = Owner {
            // Never written by an update, whatever the caller passes.
            email: "someone-else@example.com".into(),
            created_at: at(1),
            time_zone: "Europe/Berlin".into(),
            locale: "de-DE".into(),
            llm: decided(),
            version: created.version.next(),
            updated_at: at(1_800_000_060_000),
            ..created.clone()
        };
        store
            .write(|transaction| update(transaction, &changed))
            .unwrap();
        assert_eq!(
            stored(&store),
            Owner {
                email: created.email.clone(),
                created_at: created.created_at,
                ..changed.clone()
            }
        );

        // Settings can be taken back to "nothing decided".
        let cleared = Owner {
            llm: LlmSettings::default(),
            ..stored(&store)
        };
        store
            .write(|transaction| update(transaction, &cleared))
            .unwrap();
        assert_eq!(stored(&store), cleared);
    }

    #[test]
    fn an_update_of_an_owner_that_is_not_in_the_file_fails() {
        let store = Store::open_in_memory().unwrap();
        let missing = store.write(|transaction| update(transaction, &owner(OWNER_ID)));
        assert!(
            matches!(
                missing,
                Err(StoreError::Corrupt {
                    table: "owner",
                    column: "id"
                })
            ),
            "{missing:?}"
        );
    }

    #[test]
    fn the_schema_refuses_half_a_consent_record_half_a_budget_and_bad_amounts() {
        let store = Store::open_in_memory().unwrap();
        store
            .write(|transaction| insert(transaction, &owner(OWNER_ID)))
            .unwrap();
        for assignment in [
            "llm_consent_granted = 1",
            "llm_consent_at = 1800000000000",
            "llm_consent_provider = 'deepseek'",
            "llm_consent_granted = 2, llm_consent_at = 1, llm_consent_provider = 'x'",
            "llm_consent_granted = 1, llm_consent_at = 1, llm_consent_provider = ''",
            "llm_consent_granted = 1, llm_consent_at = -1, llm_consent_provider = 'x'",
            "llm_budget_daily_micro_usd = 200000",
            "llm_budget_monthly_micro_usd = 5000000",
            "llm_budget_daily_micro_usd = -1, llm_budget_monthly_micro_usd = 1",
            "llm_budget_daily_micro_usd = 1, llm_budget_monthly_micro_usd = 1000000000000001",
        ] {
            let result: Result<usize, StoreError> = store.write(|transaction| {
                Ok(transaction.execute(&format!("UPDATE owner SET {assignment}"), [])?)
            });
            assert!(
                matches!(result, Err(StoreError::Sqlite(_))),
                "{assignment}: {result:?}"
            );
        }
        // The whole records are accepted.
        let whole: Result<usize, StoreError> = store.write(|transaction| {
            Ok(transaction.execute(
                "UPDATE owner SET llm_consent_granted = 0, llm_consent_at = 1, \
                 llm_consent_provider = 'deepseek', llm_budget_daily_micro_usd = 0, \
                 llm_budget_monthly_micro_usd = 1000000000000000",
                [],
            )?)
        });
        assert_eq!(whole.unwrap(), 1);
        assert!(!stored(&store).llm.consent.unwrap().granted);
    }
}
