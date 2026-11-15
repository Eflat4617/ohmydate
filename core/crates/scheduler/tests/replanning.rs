//! Replanning from `now` over an approved plan (06 §7):
//! `packages/scheduler/test/replanning.test.ts`,
//! `history-exemption.test.ts` and `fu59.test.ts`.
//!
//! Existing blocks that started before `now` are history: they are never
//! moved, never repeated in a candidate, and count against a new block (H1,
//! H6) without being held to today's rules themselves. Blocks from `now` on
//! are seeds: kept unless the change reaches their task.

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::generate::PlanCandidate;
use ohmydate_scheduler::types::{Block, ExceptionKind, PolicyName, ScheduleInput, Task};
use ohmydate_scheduler::validate::validate_input;
use support::minute_oracle::instant_ms;
use support::replan::{
    block_minutes, commitment, plan, symmetric_difference, task_blocks, task_minutes,
};
use support::{all_week_full_day, audit, block, exception, rule};

/// `2026-11-09T<clock>:00Z` (a Monday).
fn monday(clock: &str) -> String {
    format!("2026-11-09T{clock}:00Z")
}

fn on_monday(task_id: &str, start: &str, end: &str) -> Block {
    block(task_id, &monday(start), &monday(end))
}

fn only(input: &ScheduleInput, policy: PolicyName) -> PlanCandidate {
    plan(input, policy, input.seed)
}

/// The existing blocks that started before `now`.
fn history_of(input: &ScheduleInput) -> Vec<Block> {
    let now_ms = instant_ms(&input.now);
    input
        .existing()
        .iter()
        .filter(|block| instant_ms(&block.start) < now_ms)
        .cloned()
        .collect()
}

fn violation_kinds(input: &ScheduleInput, blocks: &[Block]) -> Vec<&'static str> {
    audit(input, blocks, &history_of(input))
        .iter()
        .map(|violation| violation.code.as_str())
        .collect()
}

fn blocks_of(candidate: &PlanCandidate, task_id: &str) -> Vec<Block> {
    candidate
        .blocks
        .iter()
        .filter(|block| block.task_id == task_id)
        .cloned()
        .collect()
}

fn first_start(candidate: &PlanCandidate, task_id: &str) -> i64 {
    blocks_of(candidate, task_id)
        .iter()
        .map(|block| instant_ms(&block.start))
        .min()
        .unwrap()
}

fn last_end(candidate: &PlanCandidate, task_id: &str) -> i64 {
    blocks_of(candidate, task_id)
        .iter()
        .map(|block| instant_ms(&block.end))
        .max()
        .unwrap()
}

fn sized(mut task: Task, minutes: f64) -> Task {
    task.estimate.p50_min = minutes;
    task.estimate.p90_min = minutes;
    task
}

fn after(mut task: Task, dependencies: &[&str]) -> Task {
    task.depends_on = dependencies.iter().map(|id| (*id).to_owned()).collect();
    task
}

// replanning.test.ts

/// An hour due on Monday 17:00, in sessions of 15–120 minutes.
fn make_task(id: &str) -> Task {
    Task {
        due_at: Some(monday("17:00")),
        min_session_min: 15.0,
        max_session_min: 120.0,
        ..support::task(id, 60.0)
    }
}

/// Monday 2026-11-09 in UTC, working 09:00–17:00.
fn make_input(now: &str, tasks: Vec<Task>, existing: &[Block]) -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-10T00:00:00Z",
        tasks,
        vec![rule(1, "09:00", "17:00")],
    );
    input.now = monday(now);
    input.existing_blocks = Some(existing.to_vec());
    input.seed = 4004.0;
    input
}

fn three_hours() -> Vec<Block> {
    vec![
        on_monday("A", "09:00", "10:00"),
        on_monday("B", "11:00", "12:00"),
        on_monday("C", "14:00", "15:00"),
    ]
}

