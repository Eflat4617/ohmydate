//! `packages/scheduler/test/fu69.test.ts`: a replan was infeasible where a
//! fresh plan was feasible.
//!
//! 1. Rigid chunks: a grown task is an affected task, so its seeds were
//!    dropped and it was re-placed as `ceil(required / maxSession)` equal
//!    chunks. Between the frozen blocks of the unaffected tasks no gap held
//!    one such chunk, although the task is splittable and the gaps add up.
//!    The repair is the gap-fitted split.
//! 2. Starved dependents: a released predecessor was placed with no regard
//!    for the room its dependents still need, so `balanced` parked it in the
//!    tail of the horizon and the dependent no longer fitted. The repair is
//!    the successor bound.
//!
//! FU-69R-1 adds the starts of a session that the break rule (H6) makes
//! distinct inside one gap.

#![allow(clippy::unwrap_used)]

mod support;

use jiff::Timestamp;
use ohmydate_scheduler::canonical::canonical_json;
use ohmydate_scheduler::generate::PlanCandidate;
use ohmydate_scheduler::types::{Block, GenerateOptions, PolicyName, ScheduleInput, Task};
use support::minute_oracle::instant_ms;
use support::replan::{
    block_minutes, commitment, explains, plan, replanned, run, symmetric_difference, task_minutes,
};
use support::{audit, block, rule};

#[allow(clippy::cast_precision_loss)]
fn number(value: i64) -> f64 {
    value as f64
}

fn count(value: usize) -> f64 {
    number(i64::try_from(value).unwrap())
}

fn only(input: &ScheduleInput, policy: PolicyName) -> PlanCandidate {
    plan(input, policy, input.seed)
}

/// The blocks of one task, in plan order.
fn blocks_of(blocks: &[Block], task_id: &str) -> Vec<Block> {
    blocks
        .iter()
        .filter(|block| block.task_id == task_id)
        .cloned()
        .collect()
}

/// Feasible by the independent validator, not by the generator's own word.
fn assert_valid(input: &ScheduleInput, candidate: &PlanCandidate) {
    assert_eq!(audit(input, &candidate.blocks, &[]), Vec::new());
    assert!(candidate.feasible);
    assert_eq!(candidate.deficit_min, 0.0);
}

fn assert_sessions_in_bounds(input: &ScheduleInput, blocks: &[Block]) {
    for task in &input.tasks {
        for block in blocks_of(blocks, &task.id) {
            let minutes = number(block_minutes(&block));
            assert!(minutes >= task.min_session_min && minutes <= task.max_session_min);
        }
    }
}

fn assert_dependency_order(blocks: &[Block], dependent: &str, dependency: &str) {
    let dependency_end = blocks_of(blocks, dependency)
        .iter()
        .map(|block| instant_ms(&block.end))
        .max()
        .unwrap();
    let dependent_start = blocks_of(blocks, dependent)
        .iter()
        .map(|block| instant_ms(&block.start))
        .min()
        .unwrap();
    assert!(dependent_start >= dependency_end);
}

fn at(base: &str, offset_min: i64) -> String {
    Timestamp::from_millisecond(instant_ms(base) + offset_min * 60_000)
        .unwrap()
        .to_string()
}

/// `2026-11-<day>T<clock>:00Z`.
fn utc_on(clock: &str, day: u8) -> String {
    format!("2026-11-{day:02}T{clock}:00Z")
}

fn utc(clock: &str) -> String {
    utc_on(clock, 9)
}

/// A splittable hour in sessions of 30–120 minutes.
fn task(id: &str) -> Task {
    Task {
        min_session_min: 30.0,
        max_session_min: 120.0,
        ..support::task(id, 60.0)
    }
}

fn sized(id: &str, minutes: i64, max_session_min: i64) -> Task {
    Task {
        max_session_min: number(max_session_min),
        ..support::task(id, number(minutes))
    }
    .with_min_session(30)
}

trait TaskExt {
    fn with_min_session(self, minutes: i64) -> Self;
    fn within(self, start: &str, end: &str) -> Self;
}

impl TaskExt for Task {
    fn with_min_session(mut self, minutes: i64) -> Self {
        self.min_session_min = number(minutes);
        self
    }

    fn within(mut self, start: &str, end: &str) -> Self {
        self.earliest_start_at = Some(start.to_owned());
        self.due_at = Some(end.to_owned());
        self
    }
}

// A grown task between frozen blocks on a DST weekend.

struct Weekend {
    name: &'static str,
    time_zone: &'static str,
    start: &'static str,
    end: &'static str,
    /// UTC instant of Monday 09:00 local, the only weekday window in range.
    monday_start: &'static str,
}

/// Weekday-only 09:00–17:00 windows over a DST weekend: only Monday has
/// capacity (480 minutes).
const WEEKENDS: &[Weekend] = &[
    Weekend {
        name: "Europe/Berlin DST end (2026-10-25), the reported counterexample",
        time_zone: "Europe/Berlin",
        start: "2026-10-25T00:00:00Z",
        end: "2026-10-27T00:00:00Z",
        monday_start: "2026-10-26T08:00:00Z",
    },
    Weekend {
        name: "Europe/Berlin DST start (2026-03-29)",
        time_zone: "Europe/Berlin",
        start: "2026-03-29T00:00:00Z",
        end: "2026-03-31T00:00:00Z",
        monday_start: "2026-03-30T07:00:00Z",
    },
    Weekend {
        name: "America/New_York DST end (2026-11-01), negative offset",
        time_zone: "America/New_York",
        start: "2026-11-01T04:00:00Z",
        end: "2026-11-03T00:00:00Z",
        monday_start: "2026-11-02T14:00:00Z",
    },
];

