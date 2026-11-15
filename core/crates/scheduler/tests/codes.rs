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
use ohmydate_scheduler::types::Block;
use ohmydate_scheduler::validate::{InputIssue, Violation, validate_input};
use proptest::prelude::*;
use support::scenarios::{input, input_scenarios, two_tasks, violation_scenarios};
use support::templates::{check_coded, check_safe_params, expected_text};
use support::{audit, property};

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
