use ohmydate_app::App;
use ohmydate_app::settings::{self, BudgetPatch, LlmPatch, SettingsPatch};
use serde_json::{Map, Value};

use super::{Call, Reply};
use crate::dto;
use crate::headers::etag_for_version;
use crate::problem::Problem;

/// `GET /me`: the single local owner. The tag is `W/"<id>:<version>"`, as in
/// the TypeScript core.
pub(super) fn get_me(app: &App, call: &Call) -> Result<Reply, Problem> {
    let owner = call.read(app, settings::owner)?;
    let etag = format!("W/\"{}:{}\"", owner.id, owner.version);
    Ok(Reply::conditional(call, &etag, &dto::user(&owner))
        .header("Cache-Control", "private, no-store")
        .header("Vary", "Cookie"))
}

// The dispatcher validated the body against the contract's
// `UserSettingsPatch`, so a field of the wrong type never reaches this reader.
fn settings_patch(object: &Map<String, Value>) -> SettingsPatch {
    let text = |name: &str| object.get(name).and_then(Value::as_str).map(str::to_owned);
    let llm = object
        .get("llm")
        .and_then(Value::as_object)
        .map(|llm| LlmPatch {
            consent_granted: llm
                .get("consent")
                .and_then(|consent| consent.get("granted"))
                .and_then(Value::as_bool),
            budget: llm
                .get("budget")
                .and_then(Value::as_object)
                .map(|budget| BudgetPatch {
                    daily_usd: budget.get("dailyUsd").and_then(Value::as_f64),
                    monthly_usd: budget.get("monthlyUsd").and_then(Value::as_f64),
                }),
        });
    SettingsPatch {
        time_zone: text("timeZone"),
        locale: text("locale"),
        llm,
    }
}

/// `PATCH /me/settings`: time zone, locale, AI consent and budget. The tag
/// of the answer is the plain version (`W/"<n>"`) — the one the next
/// `If-Match` names — while `GET /me` tags `W/"<id>:<n>"`, as in the
/// TypeScript core.
pub(super) fn update_my_settings(app: &App, call: &Call) -> Result<Reply, Problem> {
    let expected = call.expected_version()?;
    let patch = settings_patch(call.body_object()?);
    call.mutate(app, |unit| {
        let owner = settings::update(unit, &patch, expected)?;
        Ok(Reply::json(200, &dto::user(&owner)).header("ETag", etag_for_version(owner.version)))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_patch_body_maps_every_field() {
        let patch = settings_patch(&object(json!({
            "timeZone": "Europe/Berlin",
            "locale": "de-DE",
            "llm": {
                "consent": {"granted": false},
                "budget": {"dailyUsd": 1.5, "monthlyUsd": 20},
            },
        })));
        assert_eq!(
            patch,
            SettingsPatch {
                time_zone: Some("Europe/Berlin".into()),
                locale: Some("de-DE".into()),
                llm: Some(LlmPatch {
                    consent_granted: Some(false),
                    budget: Some(BudgetPatch {
                        daily_usd: Some(1.5),
                        monthly_usd: Some(20.0),
                    }),
                }),
            }
        );
    }

    #[test]
    fn absent_parts_stay_absent_and_other_fields_are_not_read() {
        assert_eq!(settings_patch(&Map::new()), SettingsPatch::default());
        // `llm: {}` and `budget: {}` are present but name nothing.
        assert_eq!(
            settings_patch(&object(json!({"llm": {}}))).llm,
            Some(LlmPatch::default())
        );
        assert_eq!(
            settings_patch(&object(json!({"llm": {"budget": {"monthlyUsd": 3}}}))).llm,
            Some(LlmPatch {
                consent_granted: None,
                budget: Some(BudgetPatch {
                    daily_usd: None,
                    monthly_usd: Some(3.0),
                }),
            })
        );
        // The contract refuses these before a handler runs; the reader does
        // not turn them into a change either way.
        let stray = settings_patch(&object(json!({
            "email": "someone@example.com",
            "version": 9,
            "llm": {"consent": {"at": "2026-11-16T00:00:00Z", "provider": "other"}},
        })));
        assert_eq!(
            stray,
            SettingsPatch {
                llm: Some(LlmPatch::default()),
                ..SettingsPatch::default()
            }
        );
    }
}
