//! Bounded local improvement and the policy objective it climbs
//! (`improvePlacements`, `objectiveScore`).
//!
//! The objective is the one place where the generator computes with
//! fractions. Every operation is written in the reference's order: floating
//! point addition is not associative, and the scores are compared.

use super::context::Context;
use super::place::Position;
use super::state::{GRID_MS_F, Interval, MINUTE_MS_F, Ms, Placement, State, passes};
use crate::js;
use crate::policies::profile;
use crate::prng::Prng;
use crate::time::TimeError;
use crate::types::PolicyName;

/// The earliest start and latest end a block of a task may have given the
/// blocks already in the plan (`placementWindow`).
fn placement_window(context: &Context<'_>, state: &State, task: usize) -> (Ms, Ms) {
    let info = &context.tasks[task];
    let mut min_start_ms = js::max(context.horizon_start_ms, context.now_ms);
    let mut max_end_ms = context.horizon_end_ms;
    if let Some(earliest_ms) = info.earliest_ms {
        min_start_ms = js::max(min_start_ms, earliest_ms);
    }
    for &dependency in &info.depends_on {
        for interval in &state.intervals {
            if interval.task == dependency {
                min_start_ms = js::max(min_start_ms, interval.end_ms);
            }
        }
    }
    if let Some(due_ms) = info.due_ms {
        max_end_ms = js::min(max_end_ms, due_ms - info.buffer_ms);
    }
    for &dependent in &info.dependents {
        for interval in &state.intervals {
            if interval.task == dependent {
                max_end_ms = js::min(max_end_ms, interval.start_ms);
            }
        }
    }
    (min_start_ms, max_end_ms)
}

/// The positions 60 and 30 minutes before and after a block, inside its own
/// slot and window, that pass H1/H6 (`neighborPositions`).
fn neighbor_positions(
    context: &Context<'_>,
    state: &State,
    target: &Placement,
    (min_start_ms, max_end_ms): (Ms, Ms),
) -> Result<Vec<Position>, TimeError> {
    let mut positions = Vec::new();
    let Some(slot) = target
        .slot_id
        .and_then(|slot_id| context.slots_by_start.get(slot_id))
    else {
        return Ok(positions);
    };
    let cell_count = (target.duration_min * MINUTE_MS_F) / GRID_MS_F;
    if !js::is_integer(cell_count) || cell_count <= 0.0 {
        return Ok(positions);
    }
    let current_index = js::round((target.start_ms - slot.start_ms) / GRID_MS_F);
    // Cell counts are small whole numbers: exact as floats.
    #[allow(clippy::cast_precision_loss)]
    let limit = slot.cell_starts.len() as f64 - cell_count;
    for offset in [-12.0, -6.0, 6.0, 12.0] {
        let index = current_index + offset;
        if index < 0.0 || index > limit {
            continue;
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let cell_index = index as usize;
        let start_ms = slot.cell_starts[cell_index];
        if start_ms == target.start_ms || start_ms < min_start_ms {
            continue;
        }
        let end_ms = start_ms + cell_count * GRID_MS_F;
        if end_ms > max_end_ms || end_ms > slot.end_ms {
            continue;
        }
        if passes(context, state, start_ms, end_ms)? {
            positions.push(Position {
                start_ms,
                end_ms,
                slot_id: slot.id,
                cell_index,
            });
        }
    }
    Ok(positions)
}

/// Bounded local improvement: each new block is offered the positions 60
/// and 30 minutes before and after it inside its own slot and is moved only
/// when the policy objective strictly improves. Seeded existing blocks are
/// never moved here, preserving change minimisation. At most `cap` (<= 200)
/// blocks are tried, in an order shuffled by the seeded generator.
pub(super) fn improve_placements(
    context: &Context<'_>,
    policy: PolicyName,
    state: &mut State,
    cap: f64,
    prng: &mut Prng,
) -> Result<Vec<Placement>, TimeError> {
    let mut targets: Vec<Placement> = state
        .placements
        .iter()
        .filter(|placement| !placement.seeded)
        .copied()
        .collect();
    for index in (1..targets.len()).rev() {
        #[allow(clippy::cast_precision_loss)]
        let swap_index = prng.next_int(index as f64 + 1.0);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        targets.swap(index, swap_index as usize);
    }

    let mut evaluations = 0.0;
    for target in targets {
        if evaluations >= cap {
            break;
        }
        if !state
            .placements
            .iter()
            .any(|placement| placement.same_block(&target))
        {
            continue;
        }

        state.remove_placement(context, &target)?;
        let window = placement_window(context, state, target.task);
        evaluations += 1.0;

        state.add_placement(context, target)?;
        let original_score = objective_score(context, state, policy)?;
        state.remove_placement(context, &target)?;

        let mut best: Option<Placement> = None;
        let mut best_score = original_score;
        for position in neighbor_positions(context, state, &target, window)? {
            let moved = Placement {
                start_ms: position.start_ms,
                end_ms: position.end_ms,
                slot_id: Some(position.slot_id),
                local_hour: context.local_hour_of(position.start_ms, position.end_ms)?,
                ..target
            };
            state.add_placement(context, moved)?;
            let moved_score = objective_score(context, state, policy)?;
            state.remove_placement(context, &moved)?;
            if moved_score > best_score + 1e-9 {
                best_score = moved_score;
                best = Some(moved);
            }
        }
        state.add_placement(context, best.unwrap_or(target))?;
    }
    Ok(state.placements.clone())
}

fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    js::min(maximum, js::max(minimum, value))
}

