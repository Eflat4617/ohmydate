//! Replanning (06 §7): which existing blocks stay, which tasks are released,
//! and the staged expansion of that scope (`prepareReplan`,
//! `buildReplanSeeds`, `runReplanLevel`).
//!
//! The affected set is (a) tasks hit by the trigger (a new or changed
//! commitment or lock conflict, a measured delay), (b) both endpoints of
//! every added, removed or changed dependency edge, and (c) all transitive
//! successors of (a) and (b). Existing future blocks of every other task are
//! frozen and preserved exactly. If an affected task cannot be fully placed
//! because frozen blocks are in the way, its direct predecessors join the
//! affected set one dependency depth at a time and the attempt is retried.
//!
//! An input without existing blocks goes through the same code: nothing is
//! frozen, nothing is seeded, and the level loop runs once.

use super::context::{BlockKey, Context, block_key, minutes_of};
use super::order::build_chunks;
use super::place::{PlacementAttempt, is_better_attempt, run_placement_attempt};
use super::state::{GRID_MS_F, Interval, MINUTE_MS_F, Ms, Placement, State, overlaps_any, passes};
use crate::js;
use crate::time::TimeError;
use crate::types::{PolicyName, Task};

/// A set of tasks, by index.
pub(super) type TaskSet = Vec<bool>;

pub(super) struct ReplanPlan {
    /// Future, non-locked existing blocks in time order (then task id, end):
    /// the blocks a replan may keep or move.
    pub movable: Vec<Interval>,
    pub base_affected_tasks: TaskSet,
    /// The same blocks as keys, for the `changedBlocks` metric.
    pub movable_existing: Vec<BlockKey>,
}

/// The frozen slice of a replan for one affected set: future existing
/// blocks of every task outside the set, preserved exactly, plus the
/// affected existing block count for the change bound.
pub(super) struct ReplanScope {
    pub frozen: Vec<Interval>,
    pub frozen_tasks: TaskSet,
    pub affected_existing_blocks: usize,
}

pub(super) struct ReplanLevelAttempt {
    pub affected: TaskSet,
    pub scope: ReplanScope,
    pub result: PlacementAttempt,
    pub retained_seeds: usize,
}

/// Adds every transitive successor of the set (`propagateAffected`).
fn propagate_affected(context: &Context<'_>, initial: &TaskSet) -> TaskSet {
    let mut affected = initial.clone();
    let mut changed = true;
    while changed {
        changed = false;
        for (index, info) in context.tasks.iter().enumerate() {
            if affected[index] {
                continue;
            }
            if info
                .depends_on
                .iter()
                .any(|dependency| affected[*dependency])
            {
                affected[index] = true;
                changed = true;
            }
        }
    }
    affected
}

/// A block length a task may have as one session (`isSessionValid`).
fn is_session_valid(task: &Task, required_min: f64, duration_min: f64) -> bool {
    if duration_min <= 0.0 || duration_min % 5.0 != 0.0 {
        return false;
    }
    if !task.splittable {
        return duration_min == required_min;
    }
    duration_min >= task.min_session_min && duration_min <= task.max_session_min
}

/// A task's own window: from now (or its earliest start) to its buffered
/// deadline, inside the horizon.
fn task_window(context: &Context<'_>, task: usize) -> (Ms, Ms) {
    let info = &context.tasks[task];
    let earliest_ms = info.earliest_ms.unwrap_or(context.horizon_start_ms);
    let due_ms = info.due_ms.unwrap_or(context.horizon_end_ms);
    (
        js::max(
            js::max(context.horizon_start_ms, context.now_ms),
            earliest_ms,
        ),
        js::min(context.horizon_end_ms, due_ms - info.buffer_ms),
    )
}

