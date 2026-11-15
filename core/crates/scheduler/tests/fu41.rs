//! `packages/scheduler/test/fu41.test.ts`: a replan keeps the blocks of
//! tasks the change does not reach, and changes at most
//! `2 × affected existing blocks + 2` blocks (06 §7) — or says that it could
//! not.

#![allow(clippy::unwrap_used)]

mod support;

use std::cell::Cell;
use std::collections::BTreeSet;

use jiff::Timestamp;
use ohmydate_scheduler::types::{Block, PolicyName, ScheduleInput, Task};
use ohmydate_scheduler::validate::validate_input;
use proptest::prelude::*;
use proptest::test_runner::TestRunner;
use support::minute_oracle::instant_ms;
use support::replan::{
    affected_tasks, commitment, expanded_scope, explains, hit_tasks, ids, plan, replanned, run,
    symmetric_difference, task_blocks,
};
use support::{block, property, rule};

const STEP_MS: i64 = 5 * 60 * 1000;

#[allow(clippy::cast_precision_loss)]
fn number(value: i64) -> f64 {
    value as f64
}

fn count(value: usize) -> f64 {
    number(i64::try_from(value).unwrap())
}

/// A splittable task that may run anywhere in `[start, end)`.
fn task(id: &str, minutes: i64, max_session_min: i64, priority: i64, window: (&str, &str)) -> Task {
    Task {
        due_at: Some(window.1.to_owned()),
        earliest_start_at: Some(window.0.to_owned()),
        min_session_min: 30.0,
        max_session_min: number(max_session_min),
        priority: number(priority),
        ..support::task(id, number(minutes))
    }
}

fn after(mut task: Task, dependency: &str) -> Task {
    task.depends_on = vec![dependency.to_owned()];
    task
}

const THREE_DAYS: (&str, &str) = ("2026-11-09T00:00:00Z", "2026-11-12T00:00:00Z");

fn lord_howe_tasks() -> Vec<Task> {
    vec![
        task("T0", 155, 60, 2, THREE_DAYS),
        after(task("T1", 165, 60, 1, THREE_DAYS), "T0"),
        task("T2", 55, 60, 2, THREE_DAYS),
        task("T3", 40, 40, 2, THREE_DAYS),
        task("T4", 40, 90, 4, THREE_DAYS),
        task("T5", 55, 55, 4, THREE_DAYS),
    ]
}

/// Six tasks over three working days in Australia/Lord_Howe (UTC+11 in
/// November), three hours of focus a day.
fn lord_howe_input() -> ScheduleInput {
    let mut input = support::input(
        "Australia/Lord_Howe",
        THREE_DAYS.0,
        THREE_DAYS.1,
        lord_howe_tasks(),
        (1..=5)
            .map(|weekday| rule(weekday, "08:00", "18:00"))
            .collect(),
    );
    input.prefs = support::prefs(180.0, 240.0);
    input.seed = 5037.0;
    input
}

struct DependencyChange {
    time_zone: &'static str,
    horizon: (&'static str, &'static str),
    window: (&'static str, &'static str),
    durations: &'static [i64],
}

const BERLIN_DEPENDENCY_CHANGE: DependencyChange = DependencyChange {
    time_zone: "Europe/Berlin",
    horizon: ("2026-10-25T00:00:00Z", "2026-10-27T00:00:00Z"),
    window: ("00:00", "24:00"),
    durations: &[30, 35],
};

const SEOUL_DEPENDENCY_CHANGE: DependencyChange = DependencyChange {
    time_zone: "Asia/Seoul",
    horizon: ("2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z"),
    window: ("08:00", "18:00"),
    durations: &[30, 35, 35],
};