fn three_tasks() -> Vec<Task> {
    vec![make_task("A"), make_task("B"), make_task("C")]
}

#[test]
fn fixes_past_and_in_progress_existing_blocks_and_never_places_before_now() {
    let mut second = make_task("B");
    second.priority = 2.0;
    let input = make_input(
        "12:00",
        vec![sized(make_task("A"), 180.0), second],
        &[
            on_monday("A", "10:00", "11:00"),
            on_monday("A", "11:30", "12:30"),
            on_monday("B", "14:00", "15:00"),
        ],
    );
    let now_ms = instant_ms(&input.now);
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(candidate.feasible, "{policy}");
        assert!(
            candidate
                .blocks
                .iter()
                .all(|block| instant_ms(&block.start) >= now_ms)
        );
        // The future block of B is kept; the two history blocks of A are
        // neither moved nor repeated.
        assert!(candidate.blocks.contains(&on_monday("B", "14:00", "15:00")));
        assert_eq!(
            violation_kinds(&input, &candidate.blocks),
            Vec::<&str>::new()
        );
        // Without `remainingMin` the whole estimate is still to do: the
        // caller, not the scheduler, says how much of it history covered.
        assert_eq!(task_minutes(&candidate.blocks, "A"), 180);
    }
}

#[test]
fn clips_a_brand_new_placement_to_now_even_without_existing_blocks() {
    let mut input = make_input("12:00", vec![make_task("A")], &[]);
    input.existing_blocks = None;
    let candidate = only(&input, PolicyName::FrontLoaded);
    assert!(candidate.feasible);
    assert_eq!(candidate.blocks, [on_monday("A", "12:00", "13:00")]);
}

#[test]
fn re_places_only_the_affected_task_and_keeps_untouched_blocks() {
    let existing = three_hours();
    let mut input = make_input("00:00", three_tasks(), &existing);
    input.commitments = vec![commitment(&monday("11:00"), &monday("12:00"))];
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(candidate.feasible, "{policy}");
        assert!((2.0..=3.0).contains(&candidate.metrics.changed_blocks));
        assert!(candidate.blocks.contains(&existing[0]));
        assert!(candidate.blocks.contains(&existing[2]));
        assert!(!candidate.blocks.contains(&existing[1]));
        if *policy == PolicyName::FrontLoaded {
            assert_eq!(candidate.metrics.changed_blocks, 2.0);
        }
    }
}

#[test]
fn returns_changed_blocks_0_for_an_unchanged_replan_in_every_policy() {
    let existing = three_hours();
    let input = make_input("00:00", three_tasks(), &existing);
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(candidate.feasible, "{policy}");
        assert_eq!(candidate.metrics.changed_blocks, 0.0);
        assert_eq!(symmetric_difference(&candidate.blocks, &existing), 0);
    }
}

#[test]
fn moves_a_block_a_new_commitment_overlaps_by_as_little_as_it_can() {
    // G04 in Seoul: the commitment covers the second half of A's hour.
    let mut input = make_input(
        "00:00",
        vec![make_task("A")],
        &[on_monday("A", "00:00", "01:00")],
    );
    input.time_zone = "Asia/Seoul".to_owned();
    input.commitments = vec![commitment(&monday("00:30"), &monday("01:30"))];
    let candidate = only(&input, PolicyName::FrontLoaded);
    assert!(candidate.feasible);
    assert_eq!(candidate.metrics.changed_blocks, 2.0);
    assert_eq!(candidate.blocks, [on_monday("A", "01:30", "02:30")]);

    // The same in UTC: the task moves behind the commitment as one block.
    let mut input = make_input(
        "00:00",
        vec![sized(make_task("A"), 120.0)],
        &[on_monday("A", "09:00", "11:00")],
    );
    input.commitments = vec![commitment(&monday("09:00"), &monday("10:00"))];
    let candidate = only(&input, PolicyName::FrontLoaded);
    assert!(candidate.feasible);
    assert_eq!(candidate.metrics.changed_blocks, 2.0);
    assert_eq!(candidate.blocks, [on_monday("A", "10:00", "12:00")]);
}

