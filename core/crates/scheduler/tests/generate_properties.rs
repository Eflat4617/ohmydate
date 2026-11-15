//! `packages/scheduler/test/generate.property.test.ts`: the generator's
//! properties, with proptest in place of fast-check.
//!
//! Every feasible candidate is held against the validator and against
//! oracles written separately from both the generator and the validator: an
//! H1 sweep, the one-minute H2 membership walk and an H6 recount.

#![allow(clippy::unwrap_used)]

mod support;

use std::cell::Cell;
use std::collections::BTreeSet;

use jiff::{Timestamp, ToSpan};
use ohmydate_scheduler::generate::{PlanCandidate, generate};
use ohmydate_scheduler::types::{
    Block, Commitment, ExceptionKind, GenerateOptions, PolicyName, RiskLevel, ScheduleInput, Task,
    TaskEstimate, WindowKind,
};
use proptest::prelude::*;
use proptest::test_runner::TestRunner;
use support::minute_oracle::{daily_loads_by_minute, instant_ms, is_covered_by_minutes};
use support::{audit, property};

const MINUTE_MS: i64 = 60 * 1000;
const STEP_MS: i64 = 5 * MINUTE_MS;

const SCENARIOS: &[(&str, &str, &str)] = &[
    ("Asia/Seoul", "2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z"),
    (
        "America/New_York",
        "2026-11-01T04:00:00Z",
        "2026-11-02T00:00:00Z",
    ),
    (
        "Europe/Berlin",
        "2026-10-25T00:00:00Z",
        "2026-10-26T00:00:00Z",
    ),
    (
        "America/St_Johns",
        "2026-11-01T00:00:00Z",
        "2026-11-02T00:00:00Z",
    ),
    (
        "Australia/Lord_Howe",
        "2026-04-04T13:00:00Z",
        "2026-04-05T13:00:00Z",
    ),
    (
        "America/Santiago",
        "2026-09-06T04:00:00Z",
        "2026-09-07T04:00:00Z",
    ),
];

const WINDOWS: &[(&str, &str)] = &[
    ("00:00", "24:00"),
    ("08:00", "18:00"),
    ("01:00", "04:00"),
    ("09:00", "12:00"),
];

const HEAVY_WINDOWS: &[(&str, &str)] = &[
    ("00:00", "24:00"),
    ("08:00", "18:00"),
    ("06:00", "20:00"),
    ("09:00", "17:00"),
];

const LONG_SCENARIOS: &[(&str, &str)] = &[
    ("America/New_York", "2026-10-25T00:00:00Z"),
    ("Europe/Berlin", "2026-10-18T00:00:00Z"),
    ("America/Santiago", "2026-09-01T00:00:00Z"),
    ("Australia/Lord_Howe", "2026-03-28T00:00:00Z"),
    ("America/St_Johns", "2026-10-25T00:00:00Z"),
    ("Asia/Seoul", "2026-11-01T00:00:00Z"),
];

#[allow(clippy::cast_precision_loss)]
fn minutes(value: i64) -> f64 {
    value as f64
}

fn instant_iso(epoch_ms: i64) -> String {
    Timestamp::from_millisecond(epoch_ms).unwrap().to_string()
}

fn all_policies(seed: f64) -> GenerateOptions {
    GenerateOptions {
        policies: Some(PolicyName::ALL.to_vec()),
        seed: Some(seed),
        max_local_improvement: None,
    }
}

fn all_week(
    window: (&str, &str),
    weekdays: std::ops::RangeInclusive<u8>,
) -> Vec<ohmydate_scheduler::types::AvailabilityRule> {
    weekdays
        .map(|weekday| support::rule(weekday, window.0, window.1))
        .collect()
}

#[derive(Debug, Clone)]
struct TaskSpec {
    duration_units: i64,
    min_units: i64,
    max_units: i64,
    splittable: bool,
    priority: i64,
}

fn task_spec() -> impl Strategy<Value = TaskSpec> {
    (
        6_i64..=24,
        proptest::sample::select(&[3_i64, 6, 12][..]),
        proptest::sample::select(&[12_i64, 18, 24][..]),
        any::<bool>(),
        1_i64..=4,
    )
        .prop_map(
            |(duration_units, min_units, max_units, splittable, priority)| TaskSpec {
                duration_units,
                min_units,
                max_units,
                splittable,
                priority,
            },
        )
}