/// When each task's last interval ends; `None` for a task without one. The
/// reference starts each maximum from 0.
fn last_end_by_task(context: &Context<'_>, intervals: &[Interval]) -> Vec<Option<Ms>> {
    let mut last_end = vec![None; context.tasks.len()];
    for interval in intervals {
        last_end[interval.task] = Some(js::max(
            last_end[interval.task].unwrap_or(0.0),
            interval.end_ms,
        ));
    }
    last_end
}

/// The policy objective of a plan: the weighted sum of S1 early completion,
/// S2 daily spread, S3 preferred windows, S4 context switches, S5 retained
/// existing blocks and S6 minimum slack, each in `[0, 1]`
/// (`objectiveScore`).
pub(super) fn objective_score(
    context: &Context<'_>,
    state: &State,
    policy: PolicyName,
) -> Result<f64, TimeError> {
    let weights = profile(policy).weights;
    let horizon_ms = context.horizon_end_ms - context.horizon_start_ms;
    let span_min = js::max(1.0, horizon_ms / MINUTE_MS_F);

    let last_end = last_end_by_task(context, &state.intervals);
    let mut completion_sum = 0.0;
    let mut completion_count = 0.0;
    for last_end_ms in last_end.iter().flatten() {
        completion_sum += clamp(
            (last_end_ms - context.horizon_start_ms) / horizon_ms,
            0.0,
            1.0,
        );
        completion_count += 1.0;
    }
    let s1 = if completion_count > 0.0 {
        1.0 - completion_sum / completion_count
    } else {
        0.0
    };

    let mut max_load = 0.0;
    let mut total_load = 0.0;
    for (_, minutes) in state.daily_load.iter() {
        max_load = js::max(max_load, minutes);
        total_load += minutes;
    }
    let s2 = if total_load > 0.0 {
        1.0 - max_load / total_load
    } else {
        0.0
    };

    let mut preferred_total = 0.0;
    let mut preferred_fit = 0.0;
    for placement in &state.placements {
        let info = &context.tasks[placement.task];
        if !info.has_preferred_windows() {
            continue;
        }
        preferred_total += placement.duration_min;
        if info.prefers(placement.local_hour) {
            preferred_fit += placement.duration_min;
        }
    }
    let s3 = if preferred_total > 0.0 {
        preferred_fit / preferred_total
    } else {
        1.0
    };

    // Interval counts are small whole numbers: exact as floats.
    #[allow(clippy::cast_precision_loss)]
    let block_count = state.intervals.len() as f64;
    let switches = count_context_switches(context, &state.intervals)?;
    let s4 = if block_count > 1.0 {
        1.0 - switches / (block_count - 1.0)
    } else {
        1.0
    };

    let mut existing_minutes = 0.0;
    let mut retained_minutes = 0.0;
    for block in &context.existing_intervals {
        existing_minutes += (block.end_ms - block.start_ms) / MINUTE_MS_F;
        for interval in &state.intervals {
            if interval.task != block.task {
                continue;
            }
            retained_minutes += js::max(
                0.0,
                js::min(block.end_ms, interval.end_ms) - js::max(block.start_ms, interval.start_ms),
            ) / MINUTE_MS_F;
        }
    }
    let s5 = if existing_minutes > 0.0 {
        retained_minutes / existing_minutes
    } else {
        1.0
    };
    // 06 §7: replanning triples the retain-existing (S5) weight.
    let s5_weight = weights.s5_retain_existing * if existing_minutes > 0.0 { 3.0 } else { 1.0 };

    let slack = min_slack_minutes(context, state);
    let s6 = clamp(slack, 0.0, span_min) / span_min;

    Ok(weights.s1_early_completion * s1
        + weights.s2_daily_spread * s2
        + weights.s3_preferred_windows * s3
        + weights.s4_context_switches * s4
        + s5_weight * s5
        + weights.s6_min_slack * s6)
}

