//! `packages/scheduler/test/validate.test.ts`: the hard-constraint validator
//! and the hardening of minute-valued input.

#![allow(clippy::unwrap_used)]

mod support;

use ohmydate_scheduler::slots::{compute_available_slots, slot_total_min};
use ohmydate_scheduler::types::{
    AvailabilityRule, Block, ExceptionKind, Horizon, ScheduleInput, Task,
};
use ohmydate_scheduler::validate::{MAX_INPUT_MINUTES, validate_input};
use support::{all_week_full_day, audit, block, codes, exception, rule};

fn make_task(estimate_min: f64) -> Task {
    Task {
        due_at: Some("2026-11-09T08:00:00Z".to_owned()),
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task("A", estimate_min)
    }
}

fn make_input(task: Task, availability: Vec<AvailabilityRule>) -> ScheduleInput {
    support::input(
        "Asia/Seoul",
        "2026-11-09T00:00:00Z",
        "2026-11-10T00:00:00Z",
        vec![task],
        availability,
    )
}

fn monday_work() -> Vec<AvailabilityRule> {
    vec![rule(1, "09:00", "17:00")]
}

fn default_input() -> ScheduleInput {
    make_input(make_task(60.0), monday_work())
}

fn utc(mut input: ScheduleInput) -> ScheduleInput {
    input.time_zone = "UTC".to_owned();
    input
}

fn issue_codes(input: &ScheduleInput) -> Vec<&'static str> {
    validate_input(input)
        .iter()
        .map(|issue| issue.code.as_str())
        .collect()
}

#[test]
fn reports_h1_for_overlapping_blocks() {
    let input = make_input(make_task(120.0), monday_work());
    assert!(
        codes(
            &input,
            &[
                block("A", "2026-11-09T00:00:00Z", "2026-11-09T01:00:00Z"),
                block("A", "2026-11-09T00:30:00Z", "2026-11-09T01:30:00Z"),
            ]
        )
        .contains(&"H1")
    );
    // Blocks that only touch do not overlap.
    assert!(
        !codes(
            &input,
            &[
                block("A", "2026-11-09T00:00:00Z", "2026-11-09T01:00:00Z"),
                block("A", "2026-11-09T01:00:00Z", "2026-11-09T02:00:00Z"),
            ]
        )
        .contains(&"H1")
    );
}

#[test]
fn reports_h4_when_a_block_starts_before_earliest_start_at() {
    let input = make_input(
        Task {
            earliest_start_at: Some("2026-11-09T01:00:00Z".to_owned()),
            ..make_task(60.0)
        },
        monday_work(),
    );
    assert!(
        codes(
            &input,
            &[block("A", "2026-11-09T00:00:00Z", "2026-11-09T01:00:00Z")]
        )
        .contains(&"H4")
    );
}

#[test]
fn reports_h5_for_a_session_outside_the_min_max_bounds() {
    let input = make_input(
        Task {
            min_session_min: 60.0,
            ..make_task(60.0)
        },
        monday_work(),
    );
    assert!(
        codes(
            &input,
            &[block("A", "2026-11-09T00:00:00Z", "2026-11-09T00:30:00Z")]
        )
        .contains(&"H5")
    );
}

#[test]
fn reports_h5_when_a_non_splittable_task_is_not_one_full_block() {
    let input = make_input(
        Task {
            splittable: false,
            min_session_min: 60.0,
            max_session_min: 60.0,
            ..make_task(60.0)
        },
        monday_work(),
    );
    assert!(
        codes(
            &input,
            &[block("A", "2026-11-09T00:00:00Z", "2026-11-09T00:30:00Z")]
        )
        .contains(&"H5")
    );
}

fn break_rule_input() -> ScheduleInput {
    let mut input = make_input(make_task(180.0), monday_work());
    input.prefs.break_after_min = 120.0;
    input.prefs.break_min = 15.0;
    input
}

