//! Task order and session sizes of the greedy pass (`orderTasks`,
//! `compareTasks`, `buildChunks`).

use std::cmp::Ordering;

use super::context::{Context, GRID_MINUTES_F, TaskInfo};
use crate::codes::GeneratorExplanationCode;
use crate::js;
use crate::policies::{PolicyOrdering, profile};
use crate::types::{PolicyName, Task};

/// Why the heuristic could not place a task as asked. Each has its own
/// `heuristic_*` explanation code. The order is the alphabetical order of
/// the reference's reason names, in which the lines are written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum HeuristicReason {
    BlockedByPredecessor,
    EstimateBelowGrid,
    EstimateNotGridAligned,
    InsufficientAvailableTime,
    NoContiguousWindow,
    SessionBoundsInfeasible,
}

impl HeuristicReason {
    pub const ALL: [Self; 6] = [
        Self::BlockedByPredecessor,
        Self::EstimateBelowGrid,
        Self::EstimateNotGridAligned,
        Self::InsufficientAvailableTime,
        Self::NoContiguousWindow,
        Self::SessionBoundsInfeasible,
    ];

    /// The reference's name of the reason.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BlockedByPredecessor => "blocked_by_predecessor",
            Self::EstimateBelowGrid => "estimate_below_grid",
            Self::EstimateNotGridAligned => "estimate_not_grid_aligned",
            Self::InsufficientAvailableTime => "insufficient_available_time",
            Self::NoContiguousWindow => "no_contiguous_window",
            Self::SessionBoundsInfeasible => "session_bounds_infeasible",
        }
    }

    pub const fn code(self) -> GeneratorExplanationCode {
        match self {
            Self::BlockedByPredecessor => GeneratorExplanationCode::HeuristicBlockedByPredecessor,
            Self::EstimateBelowGrid => GeneratorExplanationCode::HeuristicEstimateBelowGrid,
            Self::EstimateNotGridAligned => {
                GeneratorExplanationCode::HeuristicEstimateNotGridAligned
            }
            Self::InsufficientAvailableTime => {
                GeneratorExplanationCode::HeuristicInsufficientAvailableTime
            }
            Self::NoContiguousWindow => GeneratorExplanationCode::HeuristicNoContiguousWindow,
            Self::SessionBoundsInfeasible => {
                GeneratorExplanationCode::HeuristicSessionBoundsInfeasible
            }
        }
    }
}

/// A set of heuristic reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) struct Reasons(u8);

impl Reasons {
    pub fn add(&mut self, reason: HeuristicReason) {
        self.0 |= 1 << reason as u8;
    }

    /// The reasons in the order their lines are written.
    pub fn sorted(self) -> impl Iterator<Item = HeuristicReason> {
        HeuristicReason::ALL
            .into_iter()
            .filter(move |reason| self.0 & (1 << *reason as u8) != 0)
    }
}

/// The session lengths (minutes) to place for a task, and why they are not
/// simply the remaining minutes when they are not.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ChunkSpec {
    pub chunks: Vec<f64>,
    pub reason: Option<HeuristicReason>,
}

/// Splits the remaining minutes into equal-sized sessions inside the task's
/// bounds (`buildChunks`).
pub(super) fn build_chunks(task: &Task, remaining_min: f64) -> ChunkSpec {
    if remaining_min <= 0.0 {
        return ChunkSpec {
            chunks: Vec::new(),
            reason: None,
        };
    }
    let required_units = (remaining_min / 5.0).floor();
    let reason = (remaining_min % 5.0 != 0.0).then_some(HeuristicReason::EstimateNotGridAligned);
    if required_units <= 0.0 {
        return ChunkSpec {
            chunks: Vec::new(),
            reason: Some(reason.unwrap_or(HeuristicReason::EstimateBelowGrid)),
        };
    }
    if !task.splittable {
        return ChunkSpec {
            chunks: vec![required_units * 5.0],
            reason,
        };
    }

    let min_units = js::max(1.0, (task.min_session_min / 5.0).ceil());
    let max_units = js::max(min_units, (task.max_session_min / 5.0).floor());
    let count = js::max(1.0, (required_units / max_units).ceil());
    if count * min_units > required_units {
        return ChunkSpec {
            chunks: vec![required_units * 5.0],
            reason: Some(reason.unwrap_or(HeuristicReason::SessionBoundsInfeasible)),
        };
    }

    let base = (required_units / count).floor();
    let remainder = required_units % count;
    let mut chunks = Vec::new();
    let mut index = 0.0;
    while index < count {
        let units = base + if index < remainder { 1.0 } else { 0.0 };
        chunks.push(units * 5.0);
        index += 1.0;
    }
    ChunkSpec { chunks, reason }
}

