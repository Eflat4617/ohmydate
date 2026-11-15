//! The scenarios of `packages/scheduler/test/explanation-codes.test.ts`:
//! small inputs that together reach every violation code, every input issue
//! code and every generator explanation code.

use ohmydate_scheduler::types::{
    AutoSplitReason, Block, Commitment, ExceptionKind, ScheduleInput, Task,
};

use super::{exception, rule};

pub fn task(id: &str) -> Task {
    Task {
        due_at: Some("2026-11-11T17:00:00Z".to_owned()),
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..super::task(id, 60.0)
    }
}

pub fn input() -> ScheduleInput {
    let mut input = super::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        "2026-11-12T00:00:00Z",
        vec![task("A")],
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", "17:00"))
            .collect(),
    );
    input.seed = 7.0;
    input
}

/// A block on 2026-11-09.
pub fn block(task_id: &str, start: &str, end: &str) -> Block {
    super::block(
        task_id,
        &format!("2026-11-09T{start}"),
        &format!("2026-11-09T{end}"),
    )
}

pub fn one_hour() -> Vec<Block> {
    vec![block("A", "09:00:00Z", "10:00:00Z")]
}

pub fn edited(edit: impl FnOnce(&mut ScheduleInput)) -> ScheduleInput {
    let mut input = input();
    edit(&mut input);
    input
}

pub fn with_task(edit: impl FnOnce(&mut Task)) -> ScheduleInput {
    edited(|input| edit(&mut input.tasks[0]))
}

pub fn two_tasks(edit: impl FnOnce(&mut Task)) -> ScheduleInput {
    edited(|input| {
        let mut second = task("B");
        edit(&mut second);
        input.tasks.push(second);
    })
}

pub fn unsplittable(min: f64, max: f64) -> impl FnOnce(&mut Task) {
    move |task| {
        task.splittable = false;
        task.min_session_min = min;
        task.max_session_min = max;
    }
}

/// Validator scenarios; together they reach every violation message code.
pub fn violation_scenarios() -> Vec<(&'static str, ScheduleInput, Vec<Block>)> {
    vec![
        (
            "invalid time zone",
            edited(|input| input.time_zone = "Mars/Base".to_owned()),
            one_hour(),
        ),
        (
            "invalid horizon",
            edited(|input| input.horizon.start = "not-an-instant".to_owned()),
            one_hour(),
        ),
        (
            "unknown task",
            input(),
            vec![
                block("A", "09:00:00Z", "10:00:00Z"),
                block("Z", "11:00:00Z", "12:00:00Z"),
            ],
        ),
        (
            "outside horizon",
            input(),
            vec![super::block(
                "A",
                "2026-11-13T09:00:00Z",
                "2026-11-13T10:00:00Z",
            )],
        ),
        (
            "invalid instant",
            input(),
            vec![super::block("A", "garbage", "2026-11-09T10:00:00Z")],
        ),
        (
            "sub-millisecond",
            input(),
            vec![block("A", "09:00:00.000000001Z", "10:00:00Z")],
        ),
        (
            "off grid",
            input(),
            vec![block("A", "09:03:00Z", "10:03:00Z")],
        ),
        (
            "ends before start",
            input(),
            vec![block("A", "10:00:00Z", "09:00:00Z")],
        ),
        (
            "same-task overlap",
            input(),
            vec![
                block("A", "09:00:00Z", "09:30:00Z"),
                block("A", "09:15:00Z", "09:45:00Z"),
            ],
        ),
        (
            "two-task overlap",
            two_tasks(|_| {}),
            vec![
                block("A", "09:00:00Z", "10:00:00Z"),
                block("B", "09:30:00Z", "10:30:00Z"),
            ],
        ),
        (
            "commitment overlap",
            edited(|input| {
                input.commitments = vec![Commitment {
                    start: "2026-11-09T09:00:00Z".to_owned(),
                    end: "2026-11-09T10:00:00Z".to_owned(),
                }];
            }),
            one_hour(),
        ),
        (
            "outside availability",
            input(),
            vec![block("A", "03:00:00Z", "04:00:00Z")],
        ),
        (
            "dependency order",
            two_tasks(|task| task.depends_on = vec!["A".to_owned()]),
            vec![
                block("B", "09:00:00Z", "10:00:00Z"),
                block("A", "10:00:00Z", "11:00:00Z"),
            ],
        ),
        (
            "before earliest start",
            with_task(|task| task.earliest_start_at = Some("2026-11-10T09:00:00Z".to_owned())),
            one_hour(),
        ),
        (
            "inside due buffer",
            with_task(|task| {
                task.due_at = Some("2026-11-09T11:00:00Z".to_owned());
                task.buffer_before_due_min = Some(60.0);
            }),
            vec![block("A", "09:30:00Z", "10:30:00Z")],
        ),
        (
            "after due",
            with_task(|task| task.due_at = Some("2026-11-09T09:30:00Z".to_owned())),
            one_hour(),
        ),
        (
            "non-splittable without remaining minutes",
            with_task(|task| {
                unsplittable(60.0, 60.0)(task);
                task.remaining_min = Some(0.0);
            }),
            one_hour(),
        ),
        (
            "non-splittable outside session bounds",
            with_task(unsplittable(90.0, 120.0)),
            one_hour(),
        ),
        (
            "non-splittable in two blocks",
            with_task(unsplittable(60.0, 60.0)),
            vec![
                block("A", "09:00:00Z", "09:30:00Z"),
                block("A", "10:00:00Z", "10:30:00Z"),
            ],
        ),
        (
            "session too short",
            input(),
            vec![
                block("A", "09:00:00Z", "09:15:00Z"),
                block("A", "10:00:00Z", "10:45:00Z"),
            ],
        ),
        (
            "daily cap",
            edited(|input| input.prefs.max_daily_focus_min = 30.0),
            one_hour(),
        ),
        (
            "missing break",
            edited(|input| {
                input.prefs.break_after_min = 30.0;
                input.prefs.break_min = 15.0;
            }),
            one_hour(),
        ),
        ("deficit", input(), Vec::new()),
        (
            "overallocated",
            input(),
            vec![block("A", "09:00:00Z", "10:30:00Z")],
        ),
    ]
}

