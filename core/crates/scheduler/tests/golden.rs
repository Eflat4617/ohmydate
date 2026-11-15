//! `packages/scheduler/test/golden.test.ts`: the fifteen golden fixtures
//! G01–G15 with their expected slots, validator verdicts, capacity reports
//! and generator behaviour.
//!
//! The fixtures are read from the reference package, so the two test suites
//! cannot drift apart; their complete generator output is additionally held
//! byte for byte by the oracle pack (`tests/oracle.rs`).

#![allow(clippy::unwrap_used)]

mod support;

use std::path::PathBuf;

use jiff::Timestamp;
use ohmydate_scheduler::explain::deficit;
use ohmydate_scheduler::generate::{GENERATOR_VERSION, generate};
use ohmydate_scheduler::replay::{history_blocks, read_plan};
use ohmydate_scheduler::requirements::task_required_minutes;
use ohmydate_scheduler::slots::{compute_available_slots, max_contiguous_min, slot_total_min};
use ohmydate_scheduler::types::{GenerateOptions, PolicyName, ScheduleInput};
use ohmydate_scheduler::validate::validate_input;
use serde_json::Value;
use support::minute_oracle::instant_ms;
use support::{audit, codes};

/// What the generator must do with a fixture. Feasible counts are the
/// returned (post-diversity) candidates that validate cleanly; the rest are
/// infeasible candidates that must still explain their violations.
struct Expectation {
    id: &'static str,
    feasible_count: usize,
    deficit_min: f64,
    capacity_deficit_min: f64,
    reason: Option<&'static str>,
    max_daily_load_min: Option<f64>,
    max_changed_blocks: Option<f64>,
    no_block_before_now: bool,
}

const fn expect(
    id: &'static str,
    feasible_count: usize,
    deficit_min: f64,
    capacity_deficit_min: f64,
) -> Expectation {
    Expectation {
        id,
        feasible_count,
        deficit_min,
        capacity_deficit_min,
        reason: None,
        max_daily_load_min: None,
        max_changed_blocks: None,
        no_block_before_now: false,
    }
}

const fn because(mut expectation: Expectation, reason: &'static str) -> Expectation {
    expectation.reason = Some(reason);
    expectation
}

fn expectations() -> Vec<Expectation> {
    vec![
        because(expect("G01", 0, 180.0, 60.0), "no_contiguous_window"),
        expect("G02", 1, 0.0, 0.0),
        expect("G03", 1, 0.0, 0.0),
        Expectation {
            max_changed_blocks: Some(3.0),
            ..expect("G04", 1, 0.0, 0.0)
        },
        Expectation {
            max_daily_load_min: Some(120.0),
            ..expect("G05", 1, 0.0, 0.0)
        },
        expect("G06", 1, 0.0, 0.0),
        because(expect("G07", 0, 60.0, 60.0), "invalid_window"),
        expect("G08", 1, 0.0, 0.0),
        because(expect("G09", 0, 120.0, 60.0), "insufficient_available_time"),
        expect("G10", 1, 0.0, 0.0),
        because(expect("G11", 0, 60.0, 60.0), "insufficient_available_time"),
        expect("G12", 1, 0.0, 0.0),
        because(expect("G13", 0, 240.0, 0.0), "no_contiguous_window"),
        expect("G14", 1, 0.0, 0.0),
        Expectation {
            no_block_before_now: true,
            ..expect("G15", 1, 0.0, 0.0)
        },
    ]
}

fn fixtures() -> Vec<Value> {
    let directory =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/scheduler/test/golden");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap())
        .collect()
}

fn sorted_strings(value: &Value) -> Vec<String> {
    let mut strings: Vec<String> = value
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry.as_str().unwrap().to_owned())
        .collect();
    strings.sort();
    strings
}

/// A slot edge as local date and time in another zone, `YYYY-MM-DDTHH:MM:SS`.
fn plain_in_zone(instant: &str, time_zone: &str) -> String {
    let zone = jiff::tz::TimeZone::get(time_zone).unwrap();
    instant
        .parse::<Timestamp>()
        .unwrap()
        .to_zoned(zone)
        .datetime()
        .to_string()
}

fn all_policies(input: &ScheduleInput) -> GenerateOptions {
    GenerateOptions {
        policies: Some(PolicyName::ALL.to_vec()),
        seed: Some(input.seed),
        max_local_improvement: None,
    }
}