fn build_input(
    scenario: (&str, &str, &str),
    window: (&str, &str),
    tasks: &[TaskSpec],
    max_daily_focus_min: i64,
    seed: i64,
) -> ScheduleInput {
    let tasks = tasks
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let max_units = entry.min_units.max(entry.max_units);
            let min_units = entry.min_units.min(max_units);
            let duration_units = entry.duration_units.clamp(min_units, max_units);
            let (min_session, max_session) = if entry.splittable {
                (min_units * 5, max_units * 5)
            } else {
                (duration_units * 5, duration_units * 5)
            };
            Task {
                due_at: Some(scenario.2.to_owned()),
                earliest_start_at: Some(scenario.1.to_owned()),
                splittable: entry.splittable,
                min_session_min: minutes(min_session),
                max_session_min: minutes(max_session),
                priority: minutes(entry.priority),
                ..support::task(&format!("T{index}"), minutes(duration_units * 5))
            }
        })
        .collect();
    let mut input = support::input(
        scenario.0,
        scenario.1,
        scenario.2,
        tasks,
        all_week(window, 1..=7),
    );
    input.prefs = support::prefs(minutes(max_daily_focus_min), 480.0);
    input.seed = minutes(seed);
    input
}

#[derive(Debug, Clone)]
struct HeavyTaskSpec {
    duration_units: i64,
    extra_p90_units: i64,
    min_units: i64,
    max_units: i64,
    splittable: bool,
    priority: i64,
    dependency_mode: i64,
    extra_index: usize,
    earliest_fraction: i64,
    buffer_units: i64,
    remaining_half: bool,
    preferred: Vec<WindowKind>,
}

fn heavy_task_spec() -> impl Strategy<Value = HeavyTaskSpec> {
    let sizes = (
        3_i64..=24,
        0_i64..=6,
        proptest::sample::select(&[3_i64, 6, 12][..]),
        proptest::sample::select(&[12_i64, 18, 24, 36][..]),
    );
    let shape = (any::<bool>(), 1_i64..=4, 0_i64..=2, 0_usize..=29);
    let window = (0_i64..=20, 0_i64..=4, any::<bool>());
    // Up to two distinct preferred windows, in any order.
    let preferred = proptest::sample::subsequence(WindowKind::ALL.to_vec(), 0..=2).prop_shuffle();
    (sizes, shape, window, preferred).prop_map(
        |(
            (duration_units, extra_p90_units, min_units, max_units),
            (splittable, priority, dependency_mode, extra_index),
            (earliest_fraction, buffer_units, remaining_half),
            preferred,
        )| HeavyTaskSpec {
            duration_units,
            extra_p90_units,
            min_units,
            max_units,
            splittable,
            priority,
            dependency_mode,
            extra_index,
            earliest_fraction,
            buffer_units,
            remaining_half,
            preferred,
        },
    )
}

#[derive(Debug, Clone)]
struct StepBlock {
    task_index: usize,
    start_step: i64,
    length_steps: i64,
}

fn step_block(lengths: std::ops::RangeInclusive<i64>) -> impl Strategy<Value = StepBlock> {
    (0_usize..=29, 0_i64..=6000, lengths).prop_map(|(task_index, start_step, length_steps)| {
        StepBlock {
            task_index,
            start_step,
            length_steps,
        }
    })
}

#[derive(Debug, Clone)]
struct HeavyException {
    day_offset: i64,
    kind: ExceptionKind,
    full_day: bool,
    start_minute: i64,
    length_minutes: i64,
}

#[derive(Debug, Clone)]
struct HeavySpec {
    scenario: (&'static str, &'static str),
    day_count: i64,
    window: (&'static str, &'static str),
    all_weekdays: bool,
    tasks: Vec<HeavyTaskSpec>,
    commitments: Vec<StepBlock>,
    locked: Vec<StepBlock>,
    existing: Vec<StepBlock>,
    exceptions: Vec<HeavyException>,
    now_fraction: i64,
    max_daily_focus_min: i64,
    break_after_min: i64,
    break_min: i64,
    risk_level: RiskLevel,
    seed: i64,
}

