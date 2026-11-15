//! `packages/scheduler/test/slots.test.ts`: DST wall-clock projection.
//!
//! The reference file also audits the same blocks with `validate`; those
//! assertions are in `tests/validate_slots.rs`.

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::slots::{compute_available_slots, max_contiguous_min, slot_total_min};
use ohmydate_scheduler::time::TimeError;
use ohmydate_scheduler::types::{
    AvailabilityRule, ExceptionKind, ExceptionRule, Horizon, ScheduleInput, Slot, Task,
};
use support::{prefs, rule};

fn make_task(estimate_min: f64, due_at: &str) -> Task {
    Task {
        due_at: Some(due_at.to_owned()),
        min_session_min: 30.0,
        max_session_min: 45.0,
        ..support::task("A", estimate_min)
    }
}

fn make_input(
    time_zone: &str,
    start: &str,
    end: &str,
    availability: Vec<AvailabilityRule>,
    exceptions: Vec<ExceptionRule>,
) -> ScheduleInput {
    ScheduleInput {
        now: start.to_owned(),
        time_zone: time_zone.to_owned(),
        horizon: Horizon {
            start: start.to_owned(),
            end: end.to_owned(),
        },
        tasks: vec![make_task(30.0, "2026-03-08T10:00:00Z")],
        availability,
        exceptions,
        commitments: Vec::new(),
        locked_blocks: Vec::new(),
        existing_blocks: None,
        affected_task_ids: None,
        prefs: prefs(480.0, 480.0),
        seed: 202.0,
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

fn timed(date: &str, kind: ExceptionKind, start_local: &str, end_local: &str) -> ExceptionRule {
    ExceptionRule {
        date: date.to_owned(),
        kind,
        start_local: Some(start_local.to_owned()),
        end_local: Some(end_local.to_owned()),
    }
}

#[test]
fn clips_the_new_york_spring_forward_gap() {
    let input = make_input(
        "America/New_York",
        "2026-03-08T05:00:00Z",
        "2026-03-08T10:00:00Z",
        vec![rule(7, "02:30", "03:30")],
        Vec::new(),
    );
    let found = compute_available_slots(&input).unwrap();
    assert_eq!(
        found,
        slots(&[("2026-03-08T07:00:00Z", "2026-03-08T07:30:00Z")])
    );
    assert_eq!(slot_total_min(&found), Ok(30.0));
}

#[test]
fn preserves_both_repetitions_of_the_new_york_autumn_fold_as_disjoint_intervals() {
    let input = make_input(
        "America/New_York",
        "2026-11-01T04:00:00Z",
        "2026-11-01T08:00:00Z",
        vec![rule(7, "01:15", "01:45")],
        Vec::new(),
    );
    let found = compute_available_slots(&input).unwrap();
    assert_eq!(
        found,
        slots(&[
            ("2026-11-01T05:15:00Z", "2026-11-01T05:45:00Z"),
            ("2026-11-01T06:15:00Z", "2026-11-01T06:45:00Z"),
        ])
    );
    assert_eq!(slot_total_min(&found), Ok(60.0));
    assert_eq!(max_contiguous_min(&found), Ok(30.0));
}

#[test]
fn does_not_assume_weekly_rules_are_grid_aligned() {
    let input = make_input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-10T00:00:00Z",
        vec![rule(1, "09:02", "09:12")],
        Vec::new(),
    );
    assert_eq!(
        compute_available_slots(&input).unwrap(),
        slots(&[("2026-11-09T09:05:00Z", "2026-11-09T09:10:00Z")])
    );
}

#[test]
fn applies_exact_fold_projection_to_timed_off_exceptions() {
    let input = make_input(
        "America/New_York",
        "2026-11-01T04:00:00Z",
        "2026-11-01T09:30:00Z",
        vec![rule(7, "00:00", "04:00")],
        vec![timed("2026-11-01", ExceptionKind::Off, "01:15", "01:45")],
    );
    let found = compute_available_slots(&input).unwrap();
    assert_eq!(
        found,
        slots(&[
            ("2026-11-01T04:00:00Z", "2026-11-01T05:15:00Z"),
            ("2026-11-01T05:45:00Z", "2026-11-01T06:15:00Z"),
            ("2026-11-01T06:45:00Z", "2026-11-01T09:00:00Z"),
        ])
    );
    assert_eq!(slot_total_min(&found), Ok(240.0));
}

#[test]
fn applies_gap_clipping_to_timed_extra_exceptions() {
    let input = make_input(
        "America/New_York",
        "2026-03-08T05:00:00Z",
        "2026-03-08T08:00:00Z",
        vec![rule(7, "00:00", "02:00")],
        vec![timed("2026-03-08", ExceptionKind::Extra, "02:30", "03:30")],
    );
    assert_eq!(
        compute_available_slots(&input).unwrap(),
        slots(&[("2026-03-08T05:00:00Z", "2026-03-08T07:30:00Z")])
    );
}

// Not in the reference file: what `computeAvailableSlots` does with the rest
// of its input, pinned from the reference's behaviour.

fn day_input(availability: Vec<AvailabilityRule>, exceptions: Vec<ExceptionRule>) -> ScheduleInput {
    make_input(
        "Asia/Seoul",
        "2026-11-12T15:00:00Z",
        "2026-11-14T15:00:00Z",
        availability,
        exceptions,
    )
}

fn untimed(date: &str, kind: ExceptionKind) -> ExceptionRule {
    ExceptionRule {
        date: date.to_owned(),
        kind,
        start_local: None,
        end_local: None,
    }
}

#[test]
fn exceptions_add_and_remove_time_on_their_own_date_only() {
    // Friday 2026-11-13 and Saturday 2026-11-14, Seoul time.
    let friday = rule(5, "09:00", "12:00");
    assert_eq!(
        compute_available_slots(&day_input(vec![friday.clone()], Vec::new())).unwrap(),
        slots(&[("2026-11-13T00:00:00Z", "2026-11-13T03:00:00Z")])
    );
    // A whole day off removes the day; a whole extra day adds 24 hours.
    assert_eq!(
        compute_available_slots(&day_input(
            vec![friday.clone()],
            vec![untimed("2026-11-13", ExceptionKind::Off)]
        ))
        .unwrap(),
        Vec::new()
    );
    assert_eq!(
        compute_available_slots(&day_input(
            vec![friday.clone()],
            vec![untimed("2026-11-14", ExceptionKind::Extra)]
        ))
        .unwrap(),
        slots(&[
            ("2026-11-13T00:00:00Z", "2026-11-13T03:00:00Z"),
            ("2026-11-13T15:00:00Z", "2026-11-14T15:00:00Z"),
        ])
    );
    // A whole day off wins over extra time on the same date.
    assert_eq!(
        compute_available_slots(&day_input(
            vec![friday.clone()],
            vec![
                timed("2026-11-13", ExceptionKind::Extra, "20:00", "23:00"),
                untimed("2026-11-13", ExceptionKind::Off),
            ]
        ))
        .unwrap(),
        Vec::new()
    );
    // An exception with only one end of its window does nothing.
    let mut half = timed("2026-11-13", ExceptionKind::Off, "10:00", "11:00");
    half.end_local = None;
    assert_eq!(
        compute_available_slots(&day_input(vec![friday.clone()], vec![half])).unwrap(),
        slots(&[("2026-11-13T00:00:00Z", "2026-11-13T03:00:00Z")])
    );
    // A date that is not spelled the way dates are printed matches no day.
    assert_eq!(
        compute_available_slots(&day_input(
            vec![friday],
            vec![untimed("20261113", ExceptionKind::Off)]
        ))
        .unwrap(),
        slots(&[("2026-11-13T00:00:00Z", "2026-11-13T03:00:00Z")])
    );
}

#[test]
fn commitments_and_locked_blocks_are_cut_out_and_edges_move_to_the_grid() {
    let mut input = day_input(vec![rule(5, "09:00", "12:00")], Vec::new());
    input.commitments = vec![ohmydate_scheduler::types::Commitment {
        // 09:58–10:31 local: off the grid on both sides.
        start: "2026-11-13T00:58:00Z".to_owned(),
        end: "2026-11-13T01:31:00Z".to_owned(),
    }];
    input.locked_blocks = vec![support::block(
        "A",
        "2026-11-13T02:00:00Z",
        "2026-11-13T02:30:00Z",
    )];
    assert_eq!(
        compute_available_slots(&input).unwrap(),
        slots(&[
            ("2026-11-13T00:00:00Z", "2026-11-13T00:55:00Z"),
            ("2026-11-13T01:35:00Z", "2026-11-13T02:00:00Z"),
            ("2026-11-13T02:30:00Z", "2026-11-13T03:00:00Z"),
        ])
    );
    // A backwards commitment cuts nothing.
    input.commitments[0].end = "2026-11-13T00:00:00Z".to_owned();
    assert_eq!(compute_available_slots(&input).unwrap().len(), 2);
}

#[test]
fn unreadable_input_is_an_error_only_where_the_reference_reads_it() {
    let friday = rule(5, "09:00", "12:00");
    let broken = |edit: fn(&mut ScheduleInput)| {
        let mut input = day_input(vec![rule(5, "09:00", "12:00")], Vec::new());
        edit(&mut input);
        compute_available_slots(&input)
    };
    assert_eq!(
        broken(|input| input.horizon.start = "soon".to_owned()),
        Err(TimeError::InvalidInstant)
    );
    assert_eq!(
        broken(|input| input.time_zone = "Mars/Olympus_Mons".to_owned()),
        Err(TimeError::UnknownTimeZone)
    );
    assert_eq!(
        broken(|input| input.availability[0].end_local = "noon".to_owned()),
        Err(TimeError::InvalidClock)
    );
    assert_eq!(
        broken(|input| input
            .commitments
            .push(ohmydate_scheduler::types::Commitment {
                start: "2026-11-13T00:00:00.0001Z".to_owned(),
                end: "2026-11-13T01:00:00Z".to_owned(),
            })),
        Err(TimeError::SubMillisecond)
    );
    assert_eq!(
        broken(|input| input
            .locked_blocks
            .push(support::block("A", "2026-11-13T00:00:00Z", "?"))),
        Err(TimeError::InvalidInstant)
    );

    // An empty horizon is answered before the zone or anything else is read.
    let mut reversed = day_input(vec![friday.clone()], Vec::new());
    std::mem::swap(&mut reversed.horizon.start, &mut reversed.horizon.end);
    reversed.time_zone = "Mars/Olympus_Mons".to_owned();
    assert_eq!(compute_available_slots(&reversed), Ok(Vec::new()));

    // A malformed clock on a weekday the horizon never reaches, or on a day
    // that is off, is never read.
    let unused = day_input(vec![friday.clone(), rule(2, "noon", "13:00")], Vec::new());
    assert_eq!(compute_available_slots(&unused).unwrap().len(), 1);
    let skipped = day_input(
        vec![rule(5, "noon", "13:00")],
        vec![untimed("2026-11-13", ExceptionKind::Off)],
    );
    assert_eq!(compute_available_slots(&skipped), Ok(Vec::new()));
    // A weekday outside 1–7 matches no day.
    let mut ninth = friday;
    ninth.weekday = 9.0;
    assert_eq!(
        compute_available_slots(&day_input(vec![ninth], Vec::new())),
        Ok(Vec::new())
    );
    assert_eq!(
        slot_total_min(&slots(&[("2026-11-13T00:00:00Z", "later")])),
        Err(TimeError::InvalidInstant)
    );
}
