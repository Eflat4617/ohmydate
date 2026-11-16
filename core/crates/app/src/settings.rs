//! The owner and their settings.

use ohmydate_domain::{
    DomainError, LlmBudget, LlmConsent, LlmSettings, MicroUsd, Owner, ValidationIssue, Version,
    ensure_no_nul,
};
use ohmydate_store::owner;

use crate::{AppError, Unit};

/// The provider a consent record is given for (ADR-022: the product's AI
/// provider is DeepSeek). The reference records its configured provider; the
/// core has one. RC-70 moves this next to the client that calls it.
pub const LLM_PROVIDER: &str = "deepseek";

/// Budget a limit falls back to when the owner sets only the other one
/// (`DEFAULT_LLM_DAILY_BUDGET_USD` of the reference: 0.2 dollars).
pub const DEFAULT_DAILY_BUDGET: i64 = 200_000;
/// `DEFAULT_LLM_MONTHLY_BUDGET_USD` of the reference: 5 dollars.
pub const DEFAULT_MONTHLY_BUDGET: i64 = 5_000_000;

/// New spending limits, in dollars as the contract sends them. A limit that
/// is absent keeps its value.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BudgetPatch {
    pub daily_usd: Option<f64>,
    pub monthly_usd: Option<f64>,
}

/// A change of the AI settings. An absent part keeps its value.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LlmPatch {
    /// The owner's answer to the consent question, when they gave one.
    pub consent_granted: Option<bool>,
    pub budget: Option<BudgetPatch>,
}

/// A partial change of the owner's settings: the contract's
/// `UserSettingsPatch`. An absent field keeps its value.
///
/// `time_zone` and `locale` arrive checked against the contract (an IANA
/// zone the bundled tz database knows; 2 to 35 characters).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsPatch {
    pub time_zone: Option<String>,
    pub locale: Option<String>,
    pub llm: Option<LlmPatch>,
}

/// The single owner of this data file.
pub fn owner(unit: &Unit<'_>) -> Result<Owner, AppError> {
    // `App::open` creates the row before anything else can run.
    owner::get(unit.connection)?.ok_or(AppError::Domain(DomainError::NotFound {
        resource: "user",
        id: None,
    }))
}

fn limit(
    path: &str,
    usd: Option<f64>,
    current: Option<MicroUsd>,
    default_micros: i64,
    issues: &mut Vec<ValidationIssue>,
) -> Option<MicroUsd> {
    match usd {
        Some(usd) => {
            let amount = MicroUsd::from_usd(usd);
            if amount.is_none() {
                issues.push(ValidationIssue::new(
                    path,
                    format!(
                        "{path} must be between 0 and {}",
                        MicroUsd::MAX.whole_usd().unwrap_or_default()
                    ),
                ));
            }
            amount
        }
        None => current.or_else(|| MicroUsd::from_micros(default_micros)),
    }
}