#[test]
fn reports_h6_when_continuous_focus_exceeds_break_after_min_without_a_break() {
    assert!(
        codes(
            &break_rule_input(),
            &[
                block("A", "2026-11-09T00:00:00Z", "2026-11-09T02:00:00Z"),
                block("A", "2026-11-09T02:00:00Z", "2026-11-09T03:00:00Z"),
            ]
        )
        .contains(&"H6")
    );
}

#[test]
fn accepts_continuous_focus_that_includes_a_long_enough_break() {
    assert!(
        !codes(
            &break_rule_input(),
            &[
                block("A", "2026-11-09T00:00:00Z", "2026-11-09T02:00:00Z"),
                block("A", "2026-11-09T02:15:00Z", "2026-11-09T03:15:00Z"),
            ]
        )
        .contains(&"H6")
    );
    // One minute short of the break joins the two blocks into one run.
    assert!(
        codes(
            &break_rule_input(),
            &[
                block("A", "2026-11-09T00:00:00Z", "2026-11-09T02:00:00Z"),
                block("A", "2026-11-09T02:10:00Z", "2026-11-09T03:10:00Z"),
            ]
        )
        .contains(&"H6")
    );
}

#[test]
fn reports_h8_for_a_block_that_is_not_on_the_5_minute_grid() {
    assert!(
        codes(
            &default_input(),
            &[block("A", "2026-11-09T00:03:00Z", "2026-11-09T01:00:00Z")]
        )
        .contains(&"H8")
    );
}

#[test]
fn adds_extra_exception_windows_and_subtracts_timed_off_windows() {
    let mut input = default_input();
    input.exceptions = vec![
        exception("2026-11-09", ExceptionKind::Off, Some(("10:00", "11:00"))),
        exception("2026-11-09", ExceptionKind::Extra, Some(("18:00", "19:00"))),
    ];
    let slots = compute_available_slots(&input).unwrap();
    assert_eq!(slot_total_min(&slots), Ok(480.0));
    assert_eq!(slots.len(), 3);
}

#[test]
fn rejects_an_invalid_iana_time_zone_with_h8() {
    let mut input = default_input();
    input.time_zone = "Not/AZone".to_owned();
    let violations = audit(
        &input,
        &[block("A", "2026-11-09T00:00:00Z", "2026-11-09T01:00:00Z")],
        &[],
    );
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0].code.as_str(), "H8");
    assert_eq!(violations[0].message_code.as_str(), "h8_invalid_time_zone");
    assert_eq!(violations[0].message, "Invalid IANA time zone: Not/AZone");
    assert!(violations[0].params.is_empty());
}

fn five_minute_task() -> Task {
    Task {
        due_at: Some("2026-11-09T10:00:00Z".to_owned()),
        min_session_min: 5.0,
        max_session_min: 5.0,
        ..make_task(5.0)
    }
}

#[test]
fn h2_covers_the_full_block_against_non_grid_aligned_availability() {
    let input = utc(make_input(
        five_minute_task(),
        vec![rule(1, "09:00", "09:03")],
    ));
    assert_eq!(compute_available_slots(&input), Ok(Vec::new()));
    assert_eq!(
        codes(
            &input,
            &[block("A", "2026-11-09T09:00:00Z", "2026-11-09T09:05:00Z")]
        ),
        ["H2"]
    );
}

#[test]
fn h2_catches_a_timed_off_exception_inside_the_block() {
    let mut input = utc(make_input(
        five_minute_task(),
        vec![rule(1, "09:00", "10:00")],
    ));
    let plan = [block("A", "2026-11-09T09:00:00Z", "2026-11-09T09:05:00Z")];
    assert_eq!(codes(&input, &plan), Vec::<&str>::new());
    input.exceptions = vec![exception(
        "2026-11-09",
        ExceptionKind::Off,
        Some(("09:01", "09:04")),
    )];
    assert_eq!(codes(&input, &plan), ["H2"]);
}

fn midnight_input() -> ScheduleInput {
    let mut input = utc(make_input(
        Task {
            due_at: Some("2026-11-10T01:00:00Z".to_owned()),
            ..make_task(120.0)
        },
        vec![rule(1, "23:00", "24:00"), rule(2, "00:00", "01:00")],
    ));
    input.horizon = Horizon {
        start: "2026-11-09T22:00:00Z".to_owned(),
        end: "2026-11-10T02:00:00Z".to_owned(),
    };
    input.prefs.break_after_min = 90.0;
    input.prefs.break_min = 15.0;
    input
}

