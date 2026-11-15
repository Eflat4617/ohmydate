//! `packages/scheduler/test/explanation-codes.test.ts` (FU-62): every
//! validator finding and input issue has a closed code whose parameters
//! reproduce its English text, and every code is reachable.
//!
//! The generator half of that file (explanation lines of candidates) is in
//! `tests/generate_codes.rs`.

#![allow(clippy::unwrap_used)]

mod support;

use std::collections::BTreeSet;

use ohmydate_scheduler::codes::{
    ExplanationCode, InputIssueMessageCode, ParamValue, Params, ViolationMessageCode,
};
use ohmydate_scheduler::types::{Block, Commitment, ExceptionKind, ScheduleInput, Task};
use ohmydate_scheduler::validate::{InputIssue, Violation, validate_input};
use proptest::prelude::*;
use support::templates::{check_coded, check_safe_params, expected_text};
use support::{audit, exception, property, rule};

fn task(id: &str) -> Task {
    Task {
        due_at: Some("2026-11-11T17:00:00Z".to_owned()),
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task(id, 60.0)
    }
}

fn input() -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-12T00:00:00Z",
        vec![task("A")],
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", "17:00"))
            .collect(),
    );
    input.seed = 7.0;
    input
}

/// A block on 2026-11-09.
fn block(task_id: &str, start: &str, end: &str) -> Block {
    support::block(
        task_id,
        &format!("2026-11-09T{start}"),
        &format!("2026-11-09T{end}"),
    )
}

fn one_hour() -> Vec<Block> {
    vec![block("A", "09:00:00Z", "10:00:00Z")]
}

fn edited(edit: impl FnOnce(&mut ScheduleInput)) -> ScheduleInput {
    let mut input = input();
    edit(&mut input);
    input
}

fn with_task(edit: impl FnOnce(&mut Task)) -> ScheduleInput {
    edited(|input| edit(&mut input.tasks[0]))
}

fn two_tasks(edit: impl FnOnce(&mut Task)) -> ScheduleInput {
    edited(|input| {
        let mut second = task("B");
        edit(&mut second);
        input.tasks.push(second);
    })
}

fn unsplittable(min: f64, max: f64) -> impl FnOnce(&mut Task) {
    move |task| {
        task.splittable = false;
        task.min_session_min = min;
        task.max_session_min = max;
    }
}