#[test]
fn excludes_locked_blocks_from_changed_blocks() {
    let mut input = make_input(
        "00:00",
        vec![sized(make_task("A"), 120.0)],
        &[on_monday("A", "09:00", "10:00")],
    );
    input.locked_blocks = vec![on_monday("A", "14:00", "15:00")];
    let candidate = only(&input, PolicyName::FrontLoaded);
    assert!(candidate.feasible);
    assert_eq!(candidate.metrics.changed_blocks, 0.0);
    // The locked hour is part of the plan but not of the candidate.
    assert_eq!(candidate.blocks, [on_monday("A", "09:00", "10:00")]);
}

#[test]
fn releases_only_the_seeds_that_tightened_preferences_no_longer_allow() {
    // Three approved hours on Monday; then the daily cap drops to two. No
    // task changed, so nothing is affected up front: the seeds are taken in
    // time order until one no longer passes, and only that task is released.
    let existing = [
        on_monday("A", "09:00", "10:00"),
        on_monday("B", "10:00", "11:00"),
        on_monday("C", "11:00", "12:00"),
    ];
    let tuesday = |mut task: Task| {
        task.due_at = Some("2026-11-10T17:00:00Z".to_owned());
        task
    };
    let mut input = make_input(
        "00:00",
        vec![
            tuesday(make_task("A")),
            tuesday(make_task("B")),
            tuesday(make_task("C")),
        ],
        &existing,
    );
    input.horizon.end = "2026-11-11T00:00:00Z".to_owned();
    input.availability = vec![rule(1, "09:00", "17:00"), rule(2, "09:00", "17:00")];
    // Under the old cap the plan is kept as it is.
    for policy in PolicyName::ALL {
        assert_eq!(only(&input, *policy).metrics.changed_blocks, 0.0);
    }
    input.prefs.max_daily_focus_min = 120.0;
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(candidate.feasible, "{policy}");
        assert_eq!(
            violation_kinds(&input, &candidate.blocks),
            Vec::<&str>::new()
        );
        assert!(candidate.blocks.contains(&existing[0]));
        assert!(candidate.blocks.contains(&existing[1]));
        assert_eq!(
            blocks_of(&candidate, "C"),
            [block("C", "2026-11-10T09:00:00Z", "2026-11-10T10:00:00Z")]
        );
        assert_eq!(candidate.metrics.changed_blocks, 2.0);
    }
}

#[test]
fn releases_a_seed_whose_remainder_is_below_the_minimum_session() {
    // N10: 90 minutes with a 60-minute seed would leave 30 < 45.
    let mut grown = sized(make_task("A"), 90.0);
    grown.min_session_min = 45.0;
    let input = make_input("00:00", vec![grown], &[on_monday("A", "09:00", "10:00")]);
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(candidate.feasible, "{policy}");
        assert_eq!(candidate.blocks, [on_monday("A", "09:00", "10:30")]);
    }
}

#[test]
fn releases_seeds_that_a_grown_or_newly_ordered_task_would_break() {
    // N6: A grew to 120 minutes and its successor B sits right behind it.
    let grown = make_input(
        "00:00",
        vec![sized(make_task("A"), 120.0), after(make_task("B"), &["A"])],
        &[
            on_monday("A", "09:00", "10:00"),
            on_monday("B", "10:00", "11:00"),
        ],
    );
    // N5: B now depends on A but was planned before it.
    let reordered = make_input(
        "00:00",
        vec![make_task("A"), after(make_task("B"), &["A"])],
        &[
            on_monday("B", "09:00", "10:00"),
            on_monday("A", "11:00", "12:00"),
        ],
    );
    for input in [grown, reordered] {
        for policy in PolicyName::ALL {
            let candidate = only(&input, *policy);
            assert!(candidate.feasible, "{policy}");
            assert!(first_start(&candidate, "B") >= last_end(&candidate, "A"));
            assert_eq!(
                violation_kinds(&input, &candidate.blocks),
                Vec::<&str>::new()
            );
        }
    }
}

