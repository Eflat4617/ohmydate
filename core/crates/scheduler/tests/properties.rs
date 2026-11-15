//! `packages/scheduler/test/property.test.ts`: the seven validator and slot
//! properties, with proptest in place of fast-check.
//!
//! Each property holds the validator (or the slot computation) against an
//! independent oracle: the slot list, a block built on top of a commitment,
//! a run-and-day recount, or the one-minute walk of
//! `support::minute_oracle`.

#![allow(clippy::unwrap_used)]

mod support;

use jiff::{Timestamp, ToSpan};
use ohmydate_scheduler::slots::{compute_available_slots, slot_total_min};
use ohmydate_scheduler::types::{
    AvailabilityKind, AvailabilityRule, Block, Commitment, ExceptionKind, ExceptionRule, RiskLevel,
    ScheduleInput, Slot, Task, TaskEstimate,
};
use proptest::prelude::*;
use support::minute_oracle::{
    aligned_available_slot_minutes, aligned_available_slots, daily_loads_by_minute,
    has_daily_cap_violation_by_minute, instant_ms, is_covered_by_minutes,
};
use support::{codes, property};

const MINUTE_MS: i64 = 60 * 1000;
const STEP_MS: i64 = 5 * MINUTE_MS;

#[derive(Debug, Clone, Copy)]
struct Scenario {
    time_zone: &'static str,
    start: &'static str,
    end: &'static str,
}

const fn scenario(time_zone: &'static str, start: &'static str, end: &'static str) -> Scenario {
    Scenario {
        time_zone,
        start,
        end,
    }
}

const SCENARIOS: &[Scenario] = &[
    scenario(
        "America/New_York",
        "2026-03-06T00:00:00Z",
        "2026-03-10T00:00:00Z",
    ),
    scenario(
        "America/New_York",
        "2026-10-30T00:00:00Z",
        "2026-11-03T00:00:00Z",
    ),
    scenario(
        "Europe/Berlin",
        "2026-10-23T00:00:00Z",
        "2026-10-28T00:00:00Z",
    ),
    scenario(
        "Australia/Sydney",
        "2026-04-03T00:00:00Z",
        "2026-04-07T00:00:00Z",
    ),
    scenario("Asia/Seoul", "2026-11-08T00:00:00Z", "2026-11-13T00:00:00Z"),
    scenario(
        "America/Santiago",
        "2026-09-03T00:00:00Z",
        "2026-09-09T00:00:00Z",
    ),
    scenario(
        "Asia/Beirut",
        "2026-03-26T00:00:00Z",
        "2026-04-01T00:00:00Z",
    ),
    scenario(
        "America/Havana",
        "2026-03-05T00:00:00Z",
        "2026-03-11T00:00:00Z",
    ),
    scenario("UTC", "2026-11-08T00:00:00Z", "2026-11-13T00:00:00Z"),
    scenario(
        "America/Goose_Bay",
        "2009-10-31T22:00:00Z",
        "2009-11-01T06:00:00Z",
    ),
    scenario(
        "America/Goose_Bay",
        "2009-03-08T02:00:00Z",
        "2009-03-08T07:00:00Z",
    ),
    scenario(
        "America/St_Johns",
        "2026-03-08T01:00:00Z",
        "2026-03-08T06:00:00Z",
    ),
    scenario(
        "America/St_Johns",
        "2026-11-01T00:00:00Z",
        "2026-11-01T05:00:00Z",
    ),
    scenario(
        "Australia/Lord_Howe",
        "2026-04-04T13:00:00Z",
        "2026-04-04T17:00:00Z",
    ),
    scenario(
        "Australia/Lord_Howe",
        "2026-10-03T13:00:00Z",
        "2026-10-03T17:00:00Z",
    ),
    scenario(
        "Europe/London",
        "2026-03-29T00:00:00Z",
        "2026-03-29T04:00:00Z",
    ),
    scenario(
        "Europe/London",
        "2026-10-25T00:00:00Z",
        "2026-10-25T04:00:00Z",
    ),
];

