//! Appointments: list with their occurrences, create, change, delete.
//!
//! A port of the commitment use-cases of the reference
//! (`plan-service.ts` for the rules, `pg-planning-store.ts` for the writes).
//! The checks run in the reference's order, so a request with several faults
//! gets the same answer. Every write also moves the availability version
//! ([`crate::availability::bump`]) in the same transaction: an appointment
//! changes what time a plan may use.
//!
//! Instants arrive as the request wrote them. The contract's `date-time`
//! format lets a few texts through that are not instants the core keeps (a
//! leap second, a year before 1970); those are 422 under the field's
//! pointer, as in the reference.

use ohmydate_domain::{
    Commitment, CommitmentSource, DomainError, Id, Instant, Version, validate_commitment_title,
};
use ohmydate_recurrence::{
    ExpandError, MAX_LOOKBACK_MS, MAX_OCCURRENCES, MAX_RANGE_MS, Occurrence, Rule, Series, expand,
    knows_time_zone,
};
use ohmydate_store::commitments as rows;

use crate::{AppError, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, Unit, availability};

/// Largest `COUNT` of a rule a request may write. A stored rule may count
/// up to 2,000 ([`MAX_OCCURRENCES`]); new ones are held lower so walking a
/// count stays cheap (`MAX_WRITE_RRULE_COUNT` of the reference).
pub const MAX_WRITE_RULE_COUNT: i64 = 1_000;

/// Longest rule text (the contract's `maxLength`).
pub const MAX_RULE_LENGTH: usize = 500;

const MINUTE_MS: i64 = 60_000;

const READ_ONLY: &str = "this commitment is imported from Google Calendar and is read-only here; \
                         change it in Google Calendar";

/// A new appointment: the contract's `CommitmentCreate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitmentCreate {
    pub title: String,
    pub start_at: String,
    pub end_at: String,
    pub time_zone: String,
    pub rrule: Option<String>,
    /// `None` is `manual`.
    pub source: Option<CommitmentSource>,
}

/// A partial change: the contract's `CommitmentPatch`. An absent field
/// keeps its value; `rrule: Some(None)` removes the rule.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitmentPatch {
    pub title: Option<String>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub time_zone: Option<String>,
    pub rrule: Option<Option<String>>,
    pub source: Option<CommitmentSource>,
}

/// The window and paging of a list request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowQuery {
    pub from: String,
    pub to: String,
    /// The `nextCursor` of the page before: the id of its last appointment.
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

/// An appointment with its occurrences inside the window of the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub commitment: Commitment,
    pub occurrences: Vec<Occurrence>,
}

/// One page of appointments, in id order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitmentPage {
    pub items: Vec<Listed>,
    pub next_cursor: Option<Id>,
}

fn invalid(path: &str, message: &str) -> AppError {
    DomainError::invalid(path, message).into()
}

fn instant(path: &str, text: &str) -> Result<Instant, AppError> {
    Instant::parse_rfc3339(text).map_err(|_| invalid(path, "invalid instant"))
}

/// `assertMinutePrecision`: the bounds of a window are whole minutes.
fn minute_instant(path: &str, text: &str) -> Result<Instant, AppError> {
    let at = instant(path, text)?;
    if at.epoch_ms() % MINUTE_MS != 0 {
        return Err(invalid(path, "instant must have minute precision"));
    }
    Ok(at)
}

/// `validateRRule`: the text is a supported rule a request may write.
fn validate_rule(text: &str) -> Result<(), AppError> {
    // The reference's database cannot hold a NUL at all; SQLite's text
    // functions stop at one. Neither is a rule anyone meant.
    if text.contains('\0') || text.chars().count() > MAX_RULE_LENGTH {
        return Err(invalid("/rrule", "Malformed RRULE part"));
    }
    match Rule::parse(text) {
        Err(error) => Err(invalid("/rrule", error.message())),
        Ok(rule) if rule.count.is_some_and(|count| count > MAX_WRITE_RULE_COUNT) => {
            Err(invalid("/rrule", "RRULE COUNT must be at most 1000"))
        }
        Ok(_) => Ok(()),
    }
}

/// `assertStartNotTooOld`: a new start lies at most ten years back. Older
/// rules would make every read walk years of days.
fn assert_start_not_too_old(start: Instant, now: Instant) -> Result<(), AppError> {
    if now.epoch_ms() - start.epoch_ms() > MAX_LOOKBACK_MS {
        return Err(invalid(
            "/startAt",
            "commitment starts more than ten years before now",
        ));
    }
    Ok(())
}

/// `assertInterval`: an end that is no instant is no end after the start.
fn end_after(start: Instant, end_text: &str) -> Result<Instant, AppError> {
    Instant::parse_rfc3339(end_text)
        .ok()
        .filter(|end| *end > start)
        .ok_or_else(|| invalid("/endAt", "commitment endAt must be after startAt"))
}

/// What the contract already guarantees for a request over HTTP, checked
/// again for callers that do not come through it: the zone is one the tz
/// database has, the source is one a request may name.
fn validate_zone_and_source(
    time_zone: Option<&str>,
    source: Option<CommitmentSource>,
) -> Result<(), AppError> {
    if time_zone.is_some_and(|zone| !knows_time_zone(zone)) {
        return Err(invalid(
            "/timeZone",
            "timeZone must be an IANA time zone name",
        ));
    }
    if source.is_some_and(|source| !source.is_writable()) {
        return Err(invalid(
            "/source",
            "source must be manual, caldav or vikunja",
        ));
    }
    Ok(())
}

