//! Differential tests against the TypeScript scheduler (blueprint 15 §5).
//!
//! Every pack was written by `packages/scheduler/scripts/export-oracle.mts`
//! from the reference implementation. Each ported module must reproduce what
//! the reference recorded, exactly: floats are compared by bit pattern, text
//! byte for byte. The committed sample runs with every `cargo test`; a large
//! pack is added with `OHMYDATE_ORACLE_DIR` (`corepack pnpm run core:diff`).
//!
//! Layers, lowest first — a mismatch in one explains mismatches above it:
//! primitives → input round trip → `inputHash` → `slots`. As modules land,
//! this file gains `inputIssues`, `validation`, `deficit` and `result`.

// Test code: a failed unwrap is a failed test, and the layer numbers are
// printed for the task report (`cargo test -- --nocapture`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod support;

use ohmydate_scheduler::canonical::{canonical_json, sha256_hex};
use ohmydate_scheduler::input_hash::{input_hash, input_hash_of};
use ohmydate_scheduler::prng::Prng;
use ohmydate_scheduler::sessions::{auto_split_min_session_min, max_legal_session_min};
use ohmydate_scheduler::slots::compute_available_slots;
use ohmydate_scheduler::time::{
    LocalDate, TimeError, instant_nanoseconds, instant_to_utc, is_plain_date, is_valid_time_zone,
    parse_clock, parse_instant, partition_by_local_date,
};
use ohmydate_scheduler::types::{GenerateOptions, ScheduleInput, Slot};
use serde_json::{Value, json};
use support::packs::{FORMAT, FORMAT_VERSION, Tally, check_header, first_difference, packs};

fn array<'a>(value: &'a Value, what: &str) -> &'a Vec<Value> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{what} is not an array"))
}

fn typed(case: &Value) -> (ScheduleInput, GenerateOptions) {
    let input = ScheduleInput::from_json(&case["input"])
        .unwrap_or_else(|error| panic!("{}: input {error}", case["id"]));
    let options = GenerateOptions::from_json(&case["options"])
        .unwrap_or_else(|error| panic!("{}: options {error}", case["id"]));
    (input, options)
}

#[test]
fn the_prng_reproduces_the_reference_streams() {
    let mut tally = Tally::new("primitives.prng");
    for pack in packs() {
        for entry in pack.primitives("prng") {
            let seed = entry["seed"].as_f64().unwrap();
            let mut prng = Prng::new(seed);
            for (index, expected) in array(&entry["floats"], "floats").iter().enumerate() {
                let actual = prng.next_float();
                tally.check(
                    (actual.to_bits() != expected.as_f64().unwrap().to_bits()).then(|| {
                        format!(
                            "{} seed {seed} float #{index}: {actual} != {expected}",
                            pack.name
                        )
                    }),
                );
            }
            for ints in array(&entry["ints"], "ints") {
                let max = ints["maxExclusive"].as_f64().unwrap();
                let mut prng = Prng::new(seed);
                let expected: Vec<f64> = array(&ints["values"], "values")
                    .iter()
                    .map(|value| value.as_f64().unwrap())
                    .collect();
                let actual: Vec<f64> = expected.iter().map(|_| prng.next_int(max)).collect();
                tally.check((actual != expected).then(|| {
                    format!(
                        "{} seed {seed} ints below {max}: {actual:?} != {expected:?}",
                        pack.name
                    )
                }));
            }
        }
    }
    tally.finish(100);
}

#[test]
fn canonical_json_and_hashes_match_the_reference() {
    let mut tally = Tally::new("primitives.canonical");
    for pack in packs() {
        for entry in pack.primitives("canonical") {
            let text = canonical_json(&entry["value"]);
            tally.check(
                (text != entry["text"].as_str().unwrap())
                    .then(|| format!("{} canonical text: {text} != {}", pack.name, entry["text"])),
            );
            tally.check(
                (sha256_hex(&text) != entry["sha256"].as_str().unwrap())
                    .then(|| format!("{} sha256 of {text}", pack.name)),
            );
        }
    }
    tally.finish(50);
}

