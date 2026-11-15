//! `packages/scheduler/test/generate.test.ts`: the plan generator's
//! behaviour on small, hand-made inputs.
//!
//! Not repeated here: the published weights and versions
//! (`policies::tests`), and the hashing of the effective seed, improvement
//! cap and instant spellings (`input_hash::tests`).

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::canonical::{canonical_json, sha256_hex};
use ohmydate_scheduler::generate::{GENERATOR_VERSION, GenerateResult, PlanCandidate, generate};
use ohmydate_scheduler::policies::{POLICY_VERSION, PolicyOrdering, profile};
use ohmydate_scheduler::types::{
    AvailabilityRule, Block, GenerateOptions, PolicyName, ScheduleInput, Task,
};
use support::{all_week_full_day, audit, block, rule};

fn make_task(id: &str) -> Task {
    Task {
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task(id, 60.0)
    }
}

fn sized(id: &str, estimate_min: f64) -> Task {
    Task {
        estimate: ohmydate_scheduler::types::TaskEstimate {
            p50_min: estimate_min,
            p90_min: estimate_min,
        },
        ..make_task(id)
    }
}

fn due(mut task: Task, due_at: &str) -> Task {
    task.due_at = Some(due_at.to_owned());
    task
}

/// Two days from Monday 2026-11-09 in UTC, available around the clock.
fn make_input(tasks: Vec<Task>, availability: Vec<AvailabilityRule>) -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-11T00:00:00Z",
        tasks,
        availability,
    );
    input.seed = 902.0;
    input
}

fn one_day(mut input: ScheduleInput) -> ScheduleInput {
    input.horizon.end = "2026-11-10T00:00:00Z".to_owned();
    input
}

fn run(input: &ScheduleInput, policies: &[PolicyName]) -> GenerateResult {
    generate(
        input,
        &GenerateOptions {
            policies: Some(policies.to_vec()),
            seed: Some(input.seed),
            max_local_improvement: None,
        },
    )
    .unwrap()
}

fn only(input: &ScheduleInput, policy: PolicyName) -> PlanCandidate {
    let mut result = run(input, &[policy]);
    assert_eq!(result.candidates.len(), 1);
    result.candidates.remove(0)
}

fn text(candidate: &PlanCandidate) -> String {
    candidate.explanation.join("\n")
}

#[test]
fn is_byte_identical_for_the_same_input_and_seed() {
    let input = make_input(vec![make_task("A"), make_task("B")], all_week_full_day());
    let first = run(&input, PolicyName::ALL).to_json();
    let second = run(&input, PolicyName::ALL).to_json();
    assert_eq!(canonical_json(&first), canonical_json(&second));
    assert_eq!(
        sha256_hex(&canonical_json(&first)),
        sha256_hex(&canonical_json(&second))
    );
    // Another seed is another problem: at least the hash says so.
    let mut reseeded = input.clone();
    reseeded.seed = 903.0;
    assert_ne!(
        run(&reseeded, PolicyName::ALL).candidates[0].input_hash,
        run(&input, PolicyName::ALL).candidates[0].input_hash
    );
    for candidate in run(&input, PolicyName::ALL).candidates {
        assert_eq!(candidate.generator_version, GENERATOR_VERSION);
    }
}

#[test]
fn returns_at_most_one_candidate_per_requested_policy_and_never_more_than_three() {
    let input = make_input(vec![make_task("A")], all_week_full_day());
    let single = run(&input, &[PolicyName::Balanced, PolicyName::Balanced]);
    assert_eq!(single.candidates.len(), 1);
    assert_eq!(single.candidates[0].policy, PolicyName::Balanced);
    // One policy alone gets no diversity note.
    assert_eq!(single.diversity_note, None);
    assert_eq!(single.diversity_note_items, None);

    let all = run(&input, PolicyName::ALL);
    assert!(all.candidates.len() <= 3);
    let mut policies: Vec<&str> = all.candidates.iter().map(|c| c.policy.as_str()).collect();
    policies.sort();
    policies.dedup();
    assert_eq!(policies.len(), all.candidates.len());
    assert!(all.diversity_note.is_some());
    assert_eq!(run(&input, &[]).candidates.len(), 0);
}

