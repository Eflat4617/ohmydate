//! `packages/scheduler/test/fu96.test.ts`: a non-splittable task longer than
//! one H6-legal block, and chains blocked by an unplaced predecessor
//! (06 §3, §6.1).

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::generate::{GenerateResult, MAX_AUTO_SPLIT_LINES, PlanCandidate, generate};
use ohmydate_scheduler::sessions::{auto_split_min_session_min, max_legal_session_min};
use ohmydate_scheduler::types::{
    AutoSplitReason, GenerateOptions, PolicyName, ScheduleInput, Task,
};
use support::minute_oracle::instant_ms;
use support::{audit, rule};

fn task(id: &str) -> Task {
    Task {
        due_at: Some("2026-11-20T00:00:00Z".to_owned()),
        min_session_min: 30.0,
        max_session_min: 90.0,
        priority: 2.0,
        ..support::task(id, 60.0)
    }
}

fn after(mut task: Task, dependencies: &[&str]) -> Task {
    task.depends_on = dependencies.iter().map(|id| (*id).to_owned()).collect();
    task
}

/// Eleven days from 2026-11-09 in UTC, 09:00–18:00 every day, with a
/// 60-minute limit before a 15-minute break.
fn input(tasks: Vec<Task>) -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-20T00:00:00Z",
        tasks,
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", "18:00"))
            .collect(),
    );
    input.prefs = support::prefs(480.0, 60.0);
    input.seed = 3.0;
    input
}

/// A non-splittable task with the pre-FU-96 bounds (one block = the
/// estimate).
fn unsplittable(id: &str, minutes: f64) -> Task {
    Task {
        splittable: false,
        min_session_min: minutes,
        max_session_min: minutes,
        ..sized(id, minutes)
    }
}

fn sized(id: &str, minutes: f64) -> Task {
    let mut task = task(id);
    task.estimate.p50_min = minutes;
    task.estimate.p90_min = minutes;
    task
}

/// The same task as the caller sends it after the FU-96 auto-split.
fn auto_split(id: &str, minutes: f64, cap_min: f64) -> Task {
    Task {
        min_session_min: auto_split_min_session_min(cap_min, 30.0),
        max_session_min: cap_min,
        auto_split: Some(AutoSplitReason::BreakAfter),
        ..sized(id, minutes)
    }
}

fn all(input: &ScheduleInput) -> GenerateResult {
    generate(input, &GenerateOptions::default()).unwrap()
}

fn front_loaded(input: &ScheduleInput) -> PlanCandidate {
    generate(
        input,
        &GenerateOptions {
            policies: Some(vec![PolicyName::FrontLoaded]),
            ..GenerateOptions::default()
        },
    )
    .unwrap()
    .candidates
    .remove(0)
}

fn codes(candidate: &PlanCandidate) -> Vec<&'static str> {
    candidate
        .explanation_items
        .iter()
        .map(|item| item.code.as_str())
        .collect()
}

fn block_minutes(candidate: &PlanCandidate, task_id: &str) -> Vec<i64> {
    candidate
        .blocks
        .iter()
        .filter(|block| block.task_id == task_id)
        .map(|block| (instant_ms(&block.end) - instant_ms(&block.start)) / 60_000)
        .collect()
}

// maxLegalSessionMin and autoSplitMinSessionMin.

#[test]
fn the_legal_session_is_the_smaller_h6_limit_on_the_grid() {
    let limit = |break_after: f64, daily: f64| {
        max_legal_session_min(break_after, daily).map(|limit| (limit.cap_min, limit.reason))
    };
    assert_eq!(
        limit(60.0, 240.0),
        Some((60.0, AutoSplitReason::BreakAfter))
    );
    assert_eq!(
        limit(60.0, 180.0),
        Some((60.0, AutoSplitReason::BreakAfter))
    );
    assert_eq!(
        limit(240.0, 150.0),
        Some((150.0, AutoSplitReason::DailyCap))
    );
    assert_eq!(limit(90.0, 90.0), Some((90.0, AutoSplitReason::BreakAfter)));
    assert_eq!(
        limit(62.0, 480.0),
        Some((60.0, AutoSplitReason::BreakAfter))
    );
    // The break rule off: the daily cap is what is left.
    assert_eq!(limit(0.0, 200.0), Some((200.0, AutoSplitReason::DailyCap)));
    // No legal session below one grid cell or for non-finite preferences.
    assert_eq!(limit(60.0, 0.0), None);
    assert_eq!(limit(3.0, 480.0), None);
    assert_eq!(limit(0.0, f64::NAN), None);
}

