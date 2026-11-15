//! The greedy placement of one seed set (`runPlacementAttempt`,
//! `placeTasks`, `selectPlacement`).

use super::context::{Context, GRID_MINUTES_F, SlotInfo, minutes_of};
use super::gapfit::{fit_sessions_into_gaps, successor_bound};
use super::improve::improve_placements;
use super::order::{HeuristicReason, Reasons, build_chunks, order_tasks};
use super::state::{GRID_MS_F, Loads, MINUTE_MS_F, Ms, Placement, State, passes};
use crate::codes::ViolationCode;
use crate::js;
use crate::policies::seed_offset;
use crate::prng::Prng;
use crate::time::{TimeError, instant_to_utc};
use crate::types::{Block, PolicyName};
use crate::validate::{ValidateOptions, Violation, validate_in_zone};

/// The outcome of placing every task once.
#[derive(Debug, Clone)]
pub(super) struct PlacementAttempt {
    pub placements: Vec<Placement>,
    pub violations: Vec<Violation>,
    pub reasons: Reasons,
    /// H7 shortfall of this attempt, counting locked minutes as placed.
    pub deficit_min: f64,
    /// Plain pass only: a dead end the repair aids target was seen (a
    /// splittable task without contiguous room for its equal chunks, a task
    /// that could not follow its dependencies, or an H3 violation).
    pub repairable: bool,
    /// A task with dependencies could not be placed completely.
    pub starved: bool,
}

impl PlacementAttempt {
    pub fn is_feasible(&self) -> bool {
        self.violations.is_empty()
    }
}

/// Settings of a repair pass of `place_tasks`.
#[derive(Debug, Clone, Copy)]
pub(super) struct RepairAids {
    /// Extra time kept free before the room each dependent still needs.
    pub successor_slack_ms: Ms,
    /// Whether a gap-fitted split first keeps the task's own still-valid
    /// blocks (minimal change) before it re-splits the whole task.
    pub keep_own_blocks: bool,
}

/// A place for a session: cells `cell_index..` of a slot.
#[derive(Debug, Clone, Copy)]
pub(super) struct Position {
    pub start_ms: Ms,
    pub end_ms: Ms,
    pub slot_id: usize,
    pub cell_index: usize,
}

/// The movable blocks of a plan in output order: by start, task id, end
/// (`blocksFromPlacements`).
pub(super) fn blocks_from_placements(
    context: &Context<'_>,
    placements: &[Placement],
) -> Result<Vec<Block>, TimeError> {
    let mut sorted: Vec<&Placement> = placements.iter().collect();
    sorted.sort_by(|a, b| {
        a.start_ms
            .total_cmp(&b.start_ms)
            .then_with(|| context.compare_task_ids(a.task, b.task))
            .then(a.end_ms.total_cmp(&b.end_ms))
    });
    sorted
        .into_iter()
        .map(|placement| {
            Ok(Block {
                task_id: context.tasks[placement.task].task.id.clone(),
                start: instant_to_utc(super::context::whole(placement.start_ms))?,
                end: instant_to_utc(super::context::whole(placement.end_ms))?,
            })
        })
        .collect()
}

/// The validator's verdict on a plan, with the input's history.
pub(super) fn validate_plan(
    context: &Context<'_>,
    placements: &[Placement],
) -> Result<Vec<Violation>, TimeError> {
    let blocks = blocks_from_placements(context, placements)?;
    validate_in_zone(
        context.input,
        &context.zone,
        &blocks,
        &ValidateOptions {
            risk_level: context.risk_level,
            history_blocks: &context.history_blocks,
        },
    )
}

/// True when the candidate attempt ranks above the current one: feasible
/// first, then the smaller H7 deficit, then fewer violations, then more
/// retained seeds (`isBetterAttempt`).
pub(super) fn is_better_attempt(
    candidate: &PlacementAttempt,
    candidate_seeds: usize,
    current: &PlacementAttempt,
    current_seeds: usize,
) -> bool {
    if candidate.is_feasible() != current.is_feasible() {
        return candidate.is_feasible();
    }
    if candidate.deficit_min != current.deficit_min {
        return candidate.deficit_min < current.deficit_min;
    }
    if candidate.violations.len() != current.violations.len() {
        return candidate.violations.len() < current.violations.len();
    }
    candidate_seeds > current_seeds
}