/// The smallest due-buffer slack of the plan in minutes; when no task has a
/// deadline, the horizon end minus the last block (`minSlackMinutes`).
pub(super) fn min_slack_minutes(context: &Context<'_>, state: &State) -> f64 {
    let last_end = last_end_by_task(context, &state.intervals);
    let mut minimum = f64::INFINITY;
    let mut saw_deadline = false;
    for (info, last_end_ms) in context.tasks.iter().zip(&last_end) {
        let Some(due_ms) = info.due_ms else {
            continue;
        };
        saw_deadline = true;
        let last_end_ms = last_end_ms.unwrap_or(context.horizon_start_ms);
        let slack = (due_ms - info.buffer_ms - last_end_ms) / MINUTE_MS_F;
        minimum = js::min(minimum, slack);
    }
    if saw_deadline && minimum.is_finite() {
        return minimum;
    }
    let last_end_ms = state
        .intervals
        .iter()
        .fold(context.horizon_start_ms, |last, interval| {
            js::max(last, interval.end_ms)
        });
    (context.horizon_end_ms - last_end_ms) / MINUTE_MS_F
}

/// Adjacent blocks on the same local date with different tasks. A day
/// boundary is not a context switch; the metric tracks intra-day task
/// changes (`countContextSwitches`).
pub(super) fn count_context_switches(
    context: &Context<'_>,
    intervals: &[Interval],
) -> Result<f64, TimeError> {
    let mut switches = 0.0;
    for pair in intervals.windows(2) {
        let (previous, current) = (&pair[0], &pair[1]);
        if previous.task == current.task {
            continue;
        }
        let previous_date =
            context.local_date_at(js::max(previous.start_ms, previous.end_ms - 1.0))?;
        if previous_date == context.local_date_at(current.start_ms)? {
            switches += 1.0;
        }
    }
    Ok(switches)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::fixture::{at, day, instant, state_with, task};
    use super::*;

    fn due(mut task: serde_json::Value, clock: &str) -> serde_json::Value {
        task["dueAt"] = json!(instant(clock));
        task
    }

    #[test]
    fn a_block_may_lie_between_its_dependencies_and_its_dependents() {
        // A ← B ← C; B is due at 15:00 with a 30-minute buffer.
        let mut middle = due(task("B", 60, &["A"]), "15:00");
        middle["bufferBeforeDueMin"] = json!(30);
        middle["earliestStartAt"] = json!(instant("09:30"));
        let input = day(
            &[task("A", 60, &[]), middle, task("C", 60, &["B"])],
            &json!({}),
        );
        let context = Context::build(&input).unwrap();
        let empty = context.create_state();
        assert_eq!(
            placement_window(&context, &empty, 0),
            (at("09:00"), at("17:00"))
        );
        assert_eq!(
            placement_window(&context, &empty, 1),
            (at("09:30"), at("14:30"))
        );
        // With A and C placed, B has to fit between them.
        let state = state_with(&context, &[(0, "09:00", "10:30"), (2, "13:00", "14:00")]);
        assert_eq!(
            placement_window(&context, &state, 1),
            (at("10:30"), at("13:00"))
        );
        // A may not run past where B starts once B is placed.
        let state = state_with(&context, &[(1, "11:00", "12:00")]);
        assert_eq!(
            placement_window(&context, &state, 0),
            (at("09:00"), at("11:00"))
        );
        assert_eq!(
            placement_window(&context, &state, 2),
            (at("12:00"), at("17:00"))
        );
    }

    #[test]
    fn slack_is_the_tightest_deadline_or_the_room_left_in_the_horizon() {
        let mut buffered = due(task("B", 60, &[]), "15:00");
        buffered["bufferBeforeDueMin"] = json!(30);
        let input = day(
            &[
                due(task("A", 60, &[]), "12:00"),
                buffered,
                task("C", 60, &[]),
            ],
            &json!({}),
        );
        let context = Context::build(&input).unwrap();
        // A ends an hour before its deadline; B two hours before its
        // buffered one. The block of C, which has no deadline, is ignored.
        let state = state_with(
            &context,
            &[
                (0, "10:00", "11:00"),
                (1, "11:30", "12:30"),
                (2, "16:00", "17:00"),
            ],
        );
        assert_eq!(min_slack_minutes(&context, &state), 60.0);
        // An unplaced task with a deadline counts from the horizon start,
        // and a missed deadline is negative slack.
        let late = state_with(&context, &[(0, "12:00", "13:00")]);
        assert_eq!(min_slack_minutes(&context, &late), -60.0);
        assert_eq!(min_slack_minutes(&context, &context.create_state()), 180.0);

        // Without any deadline: the horizon end minus the last block.
        let free = day(&[task("A", 60, &[])], &json!({}));
        let context = Context::build(&free).unwrap();
        let state = state_with(&context, &[(0, "10:00", "11:00")]);
        assert_eq!(min_slack_minutes(&context, &state), 360.0);
        assert_eq!(min_slack_minutes(&context, &context.create_state()), 480.0);
    }

    #[test]
    fn a_context_switch_is_a_change_of_task_within_one_local_day() {
        let two_days = json!({
            "horizon": {"start": instant("09:00"), "end": "2026-11-10T17:00:00Z"},
            "availability": [
                {"weekday": 1, "startLocal": "09:00", "endLocal": "24:00", "kind": "work"},
                {"weekday": 2, "startLocal": "00:00", "endLocal": "17:00", "kind": "work"},
            ],
        });
        let input = day(&[task("A", 120, &[]), task("B", 120, &[])], &two_days);
        let context = Context::build(&input).unwrap();
        let interval = |task: usize, start_ms: Ms, minutes: f64| Interval {
            start_ms,
            end_ms: start_ms + minutes * MINUTE_MS_F,
            task,
        };
        let switches =
            |intervals: &[Interval]| count_context_switches(&context, intervals).unwrap();
        // A, A, B, A on Monday: two changes of task.
        assert_eq!(
            switches(&[
                interval(0, at("09:00"), 60.0),
                interval(0, at("10:00"), 60.0),
                interval(1, at("11:00"), 60.0),
                interval(0, at("13:00"), 60.0),
            ]),
            2.0
        );
        // The first block of the next day is not a switch ...
        let tuesday = at("09:00") + 24.0 * 60.0 * MINUTE_MS_F;
        assert_eq!(
            switches(&[interval(0, at("16:00"), 60.0), interval(1, tuesday, 60.0)]),
            0.0
        );
        // ... and a block that ends exactly at midnight belongs to its day.
        let midnight = at("23:00") + 60.0 * MINUTE_MS_F;
        assert_eq!(
            switches(&[interval(0, at("23:00"), 60.0), interval(1, midnight, 60.0)]),
            0.0
        );
        assert_eq!(switches(&[]), 0.0);
        assert_eq!(switches(&[interval(0, at("09:00"), 60.0)]), 0.0);
    }
}