fn weekend_input(weekend: &Weekend, t0_min: i64) -> ScheduleInput {
    let tasks = [(t0_min, 180), (95, 95), (100, 100)]
        .iter()
        .enumerate()
        .map(|(index, (minutes, max_session))| {
            sized(&format!("T{index}"), *minutes, *max_session).within(weekend.start, weekend.end)
        })
        .collect();
    let mut input = support::input(
        weekend.time_zone,
        weekend.start,
        weekend.end,
        tasks,
        (1..=5)
            .map(|weekday| rule(weekday, "09:00", "17:00"))
            .collect(),
    );
    input.seed = 0.0;
    input
}

#[test]
fn front_loaded_keeps_every_existing_block_and_adds_one_session_on_a_dst_weekend() {
    for weekend in WEEKENDS {
        let monday = weekend.monday_start;
        let base_input = weekend_input(weekend, 115);
        let base = only(&base_input, PolicyName::FrontLoaded);
        assert_valid(&base_input, &base);
        // T0 115 | T1 95 | T2 100 back to back from Monday 09:00 local; the
        // free tail is 170 min and T0's own slot is 115 min.
        assert_eq!(
            base.blocks,
            [
                block("T0", monday, &at(monday, 115)),
                block("T1", &at(monday, 115), &at(monday, 210)),
                block("T2", &at(monday, 210), &at(monday, 310)),
            ],
            "{}",
            weekend.name
        );

        // T0 grows by 60 min to 175: one 175-min chunk fits neither gap.
        let mutated = weekend_input(weekend, 175);
        assert_valid(&mutated, &only(&mutated, PolicyName::FrontLoaded));
        let replan_input = replanned(&mutated, &base.blocks);
        let replan = only(&replan_input, PolicyName::FrontLoaded);
        assert_valid(&replan_input, &replan);
        let mut expected = base.blocks.clone();
        expected.push(block("T0", &at(monday, 310), &at(monday, 370)));
        assert_eq!(replan.blocks, expected, "{}", weekend.name);
        assert_eq!(replan.metrics.changed_blocks, 1.0);
        assert!(explains(
            &replan,
            "Placed 370 of 370 required minutes in 4 movable block(s), retaining 3 existing block(s)."
        ));
        assert!(!explains(&replan, "Replan change bound exceeded:"));
    }
}

#[test]
fn every_policy_stays_feasible_with_unaffected_blocks_frozen_on_a_dst_weekend() {
    for weekend in WEEKENDS {
        for policy in PolicyName::ALL {
            let base_input = weekend_input(weekend, 115);
            let base = only(&base_input, *policy);
            assert_valid(&base_input, &base);
            let mutated = weekend_input(weekend, 175);
            assert_valid(&mutated, &only(&mutated, *policy));
            let replan_input = replanned(&mutated, &base.blocks);
            let replan = only(&replan_input, *policy);
            assert_valid(&replan_input, &replan);
            assert_sessions_in_bounds(&replan_input, &replan.blocks);
            assert_eq!(task_minutes(&replan.blocks, "T0"), 175);
            for frozen in ["T1", "T2"] {
                assert_eq!(
                    blocks_of(&replan.blocks, frozen),
                    blocks_of(&base.blocks, frozen),
                    "{} {policy}",
                    weekend.name
                );
            }
            assert_eq!(
                replan.metrics.changed_blocks,
                count(symmetric_difference(&base.blocks, &replan.blocks))
            );
            // 06 §7.1 bound: 2 × (affected existing blocks = T0's one) + 2.
            assert!(replan.metrics.changed_blocks <= 4.0);
        }
    }
}

#[test]
fn the_same_replan_input_gives_byte_identical_output() {
    let weekend = &WEEKENDS[0];
    let base = only(&weekend_input(weekend, 115), PolicyName::FrontLoaded);
    let replan_input = replanned(&weekend_input(weekend, 175), &base.blocks);
    let options = GenerateOptions {
        policies: Some(PolicyName::ALL.to_vec()),
        seed: Some(0.0),
        max_local_improvement: None,
    };
    let first = canonical_json(&run(&replan_input, &options).to_json());
    assert_eq!(
        first,
        canonical_json(&run(&replan_input, &options).to_json())
    );
    // Another seed is another input: at least its hash differs.
    let other = GenerateOptions {
        seed: Some(1.0),
        ..options
    };
    assert_ne!(first, canonical_json(&run(&replan_input, &other).to_json()));
}

// The shrunk counterexample: two tasks, UTC, no DST.

/// UTC days from Monday 2026-11-09, availability 09:00 to `day_end` on
/// every day.
fn day_input(tasks: Vec<Task>, day_end: &str, days: u8) -> ScheduleInput {
    let mut input = support::input(
        "UTC",
        "2026-11-09T00:00:00Z",
        &utc_on("00:00", 9 + days),
        tasks,
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", day_end))
            .collect(),
    );
    input.seed = 69.0;
    input
}

fn two_hours() -> Vec<Block> {
    vec![
        block("T0", &utc("09:00"), &utc("10:00")),
        block("T1", &utc("10:00"), &utc("11:00")),
    ]
}

/// T0 grown from 60 to 90 minutes, next to an untouched T1.
fn grown(edit: impl FnOnce(&mut Task)) -> Vec<Task> {
    let mut t0 = task("T0");
    t0.estimate.p50_min = 90.0;
    t0.estimate.p90_min = 90.0;
    edit(&mut t0);
    vec![t0, task("T1")]
}

