//! `inputHash`: a port of `canonicalInput` in `packages/scheduler/src/generate.ts`.
//!
//! The hash identifies the exact scheduling problem a candidate answers. It is
//! the SHA-256 of the canonical JSON of the input, with every instant
//! rewritten to its UTC text so that equivalent spellings hash alike, and with
//! the seed and local-improvement cap that actually drive generation.

use serde_json::{Map, Value, json};

use crate::canonical::{canonical_json, compare_utf16, sha256_hex};
use crate::time::{instant_to_utc, parse_instant};

/// Default and maximum of `GenerateOptions.maxLocalImprovement` (06 §4).
pub const MAX_LOCAL_IMPROVEMENT: f64 = 200.0;

/// An instant in canonical UTC text; anything unparsable is kept as it is, so
/// invalid inputs still hash deterministically.
fn canonical_instant(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|text| parse_instant(text).ok())
        .and_then(|epoch_ms| instant_to_utc(epoch_ms).ok())
        .map_or_else(|| value.clone(), Value::String)
}

fn field(object: &Value, name: &str) -> Value {
    object.get(name).cloned().unwrap_or(Value::Null)
}

fn canonical_block(block: &Value) -> Value {
    json!({
        "taskId": field(block, "taskId"),
        "start": canonical_instant(&field(block, "start")),
        "end": canonical_instant(&field(block, "end")),
    })
}

fn map_array(value: Option<&Value>, item: impl Fn(&Value) -> Value) -> Value {
    Value::Array(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(item)
            .collect(),
    )
}