fn heavy_spec() -> impl Strategy<Value = HeavySpec> {
    let frame = (
        proptest::sample::select(LONG_SCENARIOS),
        18_i64..=21,
        proptest::sample::select(HEAVY_WINDOWS),
        any::<bool>(),
    );
    let work = (
        // fast-check draws mostly short lists (its default size caps a
        // generated list near 10 elements) and only sometimes long ones;
        // a uniform 1–30 would leave too few feasible inputs to check.
        prop_oneof![
            4 => proptest::collection::vec(heavy_task_spec(), 1..=10),
            1 => proptest::collection::vec(heavy_task_spec(), 11..=30),
        ],
        proptest::collection::vec(step_block(6..=36), 0..=1),
        proptest::collection::vec(step_block(6..=24), 0..=2),
        proptest::collection::vec(step_block(6..=24), 0..=3),
    );
    let exceptions = proptest::collection::vec(
        (
            0_i64..=20,
            prop_oneof![Just(ExceptionKind::Off), Just(ExceptionKind::Extra)],
            any::<bool>(),
            proptest::sample::select(&[0_i64, 540, 1140][..]),
            proptest::sample::select(&[60_i64, 120, 180][..]),
        )
            .prop_map(
                |(day_offset, kind, full_day, start_minute, length_minutes)| HeavyException {
                    day_offset,
                    kind,
                    full_day,
                    start_minute,
                    length_minutes,
                },
            ),
        0..=1,
    );
    let prefs = (
        0_i64..=25,
        proptest::sample::select(&[480_i64, 720, 1440][..]),
        proptest::sample::select(&[120_i64, 240, 480][..]),
        proptest::sample::select(&[5_i64, 10, 15][..]),
        prop_oneof![Just(RiskLevel::P50), Just(RiskLevel::P90)],
        0_i64..=100_000,
    );
    (frame, work, exceptions, prefs).prop_map(
        |(
            (scenario, day_count, window, all_weekdays),
            (tasks, commitments, locked, existing),
            exceptions,
            (now_fraction, max_daily_focus_min, break_after_min, break_min, risk_level, seed),
        )| HeavySpec {
            scenario,
            day_count,
            window,
            all_weekdays,
            tasks,
            commitments,
            locked,
            existing,
            exceptions,
            now_fraction,
            max_daily_focus_min,
            break_after_min,
            break_min,
            risk_level,
            seed,
        },
    )
}

fn format_clock(total_minutes: i64) -> String {
    format!("{:02}:{:02}", total_minutes / 60, total_minutes % 60)
}

