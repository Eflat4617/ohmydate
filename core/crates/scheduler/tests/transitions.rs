//! `packages/scheduler/test/transitions.test.ts`: ADR-017 across backward
//! transitions, 30-minute DST and the FU-13 edge fixtures, checked against
//! the independent one-minute oracle.
//!
//! The reference file also audits blocks with `validate`; those assertions
//! are in `tests/validate_slots.rs`. Its two "runaway transition guard"
//! tests replace Temporal with a stub; here the guard is tested where the
//! walk is (`time::tests::a_runaway_transition_walk_stops_at_the_guard`).

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::slots::{compute_available_slots, slot_total_min};
use ohmydate_scheduler::types::{AvailabilityRule, Block, Horizon, ScheduleInput, Slot, Task};
use support::minute_oracle::{
    aligned_available_slot_minutes, aligned_available_slots, available_slot_minutes,
    daily_loads_by_minute, has_daily_cap_violation_by_minute, instant_ms, is_covered_by_minutes,
    load_on,
};
use support::{all_week_full_day, block, prefs, rule, task};

const MINUTE_MS: i64 = 60 * 1000;

fn make_input(
    time_zone: &str,
    start: &str,
    end: &str,
    availability: Vec<AvailabilityRule>,
    task: Task,
    max_daily_focus_min: f64,
) -> ScheduleInput {
    ScheduleInput {
        now: start.to_owned(),
        time_zone: time_zone.to_owned(),
        horizon: Horizon {
            start: start.to_owned(),
            end: end.to_owned(),
        },
        tasks: vec![task],
        availability,
        exceptions: Vec::new(),
        commitments: Vec::new(),
        locked_blocks: Vec::new(),
        existing_blocks: None,
        affected_task_ids: None,
        prefs: prefs(max_daily_focus_min, 1440.0),
        seed: 17017.0,
    }
}

fn slots(pairs: &[(&str, &str)]) -> Vec<Slot> {
    pairs
        .iter()
        .map(|(start, end)| Slot {
            start: (*start).to_owned(),
            end: (*end).to_owned(),
        })
        .collect()
}

#[allow(clippy::cast_precision_loss)]
fn minutes(count: i64) -> f64 {
    count as f64
}

fn goose_bay_rollback_block() -> Block {
    block("A", "2009-11-01T02:30:00Z", "2009-11-01T04:00:00Z")
}

fn goose_bay_h2_block() -> Block {
    block("A", "2009-11-01T03:00:00Z", "2009-11-01T03:30:00Z")
}

fn goose_bay_rollback_availability() -> Vec<AvailabilityRule> {
    vec![rule(6, "23:10", "23:20"), rule(7, "00:00", "00:01")]
}

// ADR-017 backward local-date transitions.

#[test]
fn a_rollback_revisits_the_previous_date_and_overflows_its_daily_cap() {
    let input = make_input(
        "America/Goose_Bay",
        "2009-11-01T02:30:00Z",
        "2009-11-01T04:30:00Z",
        all_week_full_day(),
        task("A", 90.0),
        60.0,
    );
    let blocks = [goose_bay_rollback_block()];
    assert!(has_daily_cap_violation_by_minute(&input, &blocks));
    let loads = daily_loads_by_minute(&blocks, &input.time_zone);
    assert_eq!(load_on(&loads, "2009-10-31"), 89);
    assert_eq!(load_on(&loads, "2009-11-01"), 1);
}

#[test]
fn a_block_that_ends_on_an_earlier_date_is_not_covered_on_both_dates() {
    for (start, end) in [
        ("2009-11-01T02:30:00Z", "2009-11-01T04:30:00Z"),
        ("2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z"),
    ] {
        let input = make_input(
            "America/Goose_Bay",
            start,
            end,
            goose_bay_rollback_availability(),
            Task {
                max_session_min: 120.0,
                ..task("A", 30.0)
            },
            1440.0,
        );
        let block = goose_bay_h2_block();
        assert!(!is_covered_by_minutes(
            &input,
            instant_ms(&block.start),
            instant_ms(&block.end)
        ));
    }
}

#[test]
fn preserves_every_available_minute_across_the_goose_bay_rollback() {
    let input = make_input(
        "America/Goose_Bay",
        "2009-11-01T02:30:00Z",
        "2009-11-01T04:30:00Z",
        all_week_full_day(),
        task("A", 120.0),
        1440.0,
    );
    let found = compute_available_slots(&input).unwrap();
    assert_eq!(
        found,
        slots(&[("2009-11-01T02:30:00Z", "2009-11-01T04:30:00Z")])
    );
    assert_eq!(slot_total_min(&found), Ok(120.0));
    assert_eq!(available_slot_minutes(&input), 120);
}

// ADR-017 30-minute DST in Australia/Lord_Howe.

#[test]
fn preserves_both_repetitions_of_a_30_minute_fold_as_disjoint_intervals() {
    let input = make_input(
        "Australia/Lord_Howe",
        "2026-04-04T13:00:00Z",
        "2026-04-04T17:00:00Z",
        vec![rule(7, "01:45", "02:00")],
        task("A", 60.0),
        1440.0,
    );
    let found = compute_available_slots(&input).unwrap();
    assert_eq!(
        found,
        slots(&[
            ("2026-04-04T14:45:00Z", "2026-04-04T15:00:00Z"),
            ("2026-04-04T15:15:00Z", "2026-04-04T15:30:00Z"),
        ])
    );
    assert_eq!(slot_total_min(&found), Ok(30.0));
    assert_eq!(available_slot_minutes(&input), 30);
}