/// Short horizons (under ten hours) around real transitions, so the
/// one-minute oracle stays cheap even at 10,000 runs.
const MINUTE_SCENARIOS: &[Scenario] = &[
    scenario(
        "America/Goose_Bay",
        "2009-10-31T22:00:00Z",
        "2009-11-01T06:00:00Z",
    ),
    scenario(
        "America/Goose_Bay",
        "2009-03-08T02:00:00Z",
        "2009-03-08T07:00:00Z",
    ),
    scenario(
        "America/St_Johns",
        "2026-03-08T01:00:00Z",
        "2026-03-08T06:00:00Z",
    ),
    scenario(
        "America/St_Johns",
        "2026-11-01T00:00:00Z",
        "2026-11-01T05:00:00Z",
    ),
    scenario(
        "America/Santiago",
        "2026-09-06T01:00:00Z",
        "2026-09-06T07:00:00Z",
    ),
    scenario(
        "Australia/Lord_Howe",
        "2026-04-04T13:00:00Z",
        "2026-04-04T17:00:00Z",
    ),
    scenario(
        "Australia/Lord_Howe",
        "2026-10-03T13:00:00Z",
        "2026-10-03T17:00:00Z",
    ),
    scenario("Asia/Seoul", "2026-11-08T00:00:00Z", "2026-11-08T08:00:00Z"),
    scenario(
        "America/New_York",
        "2026-03-08T05:00:00Z",
        "2026-03-08T10:00:00Z",
    ),
    scenario(
        "America/New_York",
        "2026-11-01T04:00:00Z",
        "2026-11-01T09:00:00Z",
    ),
    scenario(
        "Europe/London",
        "2026-03-29T00:00:00Z",
        "2026-03-29T04:00:00Z",
    ),
    scenario(
        "Europe/London",
        "2026-10-25T00:00:00Z",
        "2026-10-25T04:00:00Z",
    ),
];

const MINUTE_WINDOWS: &[(&str, &str)] = &[
    ("00:00", "24:00"),
    ("00:00", "02:00"),
    ("01:00", "04:00"),
    ("01:30", "02:30"),
    ("02:00", "03:30"),
    ("22:00", "24:00"),
    ("23:00", "24:00"),
];

const COMMIT_SCENARIO: Scenario = scenario("UTC", "2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z");

fn instant_iso(epoch_ms: i64) -> String {
    Timestamp::from_millisecond(epoch_ms).unwrap().to_string()
}

fn format_clock(total_minutes: i64) -> String {
    format!("{:02}:{:02}", total_minutes / 60, total_minutes % 60)
}

/// The local date `day_offset` days after the scenario's first local date.
fn local_date(scenario: Scenario, day_offset: i64) -> String {
    let zone = jiff::tz::TimeZone::get(scenario.time_zone).unwrap();
    scenario
        .start
        .parse::<Timestamp>()
        .unwrap()
        .to_zoned(zone)
        .date()
        .checked_add(day_offset.days())
        .unwrap()
        .to_string()
}

#[allow(clippy::cast_precision_loss)]
fn minutes_f64(minutes: i64) -> f64 {
    minutes as f64
}

fn grid_block(scenario: Scenario, start_step: i64, duration_steps: i64) -> Block {
    let horizon_start_ms = instant_ms(scenario.start);
    let total_steps = (instant_ms(scenario.end) - horizon_start_ms) / STEP_MS;
    let start_ms =
        horizon_start_ms + (start_step % (total_steps - duration_steps + 1).max(1)) * STEP_MS;
    support::block(
        "A",
        &instant_iso(start_ms),
        &instant_iso(start_ms + duration_steps * STEP_MS),
    )
}

fn all_week_rules(window: (&str, &str)) -> Vec<AvailabilityRule> {
    (1..=7)
        .map(|weekday| support::rule(weekday, window.0, window.1))
        .collect()
}

fn minute_task(scenario: Scenario, required_min: i64) -> Task {
    Task {
        due_at: Some(scenario.end.to_owned()),
        earliest_start_at: Some(scenario.start.to_owned()),
        ..support::task("A", minutes_f64(required_min))
    }
}

fn minute_scenario_input(
    scenario: Scenario,
    availability: Vec<AvailabilityRule>,
    exceptions: Vec<ExceptionRule>,
) -> ScheduleInput {
    let mut input = support::input(
        scenario.time_zone,
        scenario.start,
        scenario.end,
        Vec::new(),
        availability,
    );
    input.exceptions = exceptions;
    input.prefs = support::prefs(1440.0, 1440.0);
    input.seed = 424_242.0;
    input
}

