//! Capacity accounting before generation: a port of
//! `packages/scheduler/src/explain.ts`.
//!
//! Locked blocks count as placed work: their minutes are credited against
//! the task's requirement, and their latest end feeds the readiness of
//! successors. For the remaining work, availability is measured inside each
//! task's own window, then an optimistic completion is found by consuming
//! the real available intervals in order. If the remaining work cannot be
//! consumed inside the window, the completion is unreachable and successors
//! are blocked (no availability, full deficit).
//!
//! Per-task availability ignores contention between independent tasks, so
//! the total is the sum of per-task values: an explanatory upper bound.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::canonical::number_value;
use crate::js;
use crate::requirements::task_required_minutes;
use crate::slots::available_intervals;
use crate::time::{MINUTE_MS, TimeError, parse_instant};
use crate::types::{RiskLevel, ScheduleInput, Task};

#[derive(Debug, Clone, PartialEq)]
pub struct TaskDeficit {
    pub task_id: String,
    pub required_min: f64,
    pub available_before_due_min: f64,
    pub deficit_min: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeficitTotal {
    pub required_min: f64,
    pub available_before_due_min: f64,
    pub deficit_min: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeficitReport {
    pub risk_level: RiskLevel,
    /// One entry per task, predecessors before their successors.
    pub tasks: Vec<TaskDeficit>,
    pub total: DeficitTotal,
}

impl DeficitReport {
    /// The reference's JSON form.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let numbers = |required: f64, available: f64, deficit: f64| {
            let mut object = Map::new();
            object.insert("requiredMin".into(), number_value(required));
            object.insert("availableBeforeDueMin".into(), number_value(available));
            object.insert("deficitMin".into(), number_value(deficit));
            object
        };
        let mut report = Map::new();
        report.insert(
            "riskLevel".into(),
            Value::String(self.risk_level.as_str().into()),
        );
        report.insert(
            "tasks".into(),
            Value::Array(
                self.tasks
                    .iter()
                    .map(|task| {
                        let mut object = numbers(
                            task.required_min,
                            task.available_before_due_min,
                            task.deficit_min,
                        );
                        object.insert("taskId".into(), Value::String(task.task_id.clone()));
                        Value::Object(object)
                    })
                    .collect(),
            ),
        );
        report.insert(
            "total".into(),
            Value::Object(numbers(
                self.total.required_min,
                self.total.available_before_due_min,
                self.total.deficit_min,
            )),
        );
        Value::Object(report)
    }
}

// Epoch milliseconds stay far below 2^53.
#[allow(clippy::cast_precision_loss)]
fn as_f64(value: i64) -> f64 {
    value as f64
}

const MINUTE_MS_F64: f64 = MINUTE_MS as f64;

/// A time span in the float milliseconds the reference computes with (task
/// windows can be infinite or, on unvalidated input, fractional).
#[derive(Debug, Clone, Copy)]
struct Span {
    start_ms: f64,
    end_ms: f64,
}

fn overlap_ms(a_start: f64, a_end: f64, b_start: f64, b_end: f64) -> f64 {
    js::max(0.0, js::min(a_end, b_end) - js::max(a_start, b_start))
}

/// Consumes `minutes` of the slots inside `[start_ms, end_ms)` in order;
/// `Some(completion)` when they suffice.
fn consume_available(slots: &[Span], start_ms: f64, end_ms: f64, minutes: f64) -> Option<f64> {
    if minutes <= 0.0 {
        return Some(start_ms);
    }
    if end_ms <= start_ms {
        return None;
    }
    let mut remaining = minutes;
    for slot in slots {
        let slot_start = js::max(start_ms, slot.start_ms);
        let slot_end = js::min(end_ms, slot.end_ms);
        if slot_end <= slot_start {
            continue;
        }
        let take = js::min(remaining, (slot_end - slot_start) / MINUTE_MS_F64);
        remaining -= take;
        if remaining <= 0.0 {
            return Some(slot_start + take * MINUTE_MS_F64);
        }
    }
    None
}

/// Indices of the tasks with predecessors first (Kahn's algorithm in input
/// order), then whatever a cycle left over. An id names the last task that
/// carries it, as in the reference's id map.
fn topological_order(tasks: &[Task]) -> Vec<usize> {
    let mut by_id: BTreeMap<&str, usize> = BTreeMap::new();
    for (index, task) in tasks.iter().enumerate() {
        by_id.insert(task.id.as_str(), index);
    }
    // Both keyed by id, through the id's task.
    let mut indegree = vec![0_usize; tasks.len()];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); tasks.len()];
    for task in tasks {
        let own = by_id[task.id.as_str()];
        let known: Vec<usize> = task
            .depends_on
            .iter()
            .filter_map(|id| by_id.get(id.as_str()).copied())
            .collect();
        indegree[own] = known.len();
        for dependency in known {
            dependents[dependency].push(own);
        }
    }

    let mut queue: std::collections::VecDeque<usize> = tasks
        .iter()
        .map(|task| by_id[task.id.as_str()])
        .filter(|index| indegree[*index] == 0)
        .collect();
    let mut seen = vec![false; tasks.len()];
    let mut ordered = Vec::with_capacity(tasks.len());
    while let Some(index) = queue.pop_front() {
        if seen[index] {
            continue;
        }
        seen[index] = true;
        ordered.push(index);
        for &dependent in &dependents[index] {
            // The reference lets the count go below zero and only queues a
            // task when it is exactly zero.
            indegree[dependent] = indegree[dependent].wrapping_sub(1);
            if indegree[dependent] == 0 {
                queue.push_back(dependent);
            }
        }
    }
    for (index, task) in tasks.iter().enumerate() {
        if !seen[by_id[task.id.as_str()]] {
            ordered.push(index);
        }
    }
    ordered
}