/// The appointments a window `[from, to)` can show, each with its
/// occurrences inside it (`listCommitments`).
///
/// * `from` and `to` are whole minutes and at most 366 days apart (422
///   under `/from` or `/to`).
/// * An appointment that happens once is listed when it overlaps the
///   window. One with a rule is **always** listed, with the occurrences the
///   rule gives inside the window — possibly none.
/// * All appointments of a page together may have at most 2,000 occurrences
///   (422 under `/to`).
/// * Pages are in id order; `next_cursor` is set when the page is full.
///
/// One corner is the reference's and kept: a window that does not run
/// forward is only noticed when an appointment is expanded against it (422
/// under `/rrule`). With nothing to expand the answer is an empty page.
pub fn list(unit: &Unit<'_>, query: &WindowQuery) -> Result<CommitmentPage, AppError> {
    let from = minute_instant("/from", &query.from)?;
    let to = minute_instant("/to", &query.to)?;
    if to.epoch_ms() - from.epoch_ms() > MAX_RANGE_MS {
        return Err(invalid("/to", "commitment range exceeds 366 days"));
    }
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT);
    let after = query
        .cursor
        .as_deref()
        .map(|cursor| Id::parse(cursor).ok_or_else(|| invalid("cursor", "invalid list cursor")))
        .transpose()?;

    let found = rows::list_for_window(unit.connection, from, to, after.as_ref(), limit)?;
    let full = u32::try_from(found.len()).is_ok_and(|count| count == limit);
    let mut total = 0_usize;
    let mut items = Vec::with_capacity(found.len());
    for commitment in found {
        let series = Series {
            start_ms: commitment.start_at.epoch_ms(),
            end_ms: commitment.end_at.epoch_ms(),
            time_zone: &commitment.time_zone,
            rule: commitment.rrule.as_deref(),
        };
        let occurrences = expand(&series, from.epoch_ms(), to.epoch_ms()).map_err(|error| {
            let path = match error {
                ExpandError::UnknownTimeZone => "/timeZone",
                _ => "/rrule",
            };
            invalid(path, error.message())
        })?;
        total += occurrences.len();
        if total > MAX_OCCURRENCES {
            return Err(invalid(
                "/to",
                "commitments expand to more than 2000 occurrences",
            ));
        }
        items.push(Listed {
            commitment,
            occurrences,
        });
    }
    let next_cursor = if full {
        items.last().map(|last| last.commitment.id.clone())
    } else {
        None
    };
    Ok(CommitmentPage { items, next_cursor })
}

/// Creates an appointment (`createCommitment`).
///
/// Refused with 422: a start that is no instant or lies more than ten years
/// back (`/startAt`), an end that is not after the start (`/endAt`), a rule
/// outside the supported subset or with a `COUNT` above 1,000 (`/rrule`).
pub fn create(unit: &Unit<'_>, input: &CommitmentCreate) -> Result<Commitment, AppError> {
    let now = unit.clock.now();
    let start_at = instant("/startAt", &input.start_at)?;
    assert_start_not_too_old(start_at, now)?;
    let end_at = end_after(start_at, &input.end_at)?;
    if let Some(rule) = &input.rrule {
        validate_rule(rule)?;
    }
    validate_commitment_title(&input.title)?;
    validate_zone_and_source(Some(&input.time_zone), input.source)?;

    let commitment = Commitment {
        id: unit.ids.next_id(),
        title: input.title.clone(),
        start_at,
        end_at,
        time_zone: input.time_zone.clone(),
        rrule: input.rrule.clone(),
        source: input.source.unwrap_or(CommitmentSource::Manual),
        external: None,
        version: Version::INITIAL,
        created_at: now,
        updated_at: now,
    };
    rows::insert(unit.connection, &commitment)?;
    availability::bump(unit)?;
    Ok(commitment)
}