#[test]
fn clips_the_30_minute_spring_gap_without_inventing_wall_time() {
    let input = make_input(
        "Australia/Lord_Howe",
        "2026-10-03T13:00:00Z",
        "2026-10-03T17:00:00Z",
        vec![rule(7, "01:45", "02:45")],
        task("A", 60.0),
        1440.0,
    );
    let found = compute_available_slots(&input).unwrap();
    assert_eq!(
        found,
        slots(&[("2026-10-03T15:15:00Z", "2026-10-03T15:45:00Z")])
    );
    assert_eq!(slot_total_min(&found), Ok(30.0));
    assert_eq!(available_slot_minutes(&input), 30);
}

// ADR-017 minute-level invariants.

#[test]
fn projects_full_day_availability_without_losing_time_at_a_transition() {
    let input = make_input(
        "America/St_Johns",
        "2026-11-01T00:00:00Z",
        "2026-11-01T06:00:00Z",
        all_week_full_day(),
        task("A", 60.0),
        1440.0,
    );
    let horizon_min =
        (instant_ms(&input.horizon.end) - instant_ms(&input.horizon.start)) / MINUTE_MS;
    assert_eq!(
        slot_total_min(&compute_available_slots(&input).unwrap()),
        Ok(minutes(horizon_min))
    );
}

// FU-13 edge fixtures.

struct Fixture {
    name: &'static str,
    time_zone: &'static str,
    start: &'static str,
    end: &'static str,
    availability: Vec<AvailabilityRule>,
    expected: Vec<Slot>,
}

fn fixtures() -> Vec<Fixture> {
    vec![
        Fixture {
            name: "St_Johns 2009 rollback full day",
            time_zone: "America/St_Johns",
            start: "2009-11-01T02:00:00Z",
            end: "2009-11-01T05:00:00Z",
            availability: all_week_full_day(),
            expected: slots(&[("2009-11-01T02:00:00Z", "2009-11-01T05:00:00Z")]),
        },
        Fixture {
            name: "St_Johns 2009 rollback local window",
            time_zone: "America/St_Johns",
            start: "2009-11-01T02:00:00Z",
            end: "2009-11-01T05:00:00Z",
            availability: vec![rule(7, "00:00", "01:00")],
            expected: slots(&[("2009-11-01T03:30:00Z", "2009-11-01T04:30:00Z")]),
        },
        Fixture {
            name: "Santiago April fold repeated hour",
            time_zone: "America/Santiago",
            start: "2026-04-05T02:00:00Z",
            end: "2026-04-05T06:00:00Z",
            availability: vec![rule(6, "23:00", "24:00")],
            expected: slots(&[("2026-04-05T02:00:00Z", "2026-04-05T04:00:00Z")]),
        },
        Fixture {
            name: "Apia 2011 skipped Friday",
            time_zone: "Pacific/Apia",
            start: "2011-12-29T00:00:00Z",
            end: "2011-12-31T00:00:00Z",
            availability: vec![rule(5, "00:00", "24:00")],
            expected: Vec::new(),
        },
        Fixture {
            name: "Troll two-hour spring gap full day",
            time_zone: "Antarctica/Troll",
            start: "2026-03-29T00:00:00Z",
            end: "2026-03-29T06:00:00Z",
            availability: all_week_full_day(),
            expected: slots(&[("2026-03-29T00:00:00Z", "2026-03-29T06:00:00Z")]),
        },
        Fixture {
            name: "Troll two-hour spring gap local window",
            time_zone: "Antarctica/Troll",
            start: "2026-03-29T00:00:00Z",
            end: "2026-03-29T06:00:00Z",
            availability: vec![rule(7, "00:00", "04:00")],
            expected: slots(&[("2026-03-29T00:00:00Z", "2026-03-29T02:00:00Z")]),
        },
        Fixture {
            name: "Lord_Howe 30-minute fold",
            time_zone: "Australia/Lord_Howe",
            start: "2026-04-04T13:00:00Z",
            end: "2026-04-04T17:00:00Z",
            availability: vec![rule(7, "01:45", "02:15")],
            expected: slots(&[
                ("2026-04-04T14:45:00Z", "2026-04-04T15:00:00Z"),
                ("2026-04-04T15:15:00Z", "2026-04-04T15:45:00Z"),
            ]),
        },
    ]
}

#[test]
fn the_edge_fixtures_match_the_exact_minute_walk_intervals() {
    for fixture in fixtures() {
        let input = make_input(
            fixture.time_zone,
            fixture.start,
            fixture.end,
            fixture.availability,
            task("A", 60.0),
            1440.0,
        );
        let found = compute_available_slots(&input).unwrap();
        assert_eq!(found, fixture.expected, "{}", fixture.name);
        assert_eq!(found, aligned_available_slots(&input), "{}", fixture.name);
        assert_eq!(
            slot_total_min(&found),
            Ok(minutes(aligned_available_slot_minutes(&input))),
            "{}",
            fixture.name
        );
        assert!(
            slot_total_min(&found).unwrap() <= minutes(available_slot_minutes(&input)),
            "{}",
            fixture.name
        );
    }
}

#[test]
fn several_blocks_on_a_revisited_local_date_add_up() {
    let input = make_input(
        "America/Goose_Bay",
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
    assert!(has_daily_cap_violation_by_minute(&input, &blocks));
    let loads = daily_loads_by_minute(&blocks, &input.time_zone);
    assert_eq!(load_on(&loads, "2009-10-31"), 100);
    assert_eq!(load_on(&loads, "2009-11-01"), 0);
    // Without the cap the same blocks are fine.
    let mut relaxed = input;
    relaxed.prefs.max_daily_focus_min = 100.0;
    assert!(!has_daily_cap_violation_by_minute(&relaxed, &blocks));
}
