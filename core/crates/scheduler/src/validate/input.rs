//! `validateInput`: shape and internal consistency of a `ScheduleInput`,
//! checked before any plan is generated.

use std::collections::{BTreeMap, BTreeSet};

use super::{GRID_NS, NS_PER_MS, as_f64};
use super::{
    InputIssue, MAX_HORIZON_DAYS, MAX_HORIZON_MS, MAX_INPUT_MINUTES, is_whole_minute,
    usable_buffer_minutes,
};
use crate::codes::{InputIssueCode, InputIssueMessageCode, Params};
use crate::js::number_to_string;
use crate::time::{
    MINUTE_MS, instant_nanoseconds, is_plain_date, is_valid_time_zone, parse_clock, parse_instant,
};
use crate::types::{ScheduleInput, Task};

fn issue(
    code: InputIssueCode,
    message_code: InputIssueMessageCode,
    message: String,
    params: Params,
) -> InputIssue {
    InputIssue {
        code,
        message,
        message_code,
        params,
        task_id: None,
    }
}

/// An issue about one task or one block of a task.
fn task_issue(
    code: InputIssueCode,
    message_code: InputIssueMessageCode,
    task_id: &str,
    message: String,
    params: Params,
) -> InputIssue {
    InputIssue {
        code,
        message,
        message_code,
        params,
        task_id: Some(task_id.to_owned()),
    }
}

fn max_minutes_text() -> String {
    number_to_string(MAX_INPUT_MINUTES)
}

/// A local window `start`–`end` that parses and is not empty or backwards.
fn is_valid_clock_range(start_local: &str, end_local: &str) -> bool {
    match (parse_clock(start_local), parse_clock(end_local)) {
        (Ok(start), Ok(end)) => start.hour != 24 && end.minutes() > start.minutes(),
        _ => false,
    }
}

/// Depth-first search for a dependency cycle. An id names the last task that
/// carries it, as in the reference's id map; unknown ids lead nowhere.
fn has_dependency_cycle(tasks: &[Task]) -> bool {
    let mut by_id: BTreeMap<&str, usize> = BTreeMap::new();
    for (index, task) in tasks.iter().enumerate() {
        by_id.insert(task.id.as_str(), index);
    }
    let index_of = |id: &str| by_id.get(id).copied();
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        New,
        Visiting,
        Visited,
    }
    let mut marks = vec![Mark::New; tasks.len()];
    for root in tasks {
        let Some(root) = index_of(&root.id) else {
            continue;
        };
        if marks[root] != Mark::New {
            continue;
        }
        // (task, next dependency to look at): an explicit stack, so a long
        // chain cannot overflow the call stack.
        let mut stack = vec![(root, 0_usize)];
        marks[root] = Mark::Visiting;
        while let Some((task, next)) = stack.last_mut() {
            let Some(dependency) = tasks[*task].depends_on.get(*next) else {
                marks[*task] = Mark::Visited;
                stack.pop();
                continue;
            };
            *next += 1;
            let Some(dependency) = index_of(dependency) else {
                continue;
            };
            match marks[dependency] {
                Mark::Visiting => return true,
                Mark::Visited => {}
                Mark::New => {
                    marks[dependency] = Mark::Visiting;
                    stack.push((dependency, 0));
                }
            }
        }
    }
    false
}

fn validate_task_window(task: &Task, issues: &mut Vec<InputIssue>) {
    let earliest = task
        .earliest_start_at
        .as_deref()
        .map(|text| parse_instant(text).ok());
    let due = task.due_at.as_deref().map(|text| parse_instant(text).ok());
    if earliest == Some(None) || due == Some(None) {
        issues.push(task_issue(
            InputIssueCode::InvalidWindow,
            InputIssueMessageCode::InvalidTaskWindowInstant,
            &task.id,
            format!("Task \"{}\" contains an invalid window instant.", task.id),
            Params::none().text("taskId", task.id.as_str()),
        ));
        return;
    }
    if let (Some(Some(earliest)), Some(Some(due))) = (earliest, due) {
        let buffer_ms = usable_buffer_minutes(task) * as_f64(MINUTE_MS);
        if earliest > due || as_f64(earliest) >= as_f64(due) - buffer_ms {
            issues.push(task_issue(
                InputIssueCode::InvalidWindow,
                InputIssueMessageCode::TaskWindowEmpty,
                &task.id,
                format!(
                    "Task \"{}\" has earliestStartAt at or after its due window.",
                    task.id
                ),
                Params::none().text("taskId", task.id.as_str()),
            ));
        }
    }
}