#[test]
fn instants_parse_and_print_like_the_reference() {
    let mut tally = Tally::new("primitives.instants");
    for pack in packs() {
        for entry in pack.primitives("instants") {
            let text = entry["text"].as_str().unwrap();
            let parsed = parse_instant(text);
            tally.check((parsed.ok() != entry["epochMs"].as_i64()).then(|| {
                format!(
                    "{} parse {text:?}: {parsed:?} != {}",
                    pack.name, entry["epochMs"]
                )
            }));
            let printed = parsed
                .ok()
                .and_then(|epoch_ms| instant_to_utc(epoch_ms).ok());
            tally.check((printed.as_deref() != entry["utc"].as_str()).then(|| {
                format!(
                    "{} print {text:?}: {printed:?} != {}",
                    pack.name, entry["utc"]
                )
            }));
            // The validators tell "finer than a millisecond" from "not an
            // instant", so the two failures must be the reference's.
            let sub_millisecond = parsed == Err(TimeError::SubMillisecond);
            let nanoseconds = instant_nanoseconds(text);
            tally.check(
                (sub_millisecond != entry["subMillisecond"].as_bool().unwrap()
                    || sub_millisecond != nanoseconds.is_ok_and(|value| value % 1_000_000 != 0))
                .then(|| {
                    format!(
                        "{} sub-millisecond {text:?}: {parsed:?} / {nanoseconds:?} != {}",
                        pack.name, entry["subMillisecond"]
                    )
                }),
            );
        }
    }
    tally.finish(100);
}

#[test]
fn time_zone_ids_are_accepted_like_the_reference() {
    let mut tally = Tally::new("primitives.zones");
    for pack in packs() {
        for entry in pack.primitives("zones") {
            let id = entry["id"].as_str().unwrap();
            let valid = is_valid_time_zone(id);
            tally.check(
                (valid != entry["valid"].as_bool().unwrap())
                    .then(|| format!("{} zone {id:?}: {valid} != {}", pack.name, entry["valid"])),
            );
        }
    }
    tally.finish(50);
}

#[test]
fn calendar_dates_are_accepted_and_printed_like_the_reference() {
    let mut tally = Tally::new("primitives.dates");
    for pack in packs() {
        for entry in pack.primitives("dates") {
            let text = entry["text"].as_str().unwrap();
            let valid = is_plain_date(text);
            tally
                .check((valid != entry["valid"].as_bool().unwrap()).then(|| {
                    format!("{} date {text:?}: {valid} != {}", pack.name, entry["valid"])
                }));
            // A date names a day of the partition only in its printed form.
            let printed = entry["printed"].as_str();
            let names_itself = LocalDate::from_printed(text).map(|date| date.to_string());
            let expected = printed.filter(|printed| *printed == text);
            tally.check((names_itself.as_deref() != expected).then(|| {
                format!(
                    "{} printed {text:?}: {names_itself:?} != {expected:?}",
                    pack.name
                )
            }));
        }
    }
    tally.finish(50);
}

#[test]
fn local_clocks_parse_like_the_reference() {
    let mut tally = Tally::new("primitives.clocks");
    for pack in packs() {
        for entry in pack.primitives("clocks") {
            let text = entry["text"].as_str().unwrap();
            let minutes = parse_clock(text).ok().map(|clock| clock.minutes());
            tally.check((minutes != entry["minutes"].as_i64()).then(|| {
                format!(
                    "{} clock {text:?}: {minutes:?} != {}",
                    pack.name, entry["minutes"]
                )
            }));
        }
    }
    tally.finish(20);
}