fn dependency_change_input(fixture: &DependencyChange, dependency: bool) -> ScheduleInput {
    let tasks = fixture
        .durations
        .iter()
        .enumerate()
        .map(|(index, minutes)| {
            let task = task(&format!("T{index}"), *minutes, 60, 1, fixture.horizon);
            if dependency && index == 1 {
                after(task, "T0")
            } else {
                task
            }
        })
        .collect();
    let mut input = support::input(
        fixture.time_zone,
        fixture.horizon.0,
        fixture.horizon.1,
        tasks,
        (1..=7)
            .map(|weekday| rule(weekday, fixture.window.0, fixture.window.1))
            .collect(),
    );
    input.seed = 0.0;
    input
}

/// T1 comes to depend on T0 after a plan was approved: both ends of the new
/// edge are released, and the replan orders them within the change bound.
fn assert_dependency_change_replan(fixture: &DependencyChange) {
    let base = plan(
        &dependency_change_input(fixture, false),
        PolicyName::Balanced,
        0.0,
    );
    assert!(base.feasible);
    let existing = base.blocks;
    assert!(existing.len() >= fixture.durations.len());

    let input = replanned(&dependency_change_input(fixture, true), &existing);
    let candidate = plan(&input, PolicyName::Balanced, 0.0);
    assert!(candidate.feasible);
    assert_eq!(candidate.deficit_min, 0.0);
    let affected_existing = existing
        .iter()
        .filter(|block| block.task_id == "T0" || block.task_id == "T1")
        .count();
    assert_eq!(affected_existing, 2);
    assert_eq!(
        candidate.metrics.changed_blocks,
        count(symmetric_difference(&existing, &candidate.blocks))
    );
    assert!(candidate.metrics.changed_blocks <= count(affected_existing * 2 + 2));
    let of = |id: &str| -> Vec<&Block> {
        candidate
            .blocks
            .iter()
            .filter(|block| block.task_id == id)
            .collect()
    };
    let (t0, t1) = (of("T0"), of("T1"));
    assert!(!t0.is_empty() && !t1.is_empty());
    for successor in &t1 {
        for dependency in &t0 {
            assert!(instant_ms(&successor.start) >= instant_ms(&dependency.end));
        }
    }
}

#[test]
fn releases_both_endpoints_of_an_added_dependency_edge_in_berlin() {
    assert_dependency_change_replan(&BERLIN_DEPENDENCY_CHANGE);
}

#[test]
fn restores_dependency_change_feasibility_for_the_seoul_three_task_case() {
    assert_dependency_change_replan(&SEOUL_DEPENDENCY_CHANGE);
}

/// The approved Lord_Howe plan and a 15-minute commitment that lands on a
/// block of T0.
fn lord_howe_conflict() -> (ScheduleInput, Vec<Block>, BTreeSet<String>) {
    let base = lord_howe_input();
    let approved = plan(&base, PolicyName::FocusBlocked, 5037.0);
    assert!(approved.feasible);
    let existing = approved.blocks;
    assert!(existing.len() >= 6);
    let conflict = commitment("2026-11-09T23:00:00Z", "2026-11-09T23:15:00Z");
    let hit = hit_tasks(&existing, &conflict);
    assert_eq!(hit, ids(&["T0"]));
    let affected = affected_tasks(&base.tasks, &hit);
    assert_eq!(affected, ids(&["T0", "T1"]));
    let mut input = replanned(&base, &existing);
    input.commitments = vec![conflict];
    (input, existing, affected)
}

#[test]
fn preserves_unaffected_blocks_and_meets_the_bound_in_the_lord_howe_six_task_repro() {
    let (input, existing, affected) = lord_howe_conflict();
    let candidate = plan(&input, PolicyName::FocusBlocked, 5037.0);
    for task in &input.tasks {
        if !affected.contains(&task.id) {
            assert_eq!(
                task_blocks(&candidate.blocks, &task.id),
                task_blocks(&existing, &task.id),
                "{}",
                task.id
            );
        }
    }
    let affected_existing = existing
        .iter()
        .filter(|block| affected.contains(&block.task_id))
        .count();
    assert_eq!(
        count(symmetric_difference(&existing, &candidate.blocks)),
        candidate.metrics.changed_blocks
    );
    assert!(candidate.metrics.changed_blocks <= count(affected_existing * 2 + 2));
    // An infeasible remainder would have to be explained as H7.
    assert!(candidate.feasible || explains(&candidate, "H7"));
}