/// H7 shortfall of an attempt: required minutes minus live placements and
/// locked blocks (`attemptDeficitMin`).
pub(super) fn attempt_deficit_min(context: &Context<'_>, placements: &[Placement]) -> f64 {
    let mut placed_by_task = vec![0.0; context.tasks.len()];
    for placement in placements {
        placed_by_task[placement.task] += placement.duration_min;
    }
    for interval in &context.locked_intervals {
        placed_by_task[interval.task] += interval.minutes();
    }
    context
        .tasks
        .iter()
        .zip(&placed_by_task)
        .fold(0.0, |shortfall, (info, placed)| {
            shortfall + js::max(0.0, info.required_min - placed)
        })
}

/// Greedy placement plus bounded improvement for one seed set.
///
/// The plain pass is the versioned policy greedy; a feasible plain plan is
/// returned as is. Otherwise, when the plan is repairable and the work is
/// not certainly over capacity, a repair pass repeats the greedy with two
/// feasibility aids (FU-69): the successor bound keeps a task from ending so
/// late that its dependents can no longer fit, and the gap-fitted split
/// covers a splittable task whose equal chunks find no contiguous room. The
/// successor bound ignores H6 and keeping a task's own blocks can hold it
/// too late for its dependents, so when a dependent is still short one more
/// repair pass keeps a break free before every dependent's room and
/// re-splits tasks from scratch.
///
/// A repaired plan replaces the plain one only when it ranks strictly
/// better: an aided task can cost a later task its room, and a partial plan
/// must never get worse.
pub(super) fn run_placement_attempt(
    context: &Context<'_>,
    policy: PolicyName,
    seed: f64,
    max_improvement: f64,
    seeds: &[Placement],
) -> Result<PlacementAttempt, TimeError> {
    let pass = |repair| place_tasks(context, policy, seed, max_improvement, seeds, repair);
    let plain = pass(None)?;
    if plain.is_feasible() || !plain.repairable || !context.repair_plausible {
        return Ok(plain);
    }
    let mut best = plain;
    let repaired = pass(Some(RepairAids {
        successor_slack_ms: 0.0,
        keep_own_blocks: true,
    }))?;
    let starved = repaired.starved;
    if is_better_attempt(&repaired, 0, &best, 0) {
        best = repaired;
    }
    if !best.is_feasible() && starved {
        let spaced = pass(Some(RepairAids {
            successor_slack_ms: if context.break_after_ms > 0.0 {
                context.break_ms
            } else {
                0.0
            },
            keep_own_blocks: false,
        }))?;
        if is_better_attempt(&spaced, 0, &best, 0) {
            best = spaced;
        }
    }
    Ok(best)
}

