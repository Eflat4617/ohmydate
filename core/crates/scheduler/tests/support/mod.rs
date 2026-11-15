//! Shared helpers of the scheduler's integration tests.

// Each test binary uses its own part of this module. The oracle layers
// print their numbers for the task report (`cargo test -- --nocapture`).
#![allow(dead_code, clippy::print_stdout)]

pub mod minute_oracle;
pub mod packs;
pub mod property;
pub mod replan;
pub mod scenarios;
pub mod templates;

use ohmydate_scheduler::types::{
    AvailabilityKind, AvailabilityRule, Block, ExceptionKind, ExceptionRule, Horizon, Preferences,
    RiskLevel, ScheduleInput, Task, TaskEstimate,
};
use ohmydate_scheduler::validate::{ValidateOptions, Violation, validate};

/// A task with the reference tests' usual defaults; adjust fields as needed.
pub fn task(id: &str, estimate_min: f64) -> Task {
    Task {
        id: id.to_owned(),
        due_at: None,
        earliest_start_at: None,
        estimate: TaskEstimate {
            p50_min: estimate_min,
            p90_min: estimate_min,
        },
        remaining_min: None,
        splittable: true,
        min_session_min: 5.0,
        max_session_min: 1440.0,
        priority: 1.0,
        depends_on: Vec::new(),
        buffer_before_due_min: None,
        preferred_windows: None,
        auto_split: None,
    }
}

pub fn rule(weekday: u8, start_local: &str, end_local: &str) -> AvailabilityRule {
    AvailabilityRule {
        weekday: f64::from(weekday),
        start_local: start_local.to_owned(),
        end_local: end_local.to_owned(),
        kind: AvailabilityKind::Work,
    }
}

/// `00:00`–`24:00` on every weekday.
pub fn all_week_full_day() -> Vec<AvailabilityRule> {
    (1..=7)
        .map(|weekday| rule(weekday, "00:00", "24:00"))
        .collect()
}

pub fn block(task_id: &str, start: &str, end: &str) -> Block {
    Block {
        task_id: task_id.to_owned(),
        start: start.to_owned(),
        end: end.to_owned(),
    }
}

pub fn prefs(max_daily_focus_min: f64, break_after_min: f64) -> Preferences {
    Preferences {
        max_daily_focus_min,
        break_after_min,
        break_min: 15.0,
        risk_level: RiskLevel::P50,
        day_start_local: "00:00".to_owned(),
        day_end_local: "24:00".to_owned(),
    }
}

/// An input with one zone, a horizon that starts at `now`, and the reference
/// tests' usual preferences (480-minute daily cap and break rule).
pub fn input(
    time_zone: &str,
    start: &str,
    end: &str,
    tasks: Vec<Task>,
    availability: Vec<AvailabilityRule>,
) -> ScheduleInput {
    ScheduleInput {
        now: start.to_owned(),
        time_zone: time_zone.to_owned(),
        horizon: Horizon {
            start: start.to_owned(),
            end: end.to_owned(),
        },
        tasks,
        availability,
        exceptions: Vec::new(),
        commitments: Vec::new(),
        locked_blocks: Vec::new(),
        existing_blocks: None,
        affected_task_ids: None,
        prefs: prefs(480.0, 480.0),
        seed: 101.0,
    }
}

pub fn exception(date: &str, kind: ExceptionKind, window: Option<(&str, &str)>) -> ExceptionRule {
    ExceptionRule {
        date: date.to_owned(),
        kind,
        start_local: window.map(|(start, _)| start.to_owned()),
        end_local: window.map(|(_, end)| end.to_owned()),
    }
}

/// `validate` at the input's risk level with the given history.
pub fn audit(input: &ScheduleInput, blocks: &[Block], history: &[Block]) -> Vec<Violation> {
    validate(
        input,
        blocks,
        &ValidateOptions {
            risk_level: input.prefs.risk_level,
            history_blocks: history,
        },
    )
    .unwrap()
}

/// The sorted violation kinds (`H1`, `H0_horizon`, …) of a plan without
/// history, as the reference tests compare them.
pub fn codes(input: &ScheduleInput, blocks: &[Block]) -> Vec<&'static str> {
    let mut codes: Vec<&'static str> = audit(input, blocks, &[])
        .iter()
        .map(|violation| violation.code.as_str())
        .collect();
    codes.sort();
    codes
}