/// Validates the shape and internal consistency of a `ScheduleInput`
/// (`validateInput`). An empty result means the input can be scheduled.
#[must_use]
pub fn validate_input(input: &ScheduleInput) -> Vec<InputIssue> {
    let mut issues: Vec<InputIssue> = Vec::new();
    let max_days = number_to_string(as_f64(MAX_HORIZON_DAYS));
    let max_days_params = || Params::none().number("maxDays", as_f64(MAX_HORIZON_DAYS));

    if !is_valid_time_zone(&input.time_zone) {
        issues.push(issue(
            InputIssueCode::InvalidTimezone,
            InputIssueMessageCode::InvalidTimeZone,
            format!("Invalid IANA time zone: {}", input.time_zone),
            Params::none(),
        ));
    }

    let horizon_start = parse_instant(&input.horizon.start).ok();
    let horizon_end = parse_instant(&input.horizon.end).ok();
    match (horizon_start, horizon_end) {
        (Some(start), Some(end)) if end <= start => issues.push(issue(
            InputIssueCode::InvalidWindow,
            InputIssueMessageCode::HorizonNotIncreasing,
            "Horizon end must be after horizon start.".to_owned(),
            Params::none(),
        )),
        (Some(start), Some(end)) if end - start > MAX_HORIZON_MS => issues.push(issue(
            InputIssueCode::InvalidInput,
            InputIssueMessageCode::HorizonTooLong,
            format!("Horizon spans more than {max_days} days, the maximum supported length."),
            max_days_params(),
        )),
        (Some(_), Some(_)) => {}
        _ => issues.push(issue(
            InputIssueCode::InvalidInstant,
            InputIssueMessageCode::InvalidHorizonInstant,
            "Horizon contains an invalid instant.".to_owned(),
            Params::none(),
        )),
    }

    if parse_instant(&input.now).is_err() {
        issues.push(issue(
            InputIssueCode::InvalidInstant,
            InputIssueMessageCode::InvalidNow,
            "now is not a valid instant.".to_owned(),
            Params::none(),
        ));
    }

    let mut task_ids: BTreeSet<&str> = BTreeSet::new();
    for task in &input.tasks {
        let id = task.id.as_str();
        let minute_params = || {
            Params::none()
                .text("taskId", id)
                .number("maxMin", MAX_INPUT_MINUTES)
        };
        if !task_ids.insert(id) {
            issues.push(task_issue(
                InputIssueCode::DuplicateTask,
                InputIssueMessageCode::DuplicateTask,
                id,
                format!("Task id \"{id}\" is duplicated."),
                Params::none().text("taskId", id),
            ));
        }
        // Every minute-valued field is validated before window or H4
        // arithmetic can use it (a non-finite buffer would otherwise bypass
        // the deadline).
        let estimate_ok = is_whole_minute(task.estimate.p50_min)
            && is_whole_minute(task.estimate.p90_min)
            && task.remaining_min.is_none_or(is_whole_minute);
        if !estimate_ok {
            issues.push(task_issue(
                InputIssueCode::InvalidEstimate,
                InputIssueMessageCode::InvalidEstimate,
                id,
                format!(
                    "Task \"{id}\" has an estimate that is not a whole number of minutes between 0 and {}.",
                    max_minutes_text()
                ),
                minute_params(),
            ));
        }
        if task
            .buffer_before_due_min
            .is_some_and(|value| !is_whole_minute(value))
        {
            issues.push(task_issue(
                InputIssueCode::InvalidEstimate,
                InputIssueMessageCode::InvalidBuffer,
                id,
                format!(
                    "Task \"{id}\" has a bufferBeforeDueMin that is not a whole number of minutes between 0 and {}.",
                    max_minutes_text()
                ),
                minute_params(),
            ));
        }
        if !is_whole_minute(task.min_session_min) || !is_whole_minute(task.max_session_min) {
            issues.push(task_issue(
                InputIssueCode::InvalidEstimate,
                InputIssueMessageCode::InvalidSessionMinutes,
                id,
                format!(
                    "Task \"{id}\" has a session bound that is not a whole number of minutes between 0 and {}.",
                    max_minutes_text()
                ),
                minute_params(),
            ));
        }
        if task.min_session_min < 0.0
            || task.max_session_min < task.min_session_min
            || (task.splittable && task.min_session_min == 0.0)
        {
            issues.push(task_issue(
                InputIssueCode::InvalidSession,
                InputIssueMessageCode::InvalidSessionBounds,
                id,
                format!("Task \"{id}\" has invalid session bounds."),
                Params::none().text("taskId", id),
            ));
        }
        validate_task_window(task, &mut issues);
    }

    for (name, value) in [
        ("maxDailyFocusMin", input.prefs.max_daily_focus_min),
        ("breakAfterMin", input.prefs.break_after_min),
        ("breakMin", input.prefs.break_min),
    ] {
        if !is_whole_minute(value) {
            issues.push(issue(
                InputIssueCode::InvalidInput,
                InputIssueMessageCode::InvalidPreference,
                format!(
                    "prefs.{name} must be a whole number of minutes between 0 and {}.",
                    max_minutes_text()
                ),
                Params::none()
                    .text("field", name)
                    .number("maxMin", MAX_INPUT_MINUTES),
            ));
        }
    }

    for task in &input.tasks {
        for dependency in &task.depends_on {
            if !task_ids.contains(dependency.as_str()) {
                issues.push(task_issue(
                    InputIssueCode::UnknownDependency,
                    InputIssueMessageCode::UnknownDependency,
                    &task.id,
                    format!(
                        "Task \"{}\" depends on unknown task \"{dependency}\".",
                        task.id
                    ),
                    Params::none()
                        .text("taskId", task.id.as_str())
                        .text("dependencyId", dependency.as_str()),
                ));
            }
        }
    }

    if has_dependency_cycle(&input.tasks) {
        issues.push(issue(
            InputIssueCode::DependencyCycle,
            InputIssueMessageCode::DependencyCycle,
            "Task dependencies contain a cycle.".to_owned(),
            Params::none(),
        ));
    }

    for rule in &input.availability {
        if rule.weekday < 1.0 || rule.weekday > 7.0 {
            issues.push(issue(
                InputIssueCode::InvalidWindow,
                InputIssueMessageCode::InvalidWeekday,
                format!(
                    "Availability weekday {} is outside 1-7.",
                    number_to_string(rule.weekday)
                ),
                Params::none(),
            ));
            continue;
        }
        if !is_valid_clock_range(&rule.start_local, &rule.end_local) {
            issues.push(issue(
                InputIssueCode::InvalidWindow,
                InputIssueMessageCode::InvalidAvailabilityWindow,
                format!(
                    "Availability window {}-{} is invalid.",
                    rule.start_local, rule.end_local
                ),
                Params::none().number("weekday", rule.weekday),
            ));
        }
    }

    for exception in &input.exceptions {
        if !is_plain_date(&exception.date) {
            issues.push(issue(
                InputIssueCode::InvalidWindow,
                InputIssueMessageCode::InvalidExceptionDate,
                format!("Exception date \"{}\" is invalid.", exception.date),
                Params::none(),
            ));
        }
        match (&exception.start_local, &exception.end_local) {
            (Some(start_local), Some(end_local)) => {
                if !is_valid_clock_range(start_local, end_local) {
                    issues.push(issue(
                        InputIssueCode::InvalidWindow,
                        InputIssueMessageCode::InvalidExceptionWindow,
                        format!("Exception window on \"{}\" is invalid.", exception.date),
                        Params::none(),
                    ));
                }
            }
            (None, None) => {}
            _ => issues.push(issue(
                InputIssueCode::InvalidWindow,
                InputIssueMessageCode::ExceptionPartialWindow,
                format!(
                    "Exception on \"{}\" must have both start and end or neither.",
                    exception.date
                ),
                Params::none(),
            )),
        }
    }

    let horizon = match (horizon_start, horizon_end) {
        (Some(start), Some(end)) if end > start => Some((start, end)),
        _ => None,
    };
    for commitment in &input.commitments {
        let (Ok(start_ms), Ok(end_ms)) = (
            parse_instant(&commitment.start),
            parse_instant(&commitment.end),
        ) else {
            issues.push(issue(
                InputIssueCode::InvalidInstant,
                InputIssueMessageCode::CommitmentInvalidInstant,
                "commitment has an invalid instant.".to_owned(),
                Params::none(),
            ));
            continue;
        };
        if end_ms <= start_ms {
            issues.push(issue(
                InputIssueCode::InvalidWindow,
                InputIssueMessageCode::CommitmentEndBeforeStart,
                "commitment ends before it starts.".to_owned(),
                Params::none(),
            ));
        }
        // The occupied-span cap bounds transition enumeration after
        // clipping. Commitments wholly outside the horizon are irrelevant,
        // and partially overlapping ones only cost their clipped span
        // (FU-43).
        let effective_span_ms = match horizon {
            None => end_ms - start_ms,
            Some((horizon_start, horizon_end)) => {
                if start_ms < horizon_end && end_ms > horizon_start {
                    end_ms.min(horizon_end) - start_ms.max(horizon_start)
                } else {
                    0
                }
            }
        };
        if effective_span_ms > MAX_HORIZON_MS {
            issues.push(issue(
                InputIssueCode::InvalidInput,
                InputIssueMessageCode::CommitmentTooLong,
                format!(
                    "Commitment spans more than {max_days} days, the maximum supported length."
                ),
                max_days_params(),
            ));
        }
    }

    for block in input.locked_blocks.iter().chain(input.existing()) {
        let id = block.task_id.as_str();
        let task_params = || Params::none().text("taskId", id);
        if !task_ids.contains(id) {
            issues.push(task_issue(
                InputIssueCode::UnknownTask,
                InputIssueMessageCode::UnknownBlockTask,
                id,
                format!("Block references unknown task \"{id}\"."),
                task_params(),
            ));
        }
        let (Ok(start_ns), Ok(end_ns)) = (
            instant_nanoseconds(&block.start),
            instant_nanoseconds(&block.end),
        ) else {
            issues.push(task_issue(
                InputIssueCode::InvalidInstant,
                InputIssueMessageCode::InvalidBlockInstant,
                id,
                format!("Block for task \"{id}\" has an invalid instant."),
                task_params(),
            ));
            continue;
        };
        if start_ns % NS_PER_MS != 0 || end_ns % NS_PER_MS != 0 {
            issues.push(task_issue(
                InputIssueCode::InvalidPrecision,
                InputIssueMessageCode::BlockSubMillisecond,
                id,
                format!("Block for task \"{id}\" has sub-millisecond precision."),
                task_params(),
            ));
            continue;
        }
        if start_ns % GRID_NS != 0 || end_ns % GRID_NS != 0 {
            issues.push(task_issue(
                InputIssueCode::InvalidPrecision,
                InputIssueMessageCode::BlockOffGrid,
                id,
                format!("Block for task \"{id}\" is not on the 5-minute grid."),
                task_params(),
            ));
            continue;
        }
        let span_ns = end_ns - start_ns;
        if span_ns <= 0 {
            issues.push(task_issue(
                InputIssueCode::InvalidWindow,
                InputIssueMessageCode::BlockEndBeforeStart,
                id,
                format!("Block for task \"{id}\" ends before it starts."),
                task_params(),
            ));
        } else if span_ns > i128::from(MAX_HORIZON_MS) * NS_PER_MS {
            issues.push(task_issue(
                InputIssueCode::InvalidInput,
                InputIssueMessageCode::BlockTooLong,
                id,
                format!(
                    "Block for task \"{id}\" spans more than {max_days} days, the maximum supported length."
                ),
                task_params().number("maxDays", as_f64(MAX_HORIZON_DAYS)),
            ));
        }
    }

    issues
}