/// An exception of the minute scenarios: a whole day, or a window from
/// `start_step_in_day` five-minute steps for `duration_steps` steps, cut at
/// 24:00.
#[derive(Debug, Clone, Copy)]
struct ExceptionSpec {
    kind: ExceptionKind,
    day_offset: i64,
    full_day: bool,
    start_step_in_day: i64,
    duration_steps: i64,
}

fn exception_spec() -> impl Strategy<Value = ExceptionSpec> {
    (
        prop_oneof![Just(ExceptionKind::Off), Just(ExceptionKind::Extra)],
        0_i64..=2,
        any::<bool>(),
        0_i64..=287,
        1_i64..=24,
    )
        .prop_map(
            |(kind, day_offset, full_day, start_step_in_day, duration_steps)| ExceptionSpec {
                kind,
                day_offset,
                full_day,
                start_step_in_day,
                duration_steps,
            },
        )
}

fn build_exception_rule(scenario: Scenario, spec: ExceptionSpec) -> ExceptionRule {
    let date = local_date(scenario, spec.day_offset);
    if spec.full_day {
        return support::exception(&date, spec.kind, None);
    }
    let start_min = spec.start_step_in_day * 5;
    let end_min = (start_min + spec.duration_steps * 5).min(1440);
    support::exception(
        &date,
        spec.kind,
        Some((&format_clock(start_min), &format_clock(end_min))),
    )
}

#[derive(Debug, Clone)]
struct RawException {
    off: bool,
    day_offset: i64,
    full_day: bool,
    start_offset: i64,
    duration: i64,
}

#[derive(Debug, Clone)]
struct RawSpec {
    weekdays: &'static [u8],
    base_start: &'static str,
    base_end: &'static str,
    include_early: bool,
    exceptions: Vec<RawException>,
    risk_level: RiskLevel,
    with_locked: bool,
    has_dependent: bool,
    session_a_steps: i64,
    session_b_steps: i64,
    locked_slot_index: usize,
    locked_duration_steps: i64,
    earliest_a_steps: i64,
    earliest_b_steps: i64,
    buffer_a_steps: i64,
    buffer_b_steps: i64,
}

fn raw_spec() -> impl Strategy<Value = RawSpec> {
    let window = (
        prop_oneof![
            Just(&[1_u8, 2, 3, 4, 5, 6, 7][..]),
            Just(&[1_u8, 2, 3, 4, 5][..]),
            Just(&[1_u8, 2, 3, 4, 5, 6][..]),
        ],
        prop_oneof![Just("08:57"), Just("09:02"), Just("07:58")],
        prop_oneof![Just("17:03"), Just("16:58"), Just("17:07")],
        any::<bool>(),
    );
    let exceptions = proptest::collection::vec(
        (
            any::<bool>(),
            0_i64..=3,
            any::<bool>(),
            0_i64..=9,
            2_i64..=9,
        )
            .prop_map(
                |(off, day_offset, full_day, start_offset, duration)| RawException {
                    off,
                    day_offset,
                    full_day,
                    start_offset,
                    duration,
                },
            ),
        0..=2,
    );
    let flags = (
        prop_oneof![Just(RiskLevel::P50), Just(RiskLevel::P90)],
        any::<bool>(),
        any::<bool>(),
    );
    let sizes = (6_i64..=24, 6_i64..=24, 0_usize..=49, 6_i64..=12);
    let edges = (0_i64..=24, 0_i64..=24, 0_i64..=12, 0_i64..=12);
    (window, exceptions, flags, sizes, edges).prop_map(
        |(
            (weekdays, base_start, base_end, include_early),
            exceptions,
            (risk_level, with_locked, has_dependent),
            (session_a_steps, session_b_steps, locked_slot_index, locked_duration_steps),
            (earliest_a_steps, earliest_b_steps, buffer_a_steps, buffer_b_steps),
        )| RawSpec {
            weekdays,
            base_start,
            base_end,
            include_early,
            exceptions,
            risk_level,
            with_locked,
            has_dependent,
            session_a_steps,
            session_b_steps,
            locked_slot_index,
            locked_duration_steps,
            earliest_a_steps,
            earliest_b_steps,
            buffer_a_steps,
            buffer_b_steps,
        },
    )
}