#[test]
fn h6_keeps_continuous_focus_runs_across_local_midnight() {
    assert_eq!(
        codes(
            &midnight_input(),
            &[block("A", "2026-11-09T23:00:00Z", "2026-11-10T01:00:00Z")]
        ),
        ["H6"]
    );
}

#[test]
fn h6_joins_adjacent_blocks_that_meet_across_local_midnight() {
    let violations = audit(
        &midnight_input(),
        &[
            block("A", "2026-11-09T23:00:00Z", "2026-11-10T00:00:00Z"),
            block("A", "2026-11-10T00:00:00Z", "2026-11-10T01:00:00Z"),
        ],
        &[],
    );
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0].message_code.as_str(), "h6_break_missing");
    // The run is dated by its start.
    assert_eq!(
        violations[0].message,
        "Continuous focus starting on 2026-11-09 exceeds 90 minutes without a 15-minute break."
    );
}

#[test]
fn rejects_a_candidate_block_outside_the_planning_horizon() {
    let mut input = utc(make_input(
        Task {
            due_at: None,
            ..make_task(60.0)
        },
        vec![rule(4, "00:00", "24:00")],
    ));
    input.horizon.end = "2026-11-11T00:00:00Z".to_owned();
    assert_eq!(
        codes(
            &input,
            &[block("A", "2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z")]
        ),
        ["H0_horizon"]
    );
}

#[test]
fn exempts_locked_blocks_from_the_horizon_check() {
    let mut input = utc(make_input(
        Task {
            due_at: Some("2026-11-10T00:00:00Z".to_owned()),
            ..make_task(120.0)
        },
        vec![rule(1, "00:00", "24:00")],
    ));
    input.locked_blocks = vec![block("A", "2026-11-08T09:00:00Z", "2026-11-08T10:00:00Z")];
    assert!(
        !codes(
            &input,
            &[block("A", "2026-11-09T00:00:00Z", "2026-11-09T01:00:00Z")]
        )
        .contains(&"H0_horizon")
    );
    // The same block as a candidate is outside the horizon.
    assert!(
        codes(
            &input,
            &[block("A", "2026-11-08T09:00:00Z", "2026-11-08T10:00:00Z")]
        )
        .contains(&"H0_horizon")
    );
}

#[test]
fn h5_enforces_session_bounds_for_non_splittable_tasks() {
    let input = utc(make_input(
        Task {
            splittable: false,
            due_at: Some("2026-11-09T12:00:00Z".to_owned()),
            min_session_min: 30.0,
            max_session_min: 60.0,
            ..make_task(120.0)
        },
        vec![rule(1, "09:00", "13:00")],
    ));
    let violations = audit(
        &input,
        &[block("A", "2026-11-09T09:00:00Z", "2026-11-09T11:00:00Z")],
        &[],
    );
    assert_eq!(violations.len(), 1);
    assert_eq!(
        violations[0].message,
        "Non-splittable task \"A\" requires 120 minutes, outside [30, 60]."
    );
}