/// Input scenarios; together they reach every input issue message code.
pub fn input_scenarios() -> Vec<(&'static str, ScheduleInput)> {
    let long = ("2026-01-01T00:00:00Z", "2027-03-01T00:00:00Z");
    let commitment = |start: &str, end: &str| Commitment {
        start: start.to_owned(),
        end: end.to_owned(),
    };
    vec![
        (
            "time zone",
            edited(|input| input.time_zone = "Mars/Base".to_owned()),
        ),
        (
            "horizon instant",
            edited(|input| input.horizon.start = "garbage".to_owned()),
        ),
        (
            "horizon order",
            edited(|input| input.horizon.start = "2026-11-12T00:00:00Z".to_owned()),
        ),
        (
            "horizon length",
            edited(|input| {
                input.horizon.start = long.0.to_owned();
                input.horizon.end = long.1.to_owned();
            }),
        ),
        ("now", edited(|input| input.now = "garbage".to_owned())),
        (
            "duplicate task",
            edited(|input| input.tasks.push(task("A"))),
        ),
        (
            "estimate",
            with_task(|task| task.estimate.p50_min = f64::NAN),
        ),
        (
            "buffer",
            with_task(|task| task.buffer_before_due_min = Some(1.5)),
        ),
        (
            "session minutes",
            with_task(|task| task.min_session_min = 1.5),
        ),
        (
            "session bounds",
            with_task(|task| {
                task.min_session_min = 60.0;
                task.max_session_min = 30.0;
            }),
        ),
        (
            "window instant",
            with_task(|task| task.due_at = Some("garbage".to_owned())),
        ),
        (
            "empty window",
            with_task(|task| task.earliest_start_at = Some("2026-11-11T18:00:00Z".to_owned())),
        ),
        ("preference", edited(|input| input.prefs.break_min = -1.0)),
        (
            "unknown dependency",
            with_task(|task| task.depends_on = vec!["Z".to_owned()]),
        ),
        (
            "dependency cycle",
            edited(|input| {
                input.tasks[0].depends_on = vec!["B".to_owned()];
                let mut second = task("B");
                second.depends_on = vec!["A".to_owned()];
                input.tasks.push(second);
            }),
        ),
        (
            "weekday",
            edited(|input| input.availability = vec![rule(9, "09:00", "17:00")]),
        ),
        (
            "availability window",
            edited(|input| input.availability = vec![rule(1, "17:00", "09:00")]),
        ),
        (
            "exception date",
            edited(|input| {
                input.exceptions = vec![exception("2026-13-40", ExceptionKind::Off, None)]
            }),
        ),
        (
            "partial exception",
            edited(|input| {
                let mut partial =
                    exception("2026-11-10", ExceptionKind::Off, Some(("09:00", "10:00")));
                partial.end_local = None;
                input.exceptions = vec![partial];
            }),
        ),
        (
            "exception window",
            edited(|input| {
                input.exceptions = vec![exception(
                    "2026-11-10",
                    ExceptionKind::Off,
                    Some(("12:00", "10:00")),
                )];
            }),
        ),
        (
            "commitment instant",
            edited(|input| input.commitments = vec![commitment("garbage", "2026-11-09T10:00:00Z")]),
        ),
        (
            "commitment order",
            edited(|input| {
                input.commitments =
                    vec![commitment("2026-11-09T10:00:00Z", "2026-11-09T09:00:00Z")];
            }),
        ),
        (
            "commitment length",
            edited(|input| {
                input.horizon.start = "2026-11-12T00:00:00Z".to_owned();
                input.horizon.end = "2026-11-09T00:00:00Z".to_owned();
                input.commitments = vec![commitment(long.0, long.1)];
            }),
        ),
        (
            "block task",
            edited(|input| input.locked_blocks = vec![block("Z", "09:00:00Z", "10:00:00Z")]),
        ),
        (
            "block instant",
            edited(|input| {
                input.locked_blocks = vec![super::block("A", "garbage", "2026-11-09T10:00:00Z")];
            }),
        ),
        (
            "block precision",
            edited(|input| {
                input.locked_blocks = vec![block("A", "09:00:00.000000001Z", "10:00:00Z")]
            }),
        ),
        (
            "block grid",
            edited(|input| {
                input.existing_blocks = Some(vec![block("A", "09:03:00Z", "10:03:00Z")])
            }),
        ),
        (
            "block order",
            edited(|input| input.locked_blocks = vec![block("A", "10:00:00Z", "09:00:00Z")]),
        ),
        (
            "block length",
            edited(|input| input.locked_blocks = vec![super::block("A", long.0, long.1)]),
        ),
    ]
}

