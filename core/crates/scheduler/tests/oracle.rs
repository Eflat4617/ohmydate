//! Differential tests against the TypeScript scheduler (blueprint 15 §5).
//!
//! Every `tests/oracle/*.json` pack was written by
//! `packages/scheduler/scripts/export-oracle.mts`. Each ported module must
//! reproduce what the reference recorded, exactly: floats are compared by bit
//! pattern, text byte for byte. As modules land, this file gains the
//! comparison for their part of a case (`slots`, `result`, `validation`).

// Test code: a failed unwrap is a failed test.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;

use ohmydate_scheduler::canonical::{canonical_json, sha256_hex};
use ohmydate_scheduler::input_hash::input_hash;
use ohmydate_scheduler::prng::Prng;
use ohmydate_scheduler::time::{instant_to_utc, parse_instant, partition_by_local_date};
use serde_json::Value;

const FORMAT: &str = "ohmydate-scheduler-oracle";
const FORMAT_VERSION: u64 = 1;

fn check_header(pack: &Value) -> Result<(), String> {
    if pack["format"] != FORMAT {
        return Err(format!("not an oracle pack: format {}", pack["format"]));
    }
    if pack["formatVersion"] != FORMAT_VERSION {
        return Err(format!(
            "unsupported formatVersion {}",
            pack["formatVersion"]
        ));
    }
    Ok(())
}

fn packs() -> Vec<(String, Value)> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/oracle");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", directory.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "no oracle packs in {}",
        directory.display()
    );
    files
        .into_iter()
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let pack: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
                .unwrap_or_else(|error| panic!("{name} is not JSON: {error}"));
            check_header(&pack).unwrap_or_else(|reason| panic!("{name}: {reason}"));
            (name, pack)
        })
        .collect()
}

fn array<'a>(value: &'a Value, what: &str) -> &'a Vec<Value> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{what} is not an array"))
}

