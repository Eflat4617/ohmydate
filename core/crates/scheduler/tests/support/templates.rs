//! The English template of every explanation code, written down a second
//! time (`packages/scheduler/test/explanation-codes.test.ts`, FU-62).
//!
//! The crate builds each message next to its code and parameters; this
//! oracle rebuilds the text from the parameters alone, so a finding whose
//! code, text and parameters disagree fails. A code missing here makes
//! `expected_text` panic; a missing parameter makes the comparison fail.

use ohmydate_scheduler::codes::{ExplanationCode, ParamValue, Params};
use ohmydate_scheduler::js::number_to_string;

/// What the English line of a coded item must be.
pub enum Expected {
    Exact(String),
    /// The text is not fully determined by the parameters; it must match.
    Shape(Box<dyn Fn(&str) -> bool>),
}

impl Expected {
    pub fn matches(&self, text: &str) -> bool {
        match self {
            Expected::Exact(expected) => expected == text,
            Expected::Shape(shape) => shape(text),
        }
    }
}

/// A token parameter; a missing or mistyped one becomes a marker that no
/// message contains, so the comparison fails instead of the test crashing.
fn text(params: &Params, name: &str) -> String {
    match params.get(name) {
        Some(ParamValue::Text(value)) => value.clone(),
        _ => format!("<missing {name}>"),
    }
}

fn number(params: &Params, name: &str) -> String {
    match params.get(name) {
        Some(ParamValue::Number(value)) => number_to_string(*value),
        _ => format!("<missing {name}>"),
    }
}

fn never() -> Expected {
    Expected::Shape(Box::new(|_| false))
}

fn shape(prefix: &'static str, suffix: &'static str) -> Expected {
    Expected::Shape(Box::new(move |line| {
        line.len() >= prefix.len() + suffix.len()
            && line.starts_with(prefix)
            && line.ends_with(suffix)
    }))
}

/// `"…"` with no quote inside, between `prefix` and `suffix`.
fn quoted(prefix: &'static str, suffix: &'static str) -> Expected {
    Expected::Shape(Box::new(move |line| {
        line.strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(suffix))
            .and_then(|middle| middle.strip_prefix('"'))
            .and_then(|middle| middle.strip_suffix('"'))
            .is_some_and(|inner| !inner.contains('"'))
    }))
}

/// A comma-separated list of `count` words made of `allowed` characters.
fn word_list(line: &str, prefix: &str, count: Option<usize>, allowed: fn(char) -> bool) -> bool {
    let Some(list) = line
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix('.'))
    else {
        return false;
    };
    let words: Vec<&str> = list.split(", ").collect();
    count.is_none_or(|count| words.len() == count)
        && words
            .iter()
            .all(|word| !word.is_empty() && word.chars().all(allowed))
}