/// The spec of the commitment property: all week 09:00–17:00, nothing else.
fn plain_spec() -> RawSpec {
    RawSpec {
        weekdays: &[1, 2, 3, 4, 5, 6, 7],
        base_start: "09:00",
        base_end: "17:00",
        include_early: false,
        exceptions: Vec::new(),
        risk_level: RiskLevel::P50,
        with_locked: false,
        has_dependent: false,
        session_a_steps: 12,
        session_b_steps: 12,
        locked_slot_index: 0,
        locked_duration_steps: 6,
        earliest_a_steps: 0,
        earliest_b_steps: 0,
        buffer_a_steps: 0,
        buffer_b_steps: 0,
    }
}

fn build_availability(spec: &RawSpec) -> Vec<AvailabilityRule> {
    let mut rules: Vec<AvailabilityRule> = spec
        .weekdays
        .iter()
        .map(|weekday| support::rule(*weekday, spec.base_start, spec.base_end))
        .collect();
    if spec.include_early {
        rules.push(AvailabilityRule {
            kind: AvailabilityKind::Focus,
            ..support::rule(7, "01:17", "02:43")
        });
    }
    rules
}

fn build_exceptions(scenario: Scenario, spec: &RawSpec) -> Vec<ExceptionRule> {
    spec.exceptions
        .iter()
        .map(|exception| {
            let date = local_date(scenario, exception.day_offset);
            if exception.off {
                if exception.full_day {
                    return support::exception(&date, ExceptionKind::Off, None);
                }
                let start = 12 * 60 + exception.start_offset;
                return support::exception(
                    &date,
                    ExceptionKind::Off,
                    Some((
                        &format_clock(start),
                        &format_clock(start + exception.duration),
                    )),
                );
            }
            let start = 18 * 60 + exception.start_offset;
            support::exception(
                &date,
                ExceptionKind::Extra,
                Some((
                    &format_clock(start),
                    &format_clock(start + 30 + exception.duration * 3),
                )),
            )
        })
        .collect()
}

fn build_input(
    scenario: Scenario,
    spec: &RawSpec,
    tasks: Vec<Task>,
    locked_blocks: Vec<Block>,
) -> ScheduleInput {
    let mut input = support::input(
        scenario.time_zone,
        scenario.start,
        scenario.end,
        tasks,
        build_availability(spec),
    );
    input.exceptions = build_exceptions(scenario, spec);
    input.locked_blocks = locked_blocks;
    input.prefs = support::prefs(720.0, 720.0);
    input.prefs.risk_level = spec.risk_level;
    input.seed = 20_261_109.0;
    input
}

#[derive(Debug, Clone, Copy, Default)]
struct TaskWindow {
    earliest_ms: Option<i64>,
    due_ms: Option<i64>,
    buffer_before_due_min: Option<i64>,
}

fn make_task(
    id: &str,
    required_min: i64,
    scenario: Scenario,
    depends_on: &[&str],
    risk_level: RiskLevel,
    window: TaskWindow,
) -> Task {
    let estimate = match risk_level {
        RiskLevel::P90 => TaskEstimate {
            p50_min: minutes_f64((required_min - 30).max(0)),
            p90_min: minutes_f64(required_min),
        },
        RiskLevel::P50 => TaskEstimate {
            p50_min: minutes_f64(required_min),
            p90_min: minutes_f64(required_min + 30),
        },
    };
    Task {
        due_at: Some(window.due_ms.map_or(scenario.end.to_owned(), instant_iso)),
        earliest_start_at: Some(
            window
                .earliest_ms
                .map_or(scenario.start.to_owned(), instant_iso),
        ),
        estimate,
        min_session_min: 30.0,
        max_session_min: 120.0,
        depends_on: depends_on.iter().map(|id| (*id).to_owned()).collect(),
        buffer_before_due_min: window.buffer_before_due_min.map(minutes_f64),
        ..support::task(id, 0.0)
    }
}

/// Sessions of at most 120 minutes, the last one at least 30.
fn split_sessions(minutes: i64) -> Vec<i64> {
    let mut sessions = Vec::new();
    let mut remaining = minutes;
    while remaining > 120 {
        sessions.push(120);
        remaining -= 120;
    }
    if remaining > 0 {
        sessions.push(remaining);
    }
    if let Some(last) = sessions.last().copied()
        && last < 30
    {
        let count = sessions.len();
        sessions[count - 2] -= 30 - last;
        sessions[count - 1] = 30;
    }
    sessions
}