/// An input at the size 06 §10 allows (up to 30 tasks, 21 days). With
/// `prior_blocks` from an earlier valid plan, the first is locked and the
/// next ones are the existing blocks, so replans exercise seeding rather
/// than mostly-invalid random blocks.
fn build_heavy_input(spec: &HeavySpec, with_blocks: bool, prior_blocks: &[Block]) -> ScheduleInput {
    let start_ms = instant_ms(spec.scenario.1);
    let end_ms = start_ms + spec.day_count * 24 * 60 * MINUTE_MS;
    let total_steps = (end_ms - start_ms) / STEP_MS;
    let step_iso = |steps: i64| instant_iso(start_ms + steps * STEP_MS);
    let clamp_step = |steps: i64, length_steps: i64| steps.min(total_steps - length_steps).max(0);
    let end_iso = instant_iso(end_ms);

    let task_count = spec.tasks.len();
    let tasks: Vec<Task> = spec
        .tasks
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let required_min = entry.duration_units * 5;
            let p90_min = (entry.duration_units + entry.extra_p90_units) * 5;
            let min_units = entry
                .min_units
                .min(entry.max_units)
                .min(entry.duration_units);
            let max_units = min_units.max(entry.max_units);
            let (min_session_min, max_session_min) = if entry.splittable {
                (min_units * 5, max_units * 5)
            } else {
                (p90_min, p90_min)
            };
            let buffer_min = entry.buffer_units * 5;
            let latest_earliest_ms = end_ms - (buffer_min + 5) * MINUTE_MS;
            let earliest_steps = (total_steps * entry.earliest_fraction).div_euclid(100);
            let earliest_ms =
                (start_ms + clamp_step(earliest_steps, 0) * STEP_MS).min(latest_earliest_ms);
            let depends_on = if index == 0 || entry.dependency_mode == 0 {
                Vec::new()
            } else if entry.dependency_mode == 1 {
                vec![format!("T{}", index - 1)]
            } else {
                vec![format!("T{}", entry.extra_index % index)]
            };
            let remaining_min = (entry.splittable && entry.remaining_half)
                .then(|| p90_min.min(min_session_min.max((required_min / 2).div_euclid(5) * 5)));
            Task {
                id: format!("T{index}"),
                due_at: Some(end_iso.clone()),
                earliest_start_at: Some(instant_iso(earliest_ms)),
                estimate: TaskEstimate {
                    p50_min: minutes(required_min),
                    p90_min: minutes(p90_min),
                },
                remaining_min: remaining_min.map(minutes),
                splittable: entry.splittable,
                min_session_min: minutes(min_session_min),
                max_session_min: minutes(max_session_min),
                priority: minutes(entry.priority),
                depends_on,
                buffer_before_due_min: Some(minutes(buffer_min)),
                preferred_windows: Some(entry.preferred.clone()),
                auto_split: None,
            }
        })
        .collect();

    let zone = jiff::tz::TimeZone::get(spec.scenario.0).unwrap();
    let first_local_date = Timestamp::from_millisecond(start_ms)
        .unwrap()
        .to_zoned(zone)
        .date();
    let exceptions = spec
        .exceptions
        .iter()
        .map(|entry| {
            let date = first_local_date
                .checked_add(entry.day_offset.min(spec.day_count - 1).days())
                .unwrap()
                .to_string();
            let window = (
                format_clock(entry.start_minute),
                format_clock((entry.start_minute + entry.length_minutes).min(1440)),
            );
            support::exception(
                &date,
                entry.kind,
                (!entry.full_day).then_some((window.0.as_str(), window.1.as_str())),
            )
        })
        .collect();

    let block_of = |entry: &StepBlock| {
        let steps = clamp_step(entry.start_step, entry.length_steps);
        support::block(
            &format!("T{}", entry.task_index % task_count),
            &step_iso(steps),
            &step_iso(steps + entry.length_steps),
        )
    };
    let (locked_blocks, existing_blocks) = if !with_blocks {
        (Vec::new(), Vec::new())
    } else if prior_blocks.is_empty() {
        (
            spec.locked.iter().map(block_of).collect(),
            spec.existing.iter().map(block_of).collect(),
        )
    } else {
        (
            prior_blocks.iter().take(1).cloned().collect(),
            prior_blocks
                .iter()
                .skip(1)
                .take(spec.existing.len().max(1))
                .cloned()
                .collect(),
        )
    };

    let now_steps = (total_steps * spec.now_fraction).div_euclid(100);
    let mut input = support::input(
        spec.scenario.0,
        spec.scenario.1,
        &end_iso,
        tasks,
        all_week(spec.window, if spec.all_weekdays { 1..=7 } else { 1..=5 }),
    );
    input.now = step_iso(clamp_step(now_steps, 0));
    input.exceptions = exceptions;
    input.commitments = spec
        .commitments
        .iter()
        .map(|entry| {
            let steps = clamp_step(entry.start_step, entry.length_steps);
            Commitment {
                start: step_iso(steps),
                end: step_iso(steps + entry.length_steps),
            }
        })
        .collect();
    input.locked_blocks = locked_blocks;
    input.existing_blocks = Some(existing_blocks);
    input.prefs = support::prefs(
        minutes(spec.max_daily_focus_min),
        minutes(spec.break_after_min),
    );
    input.prefs.break_min = minutes(spec.break_min);
    input.prefs.risk_level = spec.risk_level;
    input.seed = minutes(spec.seed);
    input
}

type Key = (String, String, String);

fn key_of(block: &Block) -> Key {
    (
        block.task_id.clone(),
        block.start.clone(),
        block.end.clone(),
    )
}

fn unique_blocks(blocks: impl Iterator<Item = Block>) -> Vec<Block> {
    let mut seen = BTreeSet::new();
    blocks.filter(|block| seen.insert(key_of(block))).collect()
}