fn place_tasks(
    context: &Context<'_>,
    policy: PolicyName,
    seed: f64,
    max_improvement: f64,
    seeds: &[Placement],
    repair: Option<RepairAids>,
) -> Result<PlacementAttempt, TimeError> {
    let task_count = context.tasks.len();
    let mut state = context.create_state();
    let mut seeded_min_by_task = vec![0.0; task_count];
    for seed_placement in seeds {
        state.add_placement(context, *seed_placement)?;
        seeded_min_by_task[seed_placement.task] += seed_placement.duration_min;
    }

    let mut reasons = Reasons::default();
    let mut repairable = false;
    let mut starved = false;
    // When each task's last block ends: `None` until known, +∞ for a task
    // that still has unplaced work and no block.
    let mut completion_by_task: Vec<Option<Ms>> = vec![None; task_count];
    for interval in &state.intervals {
        let known = completion_by_task[interval.task].unwrap_or(f64::NEG_INFINITY);
        completion_by_task[interval.task] = Some(js::max(known, interval.end_ms));
    }
    let mut prng = Prng::new(seed + seed_offset(policy));

    let ordered = order_tasks(context, policy);
    for (task_index, &task) in ordered.iter().enumerate() {
        let info = &context.tasks[task];
        let fixed_min = minutes_of(&context.locked_by_task[task]);
        let remaining_min = js::max(
            0.0,
            info.required_min - fixed_min - seeded_min_by_task[task],
        );
        let chunks = build_chunks(info.task, remaining_min);
        if let Some(reason) = chunks.reason {
            reasons.add(reason);
        }

        let mut dependency_ready_ms = context.horizon_start_ms;
        for &dependency in &info.depends_on {
            if let Some(completion) = completion_by_task[dependency] {
                dependency_ready_ms = js::max(dependency_ready_ms, completion);
            }
        }
        let earliest_ms = info.earliest_ms.unwrap_or(context.horizon_start_ms);
        let due_ms = info.due_ms.unwrap_or(context.horizon_end_ms);
        let window_start_ms = js::max(
            js::max(
                js::max(context.horizon_start_ms, context.now_ms),
                earliest_ms,
            ),
            dependency_ready_ms,
        );
        let mut window_end_ms = js::min(context.horizon_end_ms, due_ms - info.buffer_ms);
        if let Some(aids) = repair
            && remaining_min > 0.0
            && !info.dependents.is_empty()
        {
            // Leave room for the dependents: without this a policy can park
            // the task at the tail of the horizon and starve every
            // successor (H3).
            window_end_ms = js::min(
                window_end_ms,
                successor_bound(
                    context,
                    &state,
                    &ordered,
                    task_index,
                    aids.successor_slack_ms,
                ),
            );
        }

        let mut last_end_ms = f64::NEG_INFINITY;
        for interval in &state.intervals {
            if interval.task == task {
                last_end_ms = js::max(last_end_ms, interval.end_ms);
            }
        }

        if remaining_min > 0.0 && window_end_ms <= window_start_ms {
            // FU-96: a predecessor without any block leaves its successors
            // no start time at all. That is not a lack of available time, so
            // say why.
            reasons.add(if dependency_ready_ms == f64::INFINITY {
                HeuristicReason::BlockedByPredecessor
            } else {
                HeuristicReason::InsufficientAvailableTime
            });
            starved = starved || !info.task.depends_on.is_empty();
        } else {
            let mut placed: Vec<Placement> = Vec::new();
            let mut unplaced = false;
            for &duration_min in &chunks.chunks {
                let Some(position) = select_placement(
                    context,
                    &state,
                    policy,
                    task,
                    duration_min,
                    window_start_ms,
                    window_end_ms,
                )?
                else {
                    unplaced = true;
                    break;
                };
                let placement = Placement {
                    task,
                    duration_min,
                    start_ms: position.start_ms,
                    end_ms: position.end_ms,
                    slot_id: Some(position.slot_id),
                    local_hour: context.local_hour_of(position.start_ms, position.end_ms)?,
                    seeded: false,
                };
                state.add_placement(context, placement)?;
                placed.push(placement);
            }
            if unplaced {
                // The equal-size chunks need contiguous room that fragmented
                // free time (frozen replan blocks, commitments, locked
                // blocks) may not offer even though the task is splittable
                // and the gaps add up. Fit the sessions to the gaps before
                // declaring a shortfall (06 §3 H5, §7.1).
                let fitted = match repair {
                    Some(aids) if chunks.reason.is_none() => fit_sessions_into_gaps(
                        context,
                        &mut state,
                        policy,
                        task,
                        remaining_min,
                        window_start_ms,
                        window_end_ms,
                        &placed,
                        aids.keep_own_blocks,
                    )?,
                    _ => None,
                };
                match fitted {
                    Some(sessions) => placed = sessions,
                    None => {
                        reasons.add(if info.task.splittable {
                            HeuristicReason::InsufficientAvailableTime
                        } else {
                            HeuristicReason::NoContiguousWindow
                        });
                        starved = starved || !info.task.depends_on.is_empty();
                        repairable =
                            repairable || (info.task.splittable && chunks.reason.is_none());
                    }
                }
            }
            for placement in &placed {
                last_end_ms = js::max(last_end_ms, placement.end_ms);
            }
        }

        completion_by_task[task] = Some(if last_end_ms == f64::NEG_INFINITY {
            if remaining_min > 0.0 {
                f64::INFINITY
            } else {
                window_start_ms
            }
        } else {
            last_end_ms
        });
    }

    let greedy_violations = validate_plan(context, &state.placements)?;
    let mut final_placements = state.placements.clone();
    // The verdict of the final plan: the greedy plan's when it is kept, and
    // none when an improved plan replaces a valid greedy one.
    let violations = greedy_violations;
    if violations.is_empty() && max_improvement > 0.0 {
        let improved = improve_placements(context, policy, &mut state, max_improvement, &mut prng)?;
        // An improved plan the validator rejects is dropped for the greedy
        // one, which is known to be valid.
        if validate_plan(context, &improved)?.is_empty() {
            final_placements = improved;
        }
    }

    let deficit_min = attempt_deficit_min(context, &final_placements);
    let has_h3 = violations
        .iter()
        .any(|violation| violation.code == ViolationCode::H3);
    Ok(PlacementAttempt {
        placements: final_placements,
        violations,
        reasons,
        deficit_min,
        repairable: repairable || starved || has_h3,
        starved,
    })
}

