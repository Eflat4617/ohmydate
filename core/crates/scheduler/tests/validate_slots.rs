//! The `validate` assertions of `packages/scheduler/test/slots.test.ts` and
//! `transitions.test.ts`: the validator audits the same blocks the slot
//! tests (`tests/slots.rs`, `tests/transitions.rs`) compute, across DST
//! gaps, folds and backward local-date transitions.
//!
//! The reference's "validator oracle runaway transition guard" test is
//! `validate::local::tests::a_runaway_transition_walk_stops_at_the_guard`.

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::types::{AvailabilityRule, Block, ScheduleInput, Task};
use support::{all_week_full_day, block, codes, rule, task};

const NONE: [&str; 0] = [];

fn slots_input(
    time_zone: &str,
    start: &str,
    end: &str,
    availability: Vec<AvailabilityRule>,
    task: Task,
) -> ScheduleInput {
    let mut input = support::input(time_zone, start, end, vec![task], availability);
    input.seed = 202.0;
    input
}

fn due(estimate_min: f64, due_at: &str, min_session: f64, max_session: f64) -> Task {
    Task {
        due_at: Some(due_at.to_owned()),
        min_session_min: min_session,
        max_session_min: max_session,
        ..task("A", estimate_min)
    }
}

#[test]
fn a_block_in_the_slot_left_by_the_new_york_spring_forward_gap_is_valid() {
    let input = slots_input(
        "America/New_York",
        "2026-03-08T05:00:00Z",
        "2026-03-08T10:00:00Z",
        vec![rule(7, "02:30", "03:30")],
        due(30.0, "2026-03-08T10:00:00Z", 30.0, 45.0),
    );
    assert_eq!(
        codes(
            &input,
            &[block("A", "2026-03-08T07:00:00Z", "2026-03-08T07:30:00Z")]
        ),
        NONE
    );
    // The skipped local hour is not available.
    assert!(
        codes(
            &input,
            &[block("A", "2026-03-08T06:30:00Z", "2026-03-08T07:00:00Z")]
        )
        .contains(&"H2")
    );
}

#[test]
fn both_repetitions_of_the_autumn_fold_are_available_and_the_time_between_is_not() {
    let input = slots_input(
        "America/New_York",
        "2026-11-01T04:00:00Z",
        "2026-11-01T08:00:00Z",
        vec![rule(7, "01:15", "01:45")],
        due(60.0, "2026-11-01T08:00:00Z", 30.0, 45.0),
    );
    assert_eq!(
        codes(
            &input,
            &[
                block("A", "2026-11-01T05:15:00Z", "2026-11-01T05:45:00Z"),
                block("A", "2026-11-01T06:15:00Z", "2026-11-01T06:45:00Z"),
            ]
        ),
        NONE
    );
    assert!(
        codes(
            &input,
            &[block("A", "2026-11-01T05:45:00Z", "2026-11-01T06:15:00Z")]
        )
        .contains(&"H2")
    );
}

#[test]
fn rules_off_the_grid_are_audited_by_the_minute() {
    let input = slots_input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-10T00:00:00Z",
        vec![rule(1, "09:02", "09:12")],
        due(5.0, "2026-11-09T10:00:00Z", 5.0, 5.0),
    );
    assert_eq!(
        codes(
            &input,
            &[block("A", "2026-11-09T09:05:00Z", "2026-11-09T09:10:00Z")]
        ),
        NONE
    );
    assert!(
        codes(
            &input,
            &[block("A", "2026-11-09T09:10:00Z", "2026-11-09T09:15:00Z")]
        )
        .contains(&"H2")
    );
}

// transitions.test.ts: ADR-017 backward local-date transitions.

fn transition_input(
    start: &str,
    end: &str,
    availability: Vec<AvailabilityRule>,
    task: Task,
    max_daily_focus_min: f64,
) -> ScheduleInput {
    let mut input = support::input("America/Goose_Bay", start, end, vec![task], availability);
    input.prefs = support::prefs(max_daily_focus_min, 1440.0);
    input.seed = 17017.0;
    input
}

fn rollback_block() -> Block {
    block("A", "2009-11-01T02:30:00Z", "2009-11-01T04:00:00Z")
}

fn h2_block() -> Block {
    block("A", "2009-11-01T03:00:00Z", "2009-11-01T03:30:00Z")
}

fn rollback_availability() -> Vec<AvailabilityRule> {
    vec![rule(6, "23:10", "23:20"), rule(7, "00:00", "00:01")]
}

#[test]
fn h6_rejects_a_daily_cap_overflow_when_a_rollback_revisits_the_previous_date() {
    let input = transition_input(
        "2009-11-01T02:30:00Z",
        "2009-11-01T04:30:00Z",
        all_week_full_day(),
        task("A", 90.0),
        60.0,
    );
    assert_eq!(codes(&input, &[rollback_block()]), ["H6"]);
    // 89 of the 90 minutes are on 2009-10-31: a cap of 89 holds them.
    let mut roomy = input;
    roomy.prefs.max_daily_focus_min = 89.0;
    assert_eq!(codes(&roomy, &[rollback_block()]), NONE);
}

#[test]
fn h6_audits_the_same_rollback_when_supplied_as_historical_locked_work() {
    let mut input = transition_input(
        "2026-11-09T00:00:00Z",
        "2026-11-11T00:00:00Z",
        all_week_full_day(),
        task("A", 90.0),
        60.0,
    );
    input.locked_blocks = vec![rollback_block()];
    assert_eq!(codes(&input, &[]), ["H6"]);
}

#[test]
fn h2_enumerates_both_local_dates_of_a_block_that_ends_on_an_earlier_date() {
    let short = Task {
        max_session_min: 120.0,
        ..task("A", 30.0)
    };
    let input = transition_input(
        "2009-11-01T02:30:00Z",
        "2009-11-01T04:30:00Z",
        rollback_availability(),
        short.clone(),
        1440.0,
    );
    assert_eq!(codes(&input, &[h2_block()]), ["H2"]);

    // The same block as historical locked work.
    let mut locked = transition_input(
        "2026-11-09T00:00:00Z",
        "2026-11-11T00:00:00Z",
        rollback_availability(),
        short,
        1440.0,
    );
    locked.locked_blocks = vec![h2_block()];
    assert_eq!(codes(&locked, &[]), ["H2"]);
}

#[test]
fn a_block_over_the_whole_goose_bay_rollback_is_valid() {
    let input = transition_input(
        "2009-11-01T02:30:00Z",
        "2009-11-01T04:30:00Z",
        all_week_full_day(),
        task("A", 120.0),
        1440.0,
    );
    assert_eq!(
        codes(
            &input,
            &[block("A", "2009-11-01T02:30:00Z", "2009-11-01T04:30:00Z")]
        ),
        NONE
    );
}

#[test]
fn h6_aggregates_multiple_blocks_on_a_revisited_local_date() {
    let input = transition_input(
        "2009-10-31T22:00:00Z",
        "2009-11-01T06:00:00Z",
        all_week_full_day(),
        task("A", 100.0),
        90.0,
    );
    let blocks = [
        block("A", "2009-11-01T02:00:00Z", "2009-11-01T02:50:00Z"),
        block("A", "2009-11-01T03:05:00Z", "2009-11-01T03:55:00Z"),
    ];
    let violations = support::audit(&input, &blocks, &[]);
    assert_eq!(violations.len(), 1);
    assert_eq!(
        violations[0].message,
        "Daily focus on 2009-10-31 is 100 minutes, above 90."
    );
}