/// Reads the existing blocks of an input and decides which tasks have to be
/// released from the start (`prepareReplan`).
pub(super) fn prepare_replan(context: &Context<'_>) -> Result<ReplanPlan, TimeError> {
    let task_count = context.tasks.len();
    // `existing_intervals` keeps the input order and has dropped the empty
    // blocks.
    let mut movable: Vec<Interval> = context
        .existing_intervals
        .iter()
        .filter(|interval| {
            !context.is_locked_key(interval.task, interval.start_ms, interval.end_ms)
                && interval.start_ms >= context.now_ms
        })
        .copied()
        .collect();
    let movable_existing: Vec<BlockKey> = movable
        .iter()
        .map(|interval| block_key(interval.task, interval.start_ms, interval.end_ms))
        .collect();
    movable.sort_by(|a, b| {
        a.start_ms
            .total_cmp(&b.start_ms)
            .then_with(|| context.compare_task_ids(a.task, b.task))
            .then(a.end_ms.total_cmp(&b.end_ms))
    });

    let mut affected: TaskSet = vec![false; task_count];
    // FU-59: explicit caller scope. Unknown ids are ignored: the caller may
    // pass tasks that disappeared between its read and generation, and an
    // unknown task has no blocks to release anyway.
    for task_id in context.input.affected_task_ids.as_deref().unwrap_or(&[]) {
        if let Some(&task) = context.task_index.get(task_id.as_str()) {
            affected[task] = true;
        }
    }
    let mut movable_min_by_task: Vec<Option<f64>> = vec![None; task_count];
    for item in &movable {
        let info = &context.tasks[item.task];
        let duration_min = (item.end_ms - item.start_ms) / MINUTE_MS_F;
        let (window_start_ms, window_end_ms) = task_window(context, item.task);
        let valid = context
            .find_containing_slot(item.start_ms, item.end_ms)
            .is_some()
            && is_session_valid(info.task, info.required_min, duration_min)
            && item.start_ms >= window_start_ms
            && item.end_ms <= window_end_ms;
        if !valid {
            affected[item.task] = true;
            continue;
        }
        movable_min_by_task[item.task] =
            Some(movable_min_by_task[item.task].unwrap_or(0.0) + duration_min);
    }
    for (task, movable_min) in movable_min_by_task.iter().enumerate() {
        let Some(movable_min) = movable_min else {
            continue;
        };
        let fixed_min = minutes_of(&context.locked_by_task[task]);
        if (fixed_min + movable_min - context.tasks[task].required_min).abs() > 1e-9 {
            // An existing-block set that does not exactly cover the
            // requirement is not a complete seed: release the task so the
            // remainder can be placed (or the whole task rescheduled when
            // the seed blocks the optimum).
            affected[task] = true;
        }
    }

    // Dry-run seed validation to learn which tasks genuinely have to be
    // released (invalid commitment-overlapping seed, changed dependency,
    // unrepresentable remainder). Everything else is frozen exactly.
    let nothing_frozen = vec![false; task_count];
    let (_, dry_run_affected) = build_replan_seeds(context, &movable, &nothing_frozen, &affected)?;
    Ok(ReplanPlan {
        movable,
        base_affected_tasks: propagate_affected(context, &dry_run_affected),
        movable_existing,
    })
}

/// Splits a replan into the frozen (unaffected) existing blocks and the
/// affected block count for the current affected set. Releasing more tasks
/// only ever unfreezes their own blocks (`scopeForReplan`).
fn scope_for_replan(context: &Context<'_>, replan: &ReplanPlan, affected: &TaskSet) -> ReplanScope {
    let frozen: Vec<Interval> = replan
        .movable
        .iter()
        .filter(|item| !affected[item.task])
        .copied()
        .collect();
    let mut frozen_tasks = vec![false; context.tasks.len()];
    for item in &frozen {
        frozen_tasks[item.task] = true;
    }
    ReplanScope {
        affected_existing_blocks: replan.movable.len() - frozen.len(),
        frozen,
        frozen_tasks,
    }
}

/// The affected tasks together with their direct dependencies
/// (`directPredecessors` joined to the set).
fn with_direct_predecessors(context: &Context<'_>, affected: &TaskSet) -> TaskSet {
    let mut expanded = affected.clone();
    for (index, info) in context.tasks.iter().enumerate() {
        if affected[index] {
            for &dependency in &info.depends_on {
                expanded[dependency] = true;
            }
        }
    }
    expanded
}

/// When the dependencies of a task are complete, counting locked blocks,
/// history and seeds (`dependencyCompletion`).
fn dependency_completion(
    context: &Context<'_>,
    seeds_by_task: &[Vec<Placement>],
    dependencies: &[usize],
) -> Ms {
    let mut ready = context.horizon_start_ms;
    for &dependency in dependencies {
        for interval in &context.locked_by_task[dependency] {
            ready = js::max(ready, interval.end_ms);
        }
        for interval in &context.history_by_task[dependency] {
            ready = js::max(ready, interval.end_ms);
        }
        for seed in &seeds_by_task[dependency] {
            ready = js::max(ready, seed.end_ms);
        }
    }
    ready
}