/// The value that is hashed. `seed` and `max_local_improvement` are the
/// effective ones (after applying `GenerateOptions`).
#[must_use]
pub fn canonical_input(input: &Value, seed: &Value, max_local_improvement: f64) -> Value {
    let mut canonical = Map::new();
    canonical.insert("now".into(), canonical_instant(&field(input, "now")));
    canonical.insert("timeZone".into(), field(input, "timeZone"));
    let horizon = field(input, "horizon");
    canonical.insert(
        "horizon".into(),
        json!({
            "start": canonical_instant(&field(&horizon, "start")),
            "end": canonical_instant(&field(&horizon, "end")),
        }),
    );
    canonical.insert(
        "tasks".into(),
        map_array(input.get("tasks"), |task| {
            let mut task = task.clone();
            if let Some(object) = task.as_object_mut() {
                for name in ["dueAt", "earliestStartAt"] {
                    if let Some(instant) = object.get(name).map(canonical_instant) {
                        object.insert(name.to_owned(), instant);
                    }
                }
            }
            task
        }),
    );
    canonical.insert("availability".into(), field(input, "availability"));
    canonical.insert("exceptions".into(), field(input, "exceptions"));
    canonical.insert(
        "commitments".into(),
        map_array(input.get("commitments"), |commitment| {
            json!({
                "start": canonical_instant(&field(commitment, "start")),
                "end": canonical_instant(&field(commitment, "end")),
            })
        }),
    );
    canonical.insert(
        "lockedBlocks".into(),
        map_array(input.get("lockedBlocks"), canonical_block),
    );
    canonical.insert(
        "existingBlocks".into(),
        map_array(input.get("existingBlocks"), canonical_block),
    );
    // Hashed only when supplied, so inputs without it keep their hash.
    if let Some(ids) = input.get("affectedTaskIds").and_then(Value::as_array) {
        let mut unique: Vec<&str> = Vec::new();
        for id in ids.iter().filter_map(Value::as_str) {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        unique.sort_by(|left, right| compare_utf16(left, right));
        canonical.insert("affectedTaskIds".into(), json!(unique));
    }
    canonical.insert("prefs".into(), field(input, "prefs"));
    canonical.insert("seed".into(), seed.clone());
    canonical.insert("maxLocalImprovement".into(), json!(max_local_improvement));
    Value::Object(canonical)
}

/// `inputHash` of `generate(input, options)`. `options` is the
/// `GenerateOptions` object or `null`.
#[must_use]
pub fn input_hash(input: &Value, options: &Value) -> String {
    let seed = options
        .get("seed")
        .filter(|seed| !seed.is_null())
        .cloned()
        .unwrap_or_else(|| field(input, "seed"));
    let max_local_improvement = options
        .get("maxLocalImprovement")
        .and_then(Value::as_f64)
        .unwrap_or(MAX_LOCAL_IMPROVEMENT)
        .clamp(0.0, MAX_LOCAL_IMPROVEMENT);
    sha256_hex(&canonical_json(&canonical_input(
        input,
        &seed,
        max_local_improvement,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Value {
        json!({
            "now": "2026-11-13T09:00:00+09:00",
            "timeZone": "Asia/Seoul",
            "horizon": {"start": "2026-11-13T00:00:00.000Z", "end": "2026-11-20T00:00:00Z"},
            "tasks": [{
                "id": "A",
                "dueAt": "2026-11-19T09:00:00+09:00",
                "estimate": {"p50Min": 60, "p90Min": 90},
                "splittable": true, "minSessionMin": 30, "maxSessionMin": 90,
                "priority": 2, "dependsOn": [],
            }],
            "availability": [], "exceptions": [],
            "commitments": [{"start": "2026-11-14T01:00:00Z", "end": "2026-11-14T02:00:00Z", "note": "dropped"}],
            "lockedBlocks": [],
            "prefs": {"maxDailyFocusMin": 240, "breakAfterMin": 60, "breakMin": 15, "riskLevel": "p50",
                      "dayStartLocal": "08:00", "dayEndLocal": "18:00"},
            "seed": 7,
        })
    }

    #[test]
    fn instants_are_canonicalised_and_defaults_filled() {
        let canonical = canonical_input(&input(), &json!(7), 200.0);
        assert_eq!(canonical["now"], "2026-11-13T00:00:00Z");
        assert_eq!(canonical["horizon"]["start"], "2026-11-13T00:00:00Z");
        assert_eq!(canonical["tasks"][0]["dueAt"], "2026-11-19T00:00:00Z");
        assert_eq!(
            canonical["commitments"][0],
            json!({"start": "2026-11-14T01:00:00Z", "end": "2026-11-14T02:00:00Z"})
        );
        assert_eq!(canonical["existingBlocks"], json!([]));
        assert!(canonical.get("affectedTaskIds").is_none());
        assert_eq!(canonical["maxLocalImprovement"], json!(200.0));
    }

    #[test]
    fn equivalent_spellings_hash_alike_and_real_changes_do_not() {
        let base = input_hash(&input(), &Value::Null);
        let mut respelled = input();
        respelled["now"] = json!("2026-11-13T00:00:00Z");
        respelled["tasks"][0]["dueAt"] = json!("2026-11-19T00:00:00.000Z");
        assert_eq!(input_hash(&respelled, &Value::Null), base);

        let mut later = input();
        later["tasks"][0]["dueAt"] = json!("2026-11-19T00:05:00Z");
        assert_ne!(input_hash(&later, &Value::Null), base);
        let mut affected = input();
        affected["affectedTaskIds"] = json!([]);
        assert_ne!(input_hash(&affected, &Value::Null), base);
    }

    #[test]
    fn options_override_the_seed_and_clamp_the_improvement_cap() {
        let base = input_hash(&input(), &Value::Null);
        assert_eq!(input_hash(&input(), &json!({})), base);
        assert_eq!(
            input_hash(&input(), &json!({"seed": 7, "maxLocalImprovement": 200})),
            base
        );
        assert_eq!(
            input_hash(&input(), &json!({"maxLocalImprovement": 9000})),
            base
        );
        assert_ne!(input_hash(&input(), &json!({"seed": 8})), base);
        assert_ne!(
            input_hash(&input(), &json!({"maxLocalImprovement": 50})),
            base
        );
        assert_eq!(
            input_hash(&input(), &json!({"maxLocalImprovement": -5})),
            input_hash(&input(), &json!({"maxLocalImprovement": 0}))
        );
        // Policies do not take part in the hash.
        assert_eq!(
            input_hash(&input(), &json!({"policies": ["balanced"]})),
            base
        );
    }

    #[test]
    fn affected_ids_are_deduplicated_and_sorted_and_bad_instants_kept() {
        let mut replan = input();
        replan["affectedTaskIds"] = json!(["b", "a", "b"]);
        replan["now"] = json!("yesterday");
        let canonical = canonical_input(&replan, &json!(7), 200.0);
        assert_eq!(canonical["affectedTaskIds"], json!(["a", "b"]));
        assert_eq!(canonical["now"], "yesterday");
    }
}