#[test]
fn treats_past_blocks_as_history_for_h2_and_remaining_minutes() {
    let history = on_monday("A", "09:00", "10:00");
    let future = on_monday("A", "13:00", "14:00");
    // N2: the history block lies outside today's availability; nobody asks.
    let mut n2 = make_input(
        "12:00",
        vec![make_task("A")],
        std::slice::from_ref(&history),
    );
    n2.availability = vec![rule(1, "10:00", "17:00")];
    let candidate = only(&n2, PolicyName::FrontLoaded);
    assert!(candidate.feasible);
    assert_eq!(candidate.blocks, [on_monday("A", "12:00", "13:00")]);

    // N3: what remains is exactly the future block.
    let mut remaining = make_task("A");
    remaining.remaining_min = Some(60.0);
    let both = [history.clone(), future.clone()];
    let candidate = only(
        &make_input("12:00", vec![remaining], &both),
        PolicyName::FrontLoaded,
    );
    assert!(candidate.feasible);
    assert_eq!(candidate.blocks, [future]);
    assert_eq!(candidate.metrics.changed_blocks, 0.0);

    // N3b: less remains than the future block holds.
    let mut less = make_task("A");
    less.remaining_min = Some(30.0);
    less.min_session_min = 30.0;
    let candidate = only(
        &make_input("12:00", vec![less], &both),
        PolicyName::FrontLoaded,
    );
    assert!(candidate.feasible);
    assert_eq!(candidate.blocks.len(), 1);
    assert!(instant_ms(&candidate.blocks[0].start) >= instant_ms(&monday("12:00")));
    assert_eq!(block_minutes(&candidate.blocks[0]), 30);
}

#[test]
fn does_not_audit_a_past_block_against_a_new_full_day_off_exception() {
    let mut late = sized(make_task("A"), 120.0);
    late.due_at = Some("2026-11-10T17:00:00Z".to_owned());
    let mut input = make_input("12:00", vec![late], &[on_monday("A", "09:00", "10:00")]);
    input.horizon.end = "2026-11-11T00:00:00Z".to_owned();
    input.availability = vec![rule(1, "09:00", "17:00"), rule(2, "09:00", "17:00")];
    input.exceptions = vec![exception("2026-11-09", ExceptionKind::Off, None)];
    let candidate = only(&input, PolicyName::FrontLoaded);
    assert!(candidate.feasible);
    assert!(!candidate.blocks.is_empty());
    assert!(
        candidate
            .blocks
            .iter()
            .all(|block| instant_ms(&block.start) >= instant_ms("2026-11-10T00:00:00Z"))
    );
}

#[test]
fn counts_history_for_h1_and_h6_but_not_for_h2_h4_h5() {
    let history = [on_monday("A", "09:00", "10:00")];
    let mut input = make_input("12:00", vec![make_task("A")], &[]);
    input.availability = vec![rule(1, "00:00", "24:00")];
    input.prefs.max_daily_focus_min = 90.0;
    let kinds = |start: &str, end: &str, history: &[Block]| {
        audit(&input, &[on_monday("A", start, end)], history)
            .iter()
            .map(|violation| violation.code.as_str())
            .collect::<Vec<_>>()
    };
    // 60 past minutes + 60 new ones are over the 90-minute day.
    assert!(kinds("12:00", "13:00", &history).contains(&"H6"));
    assert!(!kinds("12:00", "13:00", &[]).contains(&"H6"));
    assert!(kinds("09:30", "10:30", &history).contains(&"H1"));
    assert!(!kinds("09:30", "10:30", &[]).contains(&"H1"));
}