#[test]
fn rejects_impossible_inputs_without_planning_blocks() {
    let mut task = due(make_task("A"), "2026-11-09T04:00:00Z");
    task.earliest_start_at = Some("2026-11-09T05:00:00Z".to_owned());
    let candidate = only(
        &make_input(vec![task], all_week_full_day()),
        PolicyName::FrontLoaded,
    );
    assert!(!candidate.feasible);
    assert_eq!(candidate.blocks, Vec::new());
    assert!(
        candidate
            .explanation
            .iter()
            .any(|line| line.contains("invalid_window"))
    );
    assert_eq!(
        candidate.explanation[1],
        "Input rejected before generation: invalid_window."
    );
    assert_eq!(
        candidate.explanation_items[1].code.as_str(),
        "input_rejected"
    );
    assert_eq!(candidate.deficit_min, 60.0);
    assert_eq!(candidate.metrics.p90_coverage_ratio, 1.0);
}

#[test]
fn keeps_locked_blocks_fixed_and_reports_changed_blocks_against_the_full_plan() {
    let locked = block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z");
    let mut input = make_input(
        vec![due(sized("A", 120.0), "2026-11-09T23:00:00Z")],
        vec![rule(1, "09:00", "12:00")],
    );
    input.locked_blocks = vec![locked.clone()];
    input.existing_blocks = Some(vec![
        locked.clone(),
        block("A", "2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z"),
    ]);
    let result = run(&input, PolicyName::ALL);
    assert!(!result.candidates.is_empty());
    for candidate in &result.candidates {
        assert!(candidate.feasible);
        assert!(!candidate.blocks.contains(&locked));
        assert_eq!(candidate.metrics.changed_blocks, 0.0);
        assert_eq!(audit(&input, &candidate.blocks, &[]), Vec::new());
    }
}

#[test]
fn derives_daily_metrics_and_context_switches_from_the_placed_blocks() {
    let mut input = make_input(
        vec![make_task("A"), make_task("B")],
        vec![rule(1, "09:00", "17:00"), rule(2, "09:00", "17:00")],
    );
    input.time_zone = "Asia/Seoul".to_owned();
    let result = run(&input, &[PolicyName::FrontLoaded, PolicyName::Balanced]);
    let of = |policy| {
        result
            .candidates
            .iter()
            .find(|candidate| candidate.policy == policy)
            .unwrap()
    };
    assert_eq!(of(PolicyName::FrontLoaded).metrics.total_focus_min, 120.0);
    assert_eq!(of(PolicyName::FrontLoaded).metrics.p90_coverage_ratio, 1.0);
    let balanced = of(PolicyName::Balanced).metrics;
    assert!(balanced.max_daily_load_min <= 60.0);
    assert_eq!(balanced.avg_daily_load_min, 60.0);
    assert_eq!(balanced.context_switches, 0.0);
}

#[test]
fn never_hides_hard_violations_on_an_infeasible_candidate() {
    let whole = Task {
        splittable: false,
        min_session_min: 180.0,
        max_session_min: 180.0,
        ..sized("A", 180.0)
    };
    let candidate = only(
        &one_day(make_input(vec![whole], vec![rule(1, "09:00", "11:00")])),
        PolicyName::FrontLoaded,
    );
    assert!(!candidate.feasible);
    assert_eq!(candidate.deficit_min, 180.0);
    assert_eq!(candidate.capacity_deficit_min, 60.0);
    assert!(text(&candidate).contains("H7"));
    assert!(
        candidate
            .explanation
            .iter()
            .any(|line| line.contains("no_contiguous_window"))
    );
    assert_eq!(
        candidate.explanation.len(),
        candidate.explanation_items.len()
    );
}