/// Validator scenarios; together they reach every violation message code.
fn violation_scenarios() -> Vec<(&'static str, ScheduleInput, Vec<Block>)> {
    vec![
        (
            "invalid time zone",
            edited(|input| input.time_zone = "Mars/Base".to_owned()),
            one_hour(),
        ),
        (
            "invalid horizon",
            edited(|input| input.horizon.start = "not-an-instant".to_owned()),
            one_hour(),
        ),
        (
            "unknown task",
            input(),
            vec![
                block("A", "09:00:00Z", "10:00:00Z"),
                block("Z", "11:00:00Z", "12:00:00Z"),
            ],
        ),
        (
            "outside horizon",
            input(),
            vec![support::block(
                "A",
                "2026-11-13T09:00:00Z",
                "2026-11-13T10:00:00Z",
            )],
        ),
        (
            "invalid instant",
            input(),
            vec![support::block("A", "garbage", "2026-11-09T10:00:00Z")],
        ),
        (
            "sub-millisecond",
            input(),
            vec![block("A", "09:00:00.000000001Z", "10:00:00Z")],
        ),
        (
            "off grid",
            input(),
            vec![block("A", "09:03:00Z", "10:03:00Z")],
        ),
        (
            "ends before start",
            input(),
            vec![block("A", "10:00:00Z", "09:00:00Z")],
        ),
        (
            "same-task overlap",
            input(),
            vec![
                block("A", "09:00:00Z", "09:30:00Z"),
                block("A", "09:15:00Z", "09:45:00Z"),
            ],
        ),
        (
            "two-task overlap",
            two_tasks(|_| {}),
            vec![
                block("A", "09:00:00Z", "10:00:00Z"),
                block("B", "09:30:00Z", "10:30:00Z"),
            ],
        ),
        (
            "commitment overlap",
            edited(|input| {
                input.commitments = vec![Commitment {
                    start: "2026-11-09T09:00:00Z".to_owned(),
                    end: "2026-11-09T10:00:00Z".to_owned(),
                }];
            }),
            one_hour(),
        ),
        (
            "outside availability",
            input(),
            vec![block("A", "03:00:00Z", "04:00:00Z")],
        ),
        (
            "dependency order",
            two_tasks(|task| task.depends_on = vec!["A".to_owned()]),
            vec![
                block("B", "09:00:00Z", "10:00:00Z"),
                block("A", "10:00:00Z", "11:00:00Z"),
            ],
        ),
        (
            "before earliest start",
            with_task(|task| task.earliest_start_at = Some("2026-11-10T09:00:00Z".to_owned())),
            one_hour(),
        ),
        (
            "inside due buffer",
            with_task(|task| {
                task.due_at = Some("2026-11-09T11:00:00Z".to_owned());
                task.buffer_before_due_min = Some(60.0);
            }),
            vec![block("A", "09:30:00Z", "10:30:00Z")],
        ),
        (
            "after due",
            with_task(|task| task.due_at = Some("2026-11-09T09:30:00Z".to_owned())),
            one_hour(),
        ),
        (
            "non-splittable without remaining minutes",
            with_task(|task| {
                unsplittable(60.0, 60.0)(task);
                task.remaining_min = Some(0.0);
            }),
            one_hour(),
        ),
        (
            "non-splittable outside session bounds",
            with_task(unsplittable(90.0, 120.0)),
            one_hour(),
        ),
        (
            "non-splittable in two blocks",
            with_task(unsplittable(60.0, 60.0)),
            vec![
                block("A", "09:00:00Z", "09:30:00Z"),
                block("A", "10:00:00Z", "10:30:00Z"),
            ],
        ),
        (
            "session too short",
            input(),
            vec![
                block("A", "09:00:00Z", "09:15:00Z"),
                block("A", "10:00:00Z", "10:45:00Z"),
            ],
        ),
        (
            "daily cap",
            edited(|input| input.prefs.max_daily_focus_min = 30.0),
            one_hour(),
        ),
        (
            "missing break",
            edited(|input| {
                input.prefs.break_after_min = 30.0;
                input.prefs.break_min = 15.0;
            }),
            one_hour(),
        ),
        ("deficit", input(), Vec::new()),
        (
            "overallocated",
            input(),
            vec![block("A", "09:00:00Z", "10:30:00Z")],
        ),
    ]
}

