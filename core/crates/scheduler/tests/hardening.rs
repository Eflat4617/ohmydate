//! `packages/scheduler/test/fu39r.test.ts` and `fu43.test.ts`: input
//! hardening. Values JSON cannot carry (NaN, the infinities) and absurd
//! sizes must be rejected before generation, and a rejection must still be
//! a finite, serialisable result.

#![allow(clippy::unwrap_used)]

mod support;

use std::time::Instant;

use ohmydate_scheduler::canonical::canonical_json;
use ohmydate_scheduler::generate::{GenerateResult, PlanCandidate, generate};
use ohmydate_scheduler::types::{
    Block, Commitment, GenerateOptions, Horizon, PolicyName, ScheduleInput, Task, TaskEstimate,
};
use ohmydate_scheduler::validate::{MAX_HORIZON_DAYS, MAX_INPUT_MINUTES, validate_input};
use support::minute_oracle::instant_ms;
use support::{all_week_full_day, audit, block, rule};

/// One way to make an input, or a task, invalid.
type EditInput = fn(&mut ScheduleInput);
type EditTask = fn(&mut Task);

fn make_task(id: &str) -> Task {
    Task {
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task(id, 60.0)
    }
}

fn whole(id: &str, minutes: f64) -> Task {
    Task {
        splittable: false,
        min_session_min: minutes,
        max_session_min: minutes,
        ..support::task(id, minutes)
    }
}

fn due(mut task: Task, due_at: &str) -> Task {
    task.due_at = Some(due_at.to_owned());
    task
}

/// FU-39R's input: Monday 2026-11-09 in UTC, 09:00–17:00, one task due at
/// 14:00.
fn fu39_input() -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-09T17:00:00Z",
        vec![due(make_task("A"), "2026-11-09T14:00:00Z")],
        vec![rule(1, "09:00", "17:00")],
    );
    input.now = "2026-11-09T09:00:00Z".to_owned();
    input.seed = 39.0;
    input
}

/// FU-43's input: the same Monday, around the clock, one task.
fn fu43_input() -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-10T00:00:00Z",
        vec![make_task("A")],
        all_week_full_day(),
    );
    input.seed = 43.0;
    input
}

fn run(input: &ScheduleInput, policy: PolicyName) -> GenerateResult {
    generate(
        input,
        &GenerateOptions {
            policies: Some(vec![policy]),
            seed: Some(input.seed),
            max_local_improvement: None,
        },
    )
    .unwrap()
}

fn only(input: &ScheduleInput, policy: PolicyName) -> PlanCandidate {
    run(input, policy).candidates.remove(0)
}

fn issue_codes(input: &ScheduleInput) -> Vec<&'static str> {
    validate_input(input)
        .iter()
        .map(|issue| issue.code.as_str())
        .collect()
}

/// A rejection is infeasible, has no blocks, and every number in it is
/// finite — so its JSON holds no `null` where a number belongs.
fn assert_finite_rejection(result: &GenerateResult, name: &str) {
    let candidate = &result.candidates[0];
    assert!(!candidate.feasible, "{name}");
    assert_eq!(candidate.blocks, Vec::<Block>::new(), "{name}");
    let metrics = candidate.metrics;
    for value in [
        candidate.deficit_min,
        candidate.capacity_deficit_min,
        metrics.total_focus_min,
        metrics.min_slack_min,
        metrics.max_daily_load_min,
        metrics.avg_daily_load_min,
        metrics.context_switches,
        metrics.changed_blocks,
        metrics.deficit_min,
        metrics.capacity_deficit_min,
        metrics.p90_coverage_ratio,
    ] {
        assert!(value.is_finite(), "{name}: {value}");
    }
    let json = canonical_json(&result.to_json());
    assert!(!json.contains("null"), "{name}: {json}");
    let line = candidate.explanation.join(" ");
    assert!(
        !line.contains("Infinity") && !line.contains("NaN"),
        "{name}"
    );
}

// FU-39R M1: generator H6 with nested occupied intervals.