#[test]
fn a_non_splittable_task_in_progress_needs_no_block() {
    // N16: remainingMin = 0 while its block is still running.
    let mut running = sized(make_task("A"), 90.0);
    running.splittable = false;
    running.remaining_min = Some(0.0);
    running.min_session_min = 90.0;
    running.max_session_min = 90.0;
    let mut second = make_task("B");
    second.priority = 2.0;
    let input = make_input(
        "12:00",
        vec![running, second],
        &[on_monday("A", "11:00", "12:30")],
    );
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(candidate.feasible, "{policy}");
        assert_eq!(blocks_of(&candidate, "A"), Vec::new());
        assert!(!blocks_of(&candidate, "B").is_empty());
        // B waits until the running block is over.
        assert!(first_start(&candidate, "B") >= instant_ms(&monday("12:30")));
    }
}

// history-exemption.test.ts (06 §7.1, C1–C5)

/// An hour in sessions of 30–120 minutes, with what is left of it.
fn remaining(id: &str, due_at: &str, estimate_min: f64, remaining_min: f64) -> Task {
    Task {
        due_at: Some(due_at.to_owned()),
        remaining_min: Some(remaining_min),
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task(id, estimate_min)
    }
}

/// Monday noon in UTC, Monday and Tuesday 09:00–17:00.
fn history_input(tasks: Vec<Task>, existing: &[Block]) -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-11T00:00:00Z",
        tasks,
        vec![rule(1, "09:00", "17:00"), rule(2, "09:00", "17:00")],
    );
    input.now = monday("12:00");
    input.existing_blocks = Some(existing.to_vec());
    input.seed = 39039.0;
    input
}

const TUESDAY_EVENING: &str = "2026-11-10T17:00:00Z";

/// Every policy plans the input, and the plan passes the validator next to
/// the history — which itself breaks today's rules.
fn assert_all_policies_feasible(input: &ScheduleInput) -> Vec<PlanCandidate> {
    PolicyName::ALL
        .iter()
        .map(|policy| {
            let candidate = only(input, *policy);
            assert!(candidate.feasible, "{policy}");
            assert!(!candidate.blocks.is_empty());
            assert_eq!(
                violation_kinds(input, &candidate.blocks),
                Vec::<&str>::new()
            );
            candidate
        })
        .collect()
}

#[test]
fn an_in_progress_history_block_overlapping_a_new_commitment_is_feasible() {
    // C1.
    let mut input = history_input(
        vec![remaining("A", TUESDAY_EVENING, 180.0, 120.0)],
        &[on_monday("A", "11:30", "12:30")],
    );
    input.commitments = vec![commitment(&monday("12:15"), &monday("13:00"))];
    for candidate in assert_all_policies_feasible(&input) {
        assert!(
            candidate
                .blocks
                .iter()
                .all(|block| instant_ms(&block.start) >= instant_ms(&monday("13:00")))
        );
    }
}

#[test]
fn a_past_commitment_overlapping_past_history_is_feasible() {
    // C2.
    let mut input = history_input(
        vec![remaining("A", &monday("17:00"), 60.0, 60.0)],
        &[on_monday("A", "10:00", "11:00")],
    );
    input.horizon.end = "2026-11-10T00:00:00Z".to_owned();
    input.commitments = vec![commitment(&monday("10:00"), &monday("11:00"))];
    assert_all_policies_feasible(&input);
}