/// Input scenarios; together they reach every input issue message code.
fn input_scenarios() -> Vec<(&'static str, ScheduleInput)> {
    let long = ("2026-01-01T00:00:00Z", "2027-03-01T00:00:00Z");
    let commitment = |start: &str, end: &str| Commitment {
        start: start.to_owned(),
        end: end.to_owned(),
    };
    vec![
        (
            "time zone",
            edited(|input| input.time_zone = "Mars/Base".to_owned()),
        ),
        (
            "horizon instant",
            edited(|input| input.horizon.start = "garbage".to_owned()),
        ),
        (
            "horizon order",
            edited(|input| input.horizon.start = "2026-11-12T00:00:00Z".to_owned()),
        ),
        (
            "horizon length",
            edited(|input| {
                input.horizon.start = long.0.to_owned();
                input.horizon.end = long.1.to_owned();
            }),
        ),
        ("now", edited(|input| input.now = "garbage".to_owned())),
        (
            "duplicate task",
            edited(|input| input.tasks.push(task("A"))),
        ),
        (
            "estimate",
            with_task(|task| task.estimate.p50_min = f64::NAN),
        ),
        (
            "buffer",
            with_task(|task| task.buffer_before_due_min = Some(1.5)),
        ),
        (
            "session minutes",
            with_task(|task| task.min_session_min = 1.5),
        ),
        (
            "session bounds",
            with_task(|task| {
                task.min_session_min = 60.0;
                task.max_session_min = 30.0;
            }),
        ),
        (
            "window instant",
            with_task(|task| task.due_at = Some("garbage".to_owned())),
        ),
        (
            "empty window",
            with_task(|task| task.earliest_start_at = Some("2026-11-11T18:00:00Z".to_owned())),
        ),
        ("preference", edited(|input| input.prefs.break_min = -1.0)),
        (
            "unknown dependency",
            with_task(|task| task.depends_on = vec!["Z".to_owned()]),
        ),
        (
            "dependency cycle",
            edited(|input| {
                input.tasks[0].depends_on = vec!["B".to_owned()];
                let mut second = task("B");
                second.depends_on = vec!["A".to_owned()];
                input.tasks.push(second);
            }),
        ),
        (
            "weekday",
            edited(|input| input.availability = vec![rule(9, "09:00", "17:00")]),
        ),
        (
            "availability window",
            edited(|input| input.availability = vec![rule(1, "17:00", "09:00")]),
        ),
        (
            "exception date",
            edited(|input| {
                input.exceptions = vec![exception("2026-13-40", ExceptionKind::Off, None)]
            }),
        ),
        (
            "partial exception",
            edited(|input| {
                let mut partial =
                    exception("2026-11-10", ExceptionKind::Off, Some(("09:00", "10:00")));
                partial.end_local = None;
                input.exceptions = vec![partial];
            }),
        ),
        (
            "exception window",
            edited(|input| {
                input.exceptions = vec![exception(
                    "2026-11-10",
                    ExceptionKind::Off,
                    Some(("12:00", "10:00")),
                )];
            }),
        ),
        (
            "commitment instant",
            edited(|input| input.commitments = vec![commitment("garbage", "2026-11-09T10:00:00Z")]),
        ),
        (
            "commitment order",
            edited(|input| {
                input.commitments =
                    vec![commitment("2026-11-09T10:00:00Z", "2026-11-09T09:00:00Z")];
            }),
        ),
        (
            "commitment length",
            edited(|input| {
                input.horizon.start = "2026-11-12T00:00:00Z".to_owned();
                input.horizon.end = "2026-11-09T00:00:00Z".to_owned();
                input.commitments = vec![commitment(long.0, long.1)];
            }),
        ),
        (
            "block task",
            edited(|input| input.locked_blocks = vec![block("Z", "09:00:00Z", "10:00:00Z")]),
        ),
        (
            "block instant",
            edited(|input| {
                input.locked_blocks = vec![support::block("A", "garbage", "2026-11-09T10:00:00Z")];
            }),
        ),
        (
            "block precision",
            edited(|input| {
                input.locked_blocks = vec![block("A", "09:00:00.000000001Z", "10:00:00Z")]
            }),
        ),
        (
            "block grid",
            edited(|input| {
                input.existing_blocks = Some(vec![block("A", "09:03:00Z", "10:03:00Z")])
            }),
        ),
        (
            "block order",
            edited(|input| input.locked_blocks = vec![block("A", "10:00:00Z", "09:00:00Z")]),
        ),
        (
            "block length",
            edited(|input| input.locked_blocks = vec![support::block("A", long.0, long.1)]),
        ),
    ]
}

fn check_violation(violation: &Violation) -> Result<(), String> {
    // The message code family is the H-kind: h1_* codes only on H1 findings.
    if violation.message_code.kind() != violation.code {
        return Err(format!(
            "{} on a {} finding",
            violation.message_code, violation.code
        ));
    }
    if violation.item().params != violation.params {
        return Err(format!(
            "{}: the item has other parameters",
            violation.message_code
        ));
    }
    check_coded(
        ExplanationCode::Violation(violation.message_code),
        &violation.params,
        &violation.message,
    )
}

fn check_issue(issue: &InputIssue) -> Result<(), String> {
    check_coded(
        ExplanationCode::InputIssue(issue.message_code),
        &issue.params,
        &issue.message,
    )
}

#[test]
fn the_code_lists_are_closed_and_every_code_has_a_template() {
    let all = ExplanationCode::all();
    let unique: BTreeSet<&str> = all.iter().map(|code| code.as_str()).collect();
    assert_eq!(unique.len(), all.len());
    for code in ViolationMessageCode::ALL {
        let text = code.as_str();
        assert!(
            text.starts_with('h')
                && text.as_bytes()[1].is_ascii_digit()
                && text.as_bytes()[2] == b'_'
        );
        assert!(unique.contains(text));
    }
    for code in InputIssueMessageCode::ALL {
        assert!(code.as_str().starts_with("input_") && unique.contains(code.as_str()));
    }
    // Every code is described by the template oracle (an unknown code would
    // panic there), and no template is satisfied by a message without its
    // parameters.
    for code in all {
        let expected = expected_text(code, &Params::none());
        let needs_parameters = !matches!(
            code.as_str(),
            "constraints_satisfied"
                | "input_invalid_horizon_instant"
                | "input_horizon_not_increasing"
                | "input_invalid_now"
                | "input_dependency_cycle"
                | "input_commitment_invalid_instant"
                | "input_commitment_end_before_start"
                | "h8_invalid_horizon"
        ) && !code.as_str().starts_with("heuristic_");
        if needs_parameters {
            assert!(!expected.matches(""), "{code}");
        }
    }
}