/// The text a coded item stands for.
pub fn expected_text(code: ExplanationCode, params: &Params) -> Expected {
    let t = |name: &str| text(params, name);
    let n = |name: &str| number(params, name);
    let exact = |line: String| Expected::Exact(line);
    match code.as_str() {
        "policy_summary" => {
            let summary = match t("policy").as_str() {
                "front_loaded" => "Finish work as early as possible and maximise due-date slack.",
                "balanced" => "Spread work evenly across days.",
                "focus_blocked" => "Prefer long contiguous focus blocks and few context switches.",
                _ => return never(),
            };
            exact(format!(
                "Policy {} v{}: {summary}",
                t("policy"),
                t("policyVersion")
            ))
        }
        "placement_summary" => exact(format!(
            "Placed {} of {} required minutes in {} movable block(s), retaining {} existing block(s).",
            n("placedMin"),
            n("requiredMin"),
            n("blockCount"),
            n("retainedCount")
        )),
        "constraints_satisfied" => exact("All hard constraints H1-H8 satisfied.".to_owned()),
        "infeasible_summary" => {
            let prefix = format!(
                "Infeasible with {} hard violation(s): ",
                n("violationCount")
            );
            Expected::Shape(Box::new(move |line| {
                word_list(line, &prefix, None, |c| {
                    c.is_ascii_alphanumeric() || c == '_'
                }) && line[prefix.len()..]
                    .split(", ")
                    .all(|kind| kind.starts_with('H'))
            }))
        }
        "heuristic_insufficient_available_time"
        | "heuristic_no_contiguous_window"
        | "heuristic_estimate_not_grid_aligned"
        | "heuristic_estimate_below_grid"
        | "heuristic_session_bounds_infeasible"
        | "heuristic_blocked_by_predecessor" => exact(format!(
            "Heuristic reason: {}.",
            code.as_str().trim_start_matches("heuristic_")
        )),
        "unplaced_minutes" => exact(format!(
            "Unplaced minutes (H7 shortfall): {} min.",
            n("deficitMin")
        )),
        "capacity_deficit" => exact(format!(
            "Capacity deficit: {} min.",
            n("capacityDeficitMin")
        )),
        "replan_bound_exceeded" => exact(format!(
            "Replan change bound exceeded: {} changed block(s) > {} (2 × {} affected existing block(s) + 2). Unaffected blocks were preserved; this candidate is the best available.",
            n("changedBlocks"),
            n("bound"),
            n("affectedExistingBlocks")
        )),
        "input_rejected" => {
            let Ok(count) = n("issueCount").parse::<usize>() else {
                return never();
            };
            Expected::Shape(Box::new(move |line| {
                word_list(
                    line,
                    "Input rejected before generation: ",
                    Some(count),
                    |c| c.is_ascii_lowercase() || c == '_',
                )
            }))
        }
        "auto_split_long_task" => {
            let prefix = format!(
                "Non-splittable task \"{}\" is longer than the ",
                t("taskId")
            );
            let limit = match t("reason").as_str() {
                "break_after" => "-minute limit before a break",
                "daily_cap" => "-minute daily focus cap",
                _ => return never(),
            };
            let suffix = format!(
                "{limit}; scheduled in sessions of at most {} min.",
                n("sessionMaxMin")
            );
            Expected::Shape(Box::new(move |line| {
                line.strip_prefix(prefix.as_str())
                    .and_then(|rest| rest.strip_suffix(suffix.as_str()))
                    .is_some_and(|minutes| {
                        !minutes.is_empty() && minutes.bytes().all(|byte| byte.is_ascii_digit())
                    })
            }))
        }

        "input_invalid_time_zone" | "h8_invalid_time_zone" => shape("Invalid IANA time zone: ", ""),
        "input_invalid_horizon_instant" | "h8_invalid_horizon" => {
            exact("Horizon contains an invalid instant.".to_owned())
        }
        "input_horizon_not_increasing" => {
            exact("Horizon end must be after horizon start.".to_owned())
        }
        "input_horizon_too_long" => exact(format!(
            "Horizon spans more than {} days, the maximum supported length.",
            n("maxDays")
        )),
        "input_invalid_now" => exact("now is not a valid instant.".to_owned()),
        "input_duplicate_task" => exact(format!("Task id \"{}\" is duplicated.", t("taskId"))),
        "input_invalid_estimate" => exact(format!(
            "Task \"{}\" has an estimate that is not a whole number of minutes between 0 and {}.",
            t("taskId"),
            n("maxMin")
        )),
        "input_invalid_buffer" => exact(format!(
            "Task \"{}\" has a bufferBeforeDueMin that is not a whole number of minutes between 0 and {}.",
            t("taskId"),
            n("maxMin")
        )),
        "input_invalid_session_minutes" => exact(format!(
            "Task \"{}\" has a session bound that is not a whole number of minutes between 0 and {}.",
            t("taskId"),
            n("maxMin")
        )),
        "input_invalid_session_bounds" => exact(format!(
            "Task \"{}\" has invalid session bounds.",
            t("taskId")
        )),
        "input_invalid_task_window_instant" => exact(format!(
            "Task \"{}\" contains an invalid window instant.",
            t("taskId")
        )),
        "input_task_window_empty" => exact(format!(
            "Task \"{}\" has earliestStartAt at or after its due window.",
            t("taskId")
        )),
        "input_invalid_preference" => exact(format!(
            "prefs.{} must be a whole number of minutes between 0 and {}.",
            t("field"),
            n("maxMin")
        )),
        "input_unknown_dependency" => exact(format!(
            "Task \"{}\" depends on unknown task \"{}\".",
            t("taskId"),
            t("dependencyId")
        )),
        "input_dependency_cycle" => exact("Task dependencies contain a cycle.".to_owned()),
        "input_invalid_weekday" => shape("Availability weekday ", " is outside 1-7."),
        "input_invalid_availability_window" => shape("Availability window ", " is invalid."),
        "input_invalid_exception_date" => quoted("Exception date ", " is invalid."),
        "input_exception_partial_window" => {
            quoted("Exception on ", " must have both start and end or neither.")
        }
        "input_invalid_exception_window" => quoted("Exception window on ", " is invalid."),
        "input_commitment_invalid_instant" => {
            exact("commitment has an invalid instant.".to_owned())
        }
        "input_commitment_end_before_start" => {
            exact("commitment ends before it starts.".to_owned())
        }
        "input_commitment_too_long" => exact(format!(
            "Commitment spans more than {} days, the maximum supported length.",
            n("maxDays")
        )),
        "input_unknown_block_task" | "h0_unknown_task" => exact(format!(
            "Block references unknown task \"{}\".",
            t("taskId")
        )),
        "input_invalid_block_instant" | "h8_invalid_instant" => exact(format!(
            "Block for task \"{}\" has an invalid instant.",
            t("taskId")
        )),
        "input_block_sub_millisecond" | "h8_sub_millisecond" => exact(format!(
            "Block for task \"{}\" has sub-millisecond precision.",
            t("taskId")
        )),
        "input_block_off_grid" => exact(format!(
            "Block for task \"{}\" is not on the 5-minute grid.",
            t("taskId")
        )),
        "input_block_end_before_start" | "h8_end_before_start" => exact(format!(
            "Block for task \"{}\" ends before it starts.",
            t("taskId")
        )),
        "input_block_too_long" => exact(format!(
            "Block for task \"{}\" spans more than {} days, the maximum supported length.",
            t("taskId"),
            n("maxDays")
        )),

        "h0_outside_horizon" => exact(format!(
            "Block for task \"{}\" is outside the planning horizon.",
            t("taskId")
        )),
        "h1_same_task_overlap" => exact(format!("Blocks for task \"{}\" overlap.", t("taskId"))),
        "h1_tasks_overlap" => exact(format!(
            "Blocks for tasks \"{}\" and \"{}\" overlap.",
            t("taskId"),
            t("otherTaskId")
        )),
        "h1_commitment_overlap" => exact(format!(
            "Block for task \"{}\" overlaps a commitment.",
            t("taskId")
        )),
        "h2_outside_availability" => exact(format!(
            "Block for task \"{}\" is outside availability.",
            t("taskId")
        )),
        "h3_dependency_order" => exact(format!(
            "Task \"{}\" starts before dependency \"{}\" finishes.",
            t("taskId"),
            t("dependencyId")
        )),
        "h4_before_earliest_start" => exact(format!(
            "Task \"{}\" starts before earliestStartAt.",
            t("taskId")
        )),
        "h4_inside_due_buffer" => exact(format!(
            "Task \"{}\" ends inside its pre-due buffer.",
            t("taskId")
        )),
        "h4_after_due" => exact(format!("Task \"{}\" ends after its due time.", t("taskId"))),
        "h5_unsplittable_no_remaining" => exact(format!(
            "Non-splittable task \"{}\" has no remaining minutes and must not have a block.",
            t("taskId")
        )),
        "h5_unsplittable_required_out_of_bounds" => exact(format!(
            "Non-splittable task \"{}\" requires {} minutes, outside [{}, {}].",
            t("taskId"),
            n("requiredMin"),
            n("minSessionMin"),
            n("maxSessionMin")
        )),
        "h5_unsplittable_single_block" => exact(format!(
            "Non-splittable task \"{}\" must be one block covering {} minutes.",
            t("taskId"),
            n("requiredMin")
        )),
        "h5_session_out_of_bounds" => exact(format!(
            "Task \"{}\" has a {}-minute session outside [{}, {}].",
            t("taskId"),
            n("durationMin"),
            n("minSessionMin"),
            n("maxSessionMin")
        )),
        "h6_daily_focus_exceeded" => exact(format!(
            "Daily focus on {} is {} minutes, above {}.",
            t("date"),
            n("totalMin"),
            n("maxDailyFocusMin")
        )),
        "h6_break_missing" => exact(format!(
            "Continuous focus starting on {} exceeds {} minutes without a {}-minute break.",
            t("date"),
            n("breakAfterMin"),
            n("breakMin")
        )),
        "h7_deficit" => exact(format!(
            "Task \"{}\" is short by {} minutes (deficit).",
            t("taskId"),
            n("shortMin")
        )),
        "h7_overallocated" => exact(format!(
            "Task \"{}\" is overallocated by {} minutes.",
            t("taskId"),
            n("excessMin")
        )),
        "h8_off_grid" => exact(format!(
            "Block for task \"{}\" is not aligned to the 5-minute grid.",
            t("taskId")
        )),
        other => panic!("no template for code {other}"),
    }
}