/// Places a task's sessions into the slots in order, each at the earliest
/// position at or after the previous one; `None` when one does not fit.
fn allocate_from_slots(
    slots: &[Slot],
    task_id: &str,
    minutes: i64,
    start_after_ms: i64,
) -> Option<(Vec<Block>, i64)> {
    let mut blocks = Vec::new();
    let mut cursor = start_after_ms;
    for session_min in split_sessions(minutes) {
        let (start, end) = slots.iter().find_map(|slot| {
            let start = cursor.max(instant_ms(&slot.start));
            let end = start + session_min * MINUTE_MS;
            (end <= instant_ms(&slot.end)).then_some((start, end))
        })?;
        blocks.push(support::block(
            task_id,
            &instant_iso(start),
            &instant_iso(end),
        ));
        cursor = end;
    }
    Some((blocks, cursor))
}

fn is_covered_by_slots(slots: &[Slot], start_ms: i64, end_ms: i64) -> bool {
    let mut cursor = start_ms;
    for slot in slots {
        let (slot_start, slot_end) = (instant_ms(&slot.start), instant_ms(&slot.end));
        if slot_end <= cursor {
            continue;
        }
        if slot_start > cursor {
            return false;
        }
        cursor = cursor.max(slot_end);
        if cursor >= end_ms {
            return true;
        }
    }
    cursor >= end_ms
}

/// H6 recounted: daily minutes by the one-minute walk, focus runs by a scan.
fn has_h6_oracle(
    blocks: &[Block],
    time_zone: &str,
    max_daily_focus_min: i64,
    break_after_min: i64,
    break_min: i64,
) -> bool {
    if daily_loads_by_minute(blocks, time_zone)
        .iter()
        .any(|(_, minutes)| *minutes > max_daily_focus_min)
    {
        return true;
    }
    let mut sorted: Vec<(i64, i64)> = blocks
        .iter()
        .map(|block| (instant_ms(&block.start), instant_ms(&block.end)))
        .collect();
    sorted.sort();
    let mut run: Option<(i64, i64)> = None;
    for (start_ms, end_ms) in sorted {
        run = match run {
            Some((run_start, run_end)) if start_ms - run_end < break_min * MINUTE_MS => {
                Some((run_start, run_end.max(end_ms)))
            }
            Some((run_start, run_end)) if run_end - run_start > break_after_min * MINUTE_MS => {
                return true;
            }
            _ => Some((start_ms, end_ms)),
        };
    }
    run.is_some_and(|(run_start, run_end)| run_end - run_start > break_after_min * MINUTE_MS)
}

fn slot_minutes(slot: &Slot) -> i64 {
    (instant_ms(&slot.end) - instant_ms(&slot.start)) / MINUTE_MS
}