#[test]
fn codes_every_validator_finding_one_to_one_with_its_message_template() {
    let mut seen = BTreeSet::new();
    for (name, scenario, blocks) in violation_scenarios() {
        let violations = audit(&scenario, &blocks, &[]);
        assert!(!violations.is_empty(), "{name}");
        for violation in &violations {
            check_violation(violation).unwrap_or_else(|reason| panic!("{name}: {reason}"));
            seen.insert(violation.message_code.as_str());
        }
    }
    // Reachability: every published violation code is produced by some input.
    let published: BTreeSet<&str> = ViolationMessageCode::ALL
        .iter()
        .map(|code| code.as_str())
        .collect();
    assert_eq!(seen, published);
}

#[test]
fn codes_every_input_issue_one_to_one_with_its_message_template() {
    let mut seen = BTreeSet::new();
    for (name, scenario) in input_scenarios() {
        let issues = validate_input(&scenario);
        assert!(!issues.is_empty(), "{name}");
        for issue in &issues {
            check_issue(issue).unwrap_or_else(|reason| panic!("{name}: {reason}"));
            assert_eq!(issue.item().params, issue.params);
            seen.insert(issue.message_code.as_str());
        }
    }
    let published: BTreeSet<&str> = InputIssueMessageCode::ALL
        .iter()
        .map(|code| code.as_str())
        .collect();
    assert_eq!(seen, published);
    assert_eq!(validate_input(&input()), Vec::new());
}

#[test]
fn a_text_that_does_not_follow_from_its_parameters_is_detected() {
    let violations = audit(&input(), &[], &[]);
    let deficit = &violations[0];
    assert_eq!(check_violation(deficit), Ok(()));
    // Another number in the text, another code for the text, a parameter
    // that is free text, a finding filed under another constraint.
    let mut reworded = deficit.clone();
    reworded.message = reworded.message.replace("60", "45");
    assert!(check_violation(&reworded).is_err());
    let mut recoded = deficit.clone();
    recoded.message_code = ViolationMessageCode::H7Overallocated;
    assert!(check_violation(&recoded).is_err());
    let mut refiled = deficit.clone();
    refiled.code = ohmydate_scheduler::codes::ViolationCode::H1;
    assert!(check_violation(&refiled).is_err());
    let titled = Params::none().text("taskId", "Quarterly report draft");
    assert!(check_safe_params("h7_deficit", &titled).is_err());
    assert!(check_safe_params("x", &Params::none().number("ratio", f64::NAN)).is_err());
    assert!(check_safe_params("x", &Params::none().text("startAt", "2026-11-09")).is_err());
    assert!(check_safe_params("x", &Params::none().text("date", "09/11/2026")).is_err());
    assert!(check_safe_params("x", &Params::none().text("Task", "A")).is_err());
    assert_eq!(
        deficit.params.get("shortMin"),
        Some(&ParamValue::Number(60.0))
    );
}

proptest! {
    #![proptest_config(property::config())]

    /// Every finding on randomly edited blocks is coded.
    #[test]
    fn codes_every_finding_for_random_edited_blocks(
        specs in proptest::collection::vec(
            (
                proptest::sample::select(&["A", "B", "Z"][..]),
                8_i64..=12,
                0_i64..=(24 * 60 - 1),
                -30_i64..=600,
            ),
            0..=6,
        ),
    ) {
        let base = two_tasks(|task| {
            task.depends_on = vec!["A".to_owned()];
            task.due_at = Some("2026-11-10T12:00:00Z".to_owned());
        });
        let blocks: Vec<Block> = specs
            .iter()
            .map(|(task_id, day, start_min, length_min)| {
                let start = support::minute_oracle::instant_ms(&format!("2026-11-{day:02}T00:00:00Z"))
                    + start_min * 60_000;
                let text = |epoch_ms: i64| {
                    jiff::Timestamp::from_millisecond(epoch_ms).unwrap().to_string()
                };
                support::block(task_id, &text(start), &text(start + length_min * 60_000))
            })
            .collect();
        for violation in audit(&base, &blocks, &[]) {
            prop_assert_eq!(check_violation(&violation), Ok(()));
        }
    }
}