/// Per-task capacity accounting before generation (`deficit`).
///
/// # Errors
///
/// When the input cannot be read: an invalid horizon, time zone, clock,
/// commitment or task window instant. The reference throws there.
pub fn deficit(input: &ScheduleInput) -> Result<DeficitReport, TimeError> {
    let risk_level = input.prefs.risk_level;
    let horizon_start_ms = as_f64(parse_instant(&input.horizon.start)?);
    let horizon_end_ms = as_f64(parse_instant(&input.horizon.end)?);
    let slots: Vec<Span> = available_intervals(input)?
        .into_iter()
        .map(|interval| Span {
            start_ms: as_f64(interval.start_ms),
            end_ms: as_f64(interval.end_ms),
        })
        .collect();

    // By id; a repeated id keeps the last task's requirement.
    let mut required_by_id: BTreeMap<&str, f64> = BTreeMap::new();
    for task in &input.tasks {
        required_by_id.insert(task.id.as_str(), task_required_minutes(task, risk_level));
    }

    let mut locked_by_task: BTreeMap<&str, Vec<Span>> = BTreeMap::new();
    for block in &input.locked_blocks {
        let (Ok(start_ms), Ok(end_ms)) = (parse_instant(&block.start), parse_instant(&block.end))
        else {
            continue;
        };
        if end_ms <= start_ms {
            continue;
        }
        locked_by_task
            .entry(block.task_id.as_str())
            .or_default()
            .push(Span {
                start_ms: as_f64(start_ms),
                end_ms: as_f64(end_ms),
            });
    }

    let mut completion_by_id: BTreeMap<&str, f64> = BTreeMap::new();
    let mut results: Vec<TaskDeficit> = Vec::with_capacity(input.tasks.len());
    for index in topological_order(&input.tasks) {
        let task = &input.tasks[index];
        let required_min = required_by_id.get(task.id.as_str()).copied().unwrap_or(0.0);
        let locked: &[Span] = locked_by_task
            .get(task.id.as_str())
            .map_or(&[], Vec::as_slice);
        let locked_min = locked.iter().fold(0.0, |sum, span| {
            sum + (span.end_ms - span.start_ms) / MINUTE_MS_F64
        });
        let locked_completion_ms = locked.iter().fold(f64::NEG_INFINITY, |latest, span| {
            js::max(latest, span.end_ms)
        });
        let remaining_min = js::max(0.0, required_min - locked_min);

        let earliest_ms = match &task.earliest_start_at {
            None => horizon_start_ms,
            Some(text) => as_f64(parse_instant(text)?),
        };
        let mut dependency_ready_ms = horizon_start_ms;
        for dependency_id in &task.depends_on {
            if let Some(completion) = completion_by_id.get(dependency_id.as_str()) {
                dependency_ready_ms = js::max(dependency_ready_ms, *completion);
            }
        }

        let window_start_ms = js::max(js::max(horizon_start_ms, earliest_ms), dependency_ready_ms);
        let buffer_ms = task.buffer_before_due_min.unwrap_or(0.0) * MINUTE_MS_F64;
        let window_end_ms = match &task.due_at {
            None => horizon_end_ms,
            Some(text) => as_f64(parse_instant(text)?) - buffer_ms,
        };

        let mut free_available_ms = 0.0;
        if window_end_ms > window_start_ms {
            for slot in &slots {
                free_available_ms +=
                    overlap_ms(window_start_ms, window_end_ms, slot.start_ms, slot.end_ms);
            }
        }
        let available_before_due_min = free_available_ms / MINUTE_MS_F64 + locked_min;
        let deficit_min = js::max(0.0, required_min - available_before_due_min);

        let mut completion_ms = js::max(window_start_ms, locked_completion_ms);
        if remaining_min > 0.0 {
            completion_ms =
                match consume_available(&slots, window_start_ms, window_end_ms, remaining_min) {
                    Some(consumed_ms) => js::max(completion_ms, consumed_ms),
                    None => f64::INFINITY,
                };
        }
        completion_by_id.insert(task.id.as_str(), completion_ms);

        results.push(TaskDeficit {
            task_id: task.id.clone(),
            required_min,
            available_before_due_min,
            deficit_min,
        });
    }

    let total = results.iter().fold(
        DeficitTotal {
            required_min: 0.0,
            available_before_due_min: 0.0,
            deficit_min: 0.0,
        },
        |sum, result| DeficitTotal {
            required_min: sum.required_min + result.required_min,
            available_before_due_min: sum.available_before_due_min
                + result.available_before_due_min,
            deficit_min: sum.deficit_min + result.deficit_min,
        },
    );
    Ok(DeficitReport {
        risk_level,
        tasks: results,
        total,
    })
}