#[test]
fn skips_local_improvement_without_changing_feasibility() {
    let input = make_input(vec![sized("A", 90.0)], all_week_full_day());
    let with_improvement = run(&input, PolicyName::ALL);
    let without_improvement = generate(
        &input,
        &GenerateOptions {
            policies: Some(PolicyName::ALL.to_vec()),
            seed: Some(input.seed),
            max_local_improvement: Some(0.0),
        },
    )
    .unwrap();
    let feasible = |result: &GenerateResult| -> Vec<bool> {
        result
            .candidates
            .iter()
            .map(|candidate| candidate.feasible)
            .collect()
    };
    assert_eq!(feasible(&without_improvement), feasible(&with_improvement));
    for candidate in &without_improvement.candidates {
        if candidate.feasible {
            assert_eq!(audit(&input, &candidate.blocks, &[]), Vec::new());
        }
    }
    // The cap is part of what is hashed.
    assert_ne!(
        without_improvement.candidates[0].input_hash,
        with_improvement.candidates[0].input_hash
    );
}

#[test]
fn lets_a_feasible_candidate_win_a_diversity_collision() {
    // E1: the balanced plan is infeasible and nearly the same as the
    // feasible focus_blocked plan that follows it.
    let long = Task {
        priority: 1.0,
        ..due(sized("Z", 420.0), "2026-11-09T17:00:00Z")
    };
    let short = Task {
        splittable: false,
        min_session_min: 20.0,
        max_session_min: 20.0,
        priority: 4.0,
        ..due(sized("Y", 20.0), "2026-11-09T17:00:00Z")
    };
    let input = one_day(make_input(
        vec![long, short],
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", "17:00"))
            .collect(),
    ));
    let result = run(&input, &[PolicyName::Balanced, PolicyName::FocusBlocked]);
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(result.candidates[0].policy, PolicyName::FocusBlocked);
    assert!(result.candidates[0].feasible);
    assert_eq!(
        result.diversity_note.as_deref(),
        Some(
            "1 distinct plan(s) from 2 policy candidate(s); 1 candidate(s) dropped as too similar (distance < 0.15)."
        )
    );
    assert_eq!(
        result.diversity_note_items.unwrap()[0].to_json(),
        serde_json::json!({"code": "diversity_dropped", "params": {"kept": 1, "total": 2, "dropped": 1}})
    );
    // On its own, the balanced plan is the infeasible one.
    assert!(!only(&input, PolicyName::Balanced).feasible);
}

#[test]
fn counts_candidate_own_h7_shortfall_separately_from_capacity_deficit() {
    let candidate = only(
        &one_day(make_input(
            vec![due(sized("A", 120.0), "2026-11-09T10:00:00Z")],
            vec![rule(1, "09:00", "10:00")],
        )),
        PolicyName::FrontLoaded,
    );
    assert!(!candidate.feasible);
    assert_eq!(
        (candidate.deficit_min, candidate.capacity_deficit_min),
        (120.0, 60.0)
    );
    assert_eq!(candidate.metrics.deficit_min, 120.0);
    assert_eq!(candidate.metrics.capacity_deficit_min, 60.0);
    assert!(text(&candidate).contains("Capacity deficit: 60 min."));
    assert!(text(&candidate).contains("Unplaced minutes (H7 shortfall): 120 min."));
}