/// The position the policy's slot rule picks for one session
/// (`selectPlacement`).
fn select_placement(
    context: &Context<'_>,
    state: &State,
    policy: PolicyName,
    task: usize,
    duration_min: f64,
    min_start_ms: Ms,
    max_end_ms: Ms,
) -> Result<Option<Position>, TimeError> {
    let duration_ms = duration_min * MINUTE_MS_F;
    if duration_ms <= 0.0 || duration_ms % GRID_MS_F != 0.0 {
        return Ok(None);
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let cell_count = (duration_ms / GRID_MS_F) as usize;

    match policy {
        PolicyName::FrontLoaded => {
            for slot in &context.slots_by_start {
                let mut first = None;
                for_each_passing(
                    context,
                    state,
                    slot,
                    cell_count,
                    min_start_ms,
                    max_end_ms,
                    1,
                    |position| {
                        first = Some(position);
                        Ok(false)
                    },
                )?;
                if first.is_some() {
                    return Ok(first);
                }
            }
            Ok(None)
        }
        PolicyName::FocusBlocked => {
            for &slot_id in &context.slots_by_length {
                let slot = &context.slots_by_start[slot_id];
                let mut best = None;
                let mut best_delta = f64::INFINITY;
                for_each_passing(
                    context,
                    state,
                    slot,
                    cell_count,
                    min_start_ms,
                    max_end_ms,
                    1,
                    |position| {
                        let delta = switch_delta(state, position.start_ms, position.end_ms, task);
                        if delta < best_delta {
                            best_delta = delta;
                            best = Some(position);
                        }
                        Ok(true)
                    },
                )?;
                if best.is_some() {
                    return Ok(best);
                }
            }
            Ok(None)
        }
        PolicyName::Balanced => {
            let best =
                best_balanced_position(context, state, cell_count, min_start_ms, max_end_ms, 6)?;
            if best.is_some() {
                return Ok(best);
            }
            best_balanced_position(context, state, cell_count, min_start_ms, max_end_ms, 1)
        }
    }
}

/// Balanced placement evaluates candidate days: the position that leaves the
/// smallest maximum daily load, then the smallest sum of squared loads. A
/// 30-minute stride keeps the scan cheap on large horizons; when it finds
/// nothing (tight gaps not aligned to the stride) the caller retries every
/// 5-minute cell.
fn best_balanced_position(
    context: &Context<'_>,
    state: &State,
    cell_count: usize,
    min_start_ms: Ms,
    max_end_ms: Ms,
    stride: usize,
) -> Result<Option<Position>, TimeError> {
    let mut best = None;
    let mut best_max_load = f64::INFINITY;
    let mut best_sum_squares = f64::INFINITY;
    for slot in &context.slots_by_start {
        for_each_passing(
            context,
            state,
            slot,
            cell_count,
            min_start_ms,
            max_end_ms,
            stride,
            |position| {
                let loads = position_loads(context, slot, &position, cell_count)?;
                let mut max_load: f64 = 0.0;
                let mut sum_squares = 0.0;
                for (date, minutes) in state.daily_load.iter() {
                    let total = minutes + loads.get(date).unwrap_or(0.0);
                    max_load = js::max(max_load, total);
                    sum_squares += total * total;
                }
                for (date, minutes) in loads.iter() {
                    if !state.daily_load.contains(date) {
                        max_load = js::max(max_load, minutes);
                        sum_squares += minutes * minutes;
                    }
                }
                if max_load < best_max_load
                    || (max_load == best_max_load && sum_squares < best_sum_squares)
                {
                    best_max_load = max_load;
                    best_sum_squares = sum_squares;
                    best = Some(position);
                }
                Ok(true)
            },
        )?;
    }
    Ok(best)
}

/// Visits the positions of `cell_count` cells in a slot that lie inside the
/// window and pass H1/H6 and the daily cap, in time order (`passingInSlot`).
/// `visit` returns whether to go on.
#[allow(clippy::too_many_arguments)]
fn for_each_passing(
    context: &Context<'_>,
    state: &State,
    slot: &SlotInfo,
    cell_count: usize,
    min_start_ms: Ms,
    max_end_ms: Ms,
    stride: usize,
    mut visit: impl FnMut(Position) -> Result<bool, TimeError>,
) -> Result<(), TimeError> {
    let Some(limit) = slot.cell_starts.len().checked_sub(cell_count) else {
        return Ok(());
    };
    // Cell counts are small integers: exact as floats.
    #[allow(clippy::cast_precision_loss)]
    let length_ms = cell_count as f64 * GRID_MS_F;
    let mut index = 0;
    while index <= limit {
        let start_ms = slot.cell_starts[index];
        if start_ms >= min_start_ms {
            let end_ms = start_ms + length_ms;
            if end_ms > max_end_ms || end_ms > slot.end_ms {
                break;
            }
            if passes(context, state, start_ms, end_ms)?
                && !visit(Position {
                    start_ms,
                    end_ms,
                    slot_id: slot.id,
                    cell_index: index,
                })?
            {
                break;
            }
        }
        index += stride;
    }
    Ok(())
}

/// Daily-load contribution of a candidate. Most blocks stay inside one local
/// date, so the per-cell dates avoid a partition per candidate; blocks that
/// straddle a boundary still use the exact splitter (`positionLoads`).
fn position_loads(
    context: &Context<'_>,
    slot: &SlotInfo,
    position: &Position,
    cell_count: usize,
) -> Result<Loads, TimeError> {
    let dates = &slot.cell_dates[position.cell_index..position.cell_index + cell_count];
    match dates.first() {
        Some(first) if dates.iter().all(|date| date == first) => {
            #[allow(clippy::cast_precision_loss)]
            let minutes = cell_count as f64 * GRID_MINUTES_F;
            Ok(Loads::single(*first, minutes))
        }
        _ => context.block_daily_loads(position.start_ms, position.end_ms),
    }
}

/// How many of the two neighbours in time belong to another task
/// (`switchDelta`).
fn switch_delta(state: &State, start_ms: Ms, end_ms: Ms, task: usize) -> f64 {
    let mut previous = None;
    let mut next = None;
    for interval in &state.intervals {
        if interval.end_ms <= start_ms {
            previous = Some(interval);
        } else if interval.start_ms >= end_ms {
            next = Some(interval);
            break;
        }
    }
    let differs = |neighbour: Option<&super::state::Interval>| {
        neighbour.is_some_and(|interval| interval.task != task)
    };
    f64::from(u8::from(differs(previous)) + u8::from(differs(next)))
}