#[test]
fn legal_session_limits_match_the_reference() {
    let mut tally = Tally::new("primitives.sessions");
    for pack in packs() {
        for entry in pack.primitives("sessions") {
            let break_after_min = entry["breakAfterMin"].as_f64().unwrap();
            let max_daily_focus_min = entry["maxDailyFocusMin"].as_f64().unwrap();
            let limit = max_legal_session_min(break_after_min, max_daily_focus_min);
            let actual = limit.map_or(
                Value::Null,
                |limit| json!({"capMin": limit.cap_min, "reason": limit.reason.as_str()}),
            );
            tally.check(
                first_difference(&actual, &entry["limit"]).map(|difference| {
                    format!(
                        "{} limit({break_after_min}, {max_daily_focus_min}) {difference}",
                        pack.name
                    )
                }),
            );
            for split in array(&entry["autoSplitMin"], "autoSplitMin") {
                let default_min = split["defaultMin"].as_f64().unwrap();
                let actual = auto_split_min_session_min(limit.unwrap().cap_min, default_min);
                tally.check(
                    (actual.to_bits() != split["minSessionMin"].as_f64().unwrap().to_bits()).then(
                        || {
                            format!(
                                "{} autoSplitMin({}, {default_min}): {actual} != {}",
                                pack.name,
                                limit.unwrap().cap_min,
                                split["minSessionMin"]
                            )
                        },
                    ),
                );
            }
        }
    }
    tally.finish(50);
}

#[test]
fn local_date_partitions_match_the_reference_across_dst_transitions() {
    let mut tally = Tally::new("primitives.partitions");
    let mut segments = 0;
    for pack in packs() {
        for entry in pack.primitives("partitions") {
            let zone = entry["timeZone"].as_str().unwrap();
            let start = parse_instant(entry["start"].as_str().unwrap()).unwrap();
            let end = parse_instant(entry["end"].as_str().unwrap()).unwrap();
            let actual: Vec<Value> = partition_by_local_date(start, end, zone)
                .unwrap_or_else(|error| panic!("{} {zone}: {error}", pack.name))
                .into_iter()
                .map(|segment| {
                    json!({
                        "date": segment.date.to_string(),
                        "weekday": segment.weekday,
                        "offsetMs": segment.offset_ms,
                        "startMs": segment.start_ms,
                        "endMs": segment.end_ms,
                        "localMidnightMs": segment.local_midnight_ms,
                    })
                })
                .collect();
            segments += actual.len();
            tally.check(
                first_difference(&Value::Array(actual), &entry["segments"]).map(|difference| {
                    format!(
                        "{} {zone} {}..{} {difference} (reference tzdata {})",
                        pack.name, entry["start"], entry["end"], pack.header["oracle"]["tzdata"],
                    )
                }),
            );
        }
    }
    assert!(segments > 450, "only {segments} segments compared");
    tally.finish(29);
}

#[test]
fn every_input_reads_into_the_typed_model_and_writes_back_unchanged() {
    let mut tally = Tally::new("input round trip");
    for pack in packs() {
        for case in pack.cases() {
            let (input, _) = typed(&case);
            let written = canonical_json(&input.to_json());
            tally.check((written != canonical_json(&case["input"])).then(|| {
                format!(
                    "{} {}: the typed input writes back differently",
                    pack.name, case["id"]
                )
            }));
        }
    }
    tally.finish(27);
}

#[test]
fn input_hashes_of_every_case_match_the_reference() {
    let mut tally = Tally::new("inputHash");
    for pack in packs() {
        for case in pack.cases() {
            let (input, options) = typed(&case);
            let from_typed = input_hash_of(&input, &options);
            let from_json = input_hash(&case["input"], &case["options"]);
            for candidate in array(&case["result"]["candidates"], "candidates") {
                tally.check(
                    (candidate["inputHash"] != from_typed.as_str()
                        || candidate["inputHash"] != from_json.as_str())
                    .then(|| {
                        format!(
                            "{} {} {}: {from_typed} / {from_json} != {}",
                            pack.name, case["id"], candidate["policy"], candidate["inputHash"]
                        )
                    }),
                );
            }
        }
    }
    tally.finish(20);
}

#[test]
fn available_slots_match_the_reference() {
    let mut tally = Tally::new("slots");
    let (mut unreadable, mut intervals) = (0, 0);
    for pack in packs() {
        for case in pack.cases() {
            let (input, _) = typed(&case);
            // The reference records `null` where `computeAvailableSlots` throws.
            let actual = match compute_available_slots(&input) {
                Ok(slots) => {
                    intervals += slots.len();
                    Value::Array(slots.iter().map(Slot::to_json).collect())
                }
                Err(_) => {
                    unreadable += 1;
                    Value::Null
                }
            };
            tally.check(
                first_difference(&actual, &case["slots"])
                    .map(|difference| format!("{} {} slots{difference}", pack.name, case["id"])),
            );
        }
    }
    println!("oracle layer slots: {intervals} interval(s), {unreadable} unreadable input(s)");
    assert!(intervals > 100, "only {intervals} slot intervals compared");
    assert!(unreadable > 0, "no case exercises an unreadable input");
    tally.finish(27);
}