fn nested_history_input() -> ScheduleInput {
    let mut done = due(whole("B", 60.0), "2026-11-09T14:00:00Z");
    done.remaining_min = Some(0.0);
    let mut input = fu39_input();
    input.now = "2026-11-09T12:05:00Z".to_owned();
    input.horizon.end = "2026-11-09T14:00:00Z".to_owned();
    input.tasks = vec![due(whole("A", 30.0), "2026-11-09T14:00:00Z"), done];
    input.availability = vec![rule(1, "12:05", "13:00")];
    input.existing_blocks = Some(vec![
        block("B", "2026-11-09T09:00:00Z", "2026-11-09T12:00:00Z"),
        block("B", "2026-11-09T10:00:00Z", "2026-11-09T10:30:00Z"),
    ]);
    input.prefs.break_after_min = 120.0;
    input
}

#[test]
fn places_the_nested_history_repro_at_or_after_the_break_for_every_policy() {
    let input = nested_history_input();
    let history = input.existing().to_vec();
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(candidate.feasible, "{policy}");
        assert_eq!(candidate.blocks.len(), 1);
        // The outer history block ends at 12:00; a 15-minute break follows.
        assert!(instant_ms(&candidate.blocks[0].start) >= instant_ms("2026-11-09T12:15:00Z"));
        assert_eq!(audit(&input, &candidate.blocks, &history), Vec::new());
    }
}

