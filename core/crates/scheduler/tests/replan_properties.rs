//! `packages/scheduler/test/replan.property.test.ts`: properties of a replan
//! over an approved plan, with proptest in place of fast-check.

#![allow(clippy::unwrap_used)]

mod support;

use std::cell::Cell;

use jiff::Timestamp;
use ohmydate_scheduler::types::{Block, Commitment, PolicyName, ScheduleInput, Task};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use support::minute_oracle::instant_ms;
use support::replan::{block_minutes, plan, replanned, task_blocks};
use support::{audit, property, rule};

const MINUTE_MS: i64 = 60 * 1000;
const STEP_MS: i64 = 5 * MINUTE_MS;

/// Two days around an offset change (or none, in Seoul).
const SCENARIOS: &[(&str, &str, &str)] = &[
    ("Asia/Seoul", "2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z"),
    (
        "America/New_York",
        "2026-11-01T04:00:00Z",
        "2026-11-03T00:00:00Z",
    ),
    (
        "Europe/Berlin",
        "2026-10-25T00:00:00Z",
        "2026-10-27T00:00:00Z",
    ),
];

const WINDOWS: &[(&str, &str)] = &[("00:00", "24:00"), ("08:00", "18:00"), ("09:00", "17:00")];

type Scenario = (&'static str, &'static str, &'static str);
type Window = (&'static str, &'static str);

#[allow(clippy::cast_precision_loss)]
fn number(value: i64) -> f64 {
    value as f64
}

fn instant_iso(epoch_ms: i64) -> String {
    Timestamp::from_millisecond(epoch_ms).unwrap().to_string()
}

fn weekdays(every_day: bool, window: Window) -> Vec<ohmydate_scheduler::types::AvailabilityRule> {
    (1..=if every_day { 7 } else { 5 })
        .map(|weekday| rule(weekday, window.0, window.1))
        .collect()
}

#[derive(Debug, Clone, Copy)]
enum Mutation {
    Grow,
    Dependency,
    None,
}

#[derive(Debug, Clone)]
struct Spec {
    scenario: Scenario,
    window: Window,
    every_day: bool,
    /// `(duration units, max session units, priority)`.
    tasks: Vec<(i64, i64, i64)>,
    mutation: Mutation,
    mutation_index: usize,
    dependency_index: usize,
    grow_units: i64,
    policy: PolicyName,
    seed: i64,
}

fn spec() -> impl Strategy<Value = Spec> {
    (
        proptest::sample::select(SCENARIOS),
        proptest::sample::select(WINDOWS),
        any::<bool>(),
        proptest::collection::vec(
            (
                6_i64..=24,
                proptest::sample::select(&[12_i64, 18, 24, 36][..]),
                1_i64..=4,
            ),
            1..=3,
        ),
        proptest::sample::select(&[Mutation::Grow, Mutation::Dependency, Mutation::None][..]),
        (0_usize..=29, 0_usize..=29),
        proptest::sample::select(&[6_i64, 12][..]),
        proptest::sample::select(PolicyName::ALL),
        0_i64..=100_000,
    )
        .prop_map(
            |(
                scenario,
                window,
                every_day,
                tasks,
                mutation,
                (mutation_index, dependency_index),
                grow_units,
                policy,
                seed,
            )| Spec {
                scenario,
                window,
                every_day,
                tasks,
                mutation,
                mutation_index,
                dependency_index,
                grow_units,
                policy,
                seed,
            },
        )
}

/// Session and break shape of the generated inputs.
#[derive(Clone, Copy)]
struct Shape {
    min_session_cap_min: i64,
    break_after_min: f64,
}

const DEFAULT_SHAPE: Shape = Shape {
    min_session_cap_min: 30,
    break_after_min: 480.0,
};

fn build_input(spec: &Spec, shape: Shape) -> ScheduleInput {
    let (time_zone, start, end) = spec.scenario;
    let tasks = spec
        .tasks
        .iter()
        .enumerate()
        .map(|(index, (duration_units, max_units, priority))| {
            let minutes = duration_units * 5;
            Task {
                due_at: Some(end.to_owned()),
                earliest_start_at: Some(start.to_owned()),
                min_session_min: number(shape.min_session_cap_min.min(minutes)),
                max_session_min: number(duration_units.max(max_units) * 5),
                priority: number(*priority),
                ..support::task(&format!("T{index}"), number(minutes))
            }
        })
        .collect();
    let mut input = support::input(
        time_zone,
        start,
        end,
        tasks,
        weekdays(spec.every_day, spec.window),
    );
    input.prefs.break_after_min = shape.break_after_min;
    input.seed = number(spec.seed);
    input
}

/// What changed after the plan was approved: one task grew, one came to
/// depend on an earlier one, or nothing.
fn mutate(input: &ScheduleInput, spec: &Spec) -> ScheduleInput {
    let mut input = input.clone();
    let count = input.tasks.len();
    match spec.mutation {
        Mutation::Grow => {
            let grow = number(spec.grow_units * 5);
            let task = &mut input.tasks[spec.mutation_index % count];
            task.estimate.p50_min += grow;
            task.estimate.p90_min += grow;
        }
        Mutation::Dependency if count > 1 => {
            let index = 1 + spec.mutation_index % (count - 1);
            let dependency = input.tasks[spec.dependency_index % index].id.clone();
            if !input.tasks[index].depends_on.contains(&dependency) {
                input.tasks[index].depends_on.push(dependency);
            }
        }
        Mutation::Dependency | Mutation::None => {}
    }
    input
}

/// Whenever the changed input can be planned from nothing, it can be
/// replanned over the plan approved before the change.
fn replan_is_feasible_when_a_fresh_plan_is(config: Config, shape: Shape) -> u32 {
    let comparisons = Cell::new(0_u32);
    let mut runner = TestRunner::new(config);
    runner
        .run(&spec(), |spec| {
            let seed = number(spec.seed);
            let base_input = build_input(&spec, shape);
            let base = plan(&base_input, spec.policy, seed);
            if !base.feasible {
                return Err(TestCaseError::reject("no approved plan"));
            }
            let mutated = mutate(&base_input, &spec);
            if !plan(&mutated, spec.policy, seed).feasible {
                return Err(TestCaseError::reject("the change itself does not fit"));
            }
            comparisons.set(comparisons.get() + 1);
            let replan = plan(&replanned(&mutated, &base.blocks), spec.policy, seed);
            prop_assert!(replan.feasible);
            Ok(())
        })
        .unwrap();
    comparisons.get()
}

#[test]
fn a_replan_is_feasible_whenever_the_same_policy_is_feasible_without_existing_blocks() {
    let comparisons = replan_is_feasible_when_a_fresh_plan_is(property::config(), DEFAULT_SHAPE);
    assert!(comparisons >= property::runs());
}

/// FU-69R-1: the same implication with 45-minute minimum sessions and a
/// binding continuous-focus limit. Under the 06 §7.1 freeze it is not a
/// theorem for every input, so — as in the reference — it runs over a fixed
/// corpus; the witness property below is the one with a sound oracle.
#[test]
fn also_holds_with_min_session_45_and_break_after_120_on_a_seeded_corpus() {
    let shape = Shape {
        min_session_cap_min: 45,
        break_after_min: 120.0,
    };
    let comparisons = replan_is_feasible_when_a_fresh_plan_is(property::corpus(6945, 200), shape);
    assert!(comparisons >= 200);
}

// FU-69R-1 witness property.
//
// One UTC day is laid out left to right from random items: frozen blocks of
// other tasks, commitments, and sessions of task A, separated by nothing, a
// few minutes or exactly one break, with little or no tail. The A sessions
// are a witness: when the independent validator accepts frozen blocks +
// witness, a plan that keeps every frozen block exists, so the replan must
// be feasible in every policy and keep those blocks. A's own existing block
// is absent, the first witness session, or a shortened one (A grew).
//
// Minimum sessions of 30/45/60 minutes meet continuous-focus limits of
// 90/120/240 minutes here, which is where the start of a session inside a
// gap matters (join the previous focus run, leave a break after it, or run
// into the next one).

#[derive(Debug, Clone, Copy)]
enum ItemKind {
    Frozen,
    Commitment,
    Session,
}

#[derive(Debug, Clone, Copy)]
enum Gap {
    Cells(i64),
    Break,
}

#[derive(Debug, Clone, Copy)]
enum Existing {
    None,
    First,
    Shrunk,
}

#[derive(Debug, Clone)]
struct WitnessSpec {
    items: Vec<(ItemKind, Gap, i64)>,
    tail_cells: i64,
    min_session_cells: i64,
    max_session_extra_cells: i64,
    break_after_min: i64,
    break_min: i64,
    existing: Existing,
    shrink_cells: i64,
    seed: i64,
}

fn witness_spec() -> impl Strategy<Value = WitnessSpec> {
    let kinds = [
        ItemKind::Frozen,
        ItemKind::Commitment,
        ItemKind::Session,
        ItemKind::Session,
    ];
    let gaps = [
        Gap::Cells(0),
        Gap::Cells(0),
        Gap::Break,
        Gap::Break,
        Gap::Break,
        Gap::Cells(1),
        Gap::Cells(2),
    ];
    (
        proptest::collection::vec(
            (
                proptest::sample::select(kinds.to_vec()),
                proptest::sample::select(gaps.to_vec()),
                2_i64..=24,
            ),
            2..=6,
        ),
        proptest::sample::select(&[0_i64, 0, 0, 1, 2, 4][..]),
        proptest::sample::select(&[6_i64, 9, 12][..]),
        0_i64..=15,
        proptest::sample::select(&[90_i64, 120, 240][..]),
        proptest::sample::select(&[10_i64, 15, 30][..]),
        proptest::sample::select(&[Existing::None, Existing::First, Existing::Shrunk][..]),
        1_i64..=6,
        0_i64..=1000,
    )
        .prop_map(
            |(
                items,
                tail_cells,
                min_session_cells,
                max_session_extra_cells,
                break_after_min,
                break_min,
                existing,
                shrink_cells,
                seed,
            )| WitnessSpec {
                items,
                tail_cells,
                min_session_cells,
                max_session_extra_cells,
                break_after_min,
                break_min,
                existing,
                shrink_cells,
                seed,
            },
        )
}

struct WitnessCase {
    input: ScheduleInput,
    frozen: Vec<Block>,
    witness: Vec<Block>,
}

fn cell_instant(cell: i64) -> String {
    instant_iso(instant_ms("2026-11-09T09:00:00Z") + cell * STEP_MS)
}

fn build_witness_case(spec: &WitnessSpec) -> Option<WitnessCase> {
    let max_session_cells = spec.min_session_cells + spec.max_session_extra_cells;
    let break_cells = (spec.break_min + 4) / 5;
    let mut frozen: Vec<Block> = Vec::new();
    let mut sessions: Vec<Block> = Vec::new();
    let mut commitments: Vec<Commitment> = Vec::new();
    let mut tasks: Vec<Task> = Vec::new();
    let mut cursor = 0;
    for (kind, gap, length_cells) in &spec.items {
        let start = cursor
            + match gap {
                Gap::Break => break_cells,
                Gap::Cells(cells) => *cells,
            };
        let length = match kind {
            ItemKind::Session => max_session_cells.min(spec.min_session_cells.max(*length_cells)),
            ItemKind::Frozen => 3.max((*length_cells).min(spec.break_after_min / 5)),
            ItemKind::Commitment => *length_cells,
        };
        let end = start + length;
        if end > 96 {
            break;
        }
        let (start_at, end_at) = (cell_instant(start), cell_instant(end));
        match kind {
            ItemKind::Frozen => {
                let id = format!("F{}", frozen.len());
                frozen.push(support::block(&id, &start_at, &end_at));
                tasks.push(Task {
                    min_session_min: 15.0,
                    max_session_min: number(60.max(length * 5)),
                    priority: 2.0,
                    ..support::task(&id, number(length * 5))
                });
            }
            ItemKind::Commitment => commitments.push(Commitment {
                start: start_at,
                end: end_at,
            }),
            ItemKind::Session => sessions.push(support::block("A", &start_at, &end_at)),
        }
        cursor = end;
    }
    let first = sessions.first()?.clone();
    let required_min: i64 = sessions.iter().map(block_minutes).sum();
    tasks.push(Task {
        min_session_min: number(spec.min_session_cells * 5),
        max_session_min: number(max_session_cells * 5),
        ..support::task("A", number(required_min))
    });

    let mut existing = frozen.clone();
    match spec.existing {
        Existing::First if sessions.len() > 1 => existing.push(first),
        Existing::Shrunk => {
            let shrunk_end_ms = instant_ms(&first.end) - spec.shrink_cells * STEP_MS;
            if (shrunk_end_ms - instant_ms(&first.start)) / STEP_MS >= spec.min_session_cells {
                existing.push(support::block(
                    "A",
                    &first.start,
                    &instant_iso(shrunk_end_ms),
                ));
            }
        }
        Existing::First | Existing::None => {}
    }

    let day_start = cell_instant(0);
    let day_end = cell_instant(cursor + spec.tail_cells);
    let mut input = support::input(
        "UTC",
        &day_start,
        &day_end,
        tasks,
        vec![rule(1, "09:00", &day_end[11..16])],
    );
    input.commitments = commitments;
    input.existing_blocks = Some(existing);
    input.prefs.break_after_min = number(spec.break_after_min);
    input.prefs.break_min = number(spec.break_min);
    input.seed = number(spec.seed);
    let witness = frozen.iter().chain(&sessions).cloned().collect();
    Some(WitnessCase {
        input,
        frozen,
        witness,
    })
}

const WITNESS_RUNS: u32 = 400;

#[test]
fn is_feasible_and_keeps_the_frozen_blocks_whenever_a_validated_witness_exists() {
    let (cases, multi_session) = (Cell::new(0_u32), Cell::new(0_u32));
    let mut runner = TestRunner::new(property::corpus(6903, WITNESS_RUNS));
    runner
        .run(&witness_spec(), |spec| {
            let Some(built) = build_witness_case(&spec) else {
                return Err(TestCaseError::reject("no session of A"));
            };
            if !audit(&built.input, &built.witness, &[]).is_empty() {
                return Err(TestCaseError::reject("the layout is not a valid plan"));
            }
            cases.set(cases.get() + 1);
            if built.witness.len() - built.frozen.len() > 1 {
                multi_session.set(multi_session.get() + 1);
            }
            for policy in PolicyName::ALL {
                let candidate = plan(&built.input, *policy, number(spec.seed));
                prop_assert!(candidate.feasible, "{}", policy);
                prop_assert_eq!(candidate.deficit_min, 0.0);
                prop_assert_eq!(audit(&built.input, &candidate.blocks, &[]), Vec::new());
                for block in &built.frozen {
                    prop_assert_eq!(
                        task_blocks(&candidate.blocks, &block.task_id),
                        task_blocks(std::slice::from_ref(block), &block.task_id)
                    );
                }
            }
            Ok(())
        })
        .unwrap();
    assert!(cases.get() >= WITNESS_RUNS);
    // The property must not pass on single-session witnesses alone.
    assert!(
        multi_session.get() > WITNESS_RUNS / 4,
        "{}",
        multi_session.get()
    );
}

#[test]
fn a_layout_the_validator_rejects_is_not_taken_for_a_witness() {
    // Two sessions of A with no break between them, 100 minutes in all,
    // under a 90-minute focus limit: not a plan, so it proves nothing.
    let spec = WitnessSpec {
        items: vec![
            (ItemKind::Session, Gap::Cells(0), 10),
            (ItemKind::Session, Gap::Cells(0), 10),
        ],
        tail_cells: 0,
        min_session_cells: 6,
        max_session_extra_cells: 6,
        break_after_min: 90,
        break_min: 15,
        existing: Existing::None,
        shrink_cells: 1,
        seed: 1,
    };
    let built = build_witness_case(&spec).unwrap();
    assert_eq!(built.witness.len(), 2);
    let kinds: Vec<&str> = audit(&built.input, &built.witness, &[])
        .iter()
        .map(|violation| violation.code.as_str())
        .collect();
    assert!(kinds.contains(&"H6"), "{kinds:?}");
    // With a break between them the same sessions are a witness.
    let mut spaced = spec.clone();
    spaced.items[1].1 = Gap::Break;
    let built = build_witness_case(&spaced).unwrap();
    assert_eq!(audit(&built.input, &built.witness, &[]), Vec::new());
    // No session of A: no case at all.
    let mut none = spec;
    none.items = vec![(ItemKind::Frozen, Gap::Cells(0), 6)];
    assert!(build_witness_case(&none).is_none());
}

// Advancing `now` with `remainingMin`.

#[derive(Debug, Clone)]
struct AdvanceSpec {
    scenario: Scenario,
    window: Window,
    every_day: bool,
    /// `(duration units, max session units, priority, splittable, depends on
    /// the task before it)`.
    tasks: Vec<(i64, i64, i64, bool, bool)>,
    /// `(start step, length steps)`.
    commitments: Vec<(i64, i64)>,
    max_daily_focus_min: i64,
    break_after_min: i64,
    policy: PolicyName,
    seed: i64,
    pivot_index: usize,
    pivot_offset_units: i64,
}

fn advance_spec() -> impl Strategy<Value = AdvanceSpec> {
    (
        proptest::sample::select(SCENARIOS),
        proptest::sample::select(WINDOWS),
        any::<bool>(),
        proptest::collection::vec(
            (
                6_i64..=24,
                proptest::sample::select(&[12_i64, 18, 24, 36][..]),
                1_i64..=4,
                any::<bool>(),
                any::<bool>(),
            ),
            1..=6,
        ),
        proptest::collection::vec(
            (0_i64..=400, proptest::sample::select(&[6_i64, 12][..])),
            0..=1,
        ),
        (
            proptest::sample::select(&[180_i64, 240, 480][..]),
            proptest::sample::select(&[120_i64, 240, 480][..]),
        ),
        proptest::sample::select(PolicyName::ALL),
        0_i64..=100_000,
        (
            0_usize..=9,
            proptest::sample::select(&[3_i64, 6, 9, 12, 18][..]),
        ),
    )
        .prop_map(
            |(
                scenario,
                window,
                every_day,
                tasks,
                commitments,
                (max_daily_focus_min, break_after_min),
                policy,
                seed,
                (pivot_index, pivot_offset_units),
            )| AdvanceSpec {
                scenario,
                window,
                every_day,
                tasks,
                commitments,
                max_daily_focus_min,
                break_after_min,
                policy,
                seed,
                pivot_index,
                pivot_offset_units,
            },
        )
}

fn build_advance_input(spec: &AdvanceSpec) -> ScheduleInput {
    let (time_zone, start, end) = spec.scenario;
    let tasks = spec
        .tasks
        .iter()
        .enumerate()
        .map(
            |(index, (duration_units, max_units, priority, splittable, depends))| {
                let minutes = duration_units * 5;
                let (min_session, max_session) = if *splittable {
                    (minutes.min(30), duration_units.max(max_units) * 5)
                } else {
                    (minutes, minutes)
                };
                Task {
                    due_at: Some(end.to_owned()),
                    earliest_start_at: Some(start.to_owned()),
                    splittable: *splittable,
                    min_session_min: number(min_session),
                    max_session_min: number(max_session),
                    priority: number(*priority),
                    depends_on: if index > 0 && *depends {
                        vec![format!("T{}", index - 1)]
                    } else {
                        Vec::new()
                    },
                    ..support::task(&format!("T{index}"), number(minutes))
                }
            },
        )
        .collect();
    let (horizon_start_ms, horizon_end_ms) = (instant_ms(start), instant_ms(end));
    let mut input = support::input(
        time_zone,
        start,
        end,
        tasks,
        weekdays(spec.every_day, spec.window),
    );
    input.commitments = spec
        .commitments
        .iter()
        .map(|(start_step, length_steps)| {
            let start_ms = (horizon_start_ms + start_step * STEP_MS)
                .min(horizon_end_ms - length_steps * STEP_MS);
            Commitment {
                start: instant_iso(start_ms),
                end: instant_iso(start_ms + length_steps * STEP_MS),
            }
        })
        .collect();
    input.prefs = support::prefs(
        number(spec.max_daily_focus_min),
        number(spec.break_after_min),
    );
    input.seed = number(spec.seed);
    input
}

/// The approved plan seen again later, part of the way through one of its
/// blocks, with every task's `remainingMin` lowered by what its past blocks
/// already hold.
fn advanced(base: &ScheduleInput, blocks: &[Block], spec: &AdvanceSpec) -> ScheduleInput {
    let long: Vec<&Block> = blocks
        .iter()
        .filter(|block| block_minutes(block) >= 30)
        .collect();
    let mut now_ms = instant_ms(&base.now);
    if !long.is_empty() {
        let pivot = long[spec.pivot_index % long.len()];
        let offset_min = (spec.pivot_offset_units * 5)
            .max(5)
            .min(block_minutes(pivot) - 5);
        now_ms = instant_ms(&pivot.start) + offset_min * MINUTE_MS;
    }
    let mut input = replanned(base, blocks);
    input.now = instant_iso(now_ms);
    for task in &mut input.tasks {
        let history_min: i64 = blocks
            .iter()
            .filter(|block| block.task_id == task.id && instant_ms(&block.start) < now_ms)
            .map(block_minutes)
            .sum();
        task.remaining_min = Some((task.estimate.p50_min - number(history_min)).max(0.0));
    }
    input
}

#[test]
fn stays_feasible_with_changed_blocks_0_when_remaining_is_required_minus_history() {
    let comparisons = Cell::new(0_u32);
    let mut runner = TestRunner::new(property::config());
    runner
        .run(&advance_spec(), |spec| {
            let seed = number(spec.seed);
            let base_input = build_advance_input(&spec);
            let base = plan(&base_input, spec.policy, seed);
            if !base.feasible {
                return Err(TestCaseError::reject("no approved plan"));
            }
            comparisons.set(comparisons.get() + 1);
            let input = advanced(&base_input, &base.blocks, &spec);
            let candidate = plan(&input, spec.policy, seed);
            prop_assert!(candidate.feasible);
            prop_assert_eq!(candidate.metrics.changed_blocks, 0.0);
            Ok(())
        })
        .unwrap();
    assert!(comparisons.get() >= property::runs());
}

#[test]
fn advancing_now_without_lowering_remaining_asks_for_the_past_minutes_again() {
    // The negative of the property above: the same replan with the full
    // estimate still to do has to add blocks for what history already holds.
    let spec = AdvanceSpec {
        scenario: SCENARIOS[0],
        window: WINDOWS[1],
        every_day: true,
        tasks: vec![(12, 12, 1, false, false), (12, 12, 2, false, false)],
        commitments: Vec::new(),
        max_daily_focus_min: 480,
        break_after_min: 480,
        policy: PolicyName::FrontLoaded,
        seed: 7,
        pivot_index: 0,
        pivot_offset_units: 6,
    };
    let base_input = build_advance_input(&spec);
    let base = plan(&base_input, spec.policy, 7.0);
    assert!(base.feasible);
    let kept = advanced(&base_input, &base.blocks, &spec);
    assert!(instant_ms(&kept.now) > instant_ms(&base_input.now));
    assert_eq!(plan(&kept, spec.policy, 7.0).metrics.changed_blocks, 0.0);

    let mut again = kept.clone();
    for task in &mut again.tasks {
        task.remaining_min = None;
    }
    let candidate = plan(&again, spec.policy, 7.0);
    assert!(candidate.metrics.changed_blocks > 0.0);
}