/// Fails with every mismatch at once, so one run shows the whole picture.
fn report(mismatches: Vec<String>) {
    assert!(
        mismatches.is_empty(),
        "{} mismatch(es):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn the_prng_reproduces_the_reference_streams() {
    let mut mismatches = Vec::new();
    for (name, pack) in packs() {
        for entry in array(&pack["primitives"]["prng"], "prng") {
            let seed = entry["seed"].as_f64().unwrap();
            let mut prng = Prng::new(seed);
            for (index, expected) in array(&entry["floats"], "floats").iter().enumerate() {
                let actual = prng.next_float();
                if actual.to_bits() != expected.as_f64().unwrap().to_bits() {
                    mismatches.push(format!(
                        "{name} seed {seed} float #{index}: {actual} != {expected}"
                    ));
                }
            }
            for ints in array(&entry["ints"], "ints") {
                let max = ints["maxExclusive"].as_f64().unwrap();
                let mut prng = Prng::new(seed);
                let actual: Vec<f64> = array(&ints["values"], "values")
                    .iter()
                    .map(|_| prng.next_int(max))
                    .collect();
                let expected: Vec<f64> = array(&ints["values"], "values")
                    .iter()
                    .map(|v| v.as_f64().unwrap())
                    .collect();
                if actual != expected {
                    mismatches.push(format!(
                        "{name} seed {seed} ints below {max}: {actual:?} != {expected:?}"
                    ));
                }
            }
        }
    }
    report(mismatches);
}

#[test]
fn canonical_json_and_hashes_match_the_reference() {
    let mut mismatches = Vec::new();
    for (name, pack) in packs() {
        for entry in array(&pack["primitives"]["canonical"], "canonical") {
            let text = canonical_json(&entry["value"]);
            if text != entry["text"].as_str().unwrap() {
                mismatches.push(format!(
                    "{name} canonical text: {text} != {}",
                    entry["text"]
                ));
            }
            if sha256_hex(&text) != entry["sha256"].as_str().unwrap() {
                mismatches.push(format!("{name} sha256 of {text}"));
            }
        }
    }
    report(mismatches);
}

#[test]
fn instants_parse_and_print_like_the_reference() {
    let mut mismatches = Vec::new();
    for (name, pack) in packs() {
        for entry in array(&pack["primitives"]["instants"], "instants") {
            let text = entry["text"].as_str().unwrap();
            let parsed = parse_instant(text).ok();
            if parsed != entry["epochMs"].as_i64() {
                mismatches.push(format!(
                    "{name} parse {text:?}: {parsed:?} != {}",
                    entry["epochMs"]
                ));
            }
            let printed = parsed.and_then(|epoch_ms| instant_to_utc(epoch_ms).ok());
            if printed.as_deref() != entry["utc"].as_str() {
                mismatches.push(format!(
                    "{name} print {text:?}: {printed:?} != {}",
                    entry["utc"]
                ));
            }
        }
    }
    report(mismatches);
}

#[test]
fn local_date_partitions_match_the_reference_across_dst_transitions() {
    let mut mismatches = Vec::new();
    let mut compared = 0;
    for (name, pack) in packs() {
        for entry in array(&pack["primitives"]["partitions"], "partitions") {
            let zone = entry["timeZone"].as_str().unwrap();
            let start = parse_instant(entry["start"].as_str().unwrap()).unwrap();
            let end = parse_instant(entry["end"].as_str().unwrap()).unwrap();
            let actual: Vec<Value> = partition_by_local_date(start, end, zone)
                .unwrap_or_else(|error| panic!("{name} {zone}: {error}"))
                .into_iter()
                .map(|segment| {
                    serde_json::json!({
                        "date": segment.date,
                        "weekday": segment.weekday,
                        "offsetMs": segment.offset_ms,
                        "startMs": segment.start_ms,
                        "endMs": segment.end_ms,
                        "localMidnightMs": segment.local_midnight_ms,
                    })
                })
                .collect();
            let expected = array(&entry["segments"], "segments");
            compared += expected.len();
            if &actual != expected {
                let first = actual
                    .iter()
                    .zip(expected)
                    .position(|(a, e)| a != e)
                    .unwrap_or(actual.len().min(expected.len()));
                mismatches.push(format!(
                    "{name} {zone} {}..{}: {} vs {} segments, first difference at #{first}: {:?} != {:?} \
                     (reference tzdata {})",
                    entry["start"], entry["end"], actual.len(), expected.len(),
                    actual.get(first), expected.get(first), pack["oracle"]["tzdata"],
                ));
            }
        }
    }
    assert!(compared > 400, "only {compared} segments compared");
    report(mismatches);
}

#[test]
fn input_hashes_of_every_case_match_the_reference() {
    let mut mismatches = Vec::new();
    let mut compared = 0;
    for (name, pack) in packs() {
        for case in array(&pack["cases"], "cases") {
            let expected_hash = input_hash(&case["input"], &case["options"]);
            for candidate in array(&case["result"]["candidates"], "candidates") {
                compared += 1;
                if candidate["inputHash"] != expected_hash.as_str() {
                    mismatches.push(format!(
                        "{name} {} {}: {expected_hash} != {}",
                        case["id"], candidate["policy"], candidate["inputHash"]
                    ));
                }
            }
        }
    }
    assert!(compared >= 20, "only {compared} candidates compared");
    report(mismatches);
}

#[test]
fn recorded_results_hash_to_their_recorded_result_hash() {
    // Exercises canonical JSON on full results (float metrics, nested
    // explanation items) and guards the pack against hand edits.
    let mut mismatches = Vec::new();
    for (name, pack) in packs() {
        for case in array(&pack["cases"], "cases") {
            let actual = sha256_hex(&canonical_json(&case["result"]));
            if case["resultHash"] != actual.as_str() {
                mismatches.push(format!(
                    "{name} {}: {actual} != {}",
                    case["id"], case["resultHash"]
                ));
            }
        }
    }
    report(mismatches);
}

#[test]
fn a_changed_input_no_longer_matches_its_recorded_hash() {
    let (_, pack) = packs().remove(0);
    let case = array(&pack["cases"], "cases")
        .iter()
        .find(|case| !array(&case["result"]["candidates"], "candidates").is_empty())
        .unwrap();
    let recorded = case["result"]["candidates"][0]["inputHash"]
        .as_str()
        .unwrap();
    assert_eq!(input_hash(&case["input"], &case["options"]), recorded);
    let mut changed = case["input"].clone();
    changed["seed"] = serde_json::json!(case["input"]["seed"].as_f64().unwrap() + 1.0);
    assert_ne!(input_hash(&changed, &case["options"]), recorded);
}

#[test]
fn packs_of_another_format_or_version_are_refused() {
    let good = serde_json::json!({"format": FORMAT, "formatVersion": FORMAT_VERSION});
    assert_eq!(check_header(&good), Ok(()));
    let newer = serde_json::json!({"format": FORMAT, "formatVersion": FORMAT_VERSION + 1});
    assert!(
        check_header(&newer)
            .unwrap_err()
            .contains("unsupported formatVersion")
    );
    let other = serde_json::json!({"format": "ohmydate-export", "formatVersion": 1});
    assert!(
        check_header(&other)
            .unwrap_err()
            .contains("not an oracle pack")
    );
}
