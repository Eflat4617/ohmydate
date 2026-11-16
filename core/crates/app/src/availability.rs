//! Available hours and the availability version.
//!
//! A port of `getAvailability` / `putAvailability` and
//! `bumpAvailabilityVersion` of the reference
//! (`services/api/src/adapters/pg-planning-store.ts`).
//!
//! The availability version counts every change of what time a plan may
//! use: a `PUT` of the hours, and every create, change and delete of an
//! appointment ([`bump`]). Until the first such change there is no stored
//! state, and the answer is version 1 with the owner's time zone and the
//! default limits.

use ohmydate_domain::{
    Availability, AvailabilityPrefs, AvailabilityPut, DomainError, Version,
    validate_availability_put,
};
use ohmydate_store::availability::{self as rows, State};

use crate::{AppError, Unit, settings};

/// The owner's available hours.
///
/// Weekly windows are ordered by weekday and start, exceptions by date.
pub fn get(unit: &Unit<'_>) -> Result<Availability, AppError> {
    let (version, time_zone, prefs) = match rows::state(unit.connection)? {
        Some(state) => (state.version, state.time_zone, state.prefs),
        None => (
            Version::INITIAL,
            settings::owner(unit)?.time_zone,
            AvailabilityPrefs::default(),
        ),
    };
    Ok(Availability {
        version,
        time_zone,
        rules: rows::rules(unit.connection)?,
        exceptions: rows::exceptions(unit.connection)?,
        prefs,
    })
}

/// The availability version now.
pub fn version(unit: &Unit<'_>) -> Result<Version, AppError> {
    Ok(rows::state(unit.connection)?.map_or(Version::INITIAL, |state| state.version))
}

/// Replaces the hours when `expected` is the current availability version.
///
/// * A stale version is 412 `availability_changed`, also for a request that
///   would be refused for another reason: the caller's picture of the hours
///   is old, and that is what it has to learn first.
/// * A window that does not end after it starts, or an extra day without a
///   window, is 422 (`validate_availability_put`).
/// * The answer repeats the request in the order it listed things, with the
///   new version — as the reference answers. A later read orders them.
pub fn put(
    unit: &Unit<'_>,
    put: &AvailabilityPut,
    expected: Version,
) -> Result<Availability, AppError> {
    let current = rows::state(unit.connection)?;
    let current_version = current
        .as_ref()
        .map_or(Version::INITIAL, |state| state.version);
    if current_version != expected {
        return Err(DomainError::AvailabilityChanged {
            expected,
            actual: current_version,
        }
        .into());
    }
    validate_availability_put(put)?;

    let state = State {
        version: current_version.next(),
        time_zone: put.time_zone.clone(),
        prefs: put.prefs,
        updated_at: unit.clock.now(),
    };
    rows::replace_rules(unit.connection, &put.rules)?;
    rows::replace_exceptions(unit.connection, &put.exceptions)?;
    match current {
        Some(_) => rows::update_state(unit.connection, &state)?,
        None => rows::insert_state(unit.connection, &state)?,
    }
    Ok(Availability {
        version: state.version,
        time_zone: state.time_zone,
        rules: put.rules.clone(),
        exceptions: put.exceptions.clone(),
        prefs: put.prefs,
    })
}

