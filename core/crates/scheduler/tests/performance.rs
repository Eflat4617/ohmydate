//! `packages/scheduler/test/performance.test.ts`: the 06 §11 budget — 50
//! tasks, 14 days, 3 policies, p95 under 500 ms.
//!
//! A plain wall-clock measurement (blueprint 15 §5.4): 20 samples per batch,
//! the best of up to 5 batches, so a burst of load on a shared machine can
//! be outlived without weakening the target. The numbers are always printed;
//! the budget is asserted when `SCHED_PERF_ASSERT=1`, as in the reference —
//! an unoptimised test build on a loaded laptop is not what the budget is
//! about, and the stage reports quote an optimised run.
//!
//! The reference's test also guards its own calibration scheme (CPU time
//! normalised by a fixed workload, FU-66). That scheme is not ported: the
//! measurement here has no calibration to guard.

#![allow(clippy::unwrap_used, clippy::print_stdout)]

mod support;

use std::time::Instant;

use ohmydate_scheduler::generate::{GenerateResult, generate};
use ohmydate_scheduler::types::{GenerateOptions, PolicyName, ScheduleInput, Task, WindowKind};

fn build_large_input() -> ScheduleInput {
    let tasks: Vec<Task> = (0..50_u8)
        .map(|index| Task {
            due_at: Some("2026-11-23T00:00:00Z".to_owned()),
            min_session_min: 30.0,
            max_session_min: 120.0,
            priority: f64::from(index % 4 + 1),
            preferred_windows: Some(if index % 3 == 0 {
                vec![WindowKind::Morning]
            } else {
                Vec::new()
            }),
            ..support::task(&format!("T{index:02}"), 60.0)
        })
        .collect();
    let mut input = support::input(
        "Asia/Seoul",
        "2026-11-09T00:00:00Z",
        "2026-11-23T00:00:00Z",
        tasks,
        (1..=5)
            .map(|weekday| support::rule(weekday, "08:00", "18:00"))
            .collect(),
    );
    input.prefs = support::prefs(480.0, 240.0);
    input.seed = 50.0;
    input
}

fn three_policies() -> GenerateOptions {
    GenerateOptions {
        policies: Some(PolicyName::ALL.to_vec()),
        seed: Some(50.0),
        max_local_improvement: None,
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let index = ((sorted.len() as f64 * fraction).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[index]
}

/// Milliseconds of one `generate` call, with its result.
fn timed(input: &ScheduleInput, options: &GenerateOptions) -> (f64, GenerateResult) {
    let start = Instant::now();
    let result = generate(input, options).unwrap();
    (start.elapsed().as_secs_f64() * 1000.0, result)
}

#[test]
fn fifty_tasks_fourteen_days_three_policies_stay_inside_the_budget() {
    let input = build_large_input();
    let options = three_policies();
    let (_, first) = timed(&input, &options);
    // The workload is the one the budget names: every policy places all 50
    // tasks, and the three plans differ.
    assert_eq!(
        first
            .candidates
            .iter()
            .map(|candidate| candidate.feasible)
            .collect::<Vec<_>>(),
        [true, true, true]
    );
    assert!(
        first
            .candidates
            .iter()
            .all(|candidate| candidate.deficit_min == 0.0)
    );

    let mut best_p95 = f64::INFINITY;
    for batch in 1..=5 {
        let mut samples: Vec<f64> = (0..20)
            .map(|_| {
                let (elapsed_ms, result) = timed(&input, &options);
                assert_eq!(result, first, "generation is not deterministic");
                elapsed_ms
            })
            .collect();
        samples.sort_by(f64::total_cmp);
        let p95 = percentile(&samples, 0.95);
        println!(
            "generator perf batch {batch}: p50={:.1}ms p95={p95:.1}ms min={:.1}ms max={:.1}ms ({})",
            percentile(&samples, 0.5),
            samples[0],
            samples[samples.len() - 1],
            if cfg!(debug_assertions) {
                "unoptimised build"
            } else {
                "optimised build"
            },
        );
        best_p95 = best_p95.min(p95);
        if best_p95 < 500.0 {
            break;
        }
    }
    if std::env::var("SCHED_PERF_ASSERT").as_deref() == Ok("1") {
        assert!(
            best_p95 < 500.0,
            "best p95 {best_p95:.1} ms is over the 500 ms budget"
        );
    } else {
        println!(
            "generator perf assertion skipped (SCHED_PERF_ASSERT not set); best p95={best_p95:.1}ms."
        );
    }
}

#[test]
fn the_percentile_is_the_nearest_rank() {
    let samples: Vec<f64> = (1..=20).map(f64::from).collect();
    assert_eq!(percentile(&samples, 0.95), 19.0);
    assert_eq!(percentile(&samples, 0.5), 10.0);
    assert_eq!(percentile(&samples, 1.0), 20.0);
    assert_eq!(percentile(&samples, 0.0), 1.0);
    assert_eq!(percentile(&[7.0], 0.95), 7.0);
}

#[test]
fn a_smaller_workload_is_measurably_cheaper() {
    // The measurement can tell workloads apart: one task on one day costs a
    // small fraction of the budget workload.
    let large = build_large_input();
    let mut small = build_large_input();
    small.horizon.end = "2026-11-10T00:00:00Z".to_owned();
    small.tasks.truncate(1);
    small.tasks[0].due_at = Some("2026-11-10T00:00:00Z".to_owned());
    let options = three_policies();
    let best = |input: &ScheduleInput| {
        (0..5)
            .map(|_| timed(input, &options).0)
            .fold(f64::INFINITY, f64::min)
    };
    let (small_ms, large_ms) = (best(&small), best(&large));
    assert!(
        small_ms * 5.0 < large_ms,
        "small {small_ms:.3} ms, large {large_ms:.3} ms"
    );
}