/// Changes an appointment when `expected` is its current version
/// (`updateCommitment`).
///
/// The order of the answers is the reference's:
///
/// 1. the patch on its own — a rule, a start, or a start and end together
///    that are refused (422), whatever the appointment is;
/// 2. no such appointment (404);
/// 3. imported from Google Calendar (409 `illegal_transition`): it is
///    edited there, also when the version in the request is stale;
/// 4. a stale version (412);
/// 5. the interval after merging the patch into the appointment (422).
///
/// Every accepted patch, an empty one included, is a new version.
pub fn update(
    unit: &Unit<'_>,
    id: &Id,
    patch: &CommitmentPatch,
    expected: Version,
) -> Result<Commitment, AppError> {
    let now = unit.clock.now();
    if let Some(Some(rule)) = &patch.rrule {
        validate_rule(rule)?;
    }
    let new_start = patch
        .start_at
        .as_deref()
        .map(|text| instant("/startAt", text))
        .transpose()?;
    if let Some(start) = new_start {
        assert_start_not_too_old(start, now)?;
    }
    if let (Some(start), Some(end_text)) = (new_start, patch.end_at.as_deref()) {
        end_after(start, end_text)?;
    }
    if let Some(title) = &patch.title {
        validate_commitment_title(title)?;
    }
    validate_zone_and_source(patch.time_zone.as_deref(), patch.source)?;

    let current =
        rows::get(unit.connection, id)?.ok_or_else(|| DomainError::not_found("commitment", id))?;
    if current.is_read_only() {
        return Err(DomainError::IllegalTransition(READ_ONLY.to_owned()).into());
    }
    if current.version != expected {
        return Err(DomainError::VersionConflict {
            expected,
            actual: Some(current.version),
        }
        .into());
    }
    let start_at = new_start.unwrap_or(current.start_at);
    let end_at = match patch.end_at.as_deref() {
        Some(text) => instant("/endAt", text)?,
        None => current.end_at,
    };
    if end_at <= start_at {
        return Err(invalid("/endAt", "commitment endAt must be after startAt"));
    }

    let updated = Commitment {
        title: patch.title.clone().unwrap_or(current.title),
        start_at,
        end_at,
        time_zone: patch.time_zone.clone().unwrap_or(current.time_zone),
        rrule: match &patch.rrule {
            Some(rule) => rule.clone(),
            None => current.rrule,
        },
        source: patch.source.unwrap_or(current.source),
        version: expected.next(),
        updated_at: now,
        ..current
    };
    rows::update(unit.connection, &updated)?;
    availability::bump(unit)?;
    Ok(updated)
}