/// H1 by a sweep over every still-active interval, not just the immediate
/// predecessor: nested history can hide an outer interval that still
/// overlaps the current one. History-only collisions are exempt.
fn independent_h1_violation(
    blocks: &[Block],
    commitments: &[Commitment],
    history: &[Block],
    candidate: &[Block],
) -> bool {
    let history_keys: BTreeSet<Key> = history.iter().map(key_of).collect();
    let candidate_keys: BTreeSet<Key> = candidate.iter().map(key_of).collect();
    let mut intervals: Vec<(i64, i64, Key)> = blocks
        .iter()
        .map(|block| {
            (
                instant_ms(&block.start),
                instant_ms(&block.end),
                key_of(block),
            )
        })
        .collect();
    intervals.sort_by_key(|interval| interval.0);
    let mut active: Vec<&(i64, i64, Key)> = Vec::new();
    for current in &intervals {
        active.retain(|entry| entry.1 > current.0);
        for previous in &active {
            let involves_history =
                history_keys.contains(&previous.2) || history_keys.contains(&current.2);
            let involves_candidate =
                candidate_keys.contains(&previous.2) || candidate_keys.contains(&current.2);
            if !(involves_history && !involves_candidate) {
                return true;
            }
        }
        active.push(current);
    }
    blocks
        .iter()
        .filter(|block| !history_keys.contains(&key_of(block)))
        .any(|block| {
            let (start_ms, end_ms) = (instant_ms(&block.start), instant_ms(&block.end));
            commitments.iter().any(|commitment| {
                start_ms < instant_ms(&commitment.end) && end_ms > instant_ms(&commitment.start)
            })
        })
}

/// H6 recounted: daily minutes by the one-minute walk (a day counts only
/// when it holds an audited minute), focus runs by a scan.
fn independent_h6_violation(input: &ScheduleInput, blocks: &[Block], history: &[Block]) -> bool {
    let history_keys: BTreeSet<Key> = history.iter().map(key_of).collect();
    let mut by_date: Vec<(String, i64, i64)> = Vec::new();
    for block in blocks {
        let audited = !history_keys.contains(&key_of(block));
        for (date, load) in daily_loads_by_minute(std::slice::from_ref(block), &input.time_zone) {
            let index = by_date
                .iter()
                .position(|(known, _, _)| *known == date)
                .unwrap_or_else(|| {
                    by_date.push((date, 0, 0));
                    by_date.len() - 1
                });
            by_date[index].1 += load;
            if audited {
                by_date[index].2 += load;
            }
        }
    }
    if by_date.iter().any(|(_, total, audited)| {
        *audited > 0 && minutes(*total) > input.prefs.max_daily_focus_min
    }) {
        return true;
    }
    if input.prefs.break_after_min <= 0.0 {
        return false;
    }
    let mut intervals: Vec<(i64, i64, bool)> = blocks
        .iter()
        .map(|block| {
            (
                instant_ms(&block.start),
                instant_ms(&block.end),
                !history_keys.contains(&key_of(block)),
            )
        })
        .collect();
    intervals.sort_by_key(|interval| interval.0);
    let break_ms = input.prefs.break_min * minutes(MINUTE_MS);
    let break_after_ms = input.prefs.break_after_min * minutes(MINUTE_MS);
    let too_long = |run: (i64, i64, bool)| run.2 && minutes(run.1 - run.0) > break_after_ms;
    let mut run: Option<(i64, i64, bool)> = None;
    for (start_ms, end_ms, audited) in intervals {
        run = match run {
            Some(current) if minutes(start_ms - current.1) >= break_ms => {
                if too_long(current) {
                    return true;
                }
                Some((start_ms, end_ms, audited))
            }
            Some(current) => Some((current.0, current.1.max(end_ms), current.2 || audited)),
            None => Some((start_ms, end_ms, audited)),
        };
    }
    run.is_some_and(too_long)
}

fn nested_history_input(due_at: &str) -> ScheduleInput {
    let mut first = support::task("A", 30.0);
    first.due_at = Some(due_at.to_owned());
    first.max_session_min = 120.0;
    let second = Task {
        due_at: Some(due_at.to_owned()),
        remaining_min: Some(0.0),
        splittable: false,
        min_session_min: 60.0,
        max_session_min: 60.0,
        ..support::task("B", 60.0)
    };
    let mut input = support::input(
        "UTC",
        "2026-11-09T09:00:00Z",
        due_at,
        vec![first, second],
        vec![support::rule(1, "00:00", "24:00")],
    );
    input.seed = 39039.0;
    input
}