/// Session bounds of a splittable task in grid cells.
#[derive(Debug, Clone, Copy)]
pub(super) struct SessionBounds {
    pub min_units: f64,
    pub max_units: f64,
}

impl SessionBounds {
    pub fn of(task: &Task) -> Self {
        Self {
            min_units: js::max(1.0, (task.min_session_min / GRID_MINUTES_F).ceil()),
            max_units: (task.max_session_min / GRID_MINUTES_F).floor(),
        }
    }

    /// True when `units` grid cells can be covered by whole sessions inside
    /// the bounds; zero cells need no session (`isRepresentable`).
    pub fn is_representable(&self, units: f64) -> bool {
        if units == 0.0 {
            return true;
        }
        if units < self.min_units {
            return false;
        }
        (units / self.max_units).ceil() * self.min_units <= units
    }
}

/// The first key that decides: JavaScript's `a || b || c` on comparator
/// values, where 0 and NaN (∞ − ∞ of two tasks without a deadline) fall
/// through to the next key.
fn first_decisive(keys: [f64; 3], otherwise: Ordering) -> Ordering {
    for key in keys {
        if key < 0.0 {
            return Ordering::Less;
        }
        if key > 0.0 {
            return Ordering::Greater;
        }
    }
    otherwise
}

fn compare_tasks(context: &Context<'_>, a: usize, b: usize, ordering: PolicyOrdering) -> Ordering {
    let (first, second) = (&context.tasks[a], &context.tasks[b]);
    let due = |info: &TaskInfo<'_>| info.due_ms.unwrap_or(f64::INFINITY);
    let by_due = due(first) - due(second);
    let by_priority = first.task.priority - second.task.priority;
    let by_length = second.required_min - first.required_min;
    let by_id = context.compare_task_ids(a, b);
    match ordering {
        PolicyOrdering::Edf => first_decisive([by_due, by_priority, 0.0], by_id),
        PolicyOrdering::PriorityThenLength => {
            first_decisive([by_priority, by_length, by_due], by_id)
        }
        PolicyOrdering::LongestFirst => first_decisive([by_length, by_priority, by_due], by_id),
    }
}