/// The start of the earliest seed of any task that depends on `task`
/// (`earliestSeededSuccessorStart`).
fn earliest_seeded_successor_start(
    context: &Context<'_>,
    seeds_by_task: &[Vec<Placement>],
    task: usize,
) -> Option<Ms> {
    let mut earliest: Option<Ms> = None;
    for &dependent in &context.tasks[task].dependents {
        for seed in &seeds_by_task[dependent] {
            earliest = Some(match earliest {
                Some(known) => js::min(known, seed.start_ms),
                None => seed.start_ms,
            });
        }
    }
    earliest
}

/// Minutes of free grid cells inside `[start_ms, end_ms)`
/// (`freeMinutesBetween`).
fn free_minutes_between(context: &Context<'_>, state: &State, start_ms: Ms, end_ms: Ms) -> f64 {
    if end_ms <= start_ms {
        return 0.0;
    }
    let mut total = 0.0;
    for slot in &context.slots_by_start {
        for &cell_start in &slot.cell_starts {
            if cell_start < start_ms {
                continue;
            }
            if cell_start + GRID_MS_F > end_ms {
                break;
            }
            if !overlaps_any(&state.intervals, cell_start, cell_start + GRID_MS_F) {
                total += 5.0;
            }
        }
    }
    total
}

fn seed_of(
    context: &Context<'_>,
    item: &Interval,
    slot_id: Option<usize>,
) -> Result<Placement, TimeError> {
    Ok(Placement {
        task: item.task,
        duration_min: (item.end_ms - item.start_ms) / MINUTE_MS_F,
        start_ms: item.start_ms,
        end_ms: item.end_ms,
        slot_id,
        local_hour: context.local_hour_of(item.start_ms, item.end_ms)?,
        seeded: true,
    })
}

/// Builds seeds for the given affected set, releasing more tasks until
/// stable. A seed is invalid when it starts before a dependency's last
/// block, when the task's remainder is below its minimum session or cannot
/// fit before a seeded successor, or when H1/H2/H6/daily checks reject it
/// (06 §7.1). Blocks of `frozen_tasks` are always seeded and never released.
///
/// Returns the seeds and the affected set they were built for
/// (`buildReplanSeeds`).
fn build_replan_seeds(
    context: &Context<'_>,
    movable: &[Interval],
    frozen_tasks: &TaskSet,
    initial_affected: &TaskSet,
) -> Result<(Vec<Placement>, TaskSet), TimeError> {
    let task_count = context.tasks.len();
    let mut affected = propagate_affected(context, initial_affected);

    for _ in 0..=task_count + 2 {
        let mut state = context.create_state();
        let mut seeds: Vec<Placement> = Vec::new();
        let mut failed_task = None;
        for item in movable {
            let frozen_seed = frozen_tasks[item.task];
            if affected[item.task] && !frozen_seed {
                continue;
            }
            let slot_id = context
                .find_containing_slot(item.start_ms, item.end_ms)
                .map(|slot| slot.id);
            if !frozen_seed
                && (slot_id.is_none() || !passes(context, &state, item.start_ms, item.end_ms)?)
            {
                failed_task = Some(item.task);
                break;
            }
            let placement = seed_of(context, item, slot_id)?;
            state.add_placement(context, placement)?;
            seeds.push(placement);
        }
        if let Some(failed_task) = failed_task {
            affected[failed_task] = true;
            affected = propagate_affected(context, &affected);
            continue;
        }

        let mut seeds_by_task: Vec<Vec<Placement>> = vec![Vec::new(); task_count];
        for seed in &seeds {
            seeds_by_task[seed.task].push(*seed);
        }

        let mut next = affected.clone();
        for seed in &seeds {
            let info = &context.tasks[seed.task];
            if seed.start_ms < dependency_completion(context, &seeds_by_task, &info.depends_on) {
                // A dependency edge whose existing blocks are out of order
                // has been added or changed; 06 §7 keeps both endpoints in
                // the affected set so the predecessor is not permanently
                // frozen.
                next[seed.task] = true;
                for &dependency in &info.depends_on {
                    next[dependency] = true;
                }
            }
        }
        for (task, task_seeds) in seeds_by_task.iter().enumerate() {
            if task_seeds.is_empty() {
                continue;
            }
            let info = &context.tasks[task];
            let locked_min = minutes_of(&context.locked_by_task[task]);
            let seeded_min = task_seeds
                .iter()
                .fold(0.0, |sum, seed| sum + seed.duration_min);
            let remaining = js::max(0.0, info.required_min - locked_min - seeded_min);
            if remaining <= 0.0 {
                continue;
            }
            if !info.task.splittable || remaining < info.task.min_session_min {
                next[task] = true;
                continue;
            }
            if build_chunks(info.task, remaining).reason.is_some() {
                next[task] = true;
                continue;
            }
            if let Some(successor_start) =
                earliest_seeded_successor_start(context, &seeds_by_task, task)
            {
                let (own_start_ms, own_end_ms) = task_window(context, task);
                let window_start = js::max(
                    own_start_ms,
                    dependency_completion(context, &seeds_by_task, &info.depends_on),
                );
                let window_end = js::min(own_end_ms, successor_start);
                if window_end <= window_start
                    || free_minutes_between(context, &state, window_start, window_end) < remaining
                {
                    next[task] = true;
                }
            }
        }

        let mut propagated = propagate_affected(context, &next);
        // Unaffected tasks stay frozen even if a seed-level check wanted to
        // release them; the caller reports an infeasible or flagged
        // candidate rather than silently moving untouched blocks (06 §7).
        for (task, frozen) in frozen_tasks.iter().enumerate() {
            if *frozen {
                propagated[task] = false;
            }
        }
        if propagated == affected {
            return Ok((seeds, affected));
        }
        affected = propagated;
    }
    Ok((Vec::new(), affected))
}