#[test]
fn history_above_a_lowered_daily_cap_is_feasible() {
    // C3: a past day with five hours under a four-hour cap.
    let mut input = history_input(
        vec![remaining("A", &monday("17:00"), 60.0, 60.0)],
        &[block("A", "2026-11-08T09:00:00Z", "2026-11-08T14:00:00Z")],
    );
    input.horizon.start = "2026-11-08T00:00:00Z".to_owned();
    input.horizon.end = "2026-11-10T00:00:00Z".to_owned();
    input.prefs.max_daily_focus_min = 240.0;
    let now_ms = instant_ms(&input.now);
    for candidate in assert_all_policies_feasible(&input) {
        assert!(
            candidate
                .blocks
                .iter()
                .all(|block| instant_ms(&block.start) >= now_ms)
        );
    }

    // C3b: today is already over the cap, so the plan moves to Tuesday.
    let mut input = history_input(
        vec![remaining("A", TUESDAY_EVENING, 60.0, 60.0)],
        &[on_monday("A", "09:00", "12:00")],
    );
    input.prefs.max_daily_focus_min = 120.0;
    for candidate in assert_all_policies_feasible(&input) {
        assert!(
            candidate
                .blocks
                .iter()
                .all(|block| instant_ms(&block.start) >= instant_ms("2026-11-10T00:00:00Z"))
        );
    }
}

#[test]
fn a_history_only_run_above_the_lowered_break_limit_is_feasible() {
    // C4.
    let mut input = history_input(
        vec![remaining("A", TUESDAY_EVENING, 60.0, 60.0)],
        &[on_monday("A", "09:00", "12:00")],
    );
    input.prefs.break_after_min = 120.0;
    assert_all_policies_feasible(&input);
}

#[test]
fn a_locked_block_over_in_progress_history_is_feasible() {
    // C5.
    let mut input = history_input(
        vec![remaining("A", TUESDAY_EVENING, 120.0, 120.0)],
        &[on_monday("A", "11:30", "12:30")],
    );
    input.locked_blocks = vec![on_monday("A", "12:00", "13:00")];
    assert_all_policies_feasible(&input);
}

#[test]
fn an_audited_block_is_still_held_against_history() {
    let hour = |minutes: f64| Task {
        due_at: Some(monday("17:00")),
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task("A", minutes)
    };
    let around_the_clock = |task: Task, existing: Block| {
        let mut input = history_input(vec![task], &[existing]);
        input.availability = all_week_full_day();
        input
    };
    // Overlapping history is H1.
    let input = around_the_clock(hour(60.0), on_monday("A", "09:00", "10:00"));
    assert!(violation_kinds(&input, &[on_monday("A", "09:30", "10:30")]).contains(&"H1"));
    assert!(!violation_kinds(&input, &[on_monday("A", "12:00", "13:00")]).contains(&"H1"));

    // History plus the audited block over the daily cap is H6.
    let mut input = around_the_clock(hour(60.0), on_monday("A", "09:00", "10:00"));
    input.prefs.max_daily_focus_min = 90.0;
    assert!(violation_kinds(&input, &[on_monday("A", "12:00", "13:00")]).contains(&"H6"));

    // A run that joins history into the audited block is H6.
    let mut whole = hour(90.0);
    whole.min_session_min = 90.0;
    whole.max_session_min = 90.0;
    let mut input = around_the_clock(whole, on_monday("A", "09:00", "11:00"));
    input.prefs.break_after_min = 120.0;
    assert!(violation_kinds(&input, &[on_monday("A", "11:00", "12:30")]).contains(&"H6"));
    // After a break the same block is fine.
    assert!(!violation_kinds(&input, &[on_monday("A", "11:15", "12:45")]).contains(&"H6"));
}

// fu59.test.ts: `affectedTaskIds`, the caller-supplied scope (06 §7.1).
//
// It lets the replan caller scope dependency edits the scheduler cannot see
// (a removed edge, or a new edge whose existing blocks already satisfy the
// order). The explicit ids join the affected set and its successors;
// everything else stays frozen. The staged predecessor expansion still
// releases only the dependency depth that is actually needed.

fn scope_task(id: &str, minutes: f64) -> Task {
    Task {
        due_at: Some("2026-11-11T00:00:00Z".to_owned()),
        min_session_min: 30.0,
        max_session_min: 120.0,
        priority: 2.0,
        ..support::task(id, minutes)
    }
}