#[test]
fn accepts_exactly_break_min_after_nested_history_and_rejects_a_shorter_gap() {
    let input = nested_history_input();
    let history = input.existing().to_vec();
    let at = |start: &str, end: &str| {
        audit(&input, &[block("A", start, end)], &history)
            .iter()
            .map(|violation| violation.code.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        at("2026-11-09T12:15:00Z", "2026-11-09T12:45:00Z"),
        Vec::<&str>::new()
    );
    assert!(at("2026-11-09T12:10:00Z", "2026-11-09T12:40:00Z").contains(&"H6"));
}

// FU-39R M3: bufferBeforeDueMin validation.

fn bypass_input(buffer: f64) -> ScheduleInput {
    let mut task = due(whole("A", 120.0), "2026-11-09T10:00:00Z");
    task.buffer_before_due_min = Some(buffer);
    let mut input = fu39_input();
    input.horizon.start = "2026-11-09T09:00:00Z".to_owned();
    input.tasks = vec![task];
    input
}

#[test]
fn rejects_the_deadline_bypass_repro_and_all_invalid_buffer_values() {
    for value in [
        f64::NEG_INFINITY,
        f64::NAN,
        f64::INFINITY,
        -1.0,
        1.5,
        MAX_INPUT_MINUTES + 5.0,
    ] {
        let input = bypass_input(value);
        assert!(issue_codes(&input).contains(&"invalid_estimate"), "{value}");
        assert_finite_rejection(&run(&input, PolicyName::FrontLoaded), "buffer");
    }
    // A valid buffer is accepted (the task itself still cannot fit).
    assert_eq!(issue_codes(&bypass_input(30.0)), Vec::<&str>::new());
}

// FU-39R M4 and FU-43: rejected numeric inputs produce finite JSON metrics.

#[test]
fn rejected_numeric_inputs_yield_finite_metrics() {
    let cases: [(&str, EditInput); 9] = [
        ("p50 Infinity", |input| {
            input.tasks[0].estimate.p50_min = f64::INFINITY
        }),
        ("p90 NaN", |input| {
            input.tasks[0].estimate.p90_min = f64::NAN
        }),
        ("remainingMin Infinity", |input| {
            input.tasks[0].remaining_min = Some(f64::INFINITY);
        }),
        ("minSessionMin NaN", |input| {
            input.tasks[0].min_session_min = f64::NAN
        }),
        ("maxSessionMin Infinity", |input| {
            input.tasks[0].max_session_min = f64::INFINITY;
        }),
        ("bufferBeforeDueMin -Infinity", |input| {
            input.tasks[0].buffer_before_due_min = Some(f64::NEG_INFINITY);
        }),
        ("maxDailyFocusMin Infinity", |input| {
            input.prefs.max_daily_focus_min = f64::INFINITY;
        }),
        ("breakAfterMin NaN", |input| {
            input.prefs.break_after_min = f64::NAN
        }),
        ("breakMin above cap", |input| {
            input.prefs.break_min = MAX_INPUT_MINUTES + 5.0;
        }),
    ];
    for (name, mutate) in cases {
        let mut input = fu39_input();
        mutate(&mut input);
        assert!(!validate_input(&input).is_empty(), "{name}");
        assert_finite_rejection(&run(&input, PolicyName::FrontLoaded), name);
    }
    // The untouched input is not rejected.
    assert!(only(&fu39_input(), PolicyName::FrontLoaded).feasible);
}

#[test]
fn keeps_rejection_totals_bounded_for_huge_finite_estimates() {
    let huge = |id: &str, minutes: f64| Task {
        estimate: TaskEstimate {
            p50_min: minutes,
            p90_min: minutes,
        },
        ..make_task(id)
    };
    let mut input = fu43_input();
    input.tasks = vec![huge("A", f64::MAX), huge("B", f64::MAX), huge("C", 1e308)];
    assert!(issue_codes(&input).contains(&"invalid_estimate"));
    let result = run(&input, PolicyName::FrontLoaded);
    assert_finite_rejection(&result, "huge estimates");
    // The sum saturates at the largest exact integer instead of overflowing.
    assert_eq!(result.candidates[0].deficit_min, 9_007_199_254_740_991.0);
}

#[test]
fn rejects_every_huge_p90_or_remaining_value_with_finite_metrics() {
    let cases: [(&str, EditTask); 6] = [
        ("p90 Number.MAX_VALUE", |task| {
            task.estimate.p90_min = f64::MAX
        }),
        ("p90 1e308", |task| task.estimate.p90_min = 1e308),
        ("p90 Infinity", |task| task.estimate.p90_min = f64::INFINITY),
        ("remainingMin Number.MAX_VALUE", |task| {
            task.remaining_min = Some(f64::MAX)
        }),
        ("remainingMin 1e308", |task| {
            task.remaining_min = Some(1e308)
        }),
        ("remainingMin Infinity", |task| {
            task.remaining_min = Some(f64::INFINITY)
        }),
    ];
    for (name, mutate) in cases {
        let mut input = fu43_input();
        mutate(&mut input.tasks[0]);
        assert!(issue_codes(&input).contains(&"invalid_estimate"), "{name}");
        assert_finite_rejection(&run(&input, PolicyName::Balanced), name);
    }
}

// FU-39R LOW and FU-43: absurd horizons and occupied spans.

#[test]
fn rejects_a_horizon_of_thousands_of_years_quickly() {
    let mut input = fu39_input();
    input.time_zone = "America/New_York".to_owned();
    input.horizon = Horizon {
        start: "2026-01-01T00:00:00Z".to_owned(),
        end: "9999-01-01T00:00:00Z".to_owned(),
    };
    assert!(issue_codes(&input).contains(&"invalid_input"));
    let start = Instant::now();
    let result = run(&input, PolicyName::FrontLoaded);
    assert!(start.elapsed().as_millis() < 2000);
    assert_finite_rejection(&result, "9999 horizon");
}

#[test]
fn rejects_an_occupied_block_span_above_the_supported_horizon() {
    let over = block("A", "2026-01-01T00:00:00Z", "2027-06-01T00:00:00Z");
    let mut locked = fu43_input();
    locked.locked_blocks = vec![over.clone()];
    assert!(issue_codes(&locked).contains(&"invalid_input"));
    let mut existing = fu43_input();
    existing.existing_blocks = Some(vec![over]);
    assert!(issue_codes(&existing).contains(&"invalid_input"));
    assert_eq!(issue_codes(&fu43_input()), Vec::<&str>::new());
}

#[test]
fn accepts_a_commitment_exactly_at_the_366_day_boundary() {
    let (start, end) = ("2026-01-01T00:00:00Z", "2027-01-02T00:00:00Z");
    assert_eq!(
        instant_ms(end) - instant_ms(start),
        MAX_HORIZON_DAYS * 86_400_000
    );
    let mut input = fu43_input();
    input.now = start.to_owned();
    input.horizon = Horizon {
        start: start.to_owned(),
        end: end.to_owned(),
    };
    input.tasks = vec![make_task("A")];
    input.tasks[0].estimate = TaskEstimate {
        p50_min: 0.0,
        p90_min: 0.0,
    };
    input.commitments = vec![Commitment {
        start: start.to_owned(),
        end: end.to_owned(),
    }];
    assert!(!issue_codes(&input).contains(&"invalid_input"));
    assert!(only(&input, PolicyName::FrontLoaded).feasible);
    // One day more is over the cap.
    input.horizon.end = "2027-01-03T00:00:00Z".to_owned();
    assert!(issue_codes(&input).contains(&"invalid_input"));
}

#[test]
fn long_commitments_cost_only_their_part_inside_the_horizon() {
    let commitment = |start: &str, end: &str| Commitment {
        start: start.to_owned(),
        end: end.to_owned(),
    };
    // Entirely outside the horizon: ignored.
    let mut outside = fu43_input();
    outside.commitments = vec![
        commitment("2025-01-01T00:00:00Z", "2026-06-01T00:00:00Z"),
        commitment("2027-01-01T00:00:00Z", "2028-06-01T00:00:00Z"),
    ];
    assert!(!issue_codes(&outside).contains(&"invalid_input"));
    assert!(only(&outside, PolicyName::FrontLoaded).feasible);
    // Partially overlapping: clipped to the first hour of the horizon.
    let mut clipped = fu43_input();
    clipped.commitments = vec![commitment("2025-01-01T00:00:00Z", "2026-11-09T01:00:00Z")];
    assert!(!issue_codes(&clipped).contains(&"invalid_input"));
    let candidate = only(&clipped, PolicyName::FrontLoaded);
    assert!(candidate.feasible);
    assert!(instant_ms(&candidate.blocks[0].start) >= instant_ms("2026-11-09T01:00:00Z"));
}

// FU-43: nested history joins an audited block across midnight and DST.

fn long_task_input(time_zone: &str, start: &str, end: &str, minutes: f64) -> ScheduleInput {
    let mut input = fu43_input();
    input.time_zone = time_zone.to_owned();
    input.horizon = Horizon {
        start: start.to_owned(),
        end: end.to_owned(),
    };
    input.tasks = vec![Task {
        max_session_min: 300.0,
        ..make_task("A")
    }];
    input.tasks[0].estimate = TaskEstimate {
        p50_min: minutes,
        p90_min: minutes,
    };
    input.prefs.break_after_min = 240.0;
    input
}

#[test]
fn raises_h6_when_nested_history_across_local_midnight_joins_an_audited_block() {
    let input = long_task_input("UTC", "2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z", 230.0);
    let history = [
        block("H1", "2026-11-09T23:00:00Z", "2026-11-10T01:00:00Z"),
        block("H2", "2026-11-09T23:30:00Z", "2026-11-10T00:30:00Z"),
    ];
    let plan = [block("A", "2026-11-10T01:10:00Z", "2026-11-10T05:00:00Z")];
    let kinds = |history: &[Block]| {
        audit(&input, &plan, history)
            .iter()
            .map(|violation| violation.code.as_str())
            .collect::<Vec<_>>()
    };
    assert!(kinds(&history).contains(&"H6"));
    // Without the history the same block is within the break rule.
    assert!(!kinds(&[]).contains(&"H6"));
}

#[test]
fn raises_h6_when_nested_history_across_the_lord_howe_fold_joins_an_audited_block() {
    let input = long_task_input(
        "Australia/Lord_Howe",
        "2026-04-04T12:00:00Z",
        "2026-04-04T20:00:00Z",
        170.0,
    );
    let history = [
        block("H1", "2026-04-04T13:00:00Z", "2026-04-04T16:00:00Z"),
        block("H2", "2026-04-04T13:30:00Z", "2026-04-04T14:30:00Z"),
    ];
    let plan = [block("A", "2026-04-04T16:10:00Z", "2026-04-04T19:00:00Z")];
    assert!(
        audit(&input, &plan, &history)
            .iter()
            .any(|violation| violation.code.as_str() == "H6")
    );
}