/// Frozen, unaffected existing blocks as seeds; never released
/// (`frozenSeeds`).
fn frozen_seeds(context: &Context<'_>, scope: &ReplanScope) -> Result<Vec<Placement>, TimeError> {
    scope
        .frozen
        .iter()
        .map(|item| {
            let slot_id = context
                .find_containing_slot(item.start_ms, item.end_ms)
                .map(|slot| slot.id);
            seed_of(context, item, slot_id)
        })
        .collect()
}

/// True when the placements reproduce every frozen (unaffected) existing
/// block exactly, with no extra block for those tasks (`preservesFrozen`).
fn preserves_frozen(placements: &[Placement], scope: &ReplanScope) -> bool {
    let keys = |blocks: &mut dyn Iterator<Item = BlockKey>| {
        let mut keys: Vec<BlockKey> = blocks.collect();
        keys.sort_by(Ord::cmp);
        keys.dedup();
        keys
    };
    let expected = keys(
        &mut scope
            .frozen
            .iter()
            .map(|item| block_key(item.task, item.start_ms, item.end_ms)),
    );
    let actual = keys(
        &mut placements
            .iter()
            .filter(|placement| scope.frozen_tasks[placement.task])
            .map(|placement| block_key(placement.task, placement.start_ms, placement.end_ms)),
    );
    expected == actual
}

