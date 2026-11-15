//! `packages/scheduler/test/explain.test.ts`: the capacity report.

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::explain::{DeficitTotal, TaskDeficit, deficit};
use ohmydate_scheduler::time::TimeError;
use ohmydate_scheduler::types::{AvailabilityRule, Block, RiskLevel, ScheduleInput, Task};
use support::{block, rule};

fn make_task(id: &str) -> Task {
    Task {
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task(id, 60.0)
    }
}

fn make_input(
    start: &str,
    end: &str,
    availability: Vec<AvailabilityRule>,
    tasks: Vec<Task>,
    locked_blocks: Vec<Block>,
) -> ScheduleInput {
    let mut input = support::input("UTC", start, end, tasks, availability);
    input.locked_blocks = locked_blocks;
    input
}

fn monday_0900_1000() -> Vec<AvailabilityRule> {
    vec![rule(1, "09:00", "10:00")]
}

fn row(task_id: &str, required: f64, available: f64, deficit: f64) -> TaskDeficit {
    TaskDeficit {
        task_id: task_id.to_owned(),
        required_min: required,
        available_before_due_min: available,
        deficit_min: deficit,
    }
}

fn total(required: f64, available: f64, deficit: f64) -> DeficitTotal {
    DeficitTotal {
        required_min: required,
        available_before_due_min: available,
        deficit_min: deficit,
    }
}

fn due(id: &str, due_at: &str) -> Task {
    Task {
        due_at: Some(due_at.to_owned()),
        ..make_task(id)
    }
}

fn after(mut task: Task, dependency: &str) -> Task {
    task.depends_on = vec![dependency.to_owned()];
    task
}

#[test]
fn credits_locked_minutes_toward_the_task_requirement() {
    let input = make_input(
        "2026-11-09T09:00:00Z",
        "2026-11-09T10:00:00Z",
        monday_0900_1000(),
        vec![due("A", "2026-11-09T10:00:00Z")],
        vec![block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z")],
    );
    let report = deficit(&input).unwrap();
    assert_eq!(report.tasks, [row("A", 60.0, 60.0, 0.0)]);
    assert_eq!(report.total, total(60.0, 60.0, 0.0));
    assert_eq!(report.risk_level, RiskLevel::P50);
}

#[test]
fn chains_dependency_readiness_from_actual_interval_consumption() {
    let input = make_input(
        "2026-11-09T00:00:00Z",
        "2026-11-09T11:00:00Z",
        monday_0900_1000(),
        vec![make_task("A"), after(due("B", "2026-11-09T10:00:00Z"), "A")],
        Vec::new(),
    );
    let report = deficit(&input).unwrap();
    assert_eq!(
        report.tasks,
        [row("A", 60.0, 60.0, 0.0), row("B", 60.0, 0.0, 60.0)]
    );
    assert_eq!(report.total, total(120.0, 60.0, 60.0));
}

#[test]
fn uses_p90_requirements_and_locked_completion_for_successors() {
    let longer = |mut task: Task| {
        task.estimate.p50_min = 30.0;
        task.estimate.p90_min = 60.0;
        task
    };
    let mut input = make_input(
        "2026-11-09T00:00:00Z",
        "2026-11-09T12:00:00Z",
        vec![rule(1, "09:00", "12:00")],
        vec![
            longer(make_task("A")),
            after(longer(due("B", "2026-11-09T09:30:00Z")), "A"),
        ],
        vec![block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z")],
    );
    input.prefs.risk_level = RiskLevel::P90;
    let report = deficit(&input).unwrap();
    assert_eq!(
        report.tasks,
        [row("A", 60.0, 180.0, 0.0), row("B", 60.0, 0.0, 60.0)]
    );
    assert_eq!(report.risk_level, RiskLevel::P90);
    // At P50 both need half of that.
    input.prefs.risk_level = RiskLevel::P50;
    assert_eq!(deficit(&input).unwrap().total.required_min, 60.0);
}

#[test]
fn blocks_successors_when_a_predecessor_cannot_finish_inside_its_window() {
    let mut short = after(due("B", "2026-11-09T10:00:00Z"), "A");
    short.estimate.p50_min = 30.0;
    short.estimate.p90_min = 30.0;
    let input = make_input(
        "2026-11-09T00:00:00Z",
        "2026-11-09T11:00:00Z",
        monday_0900_1000(),
        vec![due("A", "2026-11-09T09:30:00Z"), short],
        Vec::new(),
    );
    let report = deficit(&input).unwrap();
    assert_eq!(
        report.tasks,
        [row("A", 60.0, 30.0, 30.0), row("B", 30.0, 0.0, 30.0)]
    );
    assert_eq!(report.total, total(90.0, 30.0, 60.0));
}

// Not in the reference file.

#[test]
fn successors_are_reported_after_their_predecessors_whatever_the_input_order() {
    let input = make_input(
        "2026-11-09T00:00:00Z",
        "2026-11-09T11:00:00Z",
        monday_0900_1000(),
        vec![
            after(make_task("C"), "B"),
            after(make_task("B"), "A"),
            make_task("A"),
        ],
        Vec::new(),
    );
    let report = deficit(&input).unwrap();
    let order: Vec<&str> = report
        .tasks
        .iter()
        .map(|task| task.task_id.as_str())
        .collect();
    assert_eq!(order, ["A", "B", "C"]);
    // A takes the whole hour; B and C have nothing left.
    assert_eq!(report.total, total(180.0, 60.0, 120.0));
    assert_eq!(
        report.to_json()["tasks"][1],
        serde_json::json!({"taskId": "B", "requiredMin": 60, "availableBeforeDueMin": 0, "deficitMin": 60})
    );
}

#[test]
fn an_input_the_reference_cannot_read_is_an_error() {
    let base = || {
        make_input(
            "2026-11-09T00:00:00Z",
            "2026-11-09T11:00:00Z",
            monday_0900_1000(),
            vec![make_task("A")],
            Vec::new(),
        )
    };
    let mut bad_due = base();
    bad_due.tasks[0].due_at = Some("whenever".to_owned());
    assert_eq!(deficit(&bad_due), Err(TimeError::InvalidInstant));
    let mut bad_zone = base();
    bad_zone.time_zone = "Mars/Olympus_Mons".to_owned();
    assert_eq!(deficit(&bad_zone), Err(TimeError::UnknownTimeZone));
    let mut bad_horizon = base();
    bad_horizon.horizon.end = "later".to_owned();
    assert_eq!(deficit(&bad_horizon), Err(TimeError::InvalidInstant));
    // An unreadable locked block already fails the slot computation the
    // report starts with.
    let mut bad_lock = base();
    bad_lock.locked_blocks = vec![block("A", "soon", "2026-11-09T10:00:00Z")];
    assert_eq!(deficit(&bad_lock), Err(TimeError::InvalidInstant));
    // A backwards locked block is ignored: no time cut out, no credit.
    let mut backwards = base();
    backwards.locked_blocks = vec![block("A", "2026-11-09T10:00:00Z", "2026-11-09T09:00:00Z")];
    assert_eq!(
        deficit(&backwards).unwrap().tasks,
        [row("A", 60.0, 60.0, 0.0)]
    );
    assert_eq!(deficit(&base()).unwrap().tasks, [row("A", 60.0, 60.0, 0.0)]);
}