/// Task indices in placement order: a topological order in which, among
/// the tasks whose dependencies are all placed, the policy's ordering picks
/// the next (`orderTasks`).
pub(super) fn order_tasks(context: &Context<'_>, policy: PolicyName) -> Vec<usize> {
    let ordering = profile(policy).ordering;
    let count = context.tasks.len();
    let mut indegree: Vec<usize> = context
        .tasks
        .iter()
        .map(|info| info.depends_on.len())
        .collect();
    let mut ready: Vec<usize> = (0..count).filter(|index| indegree[*index] == 0).collect();
    let mut seen = vec![false; count];
    let mut ordered = Vec::with_capacity(count);
    while !ready.is_empty() {
        ready.sort_by(|a, b| compare_tasks(context, *a, *b, ordering));
        let task = ready.remove(0);
        if seen[task] {
            continue;
        }
        seen[task] = true;
        ordered.push(task);
        for &dependent in &context.tasks[task].dependents {
            indegree[dependent] = indegree[dependent].wrapping_sub(1);
            if indegree[dependent] == 0 {
                ready.push(dependent);
            }
        }
    }
    for (index, placed) in seen.iter().enumerate() {
        if !placed {
            ordered.push(index);
        }
    }
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TaskEstimate;

    fn task(splittable: bool, min_session_min: f64, max_session_min: f64) -> Task {
        Task {
            id: "A".to_owned(),
            due_at: None,
            earliest_start_at: None,
            estimate: TaskEstimate {
                p50_min: 60.0,
                p90_min: 60.0,
            },
            remaining_min: None,
            splittable,
            min_session_min,
            max_session_min,
            priority: 1.0,
            depends_on: Vec::new(),
            buffer_before_due_min: None,
            preferred_windows: None,
            auto_split: None,
        }
    }

    fn chunks(task: &Task, remaining_min: f64) -> (Vec<f64>, Option<HeuristicReason>) {
        let spec = build_chunks(task, remaining_min);
        (spec.chunks, spec.reason)
    }

    #[test]
    fn a_splittable_task_gets_equal_sessions_with_the_remainder_first() {
        let splittable = task(true, 30.0, 90.0);
        assert_eq!(chunks(&splittable, 60.0), (vec![60.0], None));
        assert_eq!(chunks(&splittable, 180.0), (vec![90.0, 90.0], None));
        assert_eq!(chunks(&splittable, 200.0), (vec![70.0, 65.0, 65.0], None));
        assert_eq!(chunks(&splittable, 0.0), (Vec::new(), None));
        assert_eq!(chunks(&splittable, -5.0), (Vec::new(), None));
    }

    #[test]
    fn a_task_that_must_be_one_block_gets_one_session() {
        let whole = task(false, 30.0, 90.0);
        assert_eq!(chunks(&whole, 240.0), (vec![240.0], None));
    }

    #[test]
    fn what_cannot_be_placed_as_asked_is_given_a_reason() {
        let splittable = task(true, 30.0, 90.0);
        // Off the grid: rounded down, and said so.
        assert_eq!(
            chunks(&splittable, 62.0),
            (vec![60.0], Some(HeuristicReason::EstimateNotGridAligned))
        );
        // Below one cell: nothing to place. Such an amount is never on the
        // grid, so the "below grid" reason cannot be the one reported.
        assert_eq!(
            chunks(&splittable, 3.0),
            (Vec::new(), Some(HeuristicReason::EstimateNotGridAligned))
        );
        // 50 minutes in sessions of 30–40: one is too long, two too short.
        let narrow = task(true, 30.0, 40.0);
        assert_eq!(
            chunks(&narrow, 50.0),
            (vec![50.0], Some(HeuristicReason::SessionBoundsInfeasible))
        );
        // Shorter than the minimum session.
        assert_eq!(
            chunks(&splittable, 20.0),
            (vec![20.0], Some(HeuristicReason::SessionBoundsInfeasible))
        );
    }

    #[test]
    fn representable_cell_counts_follow_the_session_bounds() {
        let bounds = SessionBounds::of(&task(true, 30.0, 40.0));
        assert_eq!((bounds.min_units, bounds.max_units), (6.0, 8.0));
        for (units, expected) in [
            (0.0, true),
            (5.0, false),
            (6.0, true),
            (8.0, true),
            (9.0, false),
            (11.0, false),
            (12.0, true),
            (16.0, true),
            (17.0, false),
            (18.0, true),
        ] {
            assert_eq!(bounds.is_representable(units), expected, "{units}");
        }
    }

    #[test]
    fn reasons_are_a_set_written_in_name_order() {
        let mut reasons = Reasons::default();
        assert_eq!(reasons.sorted().count(), 0);
        reasons.add(HeuristicReason::NoContiguousWindow);
        reasons.add(HeuristicReason::BlockedByPredecessor);
        reasons.add(HeuristicReason::NoContiguousWindow);
        let names: Vec<&str> = reasons.sorted().map(HeuristicReason::as_str).collect();
        assert_eq!(names, ["blocked_by_predecessor", "no_contiguous_window"]);
        let mut all: Vec<&str> = HeuristicReason::ALL.iter().map(|r| r.as_str()).collect();
        let written = all.clone();
        all.sort();
        assert_eq!(all, written);
        for reason in HeuristicReason::ALL {
            assert_eq!(
                reason.code().as_str(),
                format!("heuristic_{}", reason.as_str())
            );
        }
    }

    #[test]
    fn the_first_non_zero_key_decides_and_nan_falls_through() {
        assert_eq!(
            first_decisive([0.0, -1.0, 5.0], Ordering::Equal),
            Ordering::Less
        );
        assert_eq!(
            first_decisive([f64::NAN, 2.0, -5.0], Ordering::Equal),
            Ordering::Greater
        );
        assert_eq!(
            first_decisive([f64::NAN, 0.0, 0.0], Ordering::Less),
            Ordering::Less
        );
        assert_eq!(
            first_decisive([f64::NEG_INFINITY, 1.0, 1.0], Ordering::Equal),
            Ordering::Less
        );
    }
}