fn violation_kinds(input: &ScheduleInput, plan: &[Block], history: &[Block]) -> Vec<&'static str> {
    audit(input, plan, history)
        .iter()
        .map(|violation| violation.code.as_str())
        .collect()
}

proptest! {
    #![proptest_config(property::config())]

    #[test]
    fn every_feasible_candidate_validates_and_at_most_three_candidates_return(
        scenario in proptest::sample::select(SCENARIOS),
        window in proptest::sample::select(WINDOWS),
        tasks in proptest::collection::vec(task_spec(), 0..=2),
        max_daily_focus_min in proptest::sample::select(&[120_i64, 240, 480][..]),
        seed in 0_i64..=100_000,
    ) {
        let input = build_input(scenario, window, &tasks, max_daily_focus_min, seed);
        let result = generate(&input, &all_policies(minutes(seed))).unwrap();
        prop_assert!(result.candidates.len() <= 3);
        for candidate in &result.candidates {
            if !candidate.feasible {
                prop_assert!(!candidate.explanation.is_empty());
                continue;
            }
            prop_assert_eq!(audit(&input, &candidate.blocks, &[]), Vec::new());
            prop_assert_eq!(candidate.deficit_min, 0.0);
            let plan: Vec<Block> = input
                .locked_blocks
                .iter()
                .chain(&candidate.blocks)
                .cloned()
                .collect();
            let max_load = daily_loads_by_minute(&plan, &input.time_zone)
                .iter()
                .map(|(_, load)| *load)
                .max()
                .unwrap_or(0);
            prop_assert_eq!(candidate.metrics.max_daily_load_min, minutes(max_load));
        }
    }

    #[test]
    fn independent_h1_and_the_validator_catch_a_candidate_under_nested_history(
        inner_start in 0_i64..=12,
        inner_units in 1_i64..=6,
        gap_units in 2_i64..=12,
        candidate_units in 1_i64..=6,
        tail_units in 0_i64..=6,
    ) {
        let base_ms = instant_ms("2026-11-09T09:00:00Z");
        let at = |units: i64| instant_iso(base_ms + units * STEP_MS);
        let inner_end = inner_start + inner_units;
        let candidate_start = inner_end + gap_units;
        let candidate_end = candidate_start + candidate_units;
        let history = [
            support::block("B", &at(0), &at(candidate_end + tail_units)),
            support::block("B", &at(inner_start), &at(inner_end)),
        ];
        let candidate = [support::block("A", &at(candidate_start), &at(candidate_end))];
        let plan: Vec<Block> = history.iter().chain(&candidate).cloned().collect();
        prop_assert!(independent_h1_violation(&plan, &[], &history, &candidate));
        let input = nested_history_input("2026-11-09T17:00:00Z");
        prop_assert!(violation_kinds(&input, &candidate, &history).contains(&"H1"));
    }
}

/// How many heavy inputs to try: `SCHED_HEAVY_RUNS` (150 by default), at
/// least 40 and at most the configured property runs.
fn heavy_runs() -> u32 {
    std::env::var("SCHED_HEAVY_RUNS")
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
        .filter(|runs| *runs > 0)
        .unwrap_or(150)
        .min(property::runs())
        .max(40)
}

fn check_heavy_candidate(
    input: &ScheduleInput,
    candidate: &PlanCandidate,
) -> Result<(), TestCaseError> {
    let now_ms = instant_ms(&input.now);
    for block in &candidate.blocks {
        prop_assert!(instant_ms(&block.start) >= now_ms);
    }
    let locked_keys: BTreeSet<Key> = input.locked_blocks.iter().map(key_of).collect();
    let history: Vec<Block> = input
        .existing()
        .iter()
        .filter(|block| instant_ms(&block.start) < now_ms && !locked_keys.contains(&key_of(block)))
        .cloned()
        .collect();
    let history_keys: BTreeSet<Key> = history.iter().map(key_of).collect();
    let full_plan = unique_blocks(
        input
            .locked_blocks
            .iter()
            .chain(&history)
            .chain(&candidate.blocks)
            .cloned(),
    );
    prop_assert!(!independent_h1_violation(
        &full_plan,
        &input.commitments,
        &history,
        &candidate.blocks
    ));
    for block in &full_plan {
        if !history_keys.contains(&key_of(block)) {
            prop_assert!(is_covered_by_minutes(
                input,
                instant_ms(&block.start),
                instant_ms(&block.end)
            ));
        }
    }
    prop_assert!(!independent_h6_violation(input, &full_plan, &history));
    Ok(())
}

