use ohmydate_app::commitments::{self, CommitmentCreate, CommitmentPatch, WindowQuery};
use ohmydate_app::{App, calendar};
use ohmydate_domain::CommitmentSource;
use serde_json::{Map, Value};

use super::{Call, Reply};
use crate::dto;
use crate::headers::{etag_for_body, etag_for_version};
use crate::problem::Problem;

fn text(object: &Map<String, Value>, name: &str) -> Option<String> {
    object.get(name).and_then(Value::as_str).map(str::to_owned)
}

fn source(object: &Map<String, Value>) -> Option<CommitmentSource> {
    object
        .get("source")
        .and_then(Value::as_str)
        .and_then(CommitmentSource::parse)
}

// The dispatcher validated the query against the contract, so `from` and
// `to` are present strings and `limit` is an integer from 1 to 100.
fn window_query(query: &Map<String, Value>) -> WindowQuery {
    WindowQuery {
        from: text(query, "from").unwrap_or_default(),
        to: text(query, "to").unwrap_or_default(),
        cursor: text(query, "cursor"),
        limit: query
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|limit| u32::try_from(limit).ok()),
    }
}

/// `GET /commitments?from=&to=`: the appointments a window can show, each
/// with its occurrences inside it.
pub(super) fn list_commitments(app: &App, call: &Call) -> Result<Reply, Problem> {
    let query = window_query(&call.query);
    let page = call.read(app, |unit| commitments::list(unit, &query))?;
    let body = dto::commitment_page(&page, app.owner_id());
    Ok(Reply::conditional(call, &etag_for_body(&body), &body))
}

// The dispatcher validated the body against the contract's
// `CommitmentCreate`, so the required fields are present strings.
fn commitment_create(object: &Map<String, Value>) -> Option<CommitmentCreate> {
    Some(CommitmentCreate {
        title: text(object, "title")?,
        start_at: text(object, "startAt")?,
        end_at: text(object, "endAt")?,
        time_zone: text(object, "timeZone")?,
        rrule: text(object, "rrule"),
        source: source(object),
    })
}

/// `POST /commitments`.
pub(super) fn create_commitment(app: &App, call: &Call) -> Result<Reply, Problem> {
    let input = commitment_create(call.body_object()?).ok_or_else(Problem::internal)?;
    let owner_id = app.owner_id();
    call.mutate(app, |unit| {
        let commitment = commitments::create(unit, &input)?;
        Ok(Reply::json(201, &dto::commitment(&commitment, owner_id))
            .header("ETag", etag_for_version(commitment.version)))
    })
}

// `rrule: null` removes the rule; an absent `rrule` keeps it.
fn commitment_patch(object: &Map<String, Value>) -> CommitmentPatch {
    CommitmentPatch {
        title: text(object, "title"),
        start_at: text(object, "startAt"),
        end_at: text(object, "endAt"),
        time_zone: text(object, "timeZone"),
        rrule: object
            .get("rrule")
            .map(|rule| rule.as_str().map(str::to_owned)),
        source: source(object),
    }
}

/// `PATCH /commitments/{id}`. An appointment imported from Google Calendar
/// answers 409 `illegal_transition`.
pub(super) fn update_commitment(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let expected = call.expected_version()?;
    let patch = commitment_patch(call.body_object()?);
    let owner_id = app.owner_id();
    call.mutate(app, |unit| {
        let commitment = commitments::update(unit, &id, &patch, expected)?;
        Ok(Reply::json(200, &dto::commitment(&commitment, owner_id))
            .header("ETag", etag_for_version(commitment.version)))
    })
}

/// `DELETE /commitments/{id}`.
pub(super) fn delete_commitment(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let expected = call.expected_version()?;
    call.mutate(app, |unit| {
        commitments::delete(unit, &id, expected)?;
        Ok(Reply::empty(204))
    })
}

