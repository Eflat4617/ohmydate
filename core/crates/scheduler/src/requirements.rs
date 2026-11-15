//! Required minutes of a task: a port of
//! `packages/scheduler/src/requirements.ts`.

use crate::js;
use crate::types::{RiskLevel, Task};

/// Minutes a task still needs at the selected risk level
/// (`taskRequiredMinutes`).
///
/// `remaining_min`, when a replanning caller supplies it, is authoritative
/// and means the minutes still needed going forward; past or in-progress
/// history blocks are not subtracted from it (06 §7.1). A block that starts
/// before `now` counts entirely as history, so callers compute
/// `remaining_min = required - history minutes`. Without `remaining_min` the
/// full P50/P90 estimate is scheduled again.
#[must_use]
pub fn task_required_minutes(task: &Task, risk_level: RiskLevel) -> f64 {
    if let Some(remaining_min) = task.remaining_min {
        return js::max(0.0, remaining_min);
    }
    js::max(
        0.0,
        match risk_level {
            RiskLevel::P90 => task.estimate.p90_min,
            RiskLevel::P50 => task.estimate.p50_min,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TaskEstimate;

    fn task(p50_min: f64, p90_min: f64, remaining_min: Option<f64>) -> Task {
        Task {
            id: "A".to_owned(),
            due_at: None,
            earliest_start_at: None,
            estimate: TaskEstimate { p50_min, p90_min },
            remaining_min,
            splittable: true,
            min_session_min: 30.0,
            max_session_min: 90.0,
            priority: 2.0,
            depends_on: Vec::new(),
            buffer_before_due_min: None,
            preferred_windows: None,
            auto_split: None,
        }
    }

    #[test]
    fn the_risk_level_selects_the_estimate() {
        let task = task(60.0, 90.0, None);
        assert_eq!(task_required_minutes(&task, RiskLevel::P50), 60.0);
        assert_eq!(task_required_minutes(&task, RiskLevel::P90), 90.0);
    }

    #[test]
    fn remaining_minutes_override_both_estimates() {
        let task = task(60.0, 90.0, Some(25.0));
        assert_eq!(task_required_minutes(&task, RiskLevel::P50), 25.0);
        assert_eq!(task_required_minutes(&task, RiskLevel::P90), 25.0);
        let done = self::task(60.0, 90.0, Some(0.0));
        assert_eq!(task_required_minutes(&done, RiskLevel::P90), 0.0);
    }

    #[test]
    fn negative_values_count_as_zero_and_nan_stays_nan() {
        assert_eq!(
            task_required_minutes(&task(-5.0, -1.0, None), RiskLevel::P50),
            0.0
        );
        assert_eq!(
            task_required_minutes(&task(60.0, 90.0, Some(-10.0)), RiskLevel::P90),
            0.0
        );
        // `Math.max(0, NaN)` is NaN; the input validator rejects such tasks.
        assert!(task_required_minutes(&task(f64::NAN, 90.0, None), RiskLevel::P50).is_nan());
        assert_eq!(
            task_required_minutes(&task(60.0, f64::INFINITY, None), RiskLevel::P90),
            f64::INFINITY
        );
    }
}
