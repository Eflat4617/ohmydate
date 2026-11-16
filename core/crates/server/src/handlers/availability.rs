use ohmydate_app::{App, availability};
use ohmydate_domain::{
    AvailabilityException, AvailabilityKind, AvailabilityPrefs, AvailabilityPut, AvailabilityRule,
    CalendarDate, DomainError, ExceptionKind, LocalTime, RiskLevel,
};
use serde_json::{Map, Value};

use super::{Call, Reply};
use crate::dto;
use crate::headers::etag_for_availability;
use crate::problem::Problem;

/// `GET /availability`. The tag is the availability version,
/// `W/"availability:<n>"` — the one `PUT /availability` and a plan approval
/// name in `If-Match`.
pub(super) fn get_availability(app: &App, call: &Call) -> Result<Reply, Problem> {
    let hours = call.read(app, availability::get)?;
    Ok(Reply::conditional(
        call,
        &etag_for_availability(hours.version),
        &dto::availability(&hours),
    ))
}

fn text<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    object.get(name).and_then(Value::as_str)
}

fn time(object: &Map<String, Value>, name: &str) -> Option<LocalTime> {
    text(object, name).and_then(LocalTime::parse)
}

fn minutes(object: &Map<String, Value>, name: &str) -> Option<u32> {
    object
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn rule(value: &Value) -> Option<AvailabilityRule> {
    let object = value.as_object()?;
    Some(AvailabilityRule {
        weekday: object
            .get("weekday")
            .and_then(Value::as_u64)
            .and_then(|weekday| u8::try_from(weekday).ok())?,
        start: time(object, "startLocal")?,
        end: time(object, "endLocal")?,
        kind: text(object, "kind").and_then(AvailabilityKind::parse)?,
    })
}

/// `Err` carries the position of an exception whose date the calendar does
/// not have. The contract's `format: date` refuses those too; should a
/// validator ever let one through, the answer is a 422 that names the
/// field, not a storage failure.
fn exception(index: usize, value: &Value) -> Result<Option<AvailabilityException>, DomainError> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    let Some(date) = text(object, "date").and_then(CalendarDate::parse) else {
        return Err(DomainError::invalid(
            &format!("/exceptions/{index}/date"),
            "date must be a calendar date",
        ));
    };
    let optional_time = |name: &str| match object.get(name) {
        None => Some(None),
        Some(_) => time(object, name).map(Some),
    };
    let (Some(kind), Some(start), Some(end)) = (
        text(object, "kind").and_then(ExceptionKind::parse),
        optional_time("startLocal"),
        optional_time("endLocal"),
    ) else {
        return Ok(None);
    };
    Ok(Some(AvailabilityException {
        date,
        kind,
        start,
        end,
    }))
}

fn prefs(object: &Map<String, Value>) -> Option<AvailabilityPrefs> {
    Some(AvailabilityPrefs {
        max_daily_focus_min: minutes(object, "maxDailyFocusMin")?,
        break_after_min: minutes(object, "breakAfterMin")?,
        break_min: minutes(object, "breakMin")?,
        day_start: time(object, "dayStartLocal")?,
        day_end: time(object, "dayEndLocal")?,
        risk_level: text(object, "riskLevel").and_then(RiskLevel::parse)?,
    })
}

// The dispatcher validated the body against the contract's `AvailabilityPut`,
// so a field of the wrong type or shape never reaches this reader: `None`
// here is a disagreement between the contract and this code (500).
fn availability_put(object: &Map<String, Value>) -> Result<Option<AvailabilityPut>, DomainError> {
    let Some(rules) = object
        .get("rules")
        .and_then(Value::as_array)
        .and_then(|rules| rules.iter().map(rule).collect::<Option<Vec<_>>>())
    else {
        return Ok(None);
    };
    let Some(listed) = object.get("exceptions").and_then(Value::as_array) else {
        return Ok(None);
    };
    let mut exceptions = Vec::with_capacity(listed.len());
    for (index, value) in listed.iter().enumerate() {
        match exception(index, value)? {
            Some(exception) => exceptions.push(exception),
            None => return Ok(None),
        }
    }
    let (Some(time_zone), Some(prefs)) = (
        text(object, "timeZone"),
        object
            .get("prefs")
            .and_then(Value::as_object)
            .and_then(prefs),
    ) else {
        return Ok(None);
    };
    Ok(Some(AvailabilityPut {
        time_zone: time_zone.to_owned(),
        rules,
        exceptions,
        prefs,
    }))
}