#[test]
fn generates_the_existing_plan_from_scratch_in_every_policy() {
    for policy in PolicyName::ALL {
        let input = day_input(vec![task("T0"), task("T1")], "12:00", 1);
        assert_eq!(only(&input, *policy).blocks, two_hours(), "{policy}");
    }
}

#[test]
fn keeps_t0_freezes_t1_and_adds_the_30_minute_remainder() {
    for policy in PolicyName::ALL {
        let fresh = day_input(grown(|_| {}), "12:00", 1);
        assert_valid(&fresh, &only(&fresh, *policy));
        let replan_input = replanned(&fresh, &two_hours());
        let replan = only(&replan_input, *policy);
        assert_valid(&replan_input, &replan);
        let mut expected = two_hours();
        expected.push(block("T0", &utc("11:00"), &utc("11:30")));
        assert_eq!(replan.blocks, expected, "{policy}");
        assert_eq!(replan.metrics.changed_blocks, 1.0);
    }
}

#[test]
fn re_splits_the_whole_task_when_its_own_block_cannot_be_kept() {
    // minSession 45: keeping the 60-minute block would leave a 30-minute
    // remainder below the minimum, so both sessions are fitted afresh.
    for policy in PolicyName::ALL {
        let tasks = grown(|task| task.min_session_min = 45.0);
        let replan_input = replanned(&day_input(tasks, "12:00", 1), &two_hours());
        let replan = only(&replan_input, *policy);
        assert_valid(&replan_input, &replan);
        assert_sessions_in_bounds(&replan_input, &replan.blocks);
        assert_eq!(blocks_of(&replan.blocks, "T0").len(), 2);
        assert_eq!(task_minutes(&replan.blocks, "T0"), 90);
        assert_eq!(
            blocks_of(&replan.blocks, "T1"),
            blocks_of(&two_hours(), "T1")
        );
        // 1 removed + 2 added <= 2 × 1 + 2.
        assert_eq!(replan.metrics.changed_blocks, 3.0);
    }
}

#[test]
fn still_returns_an_explained_infeasible_candidate_for_a_non_splittable_task() {
    // 06 §7.1: unaffected blocks stay frozen; when no placement exists under
    // that freeze the candidate is infeasible and explained, even though a
    // fresh plan is feasible. The gap-fitted split never splits such a task.
    for policy in PolicyName::ALL {
        let fresh = day_input(grown(|task| task.splittable = false), "12:00", 1);
        assert_valid(&fresh, &only(&fresh, *policy));
        let replan = only(&replanned(&fresh, &two_hours()), *policy);
        assert!(!replan.feasible);
        assert_eq!(replan.deficit_min, 90.0);
        assert_eq!(replan.blocks, blocks_of(&two_hours(), "T1"));
        assert!(explains(&replan, "H7"));
        assert!(explains(&replan, "no_contiguous_window"));
    }
}

#[test]
fn does_not_use_gaps_shorter_than_min_session() {
    // Free time is 60 + 60 min but every session must be at least 90 min.
    for policy in PolicyName::ALL {
        let tasks = grown(|task| task.min_session_min = 90.0);
        let replan = only(
            &replanned(&day_input(tasks, "12:00", 1), &two_hours()),
            *policy,
        );
        assert!(!replan.feasible);
        assert_eq!(replan.deficit_min, 90.0);
        assert_eq!(replan.blocks, blocks_of(&two_hours(), "T1"));
    }
}

// Gap-fitted sessions.

#[test]
fn splits_a_fresh_task_around_a_commitment_instead_of_reporting_a_shortfall() {
    // 09:00-17:00 with a commitment 10:55-14:10 leaves 115 + 170 min; the
    // 175-minute task needs one 175-minute chunk by the equal-chunk rule.
    let mut input = day_input(vec![sized("A", 175, 180)], "17:00", 1);
    input.commitments = vec![commitment(&utc("10:55"), &utc("14:10"))];
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert_valid(&input, &candidate);
        assert_sessions_in_bounds(&input, &candidate.blocks);
        assert_eq!(task_minutes(&candidate.blocks, "A"), 175);
        assert_eq!(candidate.blocks.len(), 2);
    }
    // front_loaded fills the earliest gap first.
    assert_eq!(
        only(&input, PolicyName::FrontLoaded).blocks,
        [
            block("A", &utc("09:00"), &utc("10:55")),
            block("A", &utc("14:10"), &utc("15:10")),
        ]
    );
    // focus_blocked takes the longest gap first; the 30-minute rest must stay
    // a valid session, so the long session is 145 min, not the full 170.
    assert_eq!(
        only(&input, PolicyName::FocusBlocked).blocks,
        [
            block("A", &utc("09:00"), &utc("09:30")),
            block("A", &utc("14:10"), &utc("16:35")),
        ]
    );
}

#[test]
fn keeps_the_equal_chunk_shortfall_when_the_gaps_cannot_cover_the_task() {
    // 60 free minutes for a 90-minute task: no complete split exists, so the
    // partial equal-chunk result (one 45-minute chunk) is reported unchanged.
    let input = day_input(vec![sized("A", 90, 60)], "10:00", 1);
    let candidate = only(&input, PolicyName::FrontLoaded);
    assert!(!candidate.feasible);
    assert_eq!(candidate.deficit_min, 45.0);
    assert_eq!(candidate.blocks, [block("A", &utc("09:00"), &utc("09:45"))]);
}