/// `GET /calendar-day-events?from=&to=`: the all-day events of a connected
/// calendar. Empty until the calendar sync exists (RC-90).
pub(super) fn list_calendar_day_events(app: &App, call: &Call) -> Result<Reply, Problem> {
    let from = text(&call.query, "from").unwrap_or_default();
    let to = text(&call.query, "to").unwrap_or_default();
    let events = call.read(app, |unit| calendar::list_day_events(unit, &from, &to))?;
    let body = dto::day_event_page(&events);
    Ok(Reply::conditional(call, &etag_for_body(&body), &body))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_create_body_maps_every_field() {
        let input = commitment_create(&object(json!({
            "title": "Seminar",
            "startAt": "2026-11-17T05:00:00Z",
            "endAt": "2026-11-17T07:00:00Z",
            "timeZone": "Asia/Seoul",
            "rrule": "FREQ=WEEKLY;BYDAY=TU",
            "source": "caldav",
        })))
        .unwrap();
        assert_eq!(
            input,
            CommitmentCreate {
                title: "Seminar".into(),
                start_at: "2026-11-17T05:00:00Z".into(),
                end_at: "2026-11-17T07:00:00Z".into(),
                time_zone: "Asia/Seoul".into(),
                rrule: Some("FREQ=WEEKLY;BYDAY=TU".into()),
                source: Some(CommitmentSource::Caldav),
            }
        );
        let plain = commitment_create(&object(json!({
            "title": "Dentist",
            "startAt": "2026-11-17T05:00:00Z",
            "endAt": "2026-11-17T07:00:00Z",
            "timeZone": "Asia/Seoul",
        })))
        .unwrap();
        assert_eq!((plain.rrule, plain.source), (None, None));
    }

    #[test]
    fn a_create_body_without_a_required_field_is_not_read_as_something_else() {
        // The contract refuses these before a handler runs.
        for missing in ["title", "startAt", "endAt", "timeZone"] {
            let mut body = object(json!({
                "title": "Dentist",
                "startAt": "2026-11-17T05:00:00Z",
                "endAt": "2026-11-17T07:00:00Z",
                "timeZone": "Asia/Seoul",
            }));
            body.remove(missing);
            assert_eq!(commitment_create(&body), None, "{missing}");
        }
    }

    #[test]
    fn a_patch_tells_a_removed_rule_from_one_that_is_not_named() {
        assert_eq!(commitment_patch(&Map::new()), CommitmentPatch::default());
        assert_eq!(
            commitment_patch(&object(json!({"rrule": null}))).rrule,
            Some(None)
        );
        assert_eq!(
            commitment_patch(&object(json!({"rrule": "FREQ=DAILY"}))).rrule,
            Some(Some("FREQ=DAILY".into()))
        );
        assert_eq!(
            commitment_patch(&object(json!({
                "title": "Renamed",
                "startAt": "2026-11-18T05:00:00Z",
                "endAt": "2026-11-18T06:00:00Z",
                "timeZone": "Europe/Berlin",
                "source": "vikunja",
            }))),
            CommitmentPatch {
                title: Some("Renamed".into()),
                start_at: Some("2026-11-18T05:00:00Z".into()),
                end_at: Some("2026-11-18T06:00:00Z".into()),
                time_zone: Some("Europe/Berlin".into()),
                rrule: None,
                source: Some(CommitmentSource::Vikunja),
            }
        );
        // The contract refuses these; the reader does not turn them into a
        // change either way.
        let stray = commitment_patch(&object(
            json!({"version": 9, "id": "x", "source": "nowhere"}),
        ));
        assert_eq!(stray, CommitmentPatch::default());
    }

    #[test]
    fn a_window_query_maps_its_parameters() {
        assert_eq!(
            window_query(&object(json!({
                "from": "2026-11-11T00:00:00Z",
                "to": "2026-11-25T00:00:00Z",
                "cursor": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55",
                "limit": 5,
            }))),
            WindowQuery {
                from: "2026-11-11T00:00:00Z".into(),
                to: "2026-11-25T00:00:00Z".into(),
                cursor: Some("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55".into()),
                limit: Some(5),
            }
        );
        let bare = window_query(&object(json!({"from": "a", "to": "b"})));
        assert_eq!((bare.cursor, bare.limit), (None, None));
    }
}