/// `PUT /availability`: replaces the hours. `If-Match` names the
/// availability version the client last saw; the answer carries the next.
pub(super) fn put_availability(app: &App, call: &Call) -> Result<Reply, Problem> {
    let expected = call.expected_version()?;
    let body = call.body_object()?;
    call.mutate(app, |unit| {
        // Read inside the mutation, so a refusal of the body is stored for
        // the key like the other 422s.
        let put = availability_put(body)?.ok_or_else(|| {
            DomainError::invalid(
                "/",
                "the request does not have the shape of AvailabilityPut",
            )
        })?;
        let hours = availability::put(unit, &put, expected)?;
        Ok(Reply::json(200, &dto::availability(&hours))
            .header("ETag", etag_for_availability(hours.version)))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn body() -> Value {
        json!({
            "timeZone": "Asia/Seoul",
            "rules": [
                {"weekday": 1, "startLocal": "09:00", "endLocal": "12:00", "kind": "work"},
                {"weekday": 7, "startLocal": "20:00", "endLocal": "24:00", "kind": "focus"},
            ],
            "exceptions": [
                {"date": "2026-12-25", "kind": "off"},
                {"date": "2026-11-21", "kind": "extra", "startLocal": "10:00", "endLocal": "14:00"},
                {"date": "2026-11-22", "kind": "off", "startLocal": "10:00"},
            ],
            "prefs": {
                "maxDailyFocusMin": 300, "breakAfterMin": 50, "breakMin": 10,
                "dayStartLocal": "07:00", "dayEndLocal": "24:00", "riskLevel": "p90",
            },
        })
    }

    fn time(text: &str) -> LocalTime {
        LocalTime::parse(text).unwrap()
    }

    #[test]
    fn a_body_maps_every_field_in_its_order() {
        let put = availability_put(&object(body())).unwrap().unwrap();
        assert_eq!(put.time_zone, "Asia/Seoul");
        assert_eq!(
            put.rules,
            vec![
                AvailabilityRule {
                    weekday: 1,
                    start: time("09:00"),
                    end: time("12:00"),
                    kind: AvailabilityKind::Work,
                },
                AvailabilityRule {
                    weekday: 7,
                    start: time("20:00"),
                    end: time("24:00"),
                    kind: AvailabilityKind::Focus,
                },
            ]
        );
        assert_eq!(put.exceptions.len(), 3);
        assert_eq!(put.exceptions[0].date.to_string(), "2026-12-25");
        assert_eq!(
            (put.exceptions[0].start, put.exceptions[0].end),
            (None, None)
        );
        assert_eq!(put.exceptions[1].kind, ExceptionKind::Extra);
        assert_eq!(
            (put.exceptions[1].start, put.exceptions[1].end),
            (Some(time("10:00")), Some(time("14:00")))
        );
        assert_eq!(
            (put.exceptions[2].start, put.exceptions[2].end),
            (Some(time("10:00")), None)
        );
        assert_eq!(
            put.prefs,
            AvailabilityPrefs {
                max_daily_focus_min: 300,
                break_after_min: 50,
                break_min: 10,
                day_start: time("07:00"),
                day_end: time("24:00"),
                risk_level: RiskLevel::P90,
            }
        );
    }

    #[test]
    fn a_date_the_calendar_does_not_have_is_a_refusal_that_names_its_field() {
        let mut bad = body();
        bad["exceptions"][1]["date"] = json!("2026-02-30");
        let error = availability_put(&object(bad)).unwrap_err();
        let DomainError::ValidationFailed(issues) = error else {
            panic!("{error:?}");
        };
        assert_eq!(issues[0].path, "/exceptions/1/date");
        assert!(!issues[0].message.contains("2026-02-30"));
    }

    #[test]
    fn a_body_the_contract_would_not_let_through_is_not_read_as_something_else() {
        // The dispatcher refuses each of these with 400 before a handler
        // runs; the reader does not guess a value for them either.
        let mut cases = Vec::new();
        for (pointer, value) in [
            ("/rules/0/weekday", json!("monday")),
            ("/rules/0/weekday", json!(300)),
            ("/rules/0/startLocal", json!("9:00")),
            ("/rules/0/kind", json!("rest")),
            ("/exceptions/0/kind", json!("maybe")),
            ("/exceptions/1/endLocal", json!(null)),
            ("/prefs/breakMin", json!(-1)),
            ("/prefs/breakMin", json!(1.5)),
            ("/prefs/riskLevel", json!("p95")),
            ("/timeZone", json!(9)),
            ("/rules", json!({})),
            ("/exceptions", json!("none")),
            ("/prefs", json!([])),
        ] {
            let mut changed = body();
            *changed.pointer_mut(pointer).unwrap() = value;
            cases.push(changed);
        }
        for name in ["timeZone", "rules", "exceptions", "prefs"] {
            let mut missing = body();
            missing.as_object_mut().unwrap().remove(name);
            cases.push(missing);
        }
        for case in cases {
            assert_eq!(availability_put(&object(case.clone())), Ok(None), "{case}");
        }
    }
}