/// Generator scenarios; together they reach every generator explanation
/// code that can be reached.
pub fn generator_scenarios() -> Vec<(&'static str, ScheduleInput)> {
    let whole = |minutes: f64| {
        move |task: &mut Task| {
            task.estimate.p50_min = minutes;
            task.estimate.p90_min = minutes;
            task.splittable = false;
            task.min_session_min = minutes;
            task.max_session_min = minutes;
        }
    };
    let sized = |minutes: f64, min: f64, max: f64| {
        move |task: &mut Task| {
            task.estimate.p50_min = minutes;
            task.estimate.p90_min = minutes;
            task.min_session_min = min;
            task.max_session_min = max;
        }
    };
    let around_the_clock = |input: &mut ScheduleInput| {
        input.availability = (1..=7)
            .map(|weekday| rule(weekday, "00:00", "24:00"))
            .collect();
    };
    vec![
        ("feasible", input()),
        (
            "infeasible capacity",
            with_task(|task| task.due_at = Some("2026-11-09T09:30:00Z".to_owned())),
        ),
        ("no contiguous window", with_task(whole(600.0))),
        ("not grid aligned", with_task(sized(62.0, 30.0, 120.0))),
        ("below grid", with_task(sized(3.0, 5.0, 120.0))),
        ("session bounds", with_task(sized(50.0, 30.0, 40.0))),
        (
            "replan bound",
            edited(|input| {
                around_the_clock(input);
                input.tasks[0].due_at = None;
                sized(150.0, 30.0, 30.0)(&mut input.tasks[0]);
                input.existing_blocks = Some(vec![block("A", "00:00:00Z", "02:00:00Z")]);
            }),
        ),
        (
            "rejected input",
            edited(|input| input.time_zone = "Mars/Base".to_owned()),
        ),
        (
            "blocked by predecessor",
            edited(|input| {
                whole(600.0)(&mut input.tasks[0]);
                let mut second = task("B");
                second.depends_on = vec!["A".to_owned()];
                input.tasks.push(second);
            }),
        ),
        (
            "auto split",
            edited(|input| {
                input.prefs.break_after_min = 60.0;
                sized(150.0, 30.0, 60.0)(&mut input.tasks[0]);
                input.tasks[0].auto_split = Some(AutoSplitReason::BreakAfter);
            }),
        ),
    ]
}

/// A replan whose four tasks each keep one existing block and need more:
/// three genuinely distinct plans, each over its change bound.
pub fn multi_replan_input() -> ScheduleInput {
    edited(|input| {
        input.availability = (1..=7)
            .map(|weekday| rule(weekday, "00:00", "24:00"))
            .collect();
        input.tasks = (0..4_u8)
            .map(|index| {
                let minutes = 150.0 + 30.0 * f64::from(index);
                let mut task = super::task(&format!("T{index}"), minutes);
                task.min_session_min = 30.0;
                task.max_session_min = 30.0;
                task
            })
            .collect();
        input.existing_blocks = Some(
            (0..4_u8)
                .map(|index| {
                    block(
                        &format!("T{index}"),
                        &format!("0{index}:00:00Z"),
                        &format!("0{index}:30:00Z"),
                    )
                })
                .collect(),
        );
    })
}