/// Two days in UTC, 09:00–17:00 every day, replanned by `front_loaded`.
fn scoped(tasks: Vec<Task>, existing: &[Block], scope: Option<&[&str]>) -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-11T00:00:00Z",
        tasks,
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", "17:00"))
            .collect(),
    );
    input.existing_blocks = Some(existing.to_vec());
    input.affected_task_ids = scope.map(|ids| ids.iter().map(|id| (*id).to_owned()).collect());
    input.seed = 59.0;
    input
}

fn front_loaded(input: &ScheduleInput) -> PlanCandidate {
    plan(input, PolicyName::FrontLoaded, 59.0)
}

/// A and B used to be linked by A → B; the edge was removed. Every existing
/// block still looks valid, so the scheduler alone sees nothing to release.
fn unlinked() -> Vec<Block> {
    vec![
        on_monday("A", "09:00", "10:00"),
        on_monday("D", "10:00", "11:00"),
        on_monday("B", "15:00", "16:00"),
    ]
}

fn abd() -> Vec<Task> {
    vec![
        scope_task("A", 60.0),
        scope_task("B", 60.0),
        scope_task("D", 60.0),
    ]
}

#[test]
fn keeps_every_block_frozen_when_the_caller_passes_no_scope() {
    let candidate = front_loaded(&scoped(abd(), &unlinked(), None));
    assert!(candidate.feasible);
    assert_eq!(candidate.metrics.changed_blocks, 0.0);
    assert_eq!(symmetric_difference(&candidate.blocks, &unlinked()), 0);
}

#[test]
fn releases_both_endpoints_of_a_removed_dependency_edge_and_freezes_the_rest() {
    let existing = unlinked();
    let candidate = front_loaded(&scoped(abd(), &existing, Some(&["A", "B"])));
    assert!(candidate.feasible);
    // B is released: front_loaded pulls it out of the late 15:00 slot.
    assert_ne!(
        task_blocks(&candidate.blocks, "B"),
        task_blocks(&existing, "B")
    );
    // D is outside the scope and stays exactly where it was.
    assert_eq!(
        task_blocks(&candidate.blocks, "D"),
        task_blocks(&existing, "D")
    );
    // At most 2 × (A's and B's existing blocks) + 2.
    assert!(candidate.metrics.changed_blocks > 0.0 && candidate.metrics.changed_blocks <= 6.0);
}

#[test]
fn releases_an_already_in_order_new_edge_only_when_the_caller_names_it() {
    // B → A is new but A already ends before B starts: undetectable.
    let existing = unlinked();
    let tasks = || {
        vec![
            scope_task("A", 60.0),
            after(scope_task("B", 60.0), &["A"]),
            scope_task("D", 60.0),
        ]
    };
    let without = front_loaded(&scoped(tasks(), &existing, None));
    assert_eq!(without.metrics.changed_blocks, 0.0);
    assert_eq!(
        task_blocks(&without.blocks, "B"),
        task_blocks(&existing, "B")
    );

    let named = front_loaded(&scoped(tasks(), &existing, Some(&["A", "B"])));
    assert!(named.feasible);
    assert_ne!(task_blocks(&named.blocks, "B"), task_blocks(&existing, "B"));
    assert_eq!(task_blocks(&named.blocks, "D"), task_blocks(&existing, "D"));
    // H3 still holds for the re-placed pair.
    assert!(last_end(&named, "A") <= first_start(&named, "B"));
}

#[test]
fn propagates_the_explicit_scope_to_transitive_successors() {
    let existing = [
        on_monday("A", "09:00", "10:00"),
        on_monday("D", "10:00", "11:00"),
        on_monday("C", "16:00", "17:00"),
    ];
    let tasks = vec![
        scope_task("A", 60.0),
        after(scope_task("C", 60.0), &["A"]),
        scope_task("D", 60.0),
    ];
    let candidate = front_loaded(&scoped(tasks, &existing, Some(&["A"])));
    assert!(candidate.feasible);
    // C depends on A, so it is released with A and moves out of 16:00.
    assert_ne!(
        task_blocks(&candidate.blocks, "C"),
        task_blocks(&existing, "C")
    );
    assert_eq!(
        task_blocks(&candidate.blocks, "D"),
        task_blocks(&existing, "D")
    );
}