#[test]
fn contains_all_fifteen_fixtures() {
    let ids: Vec<String> = fixtures()
        .iter()
        .map(|fixture| fixture["id"].as_str().unwrap().to_owned())
        .collect();
    let expected: Vec<&str> = expectations().iter().map(|expected| expected.id).collect();
    assert_eq!(ids.len(), 15);
    assert_eq!(ids, expected);
}

#[test]
fn the_fixtures_have_their_expected_slots_verdicts_and_capacity() {
    for fixture in fixtures() {
        let id = fixture["id"].as_str().unwrap();
        let input = ScheduleInput::from_json(&fixture["input"]).unwrap();
        let expected = &fixture["expected"];

        let slots = compute_available_slots(&input).unwrap();
        assert_eq!(
            slot_total_min(&slots).unwrap(),
            expected["slotTotalMin"].as_f64().unwrap(),
            "{id}"
        );
        assert_eq!(
            slots.len() as u64,
            expected["slotIntervalCount"].as_u64().unwrap(),
            "{id}"
        );
        for pair in slots.windows(2) {
            assert!(
                instant_ms(&pair[0].end) <= instant_ms(&pair[1].start),
                "{id}"
            );
        }
        assert_eq!(compute_available_slots(&input).unwrap(), slots, "{id}");

        let mut issue_codes: Vec<&str> = validate_input(&input)
            .iter()
            .map(|issue| issue.code.as_str())
            .collect();
        issue_codes.sort();
        match expected.get("inputIssueCodes") {
            None => assert!(issue_codes.is_empty(), "{id}: {issue_codes:?}"),
            Some(codes) => assert_eq!(issue_codes, sorted_strings(codes), "{id}"),
        }

        for (blocks, verdict) in [
            ("valid", "validViolationCodes"),
            ("invalid", "invalidViolationCodes"),
        ] {
            let plan = &fixture["candidateBlocks"][blocks];
            if plan.is_null() {
                continue;
            }
            let plan = read_plan(plan, "").unwrap();
            assert_eq!(
                codes(&input, &plan),
                sorted_strings(&expected[verdict]),
                "{id} {blocks}"
            );
        }

        if let Some(wanted) = expected.get("deficit") {
            let report = deficit(&input).unwrap();
            let task = report
                .tasks
                .iter()
                .find(|entry| entry.task_id == wanted["taskId"].as_str().unwrap())
                .unwrap();
            let number = |value: &Value, name: &str| value[name].as_f64().unwrap();
            assert_eq!(task.required_min, number(wanted, "requiredMin"), "{id}");
            assert_eq!(
                task.available_before_due_min,
                number(wanted, "availableBeforeDueMin"),
                "{id}"
            );
            assert_eq!(task.deficit_min, number(wanted, "deficitMin"), "{id}");
            assert_eq!(report.risk_level, input.prefs.risk_level, "{id}");
            assert_eq!(
                report.total.required_min,
                number(&wanted["total"], "requiredMin"),
                "{id}"
            );
            assert_eq!(
                report.total.available_before_due_min,
                number(&wanted["total"], "availableBeforeDueMin"),
                "{id}"
            );
            assert_eq!(
                report.total.deficit_min,
                number(&wanted["total"], "deficitMin"),
                "{id}"
            );
        }

        let user_zone_slots = expected.get("userTimeZoneSlots");
        if expected["noContiguousWindow"] == true && user_zone_slots.is_none() {
            let task = &input.tasks[0];
            assert!(!task.splittable, "{id}");
            assert!(
                max_contiguous_min(&slots).unwrap()
                    < task_required_minutes(task, input.prefs.risk_level),
                "{id}"
            );
        }
        if let Some(wanted) = user_zone_slots {
            let time_zone = fixture["userTimeZone"].as_str().unwrap();
            let plain: Vec<Value> = slots
                .iter()
                .map(|slot| {
                    serde_json::json!({
                        "startPlain": plain_in_zone(&slot.start, time_zone),
                        "endPlain": plain_in_zone(&slot.end, time_zone),
                    })
                })
                .collect();
            assert_eq!(&Value::Array(plain), wanted, "{id}");
        }
    }
}