#[test]
fn leaves_the_h6_break_after_a_frozen_run_before_continuing() {
    // breakAfter 120: T0 09:00-10:00 + frozen T1 10:00-11:00 is a full run,
    // so the 90-minute remainder may only start at 11:15.
    let mut input = day_input(vec![sized("T0", 150, 180), task("T1")], "13:00", 1);
    input.prefs.break_after_min = 120.0;
    let replan_input = replanned(&input, &two_hours());
    for policy in PolicyName::ALL {
        let replan = only(&replan_input, *policy);
        assert_valid(&replan_input, &replan);
        let mut expected = two_hours();
        expected.push(block("T0", &utc("11:15"), &utc("12:45")));
        assert_eq!(replan.blocks, expected, "{policy}");
    }
}

#[test]
fn respects_the_daily_focus_cap_across_days_and_fails_when_it_cannot() {
    // Two days, 60 frozen minutes each, cap 120/day: T0 grows to 120 and can
    // only take 60 more minutes per day.
    let mut existing = two_hours();
    existing.push(block("T2", &utc_on("09:00", 10), &utc_on("10:00", 10)));
    let build = |t0_min: i64| {
        let tasks = vec![sized("T0", t0_min, 240), task("T1"), task("T2")];
        let mut input = day_input(tasks, "12:00", 2);
        input.prefs.max_daily_focus_min = 120.0;
        replanned(&input, &existing)
    };
    for policy in PolicyName::ALL {
        let replan_input = build(120);
        let replan = only(&replan_input, *policy);
        assert_valid(&replan_input, &replan);
        assert_eq!(replan.metrics.max_daily_load_min, 120.0);
        let mut expected = existing.clone();
        expected.push(block("T0", &utc_on("10:00", 10), &utc_on("11:00", 10)));
        assert_eq!(replan.blocks, expected, "{policy}");

        // 150 minutes exceed what the cap leaves (60 + 60): no complete split.
        let too_much = only(&build(150), *policy);
        assert!(!too_much.feasible);
        assert!(too_much.deficit_min > 0.0);
        for frozen in ["T1", "T2"] {
            assert_eq!(
                blocks_of(&too_much.blocks, frozen),
                blocks_of(&existing, frozen)
            );
        }
    }
}

#[test]
fn flags_a_split_that_exceeds_the_change_bound_instead_of_exceeding_it_silently() {
    // T0 09:00-10:00, then five frozen 30-minute tasks with 30-minute gaps.
    // T0 grows by 150 min: five extra sessions > 2 × 1 + 2.
    let mut existing = vec![block("T0", &utc("09:00"), &utc("10:00"))];
    let mut tasks = vec![sized("T0", 210, 240)];
    for index in 0..5 {
        let start = at(&utc("09:00"), 60 + index * 60);
        let id = format!("F{index}");
        existing.push(block(&id, &start, &at(&start, 30)));
        tasks.push(sized(&id, 30, 30));
    }
    let replan_input = replanned(&day_input(tasks, "15:00", 1), &existing);
    let result = run(
        &replan_input,
        &support::replan::options(PolicyName::FrontLoaded, 69.0),
    );
    let replan = &result.candidates[0];
    assert_valid(&replan_input, replan);
    for block in &existing {
        assert!(replan.blocks.contains(block));
    }
    assert_eq!(blocks_of(&replan.blocks, "T0").len(), 6);
    assert_eq!(replan.metrics.changed_blocks, 5.0);
    assert!(
        replan
            .explanation
            .iter()
            .any(|line| line.starts_with("Replan change bound exceeded: 5 changed block(s) > 4"))
    );
    assert!(
        result
            .diversity_note
            .as_deref()
            .unwrap()
            .contains("Replan change bound exceeded:")
    );
}

// An added dependency: the predecessor leaves room for its dependent.

#[derive(Clone)]
struct PropertyCase {
    name: &'static str,
    time_zone: &'static str,
    start: &'static str,
    end: &'static str,
    every_day: bool,
    /// `(duration units, max session units, priority)`.
    tasks: [(i64, i64, i64); 3],
    /// `(dependent, dependency)` edge added by the mutation.
    edge: (usize, usize),
    policy: PolicyName,
    window: (&'static str, &'static str),
    min_session_cap_min: i64,
    break_after_min: f64,
}

const BERLIN_DST_END: PropertyCase = PropertyCase {
    name: "",
    time_zone: "Europe/Berlin",
    start: "2026-10-25T00:00:00Z",
    end: "2026-10-27T00:00:00Z",
    every_day: true,
    tasks: [(0, 0, 0); 3],
    edge: (0, 0),
    policy: PolicyName::Balanced,
    window: ("00:00", "24:00"),
    min_session_cap_min: 30,
    break_after_min: 480.0,
};

/// The same construction as the replan property's inputs.
fn property_input(spec: &PropertyCase, with_edge: bool) -> ScheduleInput {
    let tasks = spec
        .tasks
        .iter()
        .enumerate()
        .map(|(index, (duration_units, max_units, priority))| {
            let minutes = duration_units * 5;
            let mut task = sized(
                &format!("T{index}"),
                minutes,
                duration_units.max(max_units) * 5,
            )
            .with_min_session(spec.min_session_cap_min.min(minutes))
            .within(spec.start, spec.end);
            task.priority = number(*priority);
            if with_edge && index == spec.edge.0 {
                task.depends_on = vec![format!("T{}", spec.edge.1)];
            }
            task
        })
        .collect();
    let mut input = support::input(
        spec.time_zone,
        spec.start,
        spec.end,
        tasks,
        (1..=if spec.every_day { 7 } else { 5 })
            .map(|weekday| rule(weekday, spec.window.0, spec.window.1))
            .collect(),
    );
    input.prefs.break_after_min = spec.break_after_min;
    input.seed = 0.0;
    input
}