#[test]
fn h5_skips_a_non_splittable_task_with_no_remaining_minutes_and_flags_any_block() {
    let input = utc(make_input(
        Task {
            splittable: false,
            due_at: Some("2026-11-09T17:00:00Z".to_owned()),
            remaining_min: Some(0.0),
            min_session_min: 90.0,
            max_session_min: 90.0,
            ..make_task(90.0)
        },
        monday_work(),
    ));
    assert_eq!(codes(&input, &[]), Vec::<&str>::new());
    assert!(
        codes(
            &input,
            &[block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:30:00Z")]
        )
        .contains(&"H5")
    );
}

#[test]
fn exempts_history_blocks_from_h4_and_h5() {
    let input = utc(make_input(
        Task {
            splittable: false,
            due_at: Some("2026-11-09T12:00:00Z".to_owned()),
            min_session_min: 60.0,
            max_session_min: 60.0,
            ..make_task(60.0)
        },
        vec![rule(1, "00:00", "24:00")],
    ));
    let plan = [block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z")];
    let late = block("A", "2026-11-09T12:30:00Z", "2026-11-09T13:30:00Z");
    let as_history: Vec<&str> = audit(&input, &plan, std::slice::from_ref(&late))
        .iter()
        .map(|violation| violation.code.as_str())
        .collect();
    assert!(!as_history.contains(&"H4") && !as_history.contains(&"H5"));
    // The same late block as part of the plan breaks both.
    let as_plan = codes(&input, &[plan[0].clone(), late]);
    assert!(as_plan.contains(&"H4") && as_plan.contains(&"H5"));
}

#[test]
fn requires_overnight_single_rule_windows_to_be_split_at_midnight() {
    let input = make_input(make_task(60.0), vec![rule(1, "23:00", "01:00")]);
    assert!(issue_codes(&input).contains(&"invalid_window"));
    let split = make_input(
        make_task(60.0),
        vec![rule(1, "23:00", "24:00"), rule(2, "00:00", "01:00")],
    );
    assert_eq!(issue_codes(&split), Vec::<&str>::new());
}

fn santiago_input(estimate_min: f64, max_session_min: f64, daily_cap_min: f64) -> ScheduleInput {
    let mut input = make_input(
        Task {
            due_at: Some("2026-09-07T06:00:00Z".to_owned()),
            max_session_min,
            ..make_task(estimate_min)
        },
        all_week_full_day(),
    );
    input.time_zone = "America/Santiago".to_owned();
    input.horizon = Horizon {
        start: "2026-09-06T04:00:00Z".to_owned(),
        end: "2026-09-07T06:00:00Z".to_owned(),
    };
    input.prefs.max_daily_focus_min = daily_cap_min;
    input.prefs.break_after_min = 1440.0;
    input
}

#[test]
fn h6_rejects_a_daily_cap_overflow_after_the_santiago_midnight_gap() {
    assert_eq!(
        codes(
            &santiago_input(150.0, 150.0, 90.0),
            &[block("A", "2026-09-07T02:30:00Z", "2026-09-07T05:00:00Z")]
        ),
        ["H6"]
    );
}

#[test]
fn accepts_valid_daily_loads_split_by_the_santiago_midnight_gap() {
    assert_eq!(
        codes(
            &santiago_input(90.0, 120.0, 60.0),
            &[block("A", "2026-09-07T02:30:00Z", "2026-09-07T04:00:00Z")]
        ),
        Vec::<&str>::new()
    );
}

fn two_day_input() -> ScheduleInput {
    let mut input = utc(make_input(
        Task {
            due_at: Some("2026-11-11T00:00:00Z".to_owned()),
            earliest_start_at: Some("2026-11-09T00:00:00Z".to_owned()),
            ..make_task(60.0)
        },
        all_week_full_day(),
    ));
    input.horizon.end = "2026-11-11T00:00:00Z".to_owned();
    input
}

#[test]
fn rejects_candidate_and_locked_blocks_for_unknown_task_ids() {
    let plan = [block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z")];
    let stranger = block("UNKNOWN", "2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z");
    assert_eq!(
        codes(&two_day_input(), &[plan[0].clone(), stranger.clone()]),
        ["H0_unknown_task"]
    );

    let mut locked_input = two_day_input();
    locked_input.locked_blocks = vec![stranger];
    assert!(codes(&locked_input, &plan).contains(&"H0_unknown_task"));
    assert!(issue_codes(&locked_input).contains(&"unknown_task"));
    assert_eq!(issue_codes(&two_day_input()), Vec::<&str>::new());
}

fn morning_input() -> ScheduleInput {
    utc(make_input(
        Task {
            due_at: Some("2026-11-09T10:00:00Z".to_owned()),
            earliest_start_at: Some("2026-11-09T00:00:00Z".to_owned()),
            ..make_task(60.0)
        },
        all_week_full_day(),
    ))
}

#[test]
fn rejects_sub_millisecond_candidate_and_locked_block_precision() {
    let fine = block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z");
    let sub_millisecond = block(
        "A",
        "2026-11-09T09:00:00.000000001Z",
        "2026-11-09T10:00:00Z",
    );
    let violations = audit(
        &morning_input(),
        std::slice::from_ref(&sub_millisecond),
        &[],
    );
    assert!(
        violations
            .iter()
            .any(|violation| violation.message_code.as_str() == "h8_sub_millisecond")
    );

    let mut locked_input = morning_input();
    locked_input.locked_blocks = vec![sub_millisecond];
    assert!(codes(&locked_input, std::slice::from_ref(&fine)).contains(&"H8"));
    assert!(issue_codes(&locked_input).contains(&"invalid_precision"));

    let mut off_grid_locked = morning_input();
    off_grid_locked.locked_blocks =
        vec![block("A", "2026-11-09T09:03:00Z", "2026-11-09T10:00:00Z")];
    assert!(codes(&off_grid_locked, std::slice::from_ref(&fine)).contains(&"H8"));
    assert!(issue_codes(&off_grid_locked).contains(&"invalid_precision"));
    assert_eq!(codes(&morning_input(), &[fine]), Vec::<&str>::new());
}

// Minute input hardening.

fn with_task(edit: impl FnOnce(&mut Task)) -> ScheduleInput {
    let mut task = make_task(60.0);
    edit(&mut task);
    make_input(task, monday_work())
}

#[test]
fn rejects_nan_and_infinite_estimates() {
    // `1e400` reads as Infinity in both languages.
    assert_eq!("1e400".parse::<f64>(), Ok(f64::INFINITY));
    for value in [f64::NAN, f64::INFINITY, "1e400".parse::<f64>().unwrap()] {
        let input = with_task(|task| task.estimate.p50_min = value);
        assert!(issue_codes(&input).contains(&"invalid_estimate"), "{value}");
    }
    assert_eq!(issue_codes(&default_input()), Vec::<&str>::new());
}

#[test]
fn rejects_non_finite_and_non_integer_remaining_min_and_session_bounds() {
    for edit in [
        (|task: &mut Task| task.remaining_min = Some(f64::INFINITY)) as fn(&mut Task),
        |task| task.remaining_min = Some(60.5),
        |task| task.min_session_min = 30.5,
        |task| task.max_session_min = f64::NAN,
    ] {
        assert!(issue_codes(&with_task(edit)).contains(&"invalid_estimate"));
    }
}

#[test]
fn rejects_non_finite_non_integer_and_above_cap_preference_minutes() {
    for edit in [
        (|input: &mut ScheduleInput| input.prefs.max_daily_focus_min = f64::INFINITY)
            as fn(&mut ScheduleInput),
        |input| input.prefs.max_daily_focus_min = f64::NAN,
        |input| input.prefs.break_after_min = 120.5,
        |input| input.prefs.break_min = 15.5,
        |input| input.prefs.break_after_min = MAX_INPUT_MINUTES + 5.0,
    ] {
        let mut input = default_input();
        edit(&mut input);
        assert!(issue_codes(&input).contains(&"invalid_input"));
    }
}

#[test]
fn accepts_whole_minutes_at_the_documented_upper_cap_and_rejects_one_above_it() {
    let at_cap = with_task(|task| {
        task.estimate.p50_min = MAX_INPUT_MINUTES;
        task.estimate.p90_min = MAX_INPUT_MINUTES;
    });
    assert!(!issue_codes(&at_cap).contains(&"invalid_estimate"));
    let above_cap = with_task(|task| task.estimate.p50_min = MAX_INPUT_MINUTES + 5.0);
    assert!(issue_codes(&above_cap).contains(&"invalid_estimate"));
}

// Not in the reference file: findings pinned in full, so that the code, the
// English text and the parameters of a finding cannot drift apart unnoticed.

#[test]
fn a_finding_carries_its_code_text_parameters_task_and_blocks() {
    let input = utc(make_input(
        Task {
            due_at: None,
            ..make_task(60.0)
        },
        monday_work(),
    ));
    let short = block("A", "2026-11-09T09:00:00Z", "2026-11-09T09:30:00Z");
    let violations = audit(&input, std::slice::from_ref(&short), &[]);
    assert_eq!(violations.len(), 1);
    assert_eq!(
        violations[0].to_json(),
        serde_json::json!({
            "code": "H7",
            "message": "Task \"A\" is short by 30 minutes (deficit).",
            "messageCode": "h7_deficit",
            "params": {"taskId": "A", "shortMin": 30},
            "taskId": "A",
            "blocks": [{"taskId": "A", "start": "2026-11-09T09:00:00Z", "end": "2026-11-09T09:30:00Z"}],
        })
    );
    assert_eq!(
        violations[0].item().to_json(),
        serde_json::json!({"code": "h7_deficit", "params": {"taskId": "A", "shortMin": 30}})
    );
    // A task without any block has a deficit finding without blocks.
    let none = audit(&input, &[], &[]);
    assert_eq!(none.len(), 1);
    assert_eq!(none[0].blocks, None);
    assert_eq!(
        none[0].message,
        "Task \"A\" is short by 60 minutes (deficit)."
    );
}

#[test]
fn an_input_issue_carries_its_code_text_and_parameters() {
    let mut input = default_input();
    input.tasks.push(make_task(60.0));
    let issues = validate_input(&input);
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0].to_json(),
        serde_json::json!({
            "code": "duplicate_task",
            "message": "Task id \"A\" is duplicated.",
            "messageCode": "input_duplicate_task",
            "params": {"taskId": "A"},
            "taskId": "A",
        })
    );
    assert_eq!(
        issues[0].item().to_json(),
        serde_json::json!({"code": "input_duplicate_task", "params": {"taskId": "A"}})
    );
}

#[test]
fn dependency_cycles_are_found_and_chains_are_not() {
    let chain = |edges: &[(&str, &[&str])]| {
        let mut input = default_input();
        input.tasks = edges
            .iter()
            .map(|(id, depends_on)| Task {
                id: (*id).to_owned(),
                depends_on: depends_on.iter().map(|id| (*id).to_owned()).collect(),
                ..make_task(60.0)
            })
            .collect();
        issue_codes(&input)
    };
    assert_eq!(
        chain(&[("A", &[]), ("B", &["A"]), ("C", &["A", "B"])]),
        Vec::<&str>::new()
    );
    assert_eq!(
        chain(&[("A", &["C"]), ("B", &["A"]), ("C", &["B"])]),
        ["dependency_cycle"]
    );
    assert_eq!(chain(&[("A", &["A"])]), ["dependency_cycle"]);
    assert_eq!(
        chain(&[("A", &["ghost"]), ("B", &["A"])]),
        ["unknown_dependency"]
    );
    // A long chain is walked without recursion.
    let mut input = default_input();
    input.tasks = (0..20_000)
        .map(|index| Task {
            id: format!("t{index}"),
            depends_on: if index == 0 {
                Vec::new()
            } else {
                vec![format!("t{}", index - 1)]
            },
            ..make_task(60.0)
        })
        .collect();
    assert_eq!(issue_codes(&input), Vec::<&str>::new());
}

#[test]
fn history_is_audited_only_against_candidate_blocks() {
    // 06 §7.1: history collides freely with history, commitments and locked
    // blocks; a candidate block on top of history is an overlap.
    let mut input = two_day_input();
    input.tasks[0].estimate.p50_min = 120.0;
    let history = [
        block("A", "2026-11-09T08:00:00Z", "2026-11-09T09:00:00Z"),
        block("A", "2026-11-09T08:30:00Z", "2026-11-09T09:30:00Z"),
    ];
    let clear = [
        block("A", "2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z"),
        block("A", "2026-11-09T12:00:00Z", "2026-11-09T13:00:00Z"),
    ];
    assert_eq!(audit(&input, &clear, &history), Vec::new());
    let on_history: Vec<Block> = vec![
        block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z"),
        clear[1].clone(),
    ];
    let violations = audit(&input, &on_history, &history);
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0].message_code.as_str(), "h1_same_task_overlap");
}