/// One affected-scope attempt (06 §7): freeze every task outside
/// `affected`, seed the rest, then release tasks that still raise hard
/// violations. Never releases a frozen (unaffected) task (`runReplanLevel`).
fn run_replan_level(
    context: &Context<'_>,
    replan: &ReplanPlan,
    affected: &TaskSet,
    policy: PolicyName,
    seed: f64,
    max_improvement: f64,
) -> Result<ReplanLevelAttempt, TimeError> {
    let scope = scope_for_replan(context, replan, affected);
    let attempt = |level_affected: &TaskSet| {
        build_replan_seeds(
            context,
            &replan.movable,
            &scope.frozen_tasks,
            level_affected,
        )
    };
    let place =
        |seeds: &[Placement]| run_placement_attempt(context, policy, seed, max_improvement, seeds);

    let (seeds, mut level_affected) = attempt(affected)?;
    let mut result = place(&seeds)?;
    let mut best_retained_seeds = seeds.len();
    let mut best_result = result.clone();
    let mut best_affected = level_affected.clone();

    for _ in 0..=context.tasks.len() + 2 {
        if result.is_feasible() {
            break;
        }
        let mut next = level_affected.clone();
        let mut any_violating = false;
        for violation in &result.violations {
            let Some(task) = violation
                .task_id
                .as_deref()
                .and_then(|task_id| context.task_index.get(task_id).copied())
            else {
                continue;
            };
            if !scope.frozen_tasks[task] {
                any_violating = true;
                next[task] = true;
            }
        }
        // A violation without a movable task owner (for example H6) or one
        // that only touches frozen or unaffected blocks cannot be repaired
        // by releasing more tasks; keep the best candidate and flag it
        // instead of moving untouched blocks (06 §7).
        if !any_violating {
            break;
        }
        let mut next = propagate_affected(context, &next);
        for (task, frozen) in scope.frozen_tasks.iter().enumerate() {
            if *frozen {
                next[task] = false;
            }
        }
        if next == level_affected {
            break;
        }
        let (seeds, released) = attempt(&next)?;
        level_affected = released;
        result = place(&seeds)?;
        if is_better_attempt(&result, seeds.len(), &best_result, best_retained_seeds) {
            best_result = result.clone();
            best_retained_seeds = seeds.len();
            best_affected = level_affected.clone();
        }
    }

    // Final fallback: release every affected task but keep frozen and
    // unaffected blocks. If a still-seeded attempt was feasible we never get
    // here, so the first feasible attempt wins. When every attempt is
    // infeasible, rank by the smallest H7 deficit, then the fewest
    // violations, and only then by retained seeds (plan continuity): partial
    // plans should first place as much required work as possible.
    // Unaffected blocks are never released (06 §7).
    if !result.is_feasible() {
        let frozen = frozen_seeds(context, &scope)?;
        let fresh = place(&frozen)?;
        if is_better_attempt(&fresh, frozen.len(), &best_result, best_retained_seeds) {
            best_result = fresh;
            best_retained_seeds = frozen.len();
            best_affected = level_affected.clone();
        }
    }

    // Last resort for a frozen-block dead end: regenerate from scratch (no
    // seeds) and accept it only when every frozen block is reproduced
    // exactly. This keeps 06 §7 preservation while allowing the
    // unconstrained greedy order that originally produced the frozen plan
    // to find a feasible placement for the affected tasks.
    if !best_result.is_feasible() {
        let from_scratch = place(&[])?;
        if preserves_frozen(&from_scratch.placements, &scope)
            && is_better_attempt(&from_scratch, 0, &best_result, best_retained_seeds)
        {
            best_result = from_scratch;
            best_retained_seeds = 0;
            best_affected = level_affected.clone();
        }
    }

    Ok(ReplanLevelAttempt {
        scope: scope_for_replan(context, replan, &best_affected),
        affected: best_affected,
        result: best_result,
        retained_seeds: best_retained_seeds,
    })
}

/// The best attempt over the staged expansion of the affected set: an
/// affected task that cannot be fully placed because frozen blocks are in
/// the way releases its direct predecessors, one dependency level per retry,
/// and successors of the expanded set join the scope. If the set stops
/// growing, the explained infeasible candidate is final.
pub(super) fn best_replan_attempt(
    context: &Context<'_>,
    replan: &ReplanPlan,
    policy: PolicyName,
    seed: f64,
    max_improvement: f64,
) -> Result<ReplanLevelAttempt, TimeError> {
    let mut affected = replan.base_affected_tasks.clone();
    let mut best = run_replan_level(context, replan, &affected, policy, seed, max_improvement)?;
    let mut latest_affected = best.affected.clone();
    let mut latest_feasible = best.result.is_feasible();
    for _ in 0..context.tasks.len() + 2 {
        if latest_feasible {
            break;
        }
        let expanded = propagate_affected(
            context,
            &with_direct_predecessors(context, &latest_affected),
        );
        if expanded == latest_affected {
            break;
        }
        affected = expanded;
        let attempt = run_replan_level(context, replan, &affected, policy, seed, max_improvement)?;
        latest_affected = attempt.affected.clone();
        latest_feasible = attempt.result.is_feasible();
        // The first feasible level wins outright; otherwise the better
        // partial plan is kept.
        if latest_feasible
            || is_better_attempt(
                &attempt.result,
                attempt.retained_seeds,
                &best.result,
                best.retained_seeds,
            )
        {
            best = attempt;
        }
    }
    Ok(best)
}