/// Counterexamples found by raising the replan property to 2,000 runs: with
/// all-day windows the horizon ends one or two hours into Tuesday, and
/// `balanced` re-placed the predecessor into (or right before) that tail.
/// The last three have binding continuous-focus limits (FU-69R-1): the
/// successor bound ignores H6, so the first repair pass still leaves the
/// dependent short.
fn dependency_cases() -> Vec<PropertyCase> {
    let working_hours = PropertyCase {
        every_day: false,
        window: ("09:00", "17:00"),
        ..BERLIN_DST_END
    };
    vec![
        PropertyCase {
            name: "Europe/Berlin DST end, seed 5037",
            tasks: [(6, 12, 2), (18, 12, 2), (7, 12, 1)],
            edge: (2, 1),
            ..BERLIN_DST_END
        },
        PropertyCase {
            name: "Europe/Berlin DST end, seed 2035140076",
            tasks: [(18, 12, 2), (7, 12, 1), (6, 12, 2)],
            edge: (1, 0),
            ..BERLIN_DST_END
        },
        PropertyCase {
            name: "Europe/Berlin DST start, weekdays only",
            start: "2026-03-29T00:00:00Z",
            end: "2026-03-31T00:00:00Z",
            every_day: false,
            tasks: [(10, 12, 1), (15, 12, 1), (12, 12, 1)],
            edge: (1, 0),
            ..BERLIN_DST_END
        },
        PropertyCase {
            name: "Europe/Berlin DST end, weekdays only (reviewer CI)",
            every_day: false,
            tasks: [(6, 12, 1), (7, 12, 1), (6, 12, 1)],
            edge: (1, 0),
            ..BERLIN_DST_END
        },
        PropertyCase {
            name: "breakAfter 120, minSession 45: the dependent needs a break after its dependency",
            min_session_cap_min: 45,
            break_after_min: 120.0,
            tasks: [(22, 12, 2), (23, 12, 2), (18, 12, 1)],
            edge: (2, 0),
            ..working_hours.clone()
        },
        PropertyCase {
            name: "breakAfter 90, front_loaded: the dependency cannot keep its own late blocks",
            time_zone: "America/New_York",
            start: "2026-11-01T04:00:00Z",
            end: "2026-11-03T05:00:00Z",
            break_after_min: 90.0,
            policy: PolicyName::FrontLoaded,
            tasks: [(19, 12, 2), (21, 12, 1), (18, 12, 2)],
            edge: (1, 0),
            ..working_hours.clone()
        },
        PropertyCase {
            name: "breakAfter 90, minSession 45, DST start: the dependency cannot keep its own late blocks",
            start: "2026-03-28T00:00:00Z",
            end: "2026-03-30T22:00:00Z",
            min_session_cap_min: 45,
            break_after_min: 90.0,
            tasks: [(20, 12, 1), (23, 12, 1), (22, 12, 1)],
            edge: (1, 0),
            ..working_hours
        },
    ]
}

#[test]
fn a_replan_after_an_added_dependency_is_feasible_with_the_unaffected_task_frozen() {
    for spec in dependency_cases() {
        let base_input = property_input(&spec, false);
        let base = only(&base_input, spec.policy);
        assert_valid(&base_input, &base);
        let mutated = property_input(&spec, true);
        assert_valid(&mutated, &only(&mutated, spec.policy));
        let replan_input = replanned(&mutated, &base.blocks);
        let replan = only(&replan_input, spec.policy);
        assert_valid(&replan_input, &replan);
        let (dependent, dependency) = spec.edge;
        assert_dependency_order(
            &replan.blocks,
            &format!("T{dependent}"),
            &format!("T{dependency}"),
        );
        let frozen = (0..3)
            .find(|index| *index != dependent && *index != dependency)
            .map(|index| format!("T{index}"))
            .unwrap();
        assert_eq!(
            blocks_of(&replan.blocks, &frozen),
            blocks_of(&base.blocks, &frozen),
            "{}",
            spec.name
        );
        assert_eq!(
            replan.metrics.changed_blocks,
            count(symmetric_difference(&base.blocks, &replan.blocks))
        );
        // Both edge endpoints are affected: 2 × their existing blocks + 2.
        let affected_existing = base
            .blocks
            .iter()
            .filter(|block| block.task_id != frozen)
            .count();
        assert!(
            replan.metrics.changed_blocks <= count(2 * affected_existing + 2),
            "{}",
            spec.name
        );
    }
}

#[test]
fn a_grown_task_gains_one_session_in_the_tail_and_every_existing_block_stays() {
    // Monday 09:00-17:00 only: T0 75 | T1 120 | T2 110, free tail 175. T1
    // grows to 180 (one chunk by the equal-chunk rule); gaps are 120 and 175.
    let spec = PropertyCase {
        name: "grow",
        every_day: false,
        window: ("09:00", "17:00"),
        tasks: [(15, 12, 1), (24, 36, 1), (22, 12, 1)],
        ..BERLIN_DST_END
    };
    let base_input = property_input(&spec, false);
    let base = only(&base_input, PolicyName::FrontLoaded);
    assert_valid(&base_input, &base);
    let mut mutated = base_input.clone();
    mutated.tasks[1].estimate.p50_min = 180.0;
    mutated.tasks[1].estimate.p90_min = 180.0;
    assert_valid(&mutated, &only(&mutated, PolicyName::FrontLoaded));
    let replan_input = replanned(&mutated, &base.blocks);
    let replan = only(&replan_input, PolicyName::FrontLoaded);
    assert_valid(&replan_input, &replan);
    for block in &base.blocks {
        assert!(replan.blocks.contains(block));
    }
    assert_eq!(task_minutes(&replan.blocks, "T1"), 180);
    assert_eq!(replan.metrics.changed_blocks, 1.0);
}