proptest! {
    #![proptest_config(property::config())]

    #[test]
    fn plans_derived_from_the_available_slots_stay_valid_across_varied_inputs(
        scenario in proptest::sample::select(SCENARIOS),
        spec in raw_spec(),
    ) {
        let horizon_start_ms = instant_ms(scenario.start);
        let horizon_end_ms = instant_ms(scenario.end);
        let earliest_a_ms = horizon_start_ms + spec.earliest_a_steps * STEP_MS;
        let earliest_b_ms = horizon_start_ms + spec.earliest_b_steps * STEP_MS;
        let buffer_a_min = spec.buffer_a_steps * 5;
        let buffer_b_min = spec.buffer_b_steps * 5;

        let base_slots =
            compute_available_slots(&build_input(scenario, &spec, Vec::new(), Vec::new())).unwrap();
        let mut locked_blocks = Vec::new();
        let mut locked_min = 0;
        let mut locked_end_ms = i64::MIN;
        if spec.with_locked {
            let preferred = spec.locked_slot_index % base_slots.len().max(1);
            let chosen = (0..base_slots.len())
                .map(|offset| &base_slots[(preferred + offset) % base_slots.len()])
                .find(|slot| slot_minutes(slot) >= 30 && instant_ms(&slot.start) >= earliest_a_ms);
            prop_assume!(chosen.is_some());
            let chosen = chosen.unwrap();
            let slot_start = instant_ms(&chosen.start);
            let duration_steps = spec.locked_duration_steps.min(slot_minutes(chosen).min(60) / 5);
            let end = slot_start + duration_steps * STEP_MS;
            locked_blocks = vec![support::block("A", &instant_iso(slot_start), &instant_iso(end))];
            locked_min = duration_steps * 5;
            locked_end_ms = end;
        }

        let session_a_min = spec.session_a_steps * 5;
        let session_b_min = spec.session_b_steps * 5;
        let mut tasks = vec![make_task(
            "A",
            locked_min + session_a_min,
            scenario,
            &[],
            spec.risk_level,
            TaskWindow {
                earliest_ms: Some(earliest_a_ms),
                due_ms: Some(horizon_end_ms + buffer_a_min * MINUTE_MS),
                buffer_before_due_min: Some(buffer_a_min),
            },
        )];
        if spec.has_dependent {
            tasks.push(make_task(
                "B",
                session_b_min,
                scenario,
                &["A"],
                spec.risk_level,
                TaskWindow {
                    earliest_ms: Some(earliest_b_ms),
                    due_ms: Some(horizon_end_ms + buffer_b_min * MINUTE_MS),
                    buffer_before_due_min: Some(buffer_b_min),
                },
            ));
        }

        let input = build_input(scenario, &spec, tasks, locked_blocks);
        let slots = compute_available_slots(&input).unwrap();
        let a_placement = allocate_from_slots(&slots, "A", session_a_min, earliest_a_ms);
        prop_assume!(a_placement.is_some());
        let (mut blocks, a_end_ms) = a_placement.unwrap();
        if spec.has_dependent {
            let a_ready = a_end_ms.max(locked_end_ms).max(earliest_b_ms);
            let b_placement = allocate_from_slots(&slots, "B", session_b_min, a_ready);
            prop_assume!(b_placement.is_some());
            blocks.extend(b_placement.unwrap().0);
        }
        prop_assert_eq!(support::audit(&input, &blocks, &[]), Vec::new());
    }

    #[test]
    fn h2_agrees_with_the_available_slots_for_arbitrary_grid_blocks(
        scenario in proptest::sample::select(SCENARIOS),
        spec in raw_spec(),
        start_step in 0_i64..=5000,
        duration_steps in 6_i64..=24,
    ) {
        let mut input = build_input(scenario, &spec, Vec::new(), Vec::new());
        let slots = compute_available_slots(&input).unwrap();
        let horizon_start_ms = instant_ms(scenario.start);
        let duration_min = duration_steps * 5;
        let total_min = (instant_ms(scenario.end) - horizon_start_ms) / MINUTE_MS;
        let max_start_steps = (total_min - duration_min).div_euclid(5);
        prop_assume!(max_start_steps >= 0);
        let block_start_ms = horizon_start_ms + (start_step % (max_start_steps + 1)) * STEP_MS;
        let block_end_ms = block_start_ms + duration_min * MINUTE_MS;
        input.tasks = vec![make_task(
            "A",
            duration_min,
            scenario,
            &[],
            spec.risk_level,
            TaskWindow::default(),
        )];

        let covered = is_covered_by_slots(&slots, block_start_ms, block_end_ms);
        let expected: &[&str] = if covered { &[] } else { &["H2"] };
        prop_assert_eq!(
            codes(
                &input,
                &[support::block("A", &instant_iso(block_start_ms), &instant_iso(block_end_ms))]
            ),
            expected
        );
    }

    #[test]
    fn a_block_overlapping_a_commitment_always_reports_h1(
        commit_start_step in 0_i64..=84,
        commit_steps in 6_i64..=24,
        overlap_step in 0_i64..=23,
        block_steps in 6_i64..=24,
    ) {
        let commitment_start_ms =
            instant_ms("2026-11-09T00:00:00Z") + commit_start_step.min(96 - commit_steps) * STEP_MS;
        let block_start_ms = commitment_start_ms + (overlap_step % commit_steps) * STEP_MS;
        let mut input = build_input(
            COMMIT_SCENARIO,
            &plain_spec(),
            vec![make_task("A", 60, COMMIT_SCENARIO, &[], RiskLevel::P50, TaskWindow::default())],
            Vec::new(),
        );
        input.commitments = vec![Commitment {
            start: instant_iso(commitment_start_ms),
            end: instant_iso(commitment_start_ms + commit_steps * STEP_MS),
        }];
        let block = support::block(
            "A",
            &instant_iso(block_start_ms),
            &instant_iso(block_start_ms + block_steps * STEP_MS),
        );
        prop_assert!(codes(&input, std::slice::from_ref(&block)).contains(&"H1"));
        // The same block with the commitment gone has no overlap to report.
        input.commitments.clear();
        prop_assert!(!codes(&input, &[block]).contains(&"H1"));
    }

    #[test]
    fn h6_daily_and_break_boundaries_agree_with_an_independent_oracle(
        scenario in proptest::sample::select(SCENARIOS),
        spec in raw_spec(),
        slot_index in 0_usize..=49,
        first_steps in 6_i64..=24,
        second_steps in 6_i64..=24,
        gap_steps in 0_i64..=3,
        max_daily_focus_min in proptest::sample::select(&[30_i64, 60, 90, 120, 150][..]),
        break_after_min in proptest::sample::select(&[30_i64, 60, 90, 120][..]),
        break_min in proptest::sample::select(&[15_i64, 30][..]),
    ) {
        let mut input = build_input(scenario, &spec, Vec::new(), Vec::new());
        let slots = compute_available_slots(&input).unwrap();
        prop_assume!(!slots.is_empty());
        let preferred = slot_index % slots.len();
        let chosen = (0..slots.len())
            .map(|offset| &slots[(preferred + offset) % slots.len()])
            .find(|slot| slot_minutes(slot) >= 60);
        prop_assume!(chosen.is_some());
        let chosen = chosen.unwrap();
        let slot_start = instant_ms(&chosen.start);
        let slot_min = slot_minutes(chosen);
        let first_min = (first_steps * 5).min(slot_min);
        prop_assume!(first_min >= 30);
        let gap_min = gap_steps * 5;
        let second_min = (second_steps * 5).min((slot_min - first_min - gap_min).div_euclid(5) * 5);
        let mut blocks = vec![support::block(
            "A",
            &instant_iso(slot_start),
            &instant_iso(slot_start + first_min * MINUTE_MS),
        )];
        if second_min >= 30 {
            blocks.push(support::block(
                "A",
                &instant_iso(slot_start + (first_min + gap_min) * MINUTE_MS),
                &instant_iso(slot_start + (first_min + gap_min + second_min) * MINUTE_MS),
            ));
        }
        let required_min = first_min + if second_min >= 30 { second_min } else { 0 };
        input.tasks = vec![make_task(
            "A",
            required_min,
            scenario,
            &[],
            spec.risk_level,
            TaskWindow::default(),
        )];
        input.prefs.max_daily_focus_min = minutes_f64(max_daily_focus_min);
        input.prefs.break_after_min = minutes_f64(break_after_min);
        input.prefs.break_min = minutes_f64(break_min);

        prop_assert_eq!(
            codes(&input, &blocks).contains(&"H6"),
            has_h6_oracle(&blocks, scenario.time_zone, max_daily_focus_min, break_after_min, break_min)
        );
    }

    #[test]
    fn h2_agrees_with_the_one_minute_membership_oracle_around_transitions(
        scenario in proptest::sample::select(MINUTE_SCENARIOS),
        window in proptest::sample::select(MINUTE_WINDOWS),
        exception in exception_spec(),
        raw_start in 0_i64..=2000,
        raw_duration in 1_i64..=2000,
    ) {
        let total_steps = (instant_ms(scenario.end) - instant_ms(scenario.start)) / STEP_MS;
        let duration_steps = 1 + raw_duration % total_steps;
        let start_step = raw_start % (total_steps - duration_steps + 1);
        let block = grid_block(scenario, start_step, duration_steps);
        let mut input = minute_scenario_input(
            scenario,
            all_week_rules(window),
            vec![build_exception_rule(scenario, exception)],
        );
        input.tasks = vec![minute_task(scenario, duration_steps * 5)];

        let covered = is_covered_by_minutes(&input, instant_ms(&block.start), instant_ms(&block.end));
        let expected: &[&str] = if covered { &[] } else { &["H2"] };
        prop_assert_eq!(codes(&input, &[block]), expected);
    }

    #[test]
    fn h6_daily_loads_agree_with_the_one_minute_oracle_around_transitions(
        scenario in proptest::sample::select(MINUTE_SCENARIOS),
        raw_start in 0_i64..=2000,
        raw_duration in 1_i64..=2000,
        max_daily_focus_min in proptest::sample::select(&[10_i64, 30, 60, 90, 120, 240, 480][..]),
    ) {
        let total_steps = (instant_ms(scenario.end) - instant_ms(scenario.start)) / STEP_MS;
        let duration_steps = 1 + raw_duration % total_steps;
        let start_step = raw_start % (total_steps - duration_steps + 1);
        let block = grid_block(scenario, start_step, duration_steps);
        let mut input =
            minute_scenario_input(scenario, all_week_rules(("00:00", "24:00")), Vec::new());
        input.tasks = vec![minute_task(scenario, duration_steps * 5)];
        input.prefs.max_daily_focus_min = minutes_f64(max_daily_focus_min);
        input.prefs.break_after_min = 100_000.0;
        input.prefs.break_min = 15.0;

        let blocks = [block];
        prop_assert_eq!(
            codes(&input, &blocks).contains(&"H6"),
            has_daily_cap_violation_by_minute(&input, &blocks)
        );
    }

    #[test]
    fn exact_slot_intervals_agree_with_the_one_minute_oracle_for_varied_windows(
        scenario in proptest::sample::select(MINUTE_SCENARIOS),
        window in proptest::sample::select(MINUTE_WINDOWS),
        exceptions in proptest::collection::vec(exception_spec(), 0..=2),
    ) {
        let input = minute_scenario_input(
            scenario,
            all_week_rules(window),
            exceptions
                .into_iter()
                .map(|spec| build_exception_rule(scenario, spec))
                .collect(),
        );
        let slots = compute_available_slots(&input).unwrap();
        prop_assert_eq!(&slots, &aligned_available_slots(&input));
        prop_assert_eq!(
            slot_total_min(&slots),
            Ok(minutes_f64(aligned_available_slot_minutes(&input)))
        );
    }
}