/// Moves the availability version one forward: an appointment changed, so a
/// plan made before must not be approved as it is (08 §2.4a).
///
/// The caller runs this in the transaction of the change itself. The first
/// bump creates the state with the owner's time zone of that moment and the
/// default limits — from then on the hours have their own zone, which a
/// later change of the owner's setting does not move.
pub fn bump(unit: &Unit<'_>) -> Result<(), AppError> {
    let now = unit.clock.now();
    match rows::state(unit.connection)? {
        Some(_) => rows::bump_version(unit.connection, now)?,
        None => rows::insert_state(
            unit.connection,
            &State {
                version: Version::INITIAL.next(),
                time_zone: settings::owner(unit)?.time_zone,
                prefs: AvailabilityPrefs::default(),
                updated_at: now,
            },
        )?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{
        AvailabilityException, AvailabilityKind, AvailabilityRule, CalendarDate, ExceptionKind,
        LocalTime, RiskLevel,
    };

    use super::*;
    use crate::settings::SettingsPatch;
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

    fn v(value: u32) -> Version {
        Version::new(value).unwrap()
    }

    fn time(text: &str) -> LocalTime {
        LocalTime::parse(text).unwrap()
    }

    fn rule(weekday: u8, start: &str, end: &str) -> AvailabilityRule {
        AvailabilityRule {
            weekday,
            start: time(start),
            end: time(end),
            kind: AvailabilityKind::Work,
        }
    }

    fn day_off(date: &str) -> AvailabilityException {
        AvailabilityException {
            date: CalendarDate::parse(date).unwrap(),
            kind: ExceptionKind::Off,
            start: None,
            end: None,
        }
    }

    fn hours(
        rules: Vec<AvailabilityRule>,
        exceptions: Vec<AvailabilityException>,
    ) -> AvailabilityPut {
        AvailabilityPut {
            time_zone: "Europe/Berlin".into(),
            rules,
            exceptions,
            prefs: AvailabilityPrefs {
                max_daily_focus_min: 300,
                break_after_min: 50,
                break_min: 10,
                day_start: time("07:00"),
                day_end: time("22:00"),
                risk_level: RiskLevel::P90,
            },
        }
    }

    fn current(test: &TestApp) -> Availability {
        test.app.read(get).unwrap()
    }

    #[test]
    fn before_any_change_the_hours_are_version_one_in_the_owners_zone_with_the_defaults() {
        let test = TestApp::new();
        assert_eq!(
            current(&test),
            Availability {
                version: Version::INITIAL,
                time_zone: "Asia/Seoul".into(),
                rules: vec![],
                exceptions: vec![],
                prefs: AvailabilityPrefs::default(),
            }
        );
        assert_eq!(test.app.read(version).unwrap(), Version::INITIAL);
        // Until something is stored, the zone follows the owner's setting.
        run(&test, |unit| {
            let patch = SettingsPatch {
                time_zone: Some("America/New_York".into()),
                ..SettingsPatch::default()
            };
            settings::update(unit, &patch, Version::INITIAL)
        })
        .unwrap();
        assert_eq!(current(&test).time_zone, "America/New_York");
    }

    #[test]
    fn a_put_replaces_everything_and_is_the_next_version() {
        let test = TestApp::new();
        let first = hours(
            vec![rule(3, "13:00", "18:00"), rule(1, "09:00", "12:00")],
            vec![day_off("2026-12-25"), day_off("2026-11-20")],
        );
        let answered = run(&test, |unit| put(unit, &first, Version::INITIAL)).unwrap();
        assert_eq!(answered.version, v(2));
        assert_eq!(answered.time_zone, "Europe/Berlin");
        // The answer keeps the order of the request …
        assert_eq!(answered.rules, first.rules);
        assert_eq!(answered.exceptions, first.exceptions);
        assert_eq!(answered.prefs, first.prefs);
        // … and a read orders by weekday and by date.
        let read = current(&test);
        assert_eq!(read.version, v(2));
        assert_eq!(read.rules, vec![first.rules[1], first.rules[0]]);
        assert_eq!(
            read.exceptions,
            vec![first.exceptions[1], first.exceptions[0]]
        );
        assert_eq!(read.prefs, first.prefs);
        assert_eq!(test.app.read(version).unwrap(), v(2));

        // The next PUT leaves nothing of the first.
        let second = AvailabilityPut {
            time_zone: "UTC".into(),
            prefs: AvailabilityPrefs::default(),
            ..hours(vec![rule(5, "10:00", "11:00")], vec![])
        };
        let answered = run(&test, |unit| put(unit, &second, v(2))).unwrap();
        assert_eq!(answered.version, v(3));
        assert_eq!(
            current(&test),
            Availability {
                version: v(3),
                time_zone: "UTC".into(),
                rules: second.rules.clone(),
                exceptions: vec![],
                prefs: AvailabilityPrefs::default(),
            }
        );
    }

    #[test]
    fn a_stale_version_is_refused_and_changes_nothing() {
        let test = TestApp::new();
        let first = hours(vec![rule(1, "09:00", "12:00")], vec![]);
        // The very first PUT names version 1: there is no version 0.
        let error = run(&test, |unit| put(unit, &first, v(2))).unwrap_err();
        assert!(
            matches!(
                error,
                AppError::Domain(DomainError::AvailabilityChanged { expected, actual })
                    if expected == v(2) && actual == Version::INITIAL
            ),
            "{error:?}"
        );
        assert_eq!(current(&test).version, Version::INITIAL);

        run(&test, |unit| put(unit, &first, Version::INITIAL)).unwrap();
        let other = hours(vec![], vec![day_off("2026-12-25")]);
        for stale in [1, 3, 9] {
            let error = run(&test, |unit| put(unit, &other, v(stale))).unwrap_err();
            assert!(
                matches!(
                    error,
                    AppError::Domain(DomainError::AvailabilityChanged { actual, .. })
                        if actual == v(2)
                ),
                "{error:?}"
            );
        }
        let after = current(&test);
        assert_eq!(after.version, v(2));
        assert_eq!(after.rules, first.rules);
        assert!(after.exceptions.is_empty());
    }

    #[test]
    fn hours_that_break_a_rule_are_refused_whole_but_a_stale_version_is_told_first() {
        let test = TestApp::new();
        let inverted = hours(
            vec![rule(1, "09:00", "12:00"), rule(2, "18:00", "09:00")],
            vec![],
        );
        let error = run(&test, |unit| put(unit, &inverted, Version::INITIAL)).unwrap_err();
        let AppError::Domain(DomainError::ValidationFailed(issues)) = error else {
            panic!("{error:?}");
        };
        assert_eq!(issues[0].path, "/rules/1/endLocal");
        // Nothing of the refused request was kept, the valid window included.
        let after = current(&test);
        assert_eq!(after.version, Version::INITIAL);
        assert!(after.rules.is_empty());
        // With an old version the answer is 412, not 422.
        assert!(matches!(
            run(&test, |unit| put(unit, &inverted, v(4))),
            Err(AppError::Domain(DomainError::AvailabilityChanged { .. }))
        ));
    }

    #[test]
    fn a_bump_is_one_version_and_the_first_one_fixes_the_zone() {
        let test = TestApp::new();
        run(&test, bump).unwrap();
        let after_first = current(&test);
        assert_eq!(after_first.version, v(2));
        assert_eq!(after_first.time_zone, "Asia/Seoul");
        assert_eq!(after_first.prefs, AvailabilityPrefs::default());
        run(&test, bump).unwrap();
        run(&test, bump).unwrap();
        assert_eq!(current(&test).version, v(4));

        // The hours now have their own zone: the owner's setting moving on
        // does not move it (as in the reference).
        run(&test, |unit| {
            let patch = SettingsPatch {
                time_zone: Some("America/New_York".into()),
                ..SettingsPatch::default()
            };
            settings::update(unit, &patch, Version::INITIAL)
        })
        .unwrap();
        assert_eq!(current(&test).time_zone, "Asia/Seoul");
    }

    #[test]
    fn a_bump_keeps_the_hours_and_a_put_must_name_the_bumped_version() {
        let test = TestApp::new();
        let first = hours(vec![rule(1, "09:00", "12:00")], vec![day_off("2026-12-25")]);
        run(&test, |unit| put(unit, &first, Version::INITIAL)).unwrap();
        run(&test, bump).unwrap();
        let after = current(&test);
        assert_eq!(after.version, v(3));
        assert_eq!(after.time_zone, "Europe/Berlin");
        assert_eq!(after.rules, first.rules);
        assert_eq!(after.exceptions, first.exceptions);
        assert_eq!(after.prefs, first.prefs);
        // The version the PUT answered is no longer current.
        assert!(matches!(
            run(&test, |unit| put(unit, &first, v(2))),
            Err(AppError::Domain(DomainError::AvailabilityChanged { .. }))
        ));
        assert_eq!(
            run(&test, |unit| put(unit, &first, v(3))).unwrap().version,
            v(4)
        );
    }

    #[test]
    fn the_hours_survive_a_restart() {
        let test = TestApp::new();
        let first = hours(vec![rule(1, "09:00", "12:00")], vec![day_off("2026-12-25")]);
        run(&test, |unit| put(unit, &first, Version::INITIAL)).unwrap();
        let before = current(&test);
        let reopened = test.reopen(&crate::OwnerDefaults {
            email: "someone-else@example.com".into(),
            time_zone: "UTC".into(),
            locale: "en".into(),
        });
        assert_eq!(current(&reopened), before);
    }
}