// The successor bound, in UTC without DST.

/// Monday and Tuesday 09:00–17:00 plus a 60-minute tail on Wednesday. F and
/// G hold 240 minutes of Monday and Tuesday, so Wednesday is the
/// least-loaded day and exactly fits the predecessor P.
fn tail_input(end: &str, dependent: impl FnOnce(&mut Task)) -> ScheduleInput {
    let start = "2026-11-09T09:00:00Z";
    let mut successor = task("S").within(start, end);
    successor.depends_on = vec!["P".to_owned()];
    dependent(&mut successor);
    let mut input = support::input(
        "UTC",
        start,
        end,
        vec![
            sized("F", 240, 240).within(start, end),
            sized("G", 240, 240).within(start, end),
            task("P").within(start, end),
            successor,
        ],
        (1..=7)
            .map(|weekday| rule(weekday, "09:00", "17:00"))
            .collect(),
    );
    input.seed = 69.0;
    input
}

const WEDNESDAY_TAIL: &str = "2026-11-11T10:00:00Z";

fn frozen_mornings() -> Vec<Block> {
    vec![
        block("F", &utc("09:00"), &utc("13:00")),
        block("G", &utc_on("09:00", 10), &utc_on("13:00", 10)),
    ]
}

/// S was planned before P; the new edge S → P releases both.
fn out_of_order() -> Vec<Block> {
    let mut blocks = frozen_mornings();
    blocks.push(block("S", &utc("13:00"), &utc("14:00")));
    blocks.push(block("P", &utc_on("13:00", 10), &utc_on("14:00", 10)));
    blocks
}

#[test]
fn balanced_keeps_the_predecessor_out_of_the_tail_slot() {
    // In a replan the dependent, not the predecessor, takes the Wednesday
    // tail.
    let replan_input = replanned(&tail_input(WEDNESDAY_TAIL, |_| {}), &out_of_order());
    let replan = only(&replan_input, PolicyName::Balanced);
    assert_valid(&replan_input, &replan);
    assert_dependency_order(&replan.blocks, "S", "P");
    for block in frozen_mornings() {
        assert!(replan.blocks.contains(&block));
    }
    assert_eq!(
        blocks_of(&replan.blocks, "S"),
        [block("S", &utc_on("09:00", 11), &utc_on("10:00", 11))]
    );
    // And in a fresh plan.
    let fresh = tail_input(WEDNESDAY_TAIL, |_| {});
    let candidate = only(&fresh, PolicyName::Balanced);
    assert_valid(&fresh, &candidate);
    assert_dependency_order(&candidate.blocks, "S", "P");
}

#[test]
fn every_policy_plans_the_chain_fresh_and_replanned() {
    for policy in PolicyName::ALL {
        let fresh = tail_input(WEDNESDAY_TAIL, |_| {});
        assert_valid(&fresh, &only(&fresh, *policy));
        let replan_input = replanned(&fresh, &out_of_order());
        let replan = only(&replan_input, *policy);
        assert_valid(&replan_input, &replan);
        for block in frozen_mornings() {
            assert!(replan.blocks.contains(&block), "{policy}");
        }
    }
}

#[test]
fn a_dependent_that_can_never_fit_does_not_move_its_predecessor() {
    // S needs one 600-minute block; no slot is that long. P keeps the
    // least-loaded Wednesday tail exactly as without the bound.
    let input = tail_input(WEDNESDAY_TAIL, |task| {
        task.estimate.p50_min = 600.0;
        task.estimate.p90_min = 600.0;
        task.splittable = false;
        task.min_session_min = 600.0;
        task.max_session_min = 600.0;
    });
    let candidate = only(&input, PolicyName::Balanced);
    assert!(!candidate.feasible);
    assert_eq!(candidate.deficit_min, 600.0);
    assert_eq!(
        blocks_of(&candidate.blocks, "P"),
        [block("P", &utc_on("09:00", 11), &utc_on("10:00", 11))]
    );
    assert!(explains(
        &candidate,
        "Task \"S\" is short by 600 minutes (deficit)."
    ));
}

#[test]
fn keeps_the_plain_plan_when_the_repair_pass_is_not_strictly_better() {
    // Two 90-minute days, so the work is not over capacity and the repair
    // pass runs; but both tasks are due at the end of Monday. Plain: P
    // 09:00-10:00, S cannot follow (short by 60). The successor bound would
    // leave P only 09:00-09:30 and place neither (short by 120), so the plain
    // plan is the one reported.
    let (start, monday_end) = ("2026-11-09T09:00:00Z", "2026-11-09T10:30:00Z");
    let mut input = tail_input("2026-11-10T10:30:00Z", |_| {});
    let mut successor = task("S").within(start, monday_end);
    successor.depends_on = vec!["P".to_owned()];
    input.tasks = vec![task("P").within(start, monday_end), successor];
    input.availability = (1..=7)
        .map(|weekday| rule(weekday, "09:00", "10:30"))
        .collect();
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(!candidate.feasible);
        assert_eq!(candidate.deficit_min, 60.0);
        assert_eq!(
            candidate.blocks,
            [block("P", &utc("09:00"), &utc("10:00"))],
            "{policy}"
        );
    }
}