/// Changes the owner's settings when `expected` is the current version.
///
/// Follows the reference (`userSettings` in `services/api/src/http/routes.ts`
/// and `PgUserRepository.updateSettings`):
///
/// * A stale version is 412. Every accepted patch, an empty one included,
///   is a new version.
/// * A consent answer becomes a record of now and [`LLM_PROVIDER`]; without
///   an answer the record stays.
/// * A budget patch sets both limits: a limit it does not name keeps its
///   value, or takes the default when there was no budget.
///
/// One rule is the core's own: an amount is kept to the micro-dollar and may
/// not exceed [`MicroUsd::MAX`] (422).
pub fn update(
    unit: &Unit<'_>,
    patch: &SettingsPatch,
    expected: Version,
) -> Result<Owner, AppError> {
    let current = owner(unit)?;
    if current.version != expected {
        return Err(DomainError::VersionConflict {
            expected,
            actual: Some(current.version),
        }
        .into());
    }
    // The contract checks a locale's length only; a NUL in it is not text
    // the data file keeps (see `ensure_no_nul`). A time zone is a name of
    // the tz database and cannot hold one.
    if let Some(locale) = &patch.locale {
        ensure_no_nul("locale", locale)?;
    }
    let now = unit.clock.now();
    let mut llm = current.llm.clone();
    if let Some(change) = patch.llm {
        if let Some(granted) = change.consent_granted {
            llm.consent = Some(LlmConsent {
                granted,
                at: now,
                provider: LLM_PROVIDER.to_owned(),
            });
        }
        if let Some(budget) = change.budget {
            let mut issues = Vec::new();
            let daily = limit(
                "llm.budget.dailyUsd",
                budget.daily_usd,
                current.llm.budget.map(|budget| budget.daily),
                DEFAULT_DAILY_BUDGET,
                &mut issues,
            );
            let monthly = limit(
                "llm.budget.monthlyUsd",
                budget.monthly_usd,
                current.llm.budget.map(|budget| budget.monthly),
                DEFAULT_MONTHLY_BUDGET,
                &mut issues,
            );
            match (daily, monthly) {
                (Some(daily), Some(monthly)) if issues.is_empty() => {
                    llm.budget = Some(LlmBudget { daily, monthly });
                }
                _ => return Err(DomainError::ValidationFailed(issues).into()),
            }
        }
    }
    let updated = Owner {
        time_zone: patch.time_zone.clone().unwrap_or(current.time_zone),
        locale: patch.locale.clone().unwrap_or(current.locale),
        llm: LlmSettings {
            consent: llm.consent,
            budget: llm.budget,
        },
        version: current.version.next(),
        updated_at: now,
        ..current
    };
    owner::update(unit.connection, &updated)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestApp;

    /// Runs a use-case in a write transaction, one millisecond later.
    fn run<T>(
        test: &TestApp,
        work: impl FnOnce(&Unit<'_>) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        test.clock.advance_ms(1);
        test.app.store().write(|transaction| {
            work(&Unit {
                connection: transaction,
                clock: test.clock.as_ref(),
                ids: test.ids(),
            })
        })
    }

    fn current(test: &TestApp) -> Owner {
        test.app.read(owner).unwrap()
    }

    fn v(value: u32) -> Version {
        Version::new(value).unwrap()
    }

    fn usd(value: f64) -> MicroUsd {
        MicroUsd::from_usd(value).unwrap()
    }

    fn consent(granted: bool) -> SettingsPatch {
        SettingsPatch {
            llm: Some(LlmPatch {
                consent_granted: Some(granted),
                budget: None,
            }),
            ..SettingsPatch::default()
        }
    }

    fn budget(daily_usd: Option<f64>, monthly_usd: Option<f64>) -> SettingsPatch {
        SettingsPatch {
            llm: Some(LlmPatch {
                consent_granted: None,
                budget: Some(BudgetPatch {
                    daily_usd,
                    monthly_usd,
                }),
            }),
            ..SettingsPatch::default()
        }
    }

    #[test]
    fn time_zone_and_locale_change_together_or_alone() {
        let test = TestApp::new();
        let before = current(&test);
        let both = SettingsPatch {
            time_zone: Some("Europe/Berlin".into()),
            locale: Some("de-DE".into()),
            llm: None,
        };
        let updated = run(&test, |unit| update(unit, &both, v(1))).unwrap();
        assert_eq!(
            updated,
            Owner {
                time_zone: "Europe/Berlin".into(),
                locale: "de-DE".into(),
                version: v(2),
                updated_at: before.updated_at.checked_add_ms(1).unwrap(),
                ..before
            }
        );
        assert_eq!(
            current(&test),
            updated,
            "what is answered is what is stored"
        );

        let zone_only = SettingsPatch {
            time_zone: Some("America/New_York".into()),
            ..SettingsPatch::default()
        };
        let updated = run(&test, |unit| update(unit, &zone_only, v(2))).unwrap();
        assert_eq!(
            (updated.time_zone.as_str(), updated.locale.as_str()),
            ("America/New_York", "de-DE")
        );
    }

    #[test]
    fn a_stale_version_changes_nothing() {
        let test = TestApp::new();
        let before = current(&test);
        let patch = SettingsPatch {
            locale: Some("en-GB".into()),
            ..SettingsPatch::default()
        };
        for stale in [2, 9] {
            let error = run(&test, |unit| update(unit, &patch, v(stale))).unwrap_err();
            assert!(
                matches!(
                    error,
                    AppError::Domain(DomainError::VersionConflict { actual: Some(actual), .. })
                        if actual == v(1)
                ),
                "{error:?}"
            );
        }
        assert_eq!(current(&test), before);
    }

    #[test]
    fn an_empty_patch_is_still_a_new_version_as_in_the_reference() {
        let test = TestApp::new();
        let before = current(&test);
        let updated = run(&test, |unit| update(unit, &SettingsPatch::default(), v(1))).unwrap();
        assert_eq!(updated.version, v(2));
        assert!(updated.updated_at > before.updated_at);
        assert_eq!(
            (updated.time_zone, updated.locale, updated.llm),
            (before.time_zone, before.locale, before.llm)
        );
        // An `llm` object without parts decides nothing either.
        let hollow = SettingsPatch {
            llm: Some(LlmPatch::default()),
            ..SettingsPatch::default()
        };
        let updated = run(&test, |unit| update(unit, &hollow, v(2))).unwrap();
        assert!(updated.llm.is_empty());
        assert_eq!(updated.version, v(3));
    }

    #[test]
    fn consent_is_recorded_with_its_time_and_provider_and_budgets_are_additive() {
        let test = TestApp::new();
        assert!(current(&test).llm.is_empty());

        let granted = run(&test, |unit| update(unit, &consent(true), v(1))).unwrap();
        let record = granted.llm.consent.clone().unwrap();
        assert_eq!(
            (record.granted, record.provider.as_str(), record.at),
            (true, "deepseek", granted.updated_at)
        );
        assert_eq!(granted.llm.budget, None);

        let budgeted = run(&test, |unit| {
            update(unit, &budget(Some(1.5), Some(20.0)), v(2))
        })
        .unwrap();
        assert_eq!(
            budgeted.llm.budget,
            Some(LlmBudget {
                daily: usd(1.5),
                monthly: usd(20.0)
            })
        );
        assert_eq!(
            budgeted.llm.consent,
            Some(record.clone()),
            "a budget patch keeps the consent record, time included"
        );

        let revoked = run(&test, |unit| update(unit, &consent(false), v(3))).unwrap();
        let second = revoked.llm.consent.clone().unwrap();
        assert!(!second.granted);
        assert!(second.at > record.at, "a new answer is a new record");
        assert_eq!(revoked.llm.budget, budgeted.llm.budget);
        assert_eq!(current(&test), revoked);
    }

    #[test]
    fn a_budget_patch_fills_the_limit_it_does_not_name() {
        let test = TestApp::new();
        // No budget yet: the other limit takes the default.
        let daily = run(&test, |unit| update(unit, &budget(Some(1.0), None), v(1))).unwrap();
        assert_eq!(
            daily.llm.budget,
            Some(LlmBudget {
                daily: usd(1.0),
                monthly: usd(5.0)
            })
        );
        // A budget exists: the other limit keeps its value.
        let monthly = run(&test, |unit| update(unit, &budget(None, Some(30.0)), v(2))).unwrap();
        assert_eq!(
            monthly.llm.budget,
            Some(LlmBudget {
                daily: usd(1.0),
                monthly: usd(30.0)
            })
        );
        // A budget object without limits keeps both.
        let kept = run(&test, |unit| update(unit, &budget(None, None), v(3))).unwrap();
        assert_eq!(kept.llm.budget, monthly.llm.budget);
    }

    #[test]
    fn an_empty_budget_object_on_a_fresh_owner_writes_the_defaults() {
        let test = TestApp::new();
        let updated = run(&test, |unit| update(unit, &budget(None, None), v(1))).unwrap();
        assert_eq!(
            updated.llm.budget,
            Some(LlmBudget {
                daily: usd(0.2),
                monthly: usd(5.0)
            })
        );
    }

    #[test]
    fn amounts_outside_the_range_are_refused_and_nothing_is_written() {
        let test = TestApp::new();
        let before = current(&test);
        let too_large = SettingsPatch {
            locale: Some("en-GB".into()),
            ..budget(Some(1e300), Some(f64::INFINITY))
        };
        let error = run(&test, |unit| update(unit, &too_large, v(1))).unwrap_err();
        let AppError::Domain(DomainError::ValidationFailed(issues)) = error else {
            panic!("expected a validation failure, got {error:?}");
        };
        assert_eq!(
            issues,
            vec![
                ValidationIssue::new(
                    "llm.budget.dailyUsd",
                    "llm.budget.dailyUsd must be between 0 and 1000000000"
                ),
                ValidationIssue::new(
                    "llm.budget.monthlyUsd",
                    "llm.budget.monthlyUsd must be between 0 and 1000000000"
                ),
            ]
        );
        // The schema refuses a negative limit before a use-case runs; the
        // use-case does not accept one either.
        let negative = run(&test, |unit| update(unit, &budget(Some(-0.5), None), v(1)));
        assert!(matches!(
            negative,
            Err(AppError::Domain(DomainError::ValidationFailed(_)))
        ));
        assert_eq!(current(&test), before, "the locale was not changed either");
    }

    #[test]
    fn a_locale_with_a_nul_character_is_refused_not_stored() {
        let test = TestApp::new();
        let before = current(&test);
        for locale in ["\0\0", "ko\0KR", "ko-KR\0"] {
            let patch = SettingsPatch {
                locale: Some(locale.into()),
                time_zone: Some("Europe/Berlin".into()),
                llm: None,
            };
            let error = run(&test, |unit| update(unit, &patch, v(1))).unwrap_err();
            let AppError::Domain(DomainError::ValidationFailed(issues)) = error else {
                panic!("expected a validation failure, got {error:?}");
            };
            assert_eq!(
                issues,
                vec![ValidationIssue::new(
                    "locale",
                    "locale must not contain the NUL character"
                )]
            );
        }
        assert_eq!(
            current(&test),
            before,
            "the time zone was not changed either"
        );
    }

    #[test]
    fn the_largest_amount_is_accepted_and_fine_amounts_are_kept_to_the_micro_dollar() {
        let test = TestApp::new();
        let patch = budget(Some(1_000_000_000.0), Some(0.123_456_7));
        let updated = run(&test, |unit| update(unit, &patch, v(1))).unwrap();
        let stored = updated.llm.budget.unwrap();
        assert_eq!(stored.daily, MicroUsd::MAX);
        assert_eq!(stored.monthly.micros(), 123_457);
    }
}