#[test]
fn deficit_and_coverage_ignore_history_minutes() {
    // N14: two hours of history fill the daily cap; the 60 minutes still
    // needed cannot be placed, and history is not credited.
    let mut task = due(sized("A", 120.0), "2026-11-09T17:00:00Z");
    task.remaining_min = Some(60.0);
    let mut input = one_day(make_input(vec![task], vec![rule(1, "00:00", "24:00")]));
    input.now = "2026-11-09T12:00:00Z".to_owned();
    input.prefs.max_daily_focus_min = 120.0;
    input.existing_blocks = Some(vec![block(
        "A",
        "2026-11-09T09:00:00Z",
        "2026-11-09T11:00:00Z",
    )]);
    let candidate = only(&input, PolicyName::FrontLoaded);
    assert_eq!(candidate.blocks, Vec::<Block>::new());
    assert!(!candidate.feasible);
    assert_eq!(candidate.deficit_min, 60.0);
    assert_eq!(candidate.metrics.deficit_min, 60.0);
    assert_eq!(candidate.metrics.p90_coverage_ratio, 0.0);
    assert!(text(&candidate).contains("Placed 0 of 60 required minutes"));
    assert!(text(&candidate).contains("Unplaced minutes (H7 shortfall): 60 min."));
    // With room in the cap the remaining hour is placed after now.
    input.prefs.max_daily_focus_min = 240.0;
    let roomy = only(&input, PolicyName::FrontLoaded);
    assert!(roomy.feasible);
    assert_eq!(roomy.blocks.len(), 1);
    assert!(roomy.blocks[0].start.as_str() >= "2026-11-09T12:00:00Z");
}

#[test]
fn uses_remaining_min_for_p90_coverage_ratio() {
    let mut task = sized("A", 240.0);
    task.estimate.p90_min = 360.0;
    task.remaining_min = Some(120.0);
    let candidate = only(
        &one_day(make_input(vec![task], vec![rule(1, "09:00", "17:00")])),
        PolicyName::FrontLoaded,
    );
    assert!(candidate.feasible);
    assert_eq!(candidate.metrics.p90_coverage_ratio, 1.0);
    assert_eq!(candidate.metrics.total_focus_min, 120.0);
}

#[test]
fn ranks_all_infeasible_attempts_by_deficit_before_retained_seeds() {
    let task = Task {
        max_session_min: 60.0,
        ..due(sized("A", 90.0), "2026-11-09T10:00:00Z")
    };
    let mut input = one_day(make_input(vec![task], vec![rule(1, "09:00", "10:00")]));
    input.existing_blocks = Some(vec![block(
        "A",
        "2026-11-09T09:00:00Z",
        "2026-11-09T09:30:00Z",
    )]);
    let mut without_seed = input.clone();
    without_seed.existing_blocks = Some(Vec::new());
    let seeded = only(&input, PolicyName::FrontLoaded);
    let fresh = only(&without_seed, PolicyName::FrontLoaded);
    assert!(!seeded.feasible && !fresh.feasible);
    assert_eq!(seeded.deficit_min, 45.0);
    assert_eq!(seeded.deficit_min, fresh.deficit_min);
    assert!(text(&seeded).contains("retaining 0 existing block(s)"));
}

#[test]
fn documents_and_versions_policy_ordering_and_slot_rules() {
    assert_eq!(POLICY_VERSION, "1.0.0");
    let rules: Vec<(&str, &str, PolicyOrdering, &str)> = PolicyName::ALL
        .iter()
        .map(|policy| {
            let profile = profile(*policy);
            (
                profile.name.as_str(),
                profile.version,
                profile.ordering,
                profile.slot_rule.as_str(),
            )
        })
        .collect();
    assert_eq!(
        rules,
        [
            (
                "front_loaded",
                "1.0.0",
                PolicyOrdering::Edf,
                "chronological-earliest"
            ),
            (
                "balanced",
                "1.0.0",
                PolicyOrdering::PriorityThenLength,
                "least-loaded-day"
            ),
            (
                "focus_blocked",
                "1.0.0",
                PolicyOrdering::LongestFirst,
                "longest-slot-then-fewest-switches"
            ),
        ]
    );
    // The version is part of every candidate's first line.
    let candidate = only(
        &make_input(vec![make_task("A")], all_week_full_day()),
        PolicyName::Balanced,
    );
    assert_eq!(
        candidate.explanation[0],
        "Policy balanced v1.0.0: Spread work evenly across days."
    );
}