// FU-69R-1: the gap search explores the H6 break-offset start.
//
// The search stopped at the first start of a gap as soon as any session
// length passed there, so it never tried the start that leaves the H6 break
// after the preceding focus run. Here 10:00 (right after frozen F) admits at
// most 60 minutes and no complete split follows from it; 10:15 admits the
// 75-minute session that the 45-minute tail completes.

/// One UTC day from 09:00 to `end`. Every block in `frozen` is the whole of
/// its own task; A is the task to place.
struct GapCase {
    end: &'static str,
    frozen: &'static [(&'static str, &'static str, &'static str)],
    commitments: &'static [(&'static str, &'static str)],
    /// `(required, min session, max session)` minutes of A.
    a: (i64, i64, i64),
    break_after_min: f64,
    break_min: f64,
}

fn gap_input(spec: &GapCase) -> (ScheduleInput, Vec<Block>) {
    let frozen: Vec<Block> = spec
        .frozen
        .iter()
        .map(|(id, from, to)| block(id, &utc(from), &utc(to)))
        .collect();
    let mut tasks: Vec<Task> = frozen
        .iter()
        .map(|block| {
            let minutes = block_minutes(block);
            let mut task = sized(&block.task_id, minutes, minutes.max(60)).with_min_session(15);
            task.priority = 2.0;
            task
        })
        .collect();
    tasks.push(sized("A", spec.a.0, spec.a.2).with_min_session(spec.a.1));
    let mut input = support::input(
        "UTC",
        &utc("09:00"),
        &utc(spec.end),
        tasks,
        vec![rule(1, "09:00", spec.end)],
    );
    input.commitments = spec
        .commitments
        .iter()
        .map(|(from, to)| commitment(&utc(from), &utc(to)))
        .collect();
    input.existing_blocks = Some(frozen.clone());
    input.prefs.break_after_min = spec.break_after_min;
    input.prefs.break_min = spec.break_min;
    input.seed = 0.0;
    (input, frozen)
}

fn sessions(list: &[(&str, &str)]) -> Vec<Block> {
    list.iter()
        .map(|(from, to)| block("A", &utc(from), &utc(to)))
        .collect()
}

/// `witness` shows that a plan keeping the frozen blocks exists; then every
/// policy must find one — the given one, where `expected` names it.
fn assert_gap_plan(spec: &GapCase, witness: &[(&str, &str)], expected: Option<&[(&str, &str)]>) {
    let (input, frozen) = gap_input(spec);
    let witness_plan: Vec<Block> = frozen.iter().cloned().chain(sessions(witness)).collect();
    assert_eq!(audit(&input, &witness_plan, &[]), Vec::new());
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert_valid(&input, &candidate);
        assert_sessions_in_bounds(&input, &candidate.blocks);
        for block in &frozen {
            assert_eq!(
                blocks_of(&candidate.blocks, &block.task_id),
                std::slice::from_ref(block)
            );
        }
        assert_eq!(task_minutes(&candidate.blocks, "A"), spec.a.0);
        if let Some(expected) = expected {
            assert_eq!(
                blocks_of(&candidate.blocks, "A"),
                sessions(expected),
                "{policy}"
            );
        }
    }
}

const REVIEWER_DAY: GapCase = GapCase {
    end: "12:45",
    frozen: &[("F", "09:00", "10:00")],
    commitments: &[("11:30", "12:00")],
    a: (120, 45, 120),
    break_after_min: 120.0,
    break_min: 15.0,
};

#[test]
fn every_policy_finds_the_split_that_starts_after_the_break() {
    // A was 60 minutes at 10:15-11:15 and grew to 120.
    let (mut input, frozen) = gap_input(&REVIEWER_DAY);
    let witness: Vec<Block> = frozen
        .iter()
        .cloned()
        .chain(sessions(&[("10:15", "11:30"), ("12:00", "12:45")]))
        .collect();
    let mut existing = frozen.clone();
    existing.push(block("A", &utc("10:15"), &utc("11:15")));
    input.existing_blocks = Some(existing);
    assert_eq!(audit(&input, &witness, &[]), Vec::new());
    for policy in PolicyName::ALL {
        let mut fresh = input.clone();
        fresh.existing_blocks = None;
        assert_valid(&fresh, &only(&fresh, *policy));
        let replan = only(&input, *policy);
        assert_valid(&input, &replan);
        assert_sessions_in_bounds(&input, &replan.blocks);
        assert_eq!(blocks_of(&replan.blocks, "F"), frozen);
        assert_eq!(task_minutes(&replan.blocks, "A"), 120);
        assert_eq!(replan.blocks, witness, "{policy}");
        // 1 removed + 2 added <= 2 × (A's one existing block) + 2.
        assert_eq!(replan.metrics.changed_blocks, 3.0);
    }
}

#[test]
fn starts_late_enough_to_run_into_the_following_frozen_block() {
    // breakAfter 90: a session that reaches F (10:10-10:35) joins it, so it
    // may start no earlier than 10:35 - 90 min = 09:05. 09:00 admits nothing.
    assert_gap_plan(
        &GapCase {
            end: "12:15",
            frozen: &[("F", "10:10", "10:35")],
            commitments: &[],
            a: (120, 60, 125),
            break_after_min: 90.0,
            break_min: 30.0,
        },
        &[("09:10", "10:10"), ("11:05", "12:05")],
        Some(&[("09:05", "10:05"), ("11:05", "12:05")]),
    );
}