#[test]
fn the_auto_split_minimum_keeps_the_default_but_never_more_than_half_the_cap() {
    for (cap_min, expected) in [
        (60.0, 30.0),
        (180.0, 30.0),
        (45.0, 20.0),
        (40.0, 20.0),
        (10.0, 5.0),
        (5.0, 5.0),
    ] {
        assert_eq!(
            auto_split_min_session_min(cap_min, 30.0),
            expected,
            "{cap_min}"
        );
    }
}

#[test]
fn every_remaining_length_above_the_cap_splits_inside_the_bounds() {
    for cap_min in [5.0, 10.0, 15.0, 40.0, 45.0, 55.0, 60.0, 75.0, 120.0, 180.0] {
        for remaining_min in [
            cap_min + 5.0,
            cap_min + 10.0,
            2.0 * cap_min + 5.0,
            3.0 * cap_min - 5.0,
            5.0 * cap_min,
        ] {
            let mut long = auto_split("A", remaining_min, cap_min);
            long.due_at = Some("2026-12-09T00:00:00Z".to_owned());
            let mut month = input(vec![long]);
            month.horizon.end = "2026-12-09T00:00:00Z".to_owned();
            month.prefs.break_after_min = cap_min;
            let candidate = front_loaded(&month);
            assert!(
                candidate.feasible,
                "cap {cap_min}, remaining {remaining_min}"
            );
            assert!(!codes(&candidate).contains(&"heuristic_session_bounds_infeasible"));
        }
    }
}

// Auto-split explanation lines.

#[test]
fn places_a_long_non_splittable_task_as_legal_sessions_and_explains_it_once() {
    let scenario = input(vec![
        auto_split("A", 160.0, 60.0),
        after(unsplittable("B", 45.0), &["A"]),
    ]);
    let result = all(&scenario);
    assert!(!result.candidates.is_empty());
    for candidate in &result.candidates {
        assert!(candidate.feasible, "{}", candidate.policy);
        assert_eq!(audit(&scenario, &candidate.blocks, &[]), Vec::new());
        let sessions = block_minutes(candidate, "A");
        assert!(sessions.len() >= 3);
        assert!(sessions.iter().all(|minutes| *minutes <= 60));
        assert_eq!(sessions.iter().sum::<i64>(), 160);
        // The fitting non-splittable task stays one exact block.
        assert_eq!(block_minutes(candidate, "B"), [45]);

        assert_eq!(
            candidate.explanation.len(),
            candidate.explanation_items.len()
        );
        let index = codes(candidate)
            .iter()
            .position(|code| *code == "auto_split_long_task")
            .unwrap();
        assert_eq!(
            candidate.explanation_items[index].to_json(),
            serde_json::json!({
                "code": "auto_split_long_task",
                "params": {"taskId": "A", "sessionMaxMin": 60, "reason": "break_after"},
            })
        );
        assert_eq!(
            candidate.explanation[index],
            "Non-splittable task \"A\" is longer than the 60-minute limit before a break; scheduled in sessions of at most 60 min."
        );
        assert_eq!(
            codes(candidate)
                .iter()
                .filter(|code| **code == "auto_split_long_task")
                .count(),
            1
        );
    }
}

#[test]
fn names_the_daily_cap_when_that_is_the_binding_limit() {
    let mut long = auto_split("A", 200.0, 120.0);
    long.auto_split = Some(AutoSplitReason::DailyCap);
    let mut scenario = input(vec![long]);
    scenario.prefs.break_after_min = 0.0;
    scenario.prefs.max_daily_focus_min = 120.0;
    let candidate = front_loaded(&scenario);
    assert!(candidate.feasible);
    let index = codes(&candidate)
        .iter()
        .position(|code| *code == "auto_split_long_task")
        .unwrap();
    assert_eq!(
        candidate.explanation_items[index].params.to_json(),
        serde_json::json!({"taskId": "A", "sessionMaxMin": 120, "reason": "daily_cap"})
    );
    assert!(candidate.explanation[index].contains("the 120-minute daily focus cap"));
}