#[test]
fn the_generator_treats_every_fixture_as_expected() {
    let expectations = expectations();
    for fixture in fixtures() {
        let id = fixture["id"].as_str().unwrap();
        let wanted = expectations.iter().find(|entry| entry.id == id).unwrap();
        let input = ScheduleInput::from_json(&fixture["input"]).unwrap();
        let generated = generate(&input, &all_policies(&input)).unwrap();

        assert!((1..=3).contains(&generated.candidates.len()), "{id}");
        assert_eq!(
            generated
                .candidates
                .iter()
                .filter(|candidate| candidate.feasible)
                .count(),
            wanted.feasible_count,
            "{id}"
        );
        let hash = &generated.candidates[0].input_hash;
        assert!(
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "{id}"
        );

        let history = history_blocks(&input);
        let now_ms = instant_ms(&input.now);
        for candidate in &generated.candidates {
            assert_eq!(&candidate.input_hash, hash, "{id}");
            assert_eq!(candidate.generator_version, GENERATOR_VERSION);
            assert_eq!(candidate.deficit_min, wanted.deficit_min, "{id}");
            assert_eq!(candidate.metrics.deficit_min, candidate.deficit_min, "{id}");
            assert_eq!(
                candidate.capacity_deficit_min, wanted.capacity_deficit_min,
                "{id}"
            );
            assert_eq!(
                candidate.metrics.capacity_deficit_min, candidate.capacity_deficit_min,
                "{id}"
            );
            assert!(!candidate.explanation.is_empty(), "{id}");
            assert_eq!(
                candidate.explanation.len(),
                candidate.explanation_items.len(),
                "{id}"
            );

            let violations = audit(&input, &candidate.blocks, &history);
            if candidate.feasible {
                assert_eq!(violations, Vec::new(), "{id} {}", candidate.policy);
            } else {
                assert!(
                    candidate.blocks.is_empty()
                        || !violations.is_empty()
                        || candidate
                            .explanation
                            .iter()
                            .any(|line| line.contains("Input rejected")),
                    "{id} {}",
                    candidate.policy
                );
            }
            if let Some(limit) = wanted.max_daily_load_min {
                assert!(candidate.metrics.max_daily_load_min <= limit, "{id}");
            }
            if let Some(limit) = wanted.max_changed_blocks {
                assert!(candidate.metrics.changed_blocks <= limit, "{id}");
            }
            if wanted.no_block_before_now {
                for block in &candidate.blocks {
                    assert!(instant_ms(&block.start) >= now_ms, "{id}");
                }
            }
        }

        if let Some(reason) = wanted.reason {
            assert!(
                generated.candidates.iter().any(|candidate| candidate
                    .explanation
                    .iter()
                    .any(|line| line.contains(reason))),
                "{id}: no line names {reason}"
            );
        }
        if id == "G14" {
            assert_eq!(generated.candidates.len(), 1);
            assert!(
                generated
                    .diversity_note
                    .as_deref()
                    .unwrap()
                    .contains("distinct")
            );
        }
        // Determinism: the same input and seed give the same result.
        assert_eq!(
            generate(&input, &all_policies(&input)).unwrap(),
            generated,
            "{id}"
        );
    }
}

#[test]
fn an_expectation_that_does_not_hold_is_noticed() {
    // The assertions above compare against real output: a fixture whose
    // estimate is doubled no longer fits its expectation.
    let fixture = fixtures()
        .into_iter()
        .find(|fixture| fixture["id"] == "G02")
        .unwrap();
    let mut input = ScheduleInput::from_json(&fixture["input"]).unwrap();
    let before = generate(&input, &all_policies(&input)).unwrap();
    assert!(
        before
            .candidates
            .iter()
            .all(|candidate| candidate.deficit_min == 0.0)
    );
    for task in &mut input.tasks {
        task.estimate.p50_min *= 40.0;
        task.estimate.p90_min *= 40.0;
        task.max_session_min *= 40.0;
    }
    let after = generate(&input, &all_policies(&input)).unwrap();
    assert!(after.candidates.iter().all(|candidate| !candidate.feasible));
    assert!(
        after
            .candidates
            .iter()
            .all(|candidate| candidate.deficit_min > 0.0)
    );
    assert_ne!(
        after.candidates[0].input_hash,
        before.candidates[0].input_hash
    );
}