#[test]
fn anchors_the_second_session_to_the_next_frozen_run_after_a_full_break() {
    // After 09:00-10:30 the break ends at 11:00, but a 30-minute session from
    // 11:00 would join F (11:40-12:35) into 95 minutes; 11:05 is the first
    // start that may join it.
    assert_gap_plan(
        &GapCase {
            end: "13:50",
            frozen: &[("F", "11:40", "12:35")],
            commitments: &[("12:35", "13:30")],
            a: (120, 30, 95),
            break_after_min: 90.0,
            break_min: 30.0,
        },
        &[("09:05", "10:35"), ("11:05", "11:35")],
        Some(&[("09:00", "10:30"), ("11:05", "11:35")]),
    );
}

#[test]
fn retries_in_time_order_when_the_policy_order_cannot_leave_a_break_after_an_earlier_gap() {
    // focus_blocked fills the longest gap (12:40-15:10) first and starts at
    // 12:40, which leaves no break after any session in 10:45-12:20. Only a
    // chronological search knows that session when it picks the next start.
    assert_gap_plan(
        &GapCase {
            end: "16:35",
            frozen: &[("F0", "09:05", "10:45"), ("F1", "15:10", "15:25")],
            commitments: &[("12:20", "12:40")],
            a: (210, 60, 90),
            break_after_min: 120.0,
            break_min: 30.0,
        },
        &[("11:15", "12:15"), ("13:10", "14:40"), ("15:35", "16:35")],
        None,
    );
}

#[test]
fn the_time_order_retry_finds_the_break_the_policy_order_cannot_leave() {
    // Two gaps 15 minutes apart (less than a break): 09:00–10:30 and
    // 10:45–13:15, each with room for one 90-minute session. focus_blocked
    // fills the longer, later gap first, from its first cell — and then the
    // session in the earlier gap would join it into 195 minutes of focus.
    // Nothing stands before or after the later gap to suggest another
    // start. In time order the first session is known when the second is
    // placed, so the second starts a full break after it.
    //
    // (The reference's own case for this, the test above, is solved in
    // policy order since the start classes were completed; this one is not.)
    let spec = GapCase {
        end: "13:15",
        frozen: &[],
        commitments: &[("10:30", "10:45")],
        a: (180, 90, 120),
        break_after_min: 120.0,
        break_min: 30.0,
    };
    let witness = [("09:00", "10:30"), ("11:00", "12:30")];
    assert_gap_plan(&spec, &witness, None);
    let (input, _) = gap_input(&spec);
    assert_eq!(
        only(&input, PolicyName::FocusBlocked).blocks,
        sessions(&witness)
    );

    // Four hours cannot be had: the first gap holds one 90-minute session
    // and the second, after the break, one of at most 120.
    let (too_much, _) = gap_input(&GapCase {
        a: (240, 90, 120),
        ..spec
    });
    for policy in PolicyName::ALL {
        let candidate = only(&too_much, *policy);
        assert!(!candidate.feasible, "{policy}");
        assert!(candidate.deficit_min > 0.0);
    }
}

#[test]
fn prunes_with_the_break_rule_instead_of_exhausting_the_search_budget() {
    // 390 minutes into 160 + 280 free minutes with breakAfter 240: the second
    // gap can hold at most 270 focus minutes, so the first must give 120+.
    // Without that bound the longest-first search spent its whole budget
    // below a first session that can never be completed.
    assert_gap_plan(
        &GapCase {
            end: "17:00",
            frozen: &[],
            commitments: &[("11:40", "12:20")],
            a: (390, 60, 115),
            break_after_min: 240.0,
            break_min: 10.0,
        },
        &[
            ("09:00", "10:00"),
            ("10:10", "11:30"),
            ("12:30", "13:50"),
            ("14:00", "15:00"),
            ("15:10", "17:00"),
        ],
        None,
    );
}

#[test]
fn bounds_a_gap_next_to_a_long_frozen_stretch_by_what_h6_leaves_of_it() {
    // breakAfter 240 beside a 120-minute frozen block: the gap after it holds
    // 205 focus minutes, not its 215 free ones, whether the first session
    // joins F (120 more, then a break) or starts a break later. With the
    // looser bound the search spent its budget on first sessions that left
    // the second gap 210 minutes to cover.
    assert_gap_plan(
        &GapCase {
            end: "17:05",
            frozen: &[("F", "11:30", "13:30")],
            commitments: &[],
            a: (320, 60, 110),
            break_after_min: 240.0,
            break_min: 10.0,
        },
        &[
            ("09:10", "10:20"),
            ("10:20", "11:20"),
            ("13:40", "15:10"),
            ("15:15", "16:55"),
        ],
        None,
    );
}

#[test]
fn still_reports_the_shortfall_when_no_start_class_admits_a_complete_split() {
    // The reviewer's day, but A needs 135 minutes: 75 + 45 is all the gaps
    // hold with the break after F, so the frozen plan stays short.
    let (input, frozen) = gap_input(&GapCase {
        a: (135, 45, 135),
        ..REVIEWER_DAY
    });
    for policy in PolicyName::ALL {
        let candidate = only(&input, *policy);
        assert!(!candidate.feasible);
        assert_eq!(candidate.deficit_min, 135.0);
        assert_eq!(candidate.blocks, frozen, "{policy}");
    }
}