#[test]
fn recorded_results_hash_to_their_recorded_result_hash() {
    // Exercises canonical JSON on full results (float metrics, nested
    // explanation items) and guards the pack against hand edits.
    let mut tally = Tally::new("resultHash of the recorded result");
    for pack in packs() {
        for case in pack.cases() {
            let actual = sha256_hex(&canonical_json(&case["result"]));
            tally.check((case["resultHash"] != actual.as_str()).then(|| {
                format!(
                    "{} {}: {actual} != {}",
                    pack.name, case["id"], case["resultHash"]
                )
            }));
        }
    }
    tally.finish(27);
}

#[test]
fn a_changed_input_no_longer_matches_its_recorded_hash() {
    let pack = packs().remove(0);
    let case = pack
        .cases()
        .find(|case| !array(&case["result"]["candidates"], "candidates").is_empty())
        .unwrap();
    let recorded = case["result"]["candidates"][0]["inputHash"]
        .as_str()
        .unwrap();
    let (mut input, options) = typed(&case);
    assert_eq!(input_hash_of(&input, &options), recorded);
    input.seed += 1.0;
    assert_ne!(input_hash_of(&input, &options), recorded);
}

#[test]
fn a_changed_pack_is_reported_as_a_mismatch_with_its_place() {
    // The comparison itself: equal values pass, a changed leaf, a missing
    // key and a shorter list are each found and located.
    let recorded = json!({"slots": [{"start": "a", "end": "b"}], "n": 1.5});
    assert_eq!(first_difference(&recorded, &recorded.clone()), None);
    let mut changed = recorded.clone();
    changed["slots"][0]["end"] = json!("c");
    let difference = first_difference(&changed, &recorded).unwrap();
    assert!(difference.starts_with("/slots/0/end"), "{difference}");
    let mut number = recorded.clone();
    number["n"] = json!(1.500_000_000_000_000_2);
    assert!(
        first_difference(&number, &recorded)
            .unwrap()
            .starts_with("/n")
    );
    let mut shorter = recorded.clone();
    shorter["slots"] = json!([]);
    assert!(
        first_difference(&shorter, &recorded)
            .unwrap()
            .contains("0 item(s) != 1 item(s)")
    );
    let mut missing = recorded.clone();
    missing.as_object_mut().unwrap().remove("n");
    assert!(
        first_difference(&missing, &recorded)
            .unwrap()
            .contains("absent")
    );
    assert!(first_difference(&Value::Null, &json!([])).is_some());

    let mut tally = Tally::new("self-test");
    tally.check(None);
    tally.check(Some("difference".to_owned()));
    assert_eq!(tally.compared(), 2);
    assert!(std::panic::catch_unwind(move || tally.finish(1)).is_err());
    let empty = Tally::new("self-test");
    assert!(std::panic::catch_unwind(move || empty.finish(1)).is_err());
}

#[test]
fn packs_of_another_format_or_version_are_refused() {
    let good = json!({"format": FORMAT, "formatVersion": FORMAT_VERSION});
    assert_eq!(check_header(&good), Ok(()));
    let newer = json!({"format": FORMAT, "formatVersion": FORMAT_VERSION + 1});
    assert!(
        check_header(&newer)
            .unwrap_err()
            .contains("unsupported formatVersion")
    );
    let older = json!({"format": FORMAT, "formatVersion": 1});
    assert!(check_header(&older).unwrap_err().contains("regenerate"));
    let other = json!({"format": "ohmydate-export", "formatVersion": FORMAT_VERSION});
    assert!(
        check_header(&other)
            .unwrap_err()
            .contains("not an oracle pack")
    );
}