#[test]
fn adds_no_line_without_the_marker_or_for_a_non_splittable_task() {
    // The reference also ignores a marker with an unknown reason; here the
    // reason is an enum, so such a marker cannot be written at all.
    let mut plain = auto_split("A", 160.0, 60.0);
    plain.auto_split = None;
    let mut marked = unsplittable("B", 45.0);
    marked.auto_split = Some(AutoSplitReason::BreakAfter);
    for candidate in all(&input(vec![plain, marked])).candidates {
        assert!(!codes(&candidate).contains(&"auto_split_long_task"));
        assert_eq!(
            candidate.explanation.len(),
            candidate.explanation_items.len()
        );
    }
}

#[test]
fn caps_the_lines_so_a_candidate_stays_within_the_50_line_contract() {
    let tasks: Vec<Task> = (0..MAX_AUTO_SPLIT_LINES + 15)
        .map(|index| auto_split(&format!("T{index:02}"), 65.0, 60.0))
        .collect();
    let candidate = front_loaded(&input(tasks));
    let lines: Vec<_> = candidate
        .explanation_items
        .iter()
        .filter(|item| item.code.as_str() == "auto_split_long_task")
        .collect();
    assert_eq!(lines.len(), MAX_AUTO_SPLIT_LINES);
    assert_eq!(lines[0].params.to_json()["taskId"], "T00");
    assert!(candidate.explanation.len() <= 50);
    assert_eq!(
        candidate.explanation.len(),
        candidate.explanation_items.len()
    );
}

// heuristic_blocked_by_predecessor.

#[test]
fn names_the_unplaced_predecessor_instead_of_missing_available_time() {
    // A 160-minute single block can never satisfy the 60-minute break rule,
    // so the root stays unplaced and every successor waits on it.
    let chain = input(vec![
        unsplittable("A", 160.0),
        after(task("B"), &["A"]),
        after(task("C"), &["B"]),
    ]);
    for candidate in all(&chain).candidates {
        assert_eq!(candidate.blocks, Vec::new());
        let codes = codes(&candidate);
        assert!(codes.contains(&"heuristic_no_contiguous_window"));
        assert!(codes.contains(&"heuristic_blocked_by_predecessor"));
        assert!(!codes.contains(&"heuristic_insufficient_available_time"));
        let index = codes
            .iter()
            .position(|code| *code == "heuristic_blocked_by_predecessor")
            .unwrap();
        assert_eq!(
            candidate.explanation[index],
            "Heuristic reason: blocked_by_predecessor."
        );
    }
}

#[test]
fn is_reported_next_to_a_real_time_shortage_which_keeps_its_own_reason() {
    let mut early = task("D");
    early.due_at = Some("2026-11-09T09:30:00Z".to_owned());
    let scenario = input(vec![
        unsplittable("A", 160.0),
        after(task("B"), &["A"]),
        early,
    ]);
    for candidate in all(&scenario).candidates {
        let codes = codes(&candidate);
        assert!(codes.contains(&"heuristic_blocked_by_predecessor"));
        assert!(codes.contains(&"heuristic_insufficient_available_time"));
    }
}

#[test]
fn does_not_appear_when_nothing_is_blocked() {
    let chain = input(vec![
        auto_split("A", 160.0, 60.0),
        after(task("B"), &["A"]),
        after(task("C"), &["B"]),
    ]);
    for candidate in all(&chain).candidates {
        assert!(candidate.feasible);
        assert!(!codes(&candidate).contains(&"heuristic_blocked_by_predecessor"));
    }
    // A plain shortage without dependencies keeps the old reason only.
    let mut early = task("D");
    early.due_at = Some("2026-11-09T09:30:00Z".to_owned());
    for candidate in all(&input(vec![early])).candidates {
        let codes = codes(&candidate);
        assert!(codes.contains(&"heuristic_insufficient_available_time"));
        assert!(!codes.contains(&"heuristic_blocked_by_predecessor"));
    }
}