#[test]
fn flags_a_candidate_that_cannot_meet_the_change_bound_instead_of_silently_exceeding_it() {
    let mut input = lord_howe_input();
    input.tasks.push(task("T6", 150, 30, 1, THREE_DAYS));
    // T6's only block is outside working hours: it has to be split into five
    // new sessions, more than the bound of 2 × 1 + 2 allows.
    let input = replanned(
        &input,
        &[block("T6", "2026-11-09T00:00:00Z", "2026-11-09T02:00:00Z")],
    );
    let result = run(
        &input,
        &support::replan::options(PolicyName::FrontLoaded, 5037.0),
    );
    let candidate = &result.candidates[0];
    assert!(candidate.metrics.changed_blocks > 4.0);
    assert!(
        candidate
            .explanation
            .iter()
            .any(|line| line.starts_with("Replan change bound exceeded:"))
    );
    assert!(
        result
            .diversity_note
            .as_deref()
            .unwrap()
            .contains("Replan change bound exceeded:")
    );
    // Within the bound nothing is flagged.
    let (within, _, _) = lord_howe_conflict();
    let quiet = run(
        &within,
        &support::replan::options(PolicyName::FocusBlocked, 5037.0),
    );
    assert!(!explains(
        &quiet.candidates[0],
        "Replan change bound exceeded:"
    ));
}

#[test]
fn returns_an_explained_infeasible_candidate_when_frozen_blocks_leave_no_room() {
    let morning = ("2026-11-09T09:00:00Z", "2026-11-09T12:00:00Z");
    let existing = [
        block("A", "2026-11-09T09:00:00Z", "2026-11-09T11:00:00Z"),
        block("P", "2026-11-09T10:30:00Z", "2026-11-09T11:00:00Z"),
        block("B", "2026-11-09T11:30:00Z", "2026-11-09T12:00:00Z"),
    ];
    let mut whole = after(task("A", 120, 120, 1, morning), "P");
    whole.splittable = false;
    whole.min_session_min = 120.0;
    let mut input = support::input(
        "UTC",
        morning.0,
        morning.1,
        vec![
            task("P", 30, 30, 1, morning),
            whole,
            task("B", 30, 30, 2, morning),
        ],
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", "12:00"))
            .collect(),
    );
    input.commitments = vec![commitment("2026-11-09T09:00:00Z", "2026-11-09T10:30:00Z")];
    input.seed = 41.0;
    let candidate = plan(&replanned(&input, &existing), PolicyName::Balanced, 41.0);
    assert!(!candidate.feasible);
    assert!(candidate.deficit_min > 0.0);
    assert!(explains(&candidate, "H7"));
    assert_eq!(
        task_blocks(&candidate.blocks, "B"),
        task_blocks(&existing, "B")
    );
}

// The preservation property over random commitment conflicts.

const ODD_OFFSET_ZONES: &[&str] = &[
    "Asia/Kathmandu",
    "Australia/Lord_Howe",
    "Pacific/Chatham",
    "Pacific/Marquesas",
    "America/St_Johns",
    "Asia/Kolkata",
];

const WINDOWS: &[(&str, &str)] = &[("00:00", "24:00"), ("08:00", "18:00"), ("09:00", "17:00")];

#[derive(Debug, Clone)]
struct TaskSpec {
    duration_units: i64,
    max_units: i64,
    priority: i64,
    dependency: bool,
}