#[test]
fn matches_an_independent_h1_h2_h6_oracle_on_spec_scale_replans() {
    // 06 §10 caps are up to 30 tasks and 21 days. This property uses a
    // bounded run count so that a 10,000-run gate stays practical; the fast
    // properties still honour the full count.
    let runs = heavy_runs();
    let (total, feasible) = (Cell::new(0_u32), Cell::new(0_u32));
    let mut runner = TestRunner::new(proptest::test_runner::Config {
        cases: runs,
        ..property::config()
    });
    runner
        .run(&heavy_spec(), |spec| {
            total.set(total.get() + 1);
            let base_input = build_heavy_input(&spec, false, &[]);
            let front_loaded = GenerateOptions {
                policies: Some(vec![PolicyName::FrontLoaded]),
                seed: Some(minutes(spec.seed)),
                max_local_improvement: None,
            };
            let base = generate(&base_input, &front_loaded).unwrap();
            let prior_blocks = match base.candidates.first() {
                Some(candidate) if candidate.feasible => candidate.blocks.clone(),
                _ => Vec::new(),
            };
            let input = build_heavy_input(&spec, true, &prior_blocks);
            let result = generate(&input, &all_policies(minutes(spec.seed))).unwrap();
            if result.candidates.iter().any(|candidate| candidate.feasible) {
                feasible.set(feasible.get() + 1);
            }
            prop_assert!(result.candidates.len() <= 3);
            for candidate in &result.candidates {
                if candidate.feasible {
                    check_heavy_candidate(&input, candidate)?;
                } else {
                    prop_assert!(!candidate.explanation.is_empty());
                }
            }
            Ok(())
        })
        .unwrap();
    assert!(total.get() >= runs, "{} of {runs} inputs ran", total.get());
    // The property must not pass by having nothing feasible to check.
    assert!(
        f64::from(feasible.get()) / f64::from(total.get()) >= 0.3,
        "only {} of {} heavy inputs had a feasible candidate",
        feasible.get(),
        total.get()
    );
}

#[test]
fn independent_h1_catches_a_candidate_under_a_nested_history_outer_interval() {
    let history = [
        support::block("B", "2026-11-09T09:00:00Z", "2026-11-09T12:00:00Z"),
        support::block("B", "2026-11-09T09:30:00Z", "2026-11-09T10:00:00Z"),
    ];
    let candidate = [support::block(
        "A",
        "2026-11-09T10:30:00Z",
        "2026-11-09T11:00:00Z",
    )];
    let plan: Vec<Block> = history.iter().chain(&candidate).cloned().collect();
    assert!(independent_h1_violation(&plan, &[], &history, &candidate));
    let input = nested_history_input("2026-11-09T17:00:00Z");
    assert!(violation_kinds(&input, &candidate, &history).contains(&"H1"));

    // The oracles do not cry wolf: history alone, or a candidate clear of
    // it, is no violation.
    assert!(!independent_h1_violation(&history, &[], &history, &[]));
    let clear = [support::block(
        "A",
        "2026-11-09T12:30:00Z",
        "2026-11-09T13:00:00Z",
    )];
    let plan: Vec<Block> = history.iter().chain(&clear).cloned().collect();
    assert!(!independent_h1_violation(&plan, &[], &history, &clear));
    assert!(!violation_kinds(&input, &clear, &history).contains(&"H1"));
    assert!(!independent_h6_violation(&input, &plan, &history));
    let mut capped = input;
    capped.prefs.max_daily_focus_min = 200.0;
    assert!(independent_h6_violation(&capped, &plan, &history));
    assert!(!independent_h6_violation(&capped, &history, &history));
}