fn is_token(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:+-".contains(c))
}

fn is_utc_instant(value: &str) -> bool {
    value.ends_with('Z')
        && value
            .parse::<jiff::Timestamp>()
            .is_ok_and(|parsed| parsed.to_string() == value)
}

fn is_civil_date(value: &str) -> bool {
    value.len() == 10
        && value
            .parse::<jiff::civil::Date>()
            .is_ok_and(|parsed| parsed.to_string() == value)
}

/// Parameters are finite numbers or opaque tokens — never free text.
pub fn check_safe_params(code: &str, params: &Params) -> Result<(), String> {
    for (name, value) in params.iter() {
        let place = format!("{code}.{name}");
        let name_ok = name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && name.chars().all(|c| c.is_ascii_alphanumeric());
        if !name_ok {
            return Err(format!("{place}: not a parameter name"));
        }
        match value {
            ParamValue::Number(number) if number.is_finite() => {}
            ParamValue::Number(_) => return Err(format!("{place}: not a finite number")),
            ParamValue::Text(token) => {
                if !is_token(token) {
                    return Err(format!("{place}: not an opaque token"));
                }
                if name.ends_with("At") && !is_utc_instant(token) {
                    return Err(format!("{place}: not a UTC instant"));
                }
                if name == "date" && !is_civil_date(token) {
                    return Err(format!("{place}: not a civil date"));
                }
            }
        }
    }
    Ok(())
}

/// The FU-62 invariant for one coded message.
pub fn check_coded(code: ExplanationCode, params: &Params, message: &str) -> Result<(), String> {
    check_safe_params(code.as_str(), params)?;
    if expected_text(code, params).matches(message) {
        Ok(())
    } else {
        Err(format!(
            "{code}: the text does not follow from the parameters: {message}"
        ))
    }
}