/// Deletes an appointment when `expected` is its current version
/// (`deleteCommitment`): 404, then 409 for an imported one, then 412.
pub fn delete(unit: &Unit<'_>, id: &Id, expected: Version) -> Result<(), AppError> {
    let current =
        rows::get(unit.connection, id)?.ok_or_else(|| DomainError::not_found("commitment", id))?;
    if current.is_read_only() {
        return Err(DomainError::IllegalTransition(READ_ONLY.to_owned()).into());
    }
    if current.version != expected {
        return Err(DomainError::VersionConflict {
            expected,
            actual: Some(current.version),
        }
        .into());
    }
    rows::soft_delete(unit.connection, &current, unit.clock.now())?;
    availability::bump(unit)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{ExternalEvent, ProblemCode};

    use super::*;
    use crate::testing::TestApp;

    const DAY_MS: i64 = 24 * 60 * MINUTE_MS;

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

    fn at(text: &str) -> Instant {
        Instant::parse_rfc3339(text).unwrap()
    }

    /// A weekly seminar: Tuesday 14:00–16:00 in Seoul, from 17 November 2026.
    fn seminar() -> CommitmentCreate {
        CommitmentCreate {
            title: "Weekly seminar".into(),
            start_at: "2026-11-17T05:00:00Z".into(),
            end_at: "2026-11-17T07:00:00Z".into(),
            time_zone: "Asia/Seoul".into(),
            rrule: Some("FREQ=WEEKLY;BYDAY=TU".into()),
            source: None,
        }
    }

    fn once(title: &str, start_at: &str, end_at: &str) -> CommitmentCreate {
        CommitmentCreate {
            title: title.into(),
            start_at: start_at.into(),
            end_at: end_at.into(),
            time_zone: "UTC".into(),
            rrule: None,
            source: None,
        }
    }

    fn window(from: &str, to: &str) -> WindowQuery {
        WindowQuery {
            from: from.into(),
            to: to.into(),
            ..WindowQuery::default()
        }
    }

    fn listed(test: &TestApp, query: &WindowQuery) -> CommitmentPage {
        test.app.read(|unit| list(unit, query)).unwrap()
    }

    fn availability_version(test: &TestApp) -> u32 {
        test.app.read(availability::version).unwrap().get()
    }

    /// The pointer and message of a 422.
    fn refusal<T: std::fmt::Debug>(result: Result<T, AppError>) -> (String, String) {
        match result {
            Err(AppError::Domain(DomainError::ValidationFailed(issues))) => {
                assert_eq!(issues.len(), 1, "{issues:?}");
                (issues[0].path.clone(), issues[0].message.clone())
            }
            other => panic!("expected a 422, got {other:?}"),
        }
    }

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> ProblemCode {
        match result {
            Err(AppError::Domain(error)) => error.code(),
            other => panic!("expected a domain error, got {other:?}"),
        }
    }

    /// An appointment the calendar sync imported (no request can make one).
    fn imported(test: &TestApp) -> Commitment {
        run(test, |unit| {
            let now = unit.clock.now();
            let commitment = Commitment {
                id: unit.ids.next_id(),
                title: "Dentist".into(),
                start_at: at("2026-11-18T01:00:00Z"),
                end_at: at("2026-11-18T02:00:00Z"),
                time_zone: "Asia/Seoul".into(),
                rrule: None,
                source: CommitmentSource::Google,
                external: Some(ExternalEvent {
                    calendar_id: "primary".into(),
                    event_id: "event-1".into(),
                    etag: None,
                }),
                version: Version::INITIAL,
                created_at: now,
                updated_at: now,
            };
            rows::insert(unit.connection, &commitment)?;
            Ok(commitment)
        })
        .unwrap()
    }

    // ------------------------------------------------------------ create

    #[test]
    fn a_created_appointment_is_stored_as_written_and_moves_the_availability_version() {
        let test = TestApp::new();
        assert_eq!(availability_version(&test), 1);
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        assert_eq!(created.title, "Weekly seminar");
        assert_eq!(created.start_at, at("2026-11-17T05:00:00Z"));
        assert_eq!(created.end_at, at("2026-11-17T07:00:00Z"));
        assert_eq!(created.time_zone, "Asia/Seoul");
        assert_eq!(created.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU"));
        assert_eq!(created.source, CommitmentSource::Manual);
        assert_eq!(created.external, None);
        assert_eq!(created.version, Version::INITIAL);
        assert_eq!(created.created_at, created.updated_at);
        assert_eq!(availability_version(&test), 2);

        let caldav = CommitmentCreate {
            source: Some(CommitmentSource::Caldav),
            // A blank title is a title, and it is kept as written.
            title: "  ".into(),
            ..once(
                "x",
                "2026-11-18T01:00:00+09:00",
                "2026-11-18T02:00:00+09:00",
            )
        };
        let second = run(&test, |unit| create(unit, &caldav)).unwrap();
        assert_eq!(second.source, CommitmentSource::Caldav);
        assert_eq!(second.title, "  ");
        // An offset is normalised to UTC.
        assert_eq!(second.start_at, at("2026-11-17T16:00:00Z"));
        assert_ne!(second.id, created.id);
        assert_eq!(availability_version(&test), 3);
    }

    #[test]
    fn a_start_may_lie_ten_years_back_and_not_a_millisecond_more() {
        let test = TestApp::new();
        // `run` moves the clock one millisecond before the use-case reads it.
        let now = TestApp::START_MS + 1;
        let edge = Instant::from_epoch_ms(now - MAX_LOOKBACK_MS).unwrap();
        let too_old = Instant::from_epoch_ms(now - MAX_LOOKBACK_MS - 1).unwrap();
        let input = |start: Instant| CommitmentCreate {
            start_at: start.to_rfc3339(),
            end_at: start.checked_add_ms(3_600_000).unwrap().to_rfc3339(),
            ..seminar()
        };
        assert_eq!(
            refusal(run(&test, |unit| create(unit, &input(too_old)))),
            (
                "/startAt".to_owned(),
                "commitment starts more than ten years before now".to_owned()
            )
        );
        assert_eq!(availability_version(&test), 1, "a refusal is not a change");
        test.clock.advance_ms(-1);
        run(&test, |unit| create(unit, &input(edge))).unwrap();
    }

    #[test]
    fn faults_of_a_new_appointment_are_reported_in_the_references_order() {
        let test = TestApp::new();
        let with = |change: fn(&mut CommitmentCreate)| {
            let mut input = seminar();
            change(&mut input);
            refusal(run(&test, |unit| create(unit, &input))).0
        };
        // Each fault alone.
        assert_eq!(
            with(|input| input.start_at = "2026-11-17T23:59:60Z".into()),
            "/startAt"
        );
        assert_eq!(
            with(|input| input.start_at = "1969-12-31T23:00:00Z".into()),
            "/startAt"
        );
        assert_eq!(
            with(|input| input.start_at = "2001-01-01T00:00:00Z".into()),
            "/startAt"
        );
        assert_eq!(
            with(|input| input.end_at = "2026-11-17T05:00:00Z".into()),
            "/endAt"
        );
        assert_eq!(
            with(|input| input.end_at = "2026-11-17T04:59:59Z".into()),
            "/endAt"
        );
        assert_eq!(
            with(|input| input.end_at = "2026-11-17T23:59:60Z".into()),
            "/endAt"
        );
        assert_eq!(
            with(|input| input.rrule = Some("FREQ=HOURLY".into())),
            "/rrule"
        );
        assert_eq!(with(|input| input.title = "a\0b".into()), "/title");
        assert_eq!(
            with(|input| input.time_zone = "Mars/Olympus_Mons".into()),
            "/timeZone"
        );
        assert_eq!(
            with(|input| input.source = Some(CommitmentSource::Google)),
            "/source"
        );
        // Together: the start, then the interval, then the rule.
        assert_eq!(
            with(|input| {
                input.start_at = "2001-01-01T00:00:00Z".into();
                input.end_at = "2000-01-01T00:00:00Z".into();
                input.rrule = Some("FREQ=HOURLY".into());
            }),
            "/startAt"
        );
        assert_eq!(
            with(|input| {
                input.end_at = "2026-11-17T05:00:00Z".into();
                input.rrule = Some("FREQ=HOURLY".into());
            }),
            "/endAt"
        );
        // Nothing of any refused request exists.
        assert!(
            listed(
                &test,
                &window("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")
            )
            .items
            .is_empty()
        );
        assert_eq!(availability_version(&test), 1);
    }

    #[test]
    fn a_rule_must_be_in_the_subset_and_count_at_most_a_thousand() {
        let test = TestApp::new();
        let with_rule = |rule: &str| CommitmentCreate {
            rrule: Some(rule.to_owned()),
            ..seminar()
        };
        for rule in [
            "FREQ=DAILY;COUNT=1000",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
            "FREQ=MONTHLY;BYMONTHDAY=31",
            "FREQ=YEARLY;UNTIL=20301231",
        ] {
            run(&test, |unit| create(unit, &with_rule(rule))).unwrap();
        }
        for (rule, message) in [
            ("FREQ=DAILY;COUNT=1001", "RRULE COUNT must be at most 1000"),
            ("FREQ=DAILY;COUNT=2000", "RRULE COUNT must be at most 1000"),
            (
                "FREQ=DAILY;COUNT=2001",
                "RRULE COUNT must be between 1 and 2000",
            ),
            (
                "FREQ=DAILY;BYDAY=MO",
                "RRULE BYDAY is only supported with FREQ=WEEKLY",
            ),
            ("FREQ=DAILY;SECRET=hunter2", "Unsupported RRULE part"),
            ("FREQ=DAILY;COUNT=3\0", "Malformed RRULE part"),
        ] {
            assert_eq!(
                refusal(run(&test, |unit| create(unit, &with_rule(rule)))),
                ("/rrule".to_owned(), message.to_owned()),
                "{rule:?}"
            );
        }
        let long = format!("FREQ=WEEKLY;BYDAY={}", "MO,".repeat(170) + "MO");
        assert!(long.chars().count() > MAX_RULE_LENGTH);
        assert_eq!(
            refusal(run(&test, |unit| create(unit, &with_rule(&long)))).0,
            "/rrule"
        );
    }

    // -------------------------------------------------------------- list

    #[test]
    fn a_window_lists_each_appointment_with_its_occurrences_inside_it() {
        let test = TestApp::new();
        let weekly = run(&test, |unit| create(unit, &seminar())).unwrap();
        let single = run(&test, |unit| {
            create(
                unit,
                &once("Dentist", "2026-11-19T01:00:00Z", "2026-11-19T02:00:00Z"),
            )
        })
        .unwrap();
        let outside = run(&test, |unit| {
            create(
                unit,
                &once("Later", "2026-12-24T01:00:00Z", "2026-12-24T02:00:00Z"),
            )
        })
        .unwrap();

        let page = listed(
            &test,
            &window("2026-11-11T00:00:00Z", "2026-11-25T00:00:00Z"),
        );
        assert_eq!(page.next_cursor, None);
        let ids: Vec<&Id> = page.items.iter().map(|item| &item.commitment.id).collect();
        assert_eq!(
            ids,
            [&weekly.id, &single.id],
            "id order; `Later` does not overlap"
        );
        assert!(!ids.contains(&&outside.id));

        // A rule's occurrences are computed: printed without a zero fraction.
        let occurrences: Vec<(String, String)> = page.items[0]
            .occurrences
            .iter()
            .map(|occurrence| (occurrence.start_at(), occurrence.end_at()))
            .collect();
        assert_eq!(
            occurrences,
            [
                (
                    "2026-11-17T05:00:00Z".to_owned(),
                    "2026-11-17T07:00:00Z".to_owned()
                ),
                (
                    "2026-11-24T05:00:00Z".to_owned(),
                    "2026-11-24T07:00:00Z".to_owned()
                ),
            ]
        );
        // An appointment that happens once is its own stored instants.
        assert_eq!(page.items[1].occurrences.len(), 1);
        assert_eq!(
            page.items[1].occurrences[0].start_at(),
            "2026-11-19T01:00:00.000Z"
        );
        assert_eq!(
            page.items[1].occurrences[0].end_at(),
            "2026-11-19T02:00:00.000Z"
        );
    }

    #[test]
    fn a_recurring_appointment_is_listed_even_where_it_has_no_occurrence() {
        let test = TestApp::new();
        let weekly = run(&test, |unit| create(unit, &seminar())).unwrap();
        // Before its start, and between two Tuesdays.
        for query in [
            window("2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z"),
            window("2026-11-18T00:00:00Z", "2026-11-20T00:00:00Z"),
        ] {
            let page = listed(&test, &query);
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].commitment.id, weekly.id);
            assert!(page.items[0].occurrences.is_empty());
        }
    }

    #[test]
    fn occurrences_follow_the_wall_clock_across_a_clock_change() {
        let test = TestApp::new();
        // Sundays 09:00 in New York; the clocks go back on 1 November 2026.
        let input = CommitmentCreate {
            title: "Brunch".into(),
            start_at: "2026-10-25T13:00:00Z".into(),
            end_at: "2026-10-25T14:00:00Z".into(),
            time_zone: "America/New_York".into(),
            rrule: Some("FREQ=WEEKLY".into()),
            source: None,
        };
        run(&test, |unit| create(unit, &input)).unwrap();
        let page = listed(
            &test,
            &window("2026-10-25T00:00:00Z", "2026-11-09T00:00:00Z"),
        );
        let starts: Vec<String> = page.items[0]
            .occurrences
            .iter()
            .map(Occurrence::start_at)
            .collect();
        assert_eq!(
            starts,
            [
                "2026-10-25T13:00:00Z",
                "2026-11-01T14:00:00Z",
                "2026-11-08T14:00:00Z"
            ]
        );
    }

    #[test]
    fn pages_are_in_id_order_and_a_full_page_names_its_last_id() {
        let test = TestApp::new();
        let mut ids = Vec::new();
        for index in 0..5 {
            let input = once(
                &format!("appointment {index}"),
                "2026-11-19T01:00:00Z",
                "2026-11-19T02:00:00Z",
            );
            ids.push(run(&test, |unit| create(unit, &input)).unwrap().id);
        }
        let page_of = |cursor: Option<&Id>, limit: Option<u32>| {
            listed(
                &test,
                &WindowQuery {
                    cursor: cursor.map(|id| id.as_str().to_owned()),
                    limit,
                    ..window("2026-11-19T00:00:00Z", "2026-11-20T00:00:00Z")
                },
            )
        };
        let ids_of = |page: &CommitmentPage| -> Vec<Id> {
            page.items
                .iter()
                .map(|item| item.commitment.id.clone())
                .collect()
        };
        let first = page_of(None, Some(2));
        assert_eq!(ids_of(&first), ids[0..2]);
        assert_eq!(first.next_cursor.as_ref(), Some(&ids[1]));
        let second = page_of(first.next_cursor.as_ref(), Some(2));
        assert_eq!(ids_of(&second), ids[2..4]);
        let third = page_of(second.next_cursor.as_ref(), Some(2));
        assert_eq!(ids_of(&third), ids[4..5]);
        assert_eq!(third.next_cursor, None);
        // As in the reference, a page that is exactly full still names a
        // cursor; the page behind it is empty.
        let exact = page_of(None, Some(5));
        assert_eq!(exact.next_cursor.as_ref(), Some(&ids[4]));
        let behind = page_of(exact.next_cursor.as_ref(), Some(5));
        assert!(behind.items.is_empty() && behind.next_cursor.is_none());
        // Without a limit a page holds 20; a limit is held to 1..=100.
        assert_eq!(page_of(None, None).items.len(), 5);
        assert_eq!(page_of(None, Some(0)).items.len(), 1);
        assert_eq!(page_of(None, Some(1_000)).items.len(), 5);
    }

    #[test]
    fn a_window_is_whole_minutes_at_most_366_days_and_its_cursor_an_id() {
        let test = TestApp::new();
        let refused = |query: WindowQuery| refusal(test.app.read(|unit| list(unit, &query)));
        assert_eq!(
            refused(window("2026-11-11T00:00:30Z", "2026-11-12T00:00:00Z")),
            (
                "/from".to_owned(),
                "instant must have minute precision".to_owned()
            )
        );
        assert_eq!(
            refused(window("2026-11-11T00:00:00Z", "2026-11-12T00:00:00.001Z")).0,
            "/to"
        );
        // `from` is judged before `to`.
        assert_eq!(
            refused(window("2026-11-11T00:00:30Z", "2026-11-12T00:00:30Z")).0,
            "/from"
        );
        assert_eq!(
            refused(window("2026-11-11T23:59:60Z", "2026-11-12T00:00:00Z")),
            ("/from".to_owned(), "invalid instant".to_owned())
        );
        assert_eq!(
            refused(window("2026-11-11T00:00:00Z", "1960-01-01T00:00:00Z")).0,
            "/to"
        );
        assert_eq!(
            refused(window("2026-01-01T00:00:00Z", "2027-01-02T00:01:00Z")),
            (
                "/to".to_owned(),
                "commitment range exceeds 366 days".to_owned()
            )
        );
        // Exactly 366 days is a window.
        assert!(
            listed(
                &test,
                &window("2026-01-01T00:00:00Z", "2027-01-02T00:00:00Z")
            )
            .items
            .is_empty()
        );
        assert_eq!(
            refused(WindowQuery {
                cursor: Some("not-an-id".into()),
                ..window("2026-11-11T00:00:00Z", "2026-11-12T00:00:00Z")
            })
            .0,
            "cursor"
        );
    }

    #[test]
    fn a_window_that_does_not_run_forward_is_noticed_only_when_something_is_expanded() {
        let test = TestApp::new();
        let backwards = window("2026-11-25T00:00:00Z", "2026-11-11T00:00:00Z");
        let empty = window("2026-11-11T00:00:00Z", "2026-11-11T00:00:00Z");
        // Nothing to expand: an empty page (the reference's corner).
        assert!(listed(&test, &backwards).items.is_empty());
        assert!(listed(&test, &empty).items.is_empty());
        run(&test, |unit| create(unit, &seminar())).unwrap();
        for query in [backwards, empty] {
            assert_eq!(
                refusal(test.app.read(|unit| list(unit, &query))),
                (
                    "/rrule".to_owned(),
                    "occurrence range is not a valid interval".to_owned()
                )
            );
        }
    }

    #[test]
    fn a_page_holds_at_most_two_thousand_occurrences_in_all() {
        let test = TestApp::new();
        let daily = |title: &str| CommitmentCreate {
            title: title.into(),
            start_at: "2026-01-01T09:00:00Z".into(),
            end_at: "2026-01-01T10:00:00Z".into(),
            time_zone: "UTC".into(),
            rrule: Some("FREQ=DAILY".into()),
            source: None,
        };
        // 366 days of five daily appointments: 1,830 occurrences.
        for index in 0..5 {
            run(&test, |unit| {
                create(unit, &daily(&format!("daily {index}")))
            })
            .unwrap();
        }
        let year = window("2026-01-01T00:00:00Z", "2027-01-02T00:00:00Z");
        let page = listed(&test, &year);
        let total: usize = page.items.iter().map(|item| item.occurrences.len()).sum();
        assert_eq!(total, 5 * 366);
        // A sixth makes 2,196.
        run(&test, |unit| create(unit, &daily("daily 5"))).unwrap();
        assert_eq!(
            refusal(test.app.read(|unit| list(unit, &year))),
            (
                "/to".to_owned(),
                "commitments expand to more than 2000 occurrences".to_owned()
            )
        );
        // The cap is per page: smaller pages of the same window pass.
        let paged = listed(
            &test,
            &WindowQuery {
                limit: Some(5),
                ..year.clone()
            },
        );
        assert_eq!(paged.items.len(), 5);
        // And a shorter window passes whole.
        assert_eq!(
            listed(
                &test,
                &window("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")
            )
            .items
            .len(),
            6
        );
    }

    // ------------------------------------------------------------ update

    #[test]
    fn a_patch_changes_what_it_names_and_is_a_new_version_of_both() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        assert_eq!(availability_version(&test), 2);

        let rename = CommitmentPatch {
            title: Some("Renamed seminar".into()),
            ..CommitmentPatch::default()
        };
        let renamed = run(&test, |unit| update(unit, &created.id, &rename, v(1))).unwrap();
        assert_eq!(
            renamed,
            Commitment {
                title: "Renamed seminar".into(),
                version: v(2),
                updated_at: renamed.updated_at,
                ..created.clone()
            }
        );
        assert!(renamed.updated_at > created.updated_at);
        assert_eq!(availability_version(&test), 3);

        let everything = CommitmentPatch {
            title: Some("Moved".into()),
            start_at: Some("2026-11-18T05:00:00Z".into()),
            end_at: Some("2026-11-18T06:30:00Z".into()),
            time_zone: Some("Europe/Berlin".into()),
            rrule: Some(None),
            source: Some(CommitmentSource::Vikunja),
        };
        let moved = run(&test, |unit| update(unit, &created.id, &everything, v(2))).unwrap();
        assert_eq!(moved.title, "Moved");
        assert_eq!(moved.start_at, at("2026-11-18T05:00:00Z"));
        assert_eq!(moved.end_at, at("2026-11-18T06:30:00Z"));
        assert_eq!(moved.time_zone, "Europe/Berlin");
        assert_eq!(moved.rrule, None, "`rrule: null` removes the rule");
        assert_eq!(moved.source, CommitmentSource::Vikunja);
        assert_eq!(moved.version, v(3));
        assert_eq!(moved.created_at, created.created_at);

        // An empty patch is accepted and is a new version too.
        let touched = run(&test, |unit| {
            update(unit, &created.id, &CommitmentPatch::default(), v(3))
        })
        .unwrap();
        assert_eq!(touched.version, v(4));
        assert_eq!(touched.title, "Moved");
        assert_eq!(availability_version(&test), 5);
        // What a read gives is what the last patch answered.
        let page = listed(
            &test,
            &window("2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z"),
        );
        assert_eq!(page.items[0].commitment, touched);
    }

    #[test]
    fn one_end_of_the_interval_alone_is_judged_against_the_stored_other() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        let end_only = |text: &str| CommitmentPatch {
            end_at: Some(text.into()),
            ..CommitmentPatch::default()
        };
        let start_only = |text: &str| CommitmentPatch {
            start_at: Some(text.into()),
            ..CommitmentPatch::default()
        };
        for patch in [
            end_only("2026-11-17T05:00:00Z"),
            end_only("2026-11-17T04:00:00Z"),
            start_only("2026-11-17T07:00:00Z"),
            start_only("2026-11-17T09:00:00Z"),
        ] {
            assert_eq!(
                refusal(run(&test, |unit| update(unit, &created.id, &patch, v(1)))),
                (
                    "/endAt".to_owned(),
                    "commitment endAt must be after startAt".to_owned()
                )
            );
        }
        assert_eq!(
            refusal(run(&test, |unit| {
                update(unit, &created.id, &end_only("2026-11-17T23:59:60Z"), v(1))
            })),
            ("/endAt".to_owned(), "invalid instant".to_owned())
        );
        // A shorter and a longer appointment are fine.
        let shorter = run(&test, |unit| {
            update(unit, &created.id, &end_only("2026-11-17T05:30:00Z"), v(1))
        })
        .unwrap();
        assert_eq!(shorter.end_at, at("2026-11-17T05:30:00Z"));
        let earlier = run(&test, |unit| {
            update(unit, &created.id, &start_only("2026-11-17T04:00:00Z"), v(2))
        })
        .unwrap();
        assert_eq!(earlier.start_at, at("2026-11-17T04:00:00Z"));
        assert_eq!(availability_version(&test), 4, "two accepted patches");
    }

    #[test]
    fn a_refused_patch_is_told_before_missing_imported_and_stale() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        let google = imported(&test);
        let missing = crate::testing::id(0xee);
        let bad_rule = CommitmentPatch {
            rrule: Some(Some("FREQ=HOURLY".into())),
            ..CommitmentPatch::default()
        };
        let too_old = CommitmentPatch {
            start_at: Some("2001-01-01T00:00:00Z".into()),
            ..CommitmentPatch::default()
        };
        let inverted = CommitmentPatch {
            start_at: Some("2026-11-17T09:00:00Z".into()),
            end_at: Some("2026-11-17T08:00:00Z".into()),
            ..CommitmentPatch::default()
        };
        // 1. The patch on its own: 422 whatever it is aimed at.
        for (patch, path) in [
            (&bad_rule, "/rrule"),
            (&too_old, "/startAt"),
            (&inverted, "/endAt"),
        ] {
            for (id, version) in [(&missing, v(1)), (&google.id, v(1)), (&created.id, v(9))] {
                assert_eq!(
                    refusal(run(&test, |unit| update(unit, id, patch, version))).0,
                    path
                );
            }
        }
        let rename = CommitmentPatch {
            title: Some("x".into()),
            ..CommitmentPatch::default()
        };
        // 2. Missing.
        assert_eq!(
            code(run(&test, |unit| update(unit, &missing, &rename, v(1)))),
            ProblemCode::NotFound
        );
        // 3. Imported: 409 with the right version and with a stale one.
        for version in [v(1), v(7)] {
            let error = run(&test, |unit| update(unit, &google.id, &rename, version)).unwrap_err();
            assert!(
                matches!(&error, AppError::Domain(DomainError::IllegalTransition(message))
                    if message.contains("read-only")),
                "{error:?}"
            );
        }
        // 4. Stale.
        let stale = run(&test, |unit| update(unit, &created.id, &rename, v(2))).unwrap_err();
        assert!(
            matches!(
                stale,
                AppError::Domain(DomainError::VersionConflict { expected, actual })
                    if expected == v(2) && actual == Some(v(1))
            ),
            "{stale:?}"
        );
        // None of it changed anything.
        assert_eq!(availability_version(&test), 2, "only the create");
        let page = listed(
            &test,
            &window("2026-11-17T00:00:00Z", "2026-11-19T00:00:00Z"),
        );
        let titles: Vec<&str> = page
            .items
            .iter()
            .map(|item| item.commitment.title.as_str())
            .collect();
        assert_eq!(titles, ["Weekly seminar", "Dentist"]);
    }

    #[test]
    fn an_old_appointment_keeps_its_start_when_a_patch_does_not_name_it() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        // Eleven years later the start is older than a new one may be.
        test.clock.advance_ms(11 * 366 * DAY_MS);
        let rule_only = CommitmentPatch {
            rrule: Some(Some("FREQ=WEEKLY;BYDAY=TU,TH".into())),
            ..CommitmentPatch::default()
        };
        let updated = run(&test, |unit| update(unit, &created.id, &rule_only, v(1))).unwrap();
        assert_eq!(updated.start_at, created.start_at);
        // Naming the same old start again is refused.
        let same_start = CommitmentPatch {
            start_at: Some(created.start_at.to_rfc3339()),
            ..CommitmentPatch::default()
        };
        assert_eq!(
            refusal(run(&test, |unit| update(
                unit,
                &created.id,
                &same_start,
                v(2)
            )))
            .0,
            "/startAt"
        );
    }

    // ------------------------------------------------------------ delete

    #[test]
    fn a_deleted_appointment_is_gone_and_the_availability_version_moved() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        let month = window("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
        assert_eq!(listed(&test, &month).items.len(), 1);
        run(&test, |unit| delete(unit, &created.id, v(1))).unwrap();
        assert_eq!(availability_version(&test), 3);
        assert!(listed(&test, &month).items.is_empty());
        // It can be neither deleted nor changed again: it is not there.
        assert_eq!(
            code(run(&test, |unit| delete(unit, &created.id, v(2)))),
            ProblemCode::NotFound
        );
        assert_eq!(
            code(run(&test, |unit| {
                update(unit, &created.id, &CommitmentPatch::default(), v(2))
            })),
            ProblemCode::NotFound
        );
        assert_eq!(availability_version(&test), 3);
    }

    #[test]
    fn delete_answers_missing_then_imported_then_stale() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        let google = imported(&test);
        assert_eq!(
            code(run(&test, |unit| delete(
                unit,
                &crate::testing::id(0xee),
                v(1)
            ))),
            ProblemCode::NotFound
        );
        for version in [v(1), v(5)] {
            assert_eq!(
                code(run(&test, |unit| delete(unit, &google.id, version))),
                ProblemCode::IllegalTransition
            );
        }
        assert_eq!(
            code(run(&test, |unit| delete(unit, &created.id, v(2)))),
            ProblemCode::VersionConflict
        );
        // Both are still there, and nothing moved the availability version.
        let page = listed(
            &test,
            &window("2026-11-17T00:00:00Z", "2026-11-19T00:00:00Z"),
        );
        assert_eq!(page.items.len(), 2);
        assert_eq!(availability_version(&test), 2);
    }

    #[test]
    fn an_imported_appointment_is_listed_like_any_other() {
        let test = TestApp::new();
        let google = imported(&test);
        let page = listed(
            &test,
            &window("2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z"),
        );
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].commitment, google);
        assert_eq!(page.items[0].occurrences.len(), 1);
    }

    #[test]
    fn appointments_survive_a_restart_and_new_ids_do_not_collide() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, &seminar())).unwrap();
        let reopened = test.reopen(&crate::OwnerDefaults {
            email: "someone-else@example.com".into(),
            time_zone: "UTC".into(),
            locale: "en".into(),
        });
        let month = window("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
        assert_eq!(listed(&reopened, &month).items[0].commitment, created);
        assert_eq!(availability_version(&reopened), 2);
        let second = run(&reopened, |unit| create(unit, &seminar())).unwrap();
        assert_ne!(second.id, created.id);
        assert_eq!(listed(&reopened, &month).items.len(), 2);
    }
}
