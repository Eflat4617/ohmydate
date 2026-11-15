//! Shared helpers of the scheduler's integration tests.

// Each test binary uses its own part of this module. The oracle layers
// print their numbers for the task report (`cargo test -- --nocapture`).
#![allow(dead_code, clippy::print_stdout)]

pub mod minute_oracle;
pub mod packs;

use ohmydate_scheduler::types::{
    AvailabilityKind, AvailabilityRule, Block, Preferences, RiskLevel, Task, TaskEstimate,
};

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