/// The oracles of the properties above are themselves checked on cases with
/// a known answer, so a property cannot pass because its oracle is blind.
#[test]
fn the_property_oracles_see_what_they_are_meant_to_see() {
    let slots = [
        Slot {
            start: "2026-11-09T09:00:00Z".to_owned(),
            end: "2026-11-09T10:00:00Z".to_owned(),
        },
        Slot {
            start: "2026-11-09T10:00:00Z".to_owned(),
            end: "2026-11-09T11:00:00Z".to_owned(),
        },
        Slot {
            start: "2026-11-09T13:00:00Z".to_owned(),
            end: "2026-11-09T14:00:00Z".to_owned(),
        },
    ];
    let at = instant_ms;
    assert!(is_covered_by_slots(
        &slots,
        at("2026-11-09T09:30:00Z"),
        at("2026-11-09T10:30:00Z")
    ));
    assert!(!is_covered_by_slots(
        &slots,
        at("2026-11-09T10:30:00Z"),
        at("2026-11-09T13:30:00Z")
    ));
    assert!(!is_covered_by_slots(
        &slots,
        at("2026-11-09T08:30:00Z"),
        at("2026-11-09T09:30:00Z")
    ));
    assert_eq!(split_sessions(275), [120, 120, 35]);
    assert_eq!(split_sessions(250), [120, 100, 30]);
    assert_eq!(split_sessions(90), [90]);
    assert_eq!(
        allocate_from_slots(&slots, "A", 150, at("2026-11-09T09:00:00Z")),
        None
    );
    let (blocks, end_ms) =
        allocate_from_slots(&slots, "A", 60, at("2026-11-09T09:30:00Z")).unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(end_ms, at("2026-11-09T11:00:00Z"));

    let run = [
        support::block("A", "2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z"),
        support::block("A", "2026-11-09T10:10:00Z", "2026-11-09T11:00:00Z"),
    ];
    // 120 minutes in one run (the 10-minute gap is no 15-minute break).
    assert!(has_h6_oracle(&run, "UTC", 480, 90, 15));
    assert!(!has_h6_oracle(&run, "UTC", 480, 120, 15));
    assert!(!has_h6_oracle(&run, "UTC", 480, 90, 10));
    assert!(has_h6_oracle(&run, "UTC", 100, 480, 15));
    assert_eq!(property::config().cases, property::runs());
}