#[test]
fn ignores_unknown_ids_and_hashes_the_scope_as_a_set() {
    let existing = unlinked();
    let plain = front_loaded(&scoped(abd(), &existing, None));
    let ghost_input = scoped(abd(), &existing, Some(&["ghost"]));
    let ghost = front_loaded(&ghost_input);
    assert_eq!(ghost.blocks, plain.blocks);
    assert_eq!(ghost.metrics, plain.metrics);
    // The explicit scope is part of the hashed input, but only when supplied.
    assert_ne!(ghost.input_hash, plain.input_hash);
    assert_eq!(validate_input(&ghost_input), Vec::new());

    // Order and duplicates do not matter.
    let first = front_loaded(&scoped(abd(), &existing, Some(&["B", "A"])));
    let second = front_loaded(&scoped(abd(), &existing, Some(&["A", "B", "A"])));
    assert_eq!(second.input_hash, first.input_hash);
    assert_eq!(second.blocks, first.blocks);
    // Another set is another input.
    let other = front_loaded(&scoped(abd(), &existing, Some(&["A"])));
    assert_ne!(other.input_hash, first.input_hash);
}

/// The chain P2 → P1 → X, where X grew from 60 to 90 minutes.
fn chain(x_due: &str) -> ScheduleInput {
    let mut grown = after(scope_task("X", 90.0), &["P1"]);
    grown.due_at = Some(monday(x_due));
    scoped(
        vec![
            scope_task("P2", 30.0),
            after(scope_task("P1", 60.0), &["P2"]),
            grown,
        ],
        &chain_blocks(),
        Some(&["X"]),
    )
}

fn chain_blocks() -> Vec<Block> {
    vec![
        on_monday("P2", "09:00", "09:30"),
        on_monday("P1", "10:00", "11:00"),
        on_monday("X", "11:00", "12:00"),
    ]
}

#[test]
fn releases_no_predecessor_when_the_initial_scope_is_feasible() {
    let existing = chain_blocks();
    let candidate = front_loaded(&chain("17:00"));
    assert!(candidate.feasible);
    assert_eq!(
        task_blocks(&candidate.blocks, "P1"),
        task_blocks(&existing, "P1")
    );
    assert_eq!(
        task_blocks(&candidate.blocks, "P2"),
        task_blocks(&existing, "P2")
    );
    assert_eq!(task_minutes(&candidate.blocks, "X"), 90);
}

#[test]
fn releases_only_the_depth_that_is_required() {
    // X is due at 12:00. With P1 frozen at 10:00-11:00 only 60 minutes remain
    // after it; releasing P1 (depth 1) lets it start at 09:30 so X fits, and
    // P2 (depth 2) is never released.
    let existing = chain_blocks();
    let candidate = front_loaded(&chain("12:00"));
    assert!(candidate.feasible);
    assert_eq!(
        task_blocks(&candidate.blocks, "P2"),
        task_blocks(&existing, "P2")
    );
    assert_ne!(
        task_blocks(&candidate.blocks, "P1"),
        task_blocks(&existing, "P1")
    );
    assert!(last_end(&candidate, "P1") <= first_start(&candidate, "X"));
    assert!(
        candidate
            .blocks
            .iter()
            .all(|block| instant_ms(&block.end) <= instant_ms(&monday("12:00")))
    );
}

#[test]
fn returns_an_explained_infeasible_candidate_when_even_full_expansion_cannot_fit() {
    // Due 11:30: P2 + P1 + X need 180 minutes after 09:00 — impossible.
    let candidate = front_loaded(&chain("11:30"));
    assert!(!candidate.feasible);
    assert!(candidate.deficit_min > 0.0);
    assert!(!candidate.explanation.is_empty());
}