#[derive(Debug, Clone)]
struct ReplanSpec {
    time_zone: &'static str,
    window: (&'static str, &'static str),
    tasks: Vec<TaskSpec>,
    policy: PolicyName,
    seed: i64,
    block_index: usize,
    offset_units: i64,
    commitment_units: i64,
}

fn task_spec(
    duration_units: impl Strategy<Value = i64>,
    max_units: impl Strategy<Value = i64>,
) -> impl Strategy<Value = TaskSpec> {
    (duration_units, max_units, 1_i64..=4, any::<bool>()).prop_map(
        |(duration_units, max_units, priority, dependency)| TaskSpec {
            duration_units,
            max_units,
            priority,
            dependency,
        },
    )
}

fn replan_spec(tasks: impl Strategy<Value = Vec<TaskSpec>>) -> impl Strategy<Value = ReplanSpec> {
    (
        proptest::sample::select(ODD_OFFSET_ZONES),
        proptest::sample::select(WINDOWS),
        tasks,
        proptest::sample::select(PolicyName::ALL),
        0_i64..=100_000,
        0_usize..=99,
        0_i64..=10,
        proptest::sample::select(&[3_i64, 6, 9, 12][..]),
    )
        .prop_map(
            |(
                time_zone,
                window,
                tasks,
                policy,
                seed,
                block_index,
                offset_units,
                commitment_units,
            )| ReplanSpec {
                time_zone,
                window,
                tasks,
                policy,
                seed,
                block_index,
                offset_units,
                commitment_units,
            },
        )
}

/// Tasks of 30–90 minutes whose sessions may be as long as the task.
fn any_tasks() -> impl Strategy<Value = Vec<TaskSpec>> {
    proptest::collection::vec(
        task_spec(
            6_i64..=18,
            proptest::sample::select(&[12_i64, 18, 24, 36][..]),
        ),
        2..=5,
    )
}

/// Only shapes a session split can satisfy, each needing several sessions:
/// 30-minute sessions for 60 or 90 minutes, 45-minute sessions for 60–90.
fn multi_session_tasks() -> impl Strategy<Value = Vec<TaskSpec>> {
    proptest::collection::vec(
        prop_oneof![
            task_spec(proptest::sample::select(&[12_i64, 18][..]), Just(6_i64)),
            task_spec(12_i64..=18, Just(9_i64)),
        ],
        2..=4,
    )
}

fn replan_input(spec: &ReplanSpec, forced_split: bool) -> ScheduleInput {
    let tasks = spec
        .tasks
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let minutes = entry.duration_units * 5;
            let max_session_min = if forced_split {
                entry.max_units * 5
            } else {
                entry.duration_units.max(entry.max_units) * 5
            };
            let mut task = task(
                &format!("T{index}"),
                minutes,
                max_session_min,
                entry.priority,
                THREE_DAYS,
            );
            task.min_session_min = number(minutes.min(30));
            if entry.dependency && index > 0 {
                task.depends_on = vec![format!("T{}", index - 1)];
            }
            task
        })
        .collect();
    let mut input = support::input(
        spec.time_zone,
        THREE_DAYS.0,
        THREE_DAYS.1,
        tasks,
        (1..=7)
            .map(|weekday| rule(weekday, spec.window.0, spec.window.1))
            .collect(),
    );
    input.seed = number(spec.seed);
    input
}

fn instant_iso(epoch_ms: i64) -> String {
    Timestamp::from_millisecond(epoch_ms).unwrap().to_string()
}

/// Plans `base`, drops a commitment on one of its blocks and replans. The
/// tasks outside the largest scope the change can reach keep their blocks,
/// `changedBlocks` is the real difference, and it is within the bound.
fn check_commitment_replan(
    spec: &ReplanSpec,
    base: &ScheduleInput,
    min_blocks: usize,
) -> Result<(), TestCaseError> {
    let seed = number(spec.seed);
    let approved = plan(base, spec.policy, seed);
    if !approved.feasible || approved.blocks.len() < min_blocks.max(1) {
        return Err(TestCaseError::reject("no plan to replan"));
    }
    let existing = approved.blocks;
    let pivot = &existing[spec.block_index % existing.len()];
    let (pivot_start, pivot_end) = (instant_ms(&pivot.start), instant_ms(&pivot.end));
    let max_offset_units = ((pivot_end - pivot_start) / STEP_MS).max(0);
    let offset_units = spec.offset_units.min((max_offset_units - 1).max(0));
    let start_ms = pivot_start + offset_units * STEP_MS;
    let end_ms = (start_ms + spec.commitment_units * STEP_MS).min(instant_ms(&base.horizon.end));
    let conflict = commitment(&instant_iso(start_ms), &instant_iso(end_ms));
    let hit = hit_tasks(&existing, &conflict);
    if hit.is_empty() {
        return Err(TestCaseError::reject("the commitment hits no block"));
    }
    let affected = expanded_scope(&base.tasks, &affected_tasks(&base.tasks, &hit));
    let affected_existing = existing
        .iter()
        .filter(|block| affected.contains(&block.task_id))
        .count();

    let mut input = replanned(base, &existing);
    input.commitments = vec![conflict];
    let candidate = plan(&input, spec.policy, seed);
    for task in &base.tasks {
        if !affected.contains(&task.id) {
            prop_assert_eq!(
                task_blocks(&candidate.blocks, &task.id),
                task_blocks(&existing, &task.id)
            );
        }
    }
    prop_assert_eq!(
        count(symmetric_difference(&existing, &candidate.blocks)),
        candidate.metrics.changed_blocks
    );
    prop_assert!(candidate.metrics.changed_blocks <= count(affected_existing * 2 + 2));
    Ok(())
}

fn run_replan_property(tasks: impl Strategy<Value = Vec<TaskSpec>>, forced_split: bool) {
    let runs = property::runs();
    let comparisons = Cell::new(0_u32);
    let mut runner = TestRunner::new(property::config());
    runner
        .run(&replan_spec(tasks), |spec| {
            let base = replan_input(&spec, forced_split);
            let min_blocks = if forced_split {
                base.tasks.len() * 2
            } else {
                1
            };
            check_commitment_replan(&spec, &base, min_blocks)?;
            comparisons.set(comparisons.get() + 1);
            Ok(())
        })
        .unwrap();
    // Skipped inputs do not count as runs: every run compared a replan.
    assert!(comparisons.get() >= runs, "{} of {runs}", comparisons.get());
}

#[test]
fn only_randomizes_over_valid_iana_zones() {
    let spec = |time_zone: &'static str, tasks: Vec<TaskSpec>| ReplanSpec {
        time_zone,
        window: ("09:00", "17:00"),
        tasks,
        policy: PolicyName::Balanced,
        seed: 1,
        block_index: 0,
        offset_units: 0,
        commitment_units: 3,
    };
    let one = |dependency: bool| TaskSpec {
        duration_units: 6,
        max_units: 12,
        priority: 2,
        dependency,
    };
    for time_zone in ODD_OFFSET_ZONES {
        let input = replan_input(&spec(time_zone, vec![one(false), one(true)]), false);
        assert_eq!(validate_input(&input), Vec::new(), "{time_zone}");
    }
    // FU-59: a zone that does not exist was once skipped without notice.
    let input = replan_input(&spec("Australia/Chatham", vec![one(false)]), false);
    assert!(
        validate_input(&input)
            .iter()
            .any(|issue| issue.code.as_str() == "invalid_timezone")
    );
}

#[test]
fn preserves_unaffected_blocks_and_the_change_bound_over_random_commitment_conflicts() {
    run_replan_property(any_tasks(), false);
}

#[test]
fn preserves_unaffected_blocks_and_the_bound_when_every_task_needs_several_sessions() {
    run_replan_property(multi_session_tasks(), true);
}
