//! The two feasibility aids of a repair pass (FU-69): the gap-fitted split
//! (`fitSessionsIntoGaps`) and the successor bound (`successorBound`).
//!
//! `build_chunks` asks for `ceil(required / maxSession)` equal sessions,
//! each needing its own contiguous room. When frozen replan blocks or
//! commitments fragment the free time, that fails although shorter sessions
//! inside the task's bounds would cover the requirement. The gap-fitted
//! split searches the free runs for such a cover.

use super::context::{Context, GRID_MINUTES_F};
use super::order::SessionBounds;
use super::state::{GRID_MS_F, Ms, Placement, State, passes};
use crate::js;
use crate::time::TimeError;
use crate::types::PolicyName;

/// Deterministic work cap for one gap-fitted split search (`passes` checks
/// plus trial placements). The search is a fallback for fragmented free
/// time, so it must stay cheap even when no split exists.
/// `fit_sessions_into_gaps` searches at most twice per task (remainder after
/// kept blocks, then a full re-split) and each `search_gap_sessions` runs
/// `search_runs` at most twice (policy order, then time order), so a task
/// costs at most 4 × `GAP_FIT_BUDGET` evaluations per repair pass.
const GAP_FIT_BUDGET: i64 = 512;

// Cell counts and indices are small whole numbers: exact as floats.
#[allow(clippy::cast_precision_loss)]
fn count(value: usize) -> f64 {
    value as f64
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn index(value: f64) -> usize {
    value as usize
}

/// A maximal run of free grid cells `[first_cell, end_cell)` of one slot.
#[derive(Debug, Clone, Copy)]
struct CellRange {
    slot: usize,
    first_cell: usize,
    end_cell: usize,
}

/// Contiguous free grid cells of one slot on one local date.
#[derive(Debug, Clone, Copy)]
struct FreeRun {
    slot: usize,
    cell_count: f64,
    start_ms: Ms,
    /// Upper bound on the cells this run can host under H6 and the daily
    /// focus cap.
    usable_cells: f64,
    /// Focus minutes already on the run's local date (balanced ordering).
    day_load_min: f64,
}

#[derive(Debug, Clone, Copy)]
struct FocusStretch {
    start_ms: Ms,
    end_ms: Ms,
}

/// Free whole grid cells inside `[window_start_ms, window_end_ms)` in time
/// order: every slot minus the occupied intervals of `state`
/// (`freeCellRanges`).
fn free_cell_ranges(
    context: &Context<'_>,
    state: &State,
    window_start_ms: Ms,
    window_end_ms: Ms,
) -> Vec<CellRange> {
    let mut busy: Vec<(Ms, Ms)> = Vec::new();
    for interval in &state.intervals {
        match busy.last_mut() {
            Some(last) if interval.start_ms <= last.1 => last.1 = js::max(last.1, interval.end_ms),
            _ => busy.push((interval.start_ms, interval.end_ms)),
        }
    }

    let mut ranges = Vec::new();
    for slot in &context.slots_by_start {
        let mut push_range = |from_ms: Ms, to_ms: Ms| {
            let first_cell = js::max(0.0, ((from_ms - slot.start_ms) / GRID_MS_F).ceil());
            let end_cell = js::min(
                count(slot.cell_starts.len()),
                ((to_ms - slot.start_ms) / GRID_MS_F).floor(),
            );
            if end_cell > first_cell {
                ranges.push(CellRange {
                    slot: slot.id,
                    first_cell: index(first_cell),
                    end_cell: index(end_cell),
                });
            }
        };
        let low_ms = js::max(slot.start_ms, window_start_ms);
        let high_ms = js::min(slot.end_ms, window_end_ms);
        let mut free_from_ms = low_ms;
        for &(occupied_start, occupied_end) in &busy {
            if free_from_ms >= high_ms || occupied_start >= high_ms {
                break;
            }
            if occupied_end <= free_from_ms {
                continue;
            }
            push_range(free_from_ms, occupied_start);
            free_from_ms = occupied_end;
        }
        push_range(free_from_ms, high_ms);
    }
    ranges
}

/// Most focus cells that `cell_count` consecutive free cells can hold under
/// the H6 continuous-focus rule alone: stretches of at most `breakAfterMin`
/// separated by `breakMin`. An upper bound (`focusCellsWithBreaks`).
fn focus_cells_with_breaks(context: &Context<'_>, cell_count: f64) -> f64 {
    if cell_count <= 0.0 {
        return 0.0;
    }
    let stretch_cells = (context.break_after_ms / GRID_MS_F).floor();
    if context.break_after_ms <= 0.0 || stretch_cells < 1.0 {
        return cell_count;
    }
    let cycle_cells = stretch_cells + (context.break_ms / GRID_MS_F).ceil();
    let cycles = (cell_count / cycle_cells).floor();
    cycles * stretch_cells + js::min(cell_count - cycles * cycle_cells, stretch_cells)
}

/// Occupied intervals merged while they are closer than `breakMin` (H6).
fn focus_stretches(context: &Context<'_>, state: &State) -> Vec<FocusStretch> {
    let mut stretches: Vec<FocusStretch> = Vec::new();
    for interval in &state.intervals {
        match stretches.last_mut() {
            Some(last) if interval.start_ms - last.end_ms < context.break_ms => {
                last.end_ms = js::max(last.end_ms, interval.end_ms);
            }
            _ => stretches.push(FocusStretch {
                start_ms: interval.start_ms,
                end_ms: interval.end_ms,
            }),
        }
    }
    stretches
}

/// Upper bound on the focus cells a free run can hold under H6 given the
/// focus stretches next to it. At either end the run's focus joins the
/// neighbour (then that stretch is limited by what the neighbour leaves of
/// `breakAfterMin`, and a break follows) or stays a break away from it (then
/// those cells are lost). Each end alone gives a valid bound; the smaller
/// wins (`focusCellsInRun`).
fn focus_cells_in_run(
    context: &Context<'_>,
    stretches: &[FocusStretch],
    start_ms: Ms,
    cell_count: f64,
) -> f64 {
    if context.break_after_ms <= 0.0 {
        return cell_count;
    }
    let end_ms = start_ms + cell_count * GRID_MS_F;
    let mut before = None;
    let mut after = None;
    for stretch in stretches {
        if stretch.end_ms <= start_ms {
            before = Some(stretch);
        } else if stretch.start_ms >= end_ms {
            after = Some(stretch);
            break;
        }
    }
    let break_cells = (context.break_ms / GRID_MS_F).ceil();
    let beside_neighbour = |skip_ms: Ms, joined_ms: Ms| {
        let joined = js::min(cell_count, (joined_ms / GRID_MS_F).floor());
        js::max(
            focus_cells_with_breaks(context, cell_count - (skip_ms / GRID_MS_F).ceil()),
            if joined < 1.0 {
                0.0
            } else {
                joined + focus_cells_with_breaks(context, cell_count - joined - break_cells)
            },
        )
    };
    let mut bound = focus_cells_with_breaks(context, cell_count);
    if let Some(before) = before
        && before.end_ms + context.break_ms > start_ms
    {
        bound = js::min(
            bound,
            beside_neighbour(
                before.end_ms + context.break_ms - start_ms,
                before.start_ms + context.break_after_ms - start_ms,
            ),
        );
    }
    if let Some(after) = after
        && after.start_ms - context.break_ms < end_ms
    {
        bound = js::min(
            bound,
            beside_neighbour(
                end_ms - (after.start_ms - context.break_ms),
                end_ms - (after.end_ms - context.break_after_ms),
            ),
        );
    }
    bound
}

/// Free runs for a gap-fitted split, in time order: the free cell ranges
/// split at local-date changes so the daily focus cap bounds each run on its
/// own. Runs that cannot host one minimum session are dropped (`freeRuns`).
fn free_runs(
    context: &Context<'_>,
    state: &State,
    window_start_ms: Ms,
    window_end_ms: Ms,
    min_units: f64,
) -> Vec<FreeRun> {
    let mut runs = Vec::new();
    let stretches = focus_stretches(context, state);
    let mut push_run = |slot_id: usize, first_cell: usize, end_cell: usize| {
        let slot = &context.slots_by_start[slot_id];
        let cell_count = count(end_cell - first_cell);
        if cell_count < min_units {
            return;
        }
        let start_ms = slot.cell_starts[first_cell];
        let day_load_min = state
            .daily_load
            .get(slot.cell_dates[first_cell])
            .unwrap_or(0.0);
        // A cell may straddle local midnight by under one grid step when the
        // slot is not grid-aligned to it, so round the cap up to stay an
        // upper bound.
        let usable_cells = js::min(
            focus_cells_in_run(context, &stretches, start_ms, cell_count),
            ((context.max_daily_focus_min - day_load_min) / GRID_MINUTES_F).ceil(),
        );
        if usable_cells < min_units {
            return;
        }
        runs.push(FreeRun {
            slot: slot_id,
            cell_count,
            start_ms,
            usable_cells,
            day_load_min,
        });
    };
    for range in free_cell_ranges(context, state, window_start_ms, window_end_ms) {
        let dates = &context.slots_by_start[range.slot].cell_dates;
        let mut run_start = range.first_cell;
        for cell in run_start + 1..=range.end_cell {
            if cell == range.end_cell || dates[cell] != dates[run_start] {
                push_run(range.slot, run_start, cell);
                run_start = cell;
            }
        }
    }
    runs
}

/// Latest instant from which `need_units` free cells are still usable before
/// `limit_ms`: scanning the ranges backwards, a range counts only when the
/// part inside `[from_ms, limit_ms)` holds one `piece_units` session (the
/// whole need when `contiguous`). `None` when the need does not fit at all
/// (`latestStartWithRoom`).
fn latest_start_with_room(
    context: &Context<'_>,
    ranges: &[CellRange],
    from_ms: Ms,
    limit_ms: Ms,
    need_units: f64,
    piece_units: f64,
    contiguous: bool,
) -> Option<Ms> {
    let mut gathered = 0.0;
    for range in ranges.iter().rev() {
        let slot = &context.slots_by_start[range.slot];
        let first_cell = js::max(
            count(range.first_cell),
            ((from_ms - slot.start_ms) / GRID_MS_F).ceil(),
        );
        let end_cell = js::min(
            count(range.end_cell),
            ((limit_ms - slot.start_ms) / GRID_MS_F).floor(),
        );
        let length = end_cell - first_cell;
        if length < piece_units {
            continue;
        }
        if contiguous {
            return Some(slot.start_ms + (end_cell - need_units) * GRID_MS_F);
        }
        if gathered + length >= need_units {
            let take = js::max(need_units - gathered, piece_units);
            return Some(slot.start_ms + (end_cell - take) * GRID_MS_F);
        }
        gathered += length;
    }
    None
}

/// Latest end the task `ordered[task_index]` may have so that its dependents
/// can still be placed (FU-69): for every transitive dependent, the latest
/// instant from which its still-unplaced minutes fit into the free cells
/// before its own deadline and its own dependents' bounds, and the start of
/// any block it already has. Positive infinity when nothing constrains the
/// task.
///
/// With `slack_ms` 0 this is a necessary condition for H3 + H7 only (it
/// ignores H6 and the room other tasks will take), so it never removes a
/// position that a valid greedy plan uses; a dependent that cannot be placed
/// at all imposes no bound. A positive `slack_ms` keeps that much time free
/// before each dependent's room as well (the break H6 may demand after its
/// dependency), which is a heuristic and may be stricter than necessary.
pub(super) fn successor_bound(
    context: &Context<'_>,
    state: &State,
    ordered: &[usize],
    task_index: usize,
    slack_ms: Ms,
) -> Ms {
    let task_count = context.tasks.len();
    let direct = &context.tasks[ordered[task_index]].dependents;
    if direct.is_empty() {
        return f64::INFINITY;
    }
    let mut reachable = vec![false; task_count];
    let mut queue: Vec<usize> = direct.clone();
    let mut head = 0;
    while head < queue.len() {
        let dependent = queue[head];
        head += 1;
        if reachable[dependent] {
            continue;
        }
        reachable[dependent] = true;
        queue.extend(&context.tasks[dependent].dependents);
    }

    let placement_start_ms = js::max(context.horizon_start_ms, context.now_ms);
    let ranges = free_cell_ranges(context, state, placement_start_ms, context.horizon_end_ms);
    let mut placed_min_by_task = vec![0.0; task_count];
    let mut first_start_by_task: Vec<Option<Ms>> = vec![None; task_count];
    let mut note_block = |task: usize, start_ms: Ms, minutes: f64| {
        placed_min_by_task[task] += minutes;
        first_start_by_task[task] = Some(match first_start_by_task[task] {
            Some(known) => js::min(known, start_ms),
            None => start_ms,
        });
    };
    for placement in &state.placements {
        note_block(placement.task, placement.start_ms, placement.duration_min);
    }
    for interval in &context.locked_intervals {
        note_block(interval.task, interval.start_ms, interval.minutes());
    }

    // `ordered` is topological, so walking it backwards visits every
    // dependent before the task it depends on.
    let mut latest_start: Vec<Option<Ms>> = vec![None; task_count];
    for &dependent in ordered[task_index + 1..].iter().rev() {
        if !reachable[dependent] {
            continue;
        }
        let info = &context.tasks[dependent];
        let mut limit_ms = js::min(
            context.horizon_end_ms,
            info.due_ms.unwrap_or(f64::INFINITY) - info.buffer_ms,
        );
        for &next in &info.dependents {
            limit_ms = js::min(limit_ms, latest_start[next].unwrap_or(f64::INFINITY));
        }
        let mut bound_ms = first_start_by_task[dependent].unwrap_or(f64::INFINITY);
        let need_min = js::max(0.0, info.required_min - placed_min_by_task[dependent]);
        if need_min > 0.0 {
            let need_units = (need_min / GRID_MINUTES_F).ceil();
            let piece_units = if info.task.splittable {
                js::min(
                    need_units,
                    js::max(1.0, (info.task.min_session_min / GRID_MINUTES_F).ceil()),
                )
            } else {
                need_units
            };
            let earliest_ms = match info.earliest_ms {
                None => placement_start_ms,
                Some(earliest_ms) => js::max(placement_start_ms, earliest_ms),
            };
            if let Some(room_ms) = latest_start_with_room(
                context,
                &ranges,
                earliest_ms,
                limit_ms,
                need_units,
                piece_units,
                !info.task.splittable,
            ) {
                bound_ms = js::min(bound_ms, room_ms - slack_ms);
            }
        }
        latest_start[dependent] = Some(bound_ms);
    }

    direct.iter().fold(f64::INFINITY, |bound_ms, dependent| {
        js::min(bound_ms, latest_start[*dependent].unwrap_or(f64::INFINITY))
    })
}

/// Start offsets worth trying for the next session of a run whose cells from
/// `from` on are free. With P the focus run that ends before `from` and S
/// the one that starts after the run, a session joins P when it starts
/// within `breakMin` of it and joins S when it ends within `breakMin` of it,
/// and the joined stretch may not exceed `breakAfterMin` (H6). That makes
/// three starts distinct, each the earliest of its class (an earlier start
/// admits every length a later start of the same class does and leaves more
/// room):
///
/// 1. `from`: joins P when P is that close;
/// 2. the first cell a full break after P: joins nothing before it;
/// 3. the first cell from which a session may run into S, that is no earlier
///    than S's end minus `breakAfterMin`: a session starting between 2 and 3
///    has to stop a break short of S.
///
/// H1 holds on free cells and the daily cap does not depend on the start, so
/// `passes` covers the rest (`startOffsets`).
fn start_offsets(context: &Context<'_>, state: &State, run: &FreeRun, from: f64) -> Vec<f64> {
    let mut starts = vec![from];
    if context.break_after_ms <= 0.0 {
        return starts;
    }
    let from_ms = run.start_ms + from * GRID_MS_F;
    let run_end_ms = run.start_ms + run.cell_count * GRID_MS_F;
    let mut before_end_ms = f64::NEG_INFINITY;
    let mut after_start_ms = f64::INFINITY;
    let mut after_end_ms = f64::NEG_INFINITY;
    for interval in &state.intervals {
        if interval.end_ms <= from_ms {
            before_end_ms = js::max(before_end_ms, interval.end_ms);
        } else if interval.start_ms >= run_end_ms {
            if after_start_ms == f64::INFINITY {
                after_start_ms = interval.start_ms;
            } else if interval.start_ms - after_end_ms >= context.break_ms {
                break;
            }
            after_end_ms = js::max(after_end_ms, interval.end_ms);
        }
    }

    let offset_of = |epoch_ms: Ms| ((epoch_ms - run.start_ms) / GRID_MS_F).ceil();
    let mut detached = from;
    if before_end_ms + context.break_ms > from_ms {
        detached = offset_of(before_end_ms + context.break_ms);
        starts.push(detached);
    }
    if after_start_ms - run_end_ms < context.break_ms {
        let anchored = offset_of(after_end_ms - context.break_after_ms);
        if anchored > detached {
            starts.push(anchored);
        }
    }
    starts
}

/// One depth-first search for sessions that cover exactly `units` cells
/// (`searchRuns`).
struct RunSearch<'c, 'a> {
    context: &'c Context<'a>,
    task: usize,
    bounds: SessionBounds,
    runs: Vec<FreeRun>,
    /// `usable_after[k]`: upper bound on the cells runs `k..` can still host.
    usable_after: Vec<f64>,
    /// Evaluations left (`passes` checks plus trial placements); they bound
    /// the work and the recursion depth.
    budget: i64,
    sessions: Vec<Placement>,
}

impl RunSearch<'_, '_> {
    fn fits(
        &mut self,
        state: &State,
        run: &FreeRun,
        offset: f64,
        length: f64,
    ) -> Result<bool, TimeError> {
        if self.budget <= 0 {
            return Ok(false);
        }
        self.budget -= 1;
        let start_ms = run.start_ms + offset * GRID_MS_F;
        passes(self.context, state, start_ms, start_ms + length * GRID_MS_F)
    }

    /// `passes` is monotone in the session length for a fixed start (a
    /// shorter block overlaps less, loads less and joins no longer run), so
    /// the longest passing length is found by bisection.
    fn longest_fitting(
        &mut self,
        state: &State,
        run: &FreeRun,
        offset: f64,
        cap: f64,
    ) -> Result<f64, TimeError> {
        if cap < self.bounds.min_units || !self.fits(state, run, offset, self.bounds.min_units)? {
            return Ok(0.0);
        }
        let mut low = self.bounds.min_units;
        let mut high = cap;
        while low < high {
            let middle = ((low + high) / 2.0).ceil();
            if self.fits(state, run, offset, middle)? {
                low = middle;
            } else {
                high = middle - 1.0;
            }
        }
        Ok(low)
    }

    /// Visits the runs from `index` on, filling each left to right. For the
    /// next session in a run every passing (start, length) whose remainder
    /// is still representable is tried, longest session first. Every session
    /// is checked with `passes` against the live state, so H1/H6 hold by
    /// construction.
    fn search(
        &mut self,
        state: &mut State,
        index: usize,
        offset: f64,
        remaining: f64,
    ) -> Result<bool, TimeError> {
        if remaining == 0.0 {
            return Ok(true);
        }
        for k in index..self.runs.len() {
            let run = self.runs[k];
            let from = if k == index { offset } else { 0.0 };
            let left_cells = run.cell_count - from;
            let usable_here = if left_cells < self.bounds.min_units {
                0.0
            } else {
                js::min(run.usable_cells, left_cells)
            };
            if remaining > usable_here + self.usable_after[k + 1] {
                return Ok(false);
            }
            if usable_here == 0.0 {
                continue;
            }
            let starts = start_offsets(self.context, state, &run, from);
            let mut longest = Vec::with_capacity(starts.len());
            for &start in &starts {
                let cap = js::min(
                    js::min(self.bounds.max_units, remaining),
                    run.cell_count - start,
                );
                longest.push(self.longest_fitting(state, &run, start, cap)?);
            }
            // Longest session first across the starts (earliest start on
            // ties): a start that only admits short sessions is then tried
            // last instead of draining the budget before the next start is
            // reached.
            let mut length = longest.iter().copied().fold(f64::NEG_INFINITY, js::max);
            while length >= self.bounds.min_units {
                if self.bounds.is_representable(remaining - length) {
                    for (choice, &start) in starts.iter().enumerate() {
                        if length > longest[choice] {
                            continue;
                        }
                        if self.budget <= 0 {
                            return Ok(false);
                        }
                        self.budget -= 1;
                        let start_ms = run.start_ms + start * GRID_MS_F;
                        let end_ms = start_ms + length * GRID_MS_F;
                        let placement = Placement {
                            task: self.task,
                            duration_min: length * GRID_MINUTES_F,
                            start_ms,
                            end_ms,
                            slot_id: Some(run.slot),
                            local_hour: self.context.local_hour_of(start_ms, end_ms)?,
                            seeded: false,
                        };
                        state.add_placement(self.context, placement)?;
                        self.sessions.push(placement);
                        if self.search(state, k, start + length, remaining - length)? {
                            return Ok(true);
                        }
                        self.sessions.pop();
                        state.remove_placement(self.context, &placement)?;
                    }
                }
                length -= 1.0;
            }
        }
        Ok(false)
    }
}

/// Searches `runs` in the given order for sessions covering exactly `units`
/// cells. Successful sessions stay in `state`; a failed search leaves it
/// unchanged. An exhausted budget is a failed search.
fn search_runs(
    context: &Context<'_>,
    state: &mut State,
    task: usize,
    units: f64,
    bounds: SessionBounds,
    runs: Vec<FreeRun>,
) -> Result<Option<Vec<Placement>>, TimeError> {
    let mut usable_after = vec![0.0; runs.len() + 1];
    for k in (0..runs.len()).rev() {
        usable_after[k] = usable_after[k + 1] + runs[k].usable_cells;
    }
    if units > usable_after[0] {
        return Ok(None);
    }
    let mut search = RunSearch {
        context,
        task,
        bounds,
        runs,
        usable_after,
        budget: GAP_FIT_BUDGET,
        sessions: Vec::new(),
    };
    Ok(search
        .search(state, 0, 0.0, units)?
        .then_some(search.sessions))
}

/// Cover exactly `units` grid cells with sessions inside the session bounds:
/// over the free runs in policy order — earliest first (front_loaded),
/// longest first (focus_blocked), least-loaded day first (balanced) — and,
/// when that order is not chronological and finds nothing, once more in time
/// order. Only the chronological search sees every session's preceding focus
/// when it picks a start, so only it can leave the H6 break after a session
/// in an earlier gap (`searchGapSessions`).
#[allow(clippy::too_many_arguments)]
fn search_gap_sessions(
    context: &Context<'_>,
    state: &mut State,
    policy: PolicyName,
    task: usize,
    units: f64,
    bounds: SessionBounds,
    window_start_ms: Ms,
    window_end_ms: Ms,
) -> Result<Option<Vec<Placement>>, TimeError> {
    if units == 0.0 {
        return Ok(Some(Vec::new()));
    }
    let chronological = free_runs(
        context,
        state,
        window_start_ms,
        window_end_ms,
        bounds.min_units,
    );
    // `chronological` is in time order, which also breaks ties.
    let mut order: Vec<usize> = (0..chronological.len()).collect();
    match policy {
        PolicyName::FrontLoaded => {}
        PolicyName::FocusBlocked => order.sort_by(|a, b| {
            let (a, b) = (&chronological[*a], &chronological[*b]);
            b.cell_count
                .total_cmp(&a.cell_count)
                .then(a.start_ms.total_cmp(&b.start_ms))
        }),
        PolicyName::Balanced => order.sort_by(|a, b| {
            let (a, b) = (&chronological[*a], &chronological[*b]);
            a.day_load_min
                .total_cmp(&b.day_load_min)
                .then(a.start_ms.total_cmp(&b.start_ms))
        }),
    }
    let is_chronological = order
        .iter()
        .enumerate()
        .all(|(position, run)| position == *run);
    let preferred: Vec<FreeRun> = order.iter().map(|run| chronological[*run]).collect();
    let found = search_runs(context, state, task, units, bounds, preferred)?;
    if found.is_some() || is_chronological {
        return Ok(found);
    }
    search_runs(context, state, task, units, bounds, chronological)
}

/// Keeps the task's own future existing blocks that are still valid sessions
/// in the current window and state, as long as the remainder stays
/// representable. The kept blocks are added to `state` as seeded placements
/// (`retainOwnBlocks`).
fn retain_own_blocks(
    context: &Context<'_>,
    state: &mut State,
    task: usize,
    required_units: f64,
    bounds: SessionBounds,
    window_start_ms: Ms,
    window_end_ms: Ms,
) -> Result<Vec<Placement>, TimeError> {
    let mut retained = Vec::new();
    let mut retained_units = 0.0;
    for block in &context.future_existing_by_task[task] {
        let units = (block.end_ms - block.start_ms) / GRID_MS_F;
        if !js::is_integer(units)
            || units < bounds.min_units
            || units > bounds.max_units
            || block.start_ms < window_start_ms
            || block.end_ms > window_end_ms
            || retained_units + units > required_units
            || !bounds.is_representable(required_units - retained_units - units)
        {
            continue;
        }
        let Some(slot_id) = context
            .find_containing_slot(block.start_ms, block.end_ms)
            .map(|slot| slot.id)
        else {
            continue;
        };
        if !passes(context, state, block.start_ms, block.end_ms)? {
            continue;
        }
        let placement = Placement {
            task,
            duration_min: units * GRID_MINUTES_F,
            start_ms: block.start_ms,
            end_ms: block.end_ms,
            slot_id: Some(slot_id),
            local_hour: context.local_hour_of(block.start_ms, block.end_ms)?,
            seeded: true,
        };
        state.add_placement(context, placement)?;
        retained.push(placement);
        retained_units += units;
    }
    Ok(retained)
}

/// Gap-fitted split for a splittable task whose equal-size chunks do not all
/// fit (FU-69).
///
/// The search runs on a copy of the state and commits only a complete split,
/// so a failed search leaves the partial equal-chunk placement untouched.
/// With `keep_own_blocks` the task's own still-valid future blocks are kept
/// first and only the remainder is fitted (06 §7 S5, §7.1); then a full
/// re-split is tried.
#[allow(clippy::too_many_arguments)]
pub(super) fn fit_sessions_into_gaps(
    context: &Context<'_>,
    state: &mut State,
    policy: PolicyName,
    task: usize,
    remaining_min: f64,
    window_start_ms: Ms,
    window_end_ms: Ms,
    nominal: &[Placement],
    keep_own_blocks: bool,
) -> Result<Option<Vec<Placement>>, TimeError> {
    let info = context.tasks[task].task;
    if !info.splittable || remaining_min <= 0.0 || remaining_min % GRID_MINUTES_F != 0.0 {
        return Ok(None);
    }
    let bounds = SessionBounds::of(info);
    let required_units = remaining_min / GRID_MINUTES_F;
    if bounds.max_units < bounds.min_units || !bounds.is_representable(required_units) {
        return Ok(None);
    }

    let mut scratch = state.clone();
    for placement in nominal {
        scratch.remove_placement(context, placement)?;
    }

    let mut sessions: Option<Vec<Placement>> = None;
    let retained = if keep_own_blocks {
        retain_own_blocks(
            context,
            &mut scratch,
            task,
            required_units,
            bounds,
            window_start_ms,
            window_end_ms,
        )?
    } else {
        Vec::new()
    };
    if !retained.is_empty() {
        let retained_units = retained.iter().fold(0.0, |sum, placement| {
            sum + placement.duration_min / GRID_MINUTES_F
        });
        match search_gap_sessions(
            context,
            &mut scratch,
            policy,
            task,
            required_units - retained_units,
            bounds,
            window_start_ms,
            window_end_ms,
        )? {
            Some(rest) => sessions = Some(retained.iter().copied().chain(rest).collect()),
            None => {
                for placement in &retained {
                    scratch.remove_placement(context, placement)?;
                }
            }
        }
    }
    let sessions = match sessions {
        Some(sessions) => sessions,
        None => match search_gap_sessions(
            context,
            &mut scratch,
            policy,
            task,
            required_units,
            bounds,
            window_start_ms,
            window_end_ms,
        )? {
            Some(sessions) => sessions,
            None => return Ok(None),
        },
    };

    for placement in nominal {
        state.remove_placement(context, placement)?;
    }
    for placement in &sessions {
        state.add_placement(context, *placement)?;
    }
    Ok(Some(sessions))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::fixture::{at, block, day, instant, prefs, state_with, task};
    use super::*;

    fn cells(ranges: &[CellRange]) -> Vec<(usize, usize)> {
        ranges
            .iter()
            .map(|range| (range.first_cell, range.end_cell))
            .collect()
    }

    fn spans(placements: &[Placement]) -> Vec<(Ms, Ms)> {
        let mut spans: Vec<(Ms, Ms)> = placements
            .iter()
            .map(|placement| (placement.start_ms, placement.end_ms))
            .collect();
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        spans
    }

    #[test]
    fn focus_under_the_break_rule_is_stretches_separated_by_breaks() {
        // 120 minutes of focus (24 cells), then a 15-minute break (3 cells).
        let input = day(&[task("A", 60, &[])], &json!({"prefs": prefs(480, 120)}));
        let context = Context::build(&input).unwrap();
        for (free, focus) in [
            (0.0, 0.0),
            (-3.0, 0.0),
            (10.0, 10.0),
            (24.0, 24.0),
            (27.0, 24.0),
            (30.0, 27.0),
            (54.0, 48.0),
            (60.0, 54.0),
        ] {
            assert_eq!(focus_cells_with_breaks(&context, free), focus, "{free}");
        }
        // With the rule off every free cell can be focus.
        let input = day(&[task("A", 60, &[])], &json!({"prefs": prefs(480, 0)}));
        let context = Context::build(&input).unwrap();
        assert_eq!(focus_cells_with_breaks(&context, 60.0), 60.0);
    }

    #[test]
    fn free_cells_are_the_slots_minus_what_is_occupied() {
        let input = day(&[task("A", 60, &[]), task("B", 60, &[])], &json!({}));
        let context = Context::build(&input).unwrap();
        let empty = context.create_state();
        assert_eq!(
            cells(&free_cell_ranges(
                &context,
                &empty,
                at("09:00"),
                at("17:00")
            )),
            [(0, 96)]
        );
        // Blocks that touch are one occupied stretch.
        let state = state_with(
            &context,
            &[
                (0, "10:00", "11:00"),
                (1, "11:00", "11:30"),
                (0, "14:00", "15:00"),
            ],
        );
        assert_eq!(
            cells(&free_cell_ranges(
                &context,
                &state,
                at("09:00"),
                at("17:00")
            )),
            [(0, 12), (30, 60), (72, 96)]
        );
        assert_eq!(
            cells(&free_cell_ranges(
                &context,
                &state,
                at("09:30"),
                at("16:00")
            )),
            [(6, 12), (30, 60), (72, 84)]
        );
        // Only whole cells count, and an empty window has none.
        assert_eq!(
            cells(&free_cell_ranges(
                &context,
                &state,
                at("09:02"),
                at("09:58")
            )),
            [(1, 11)]
        );
        assert_eq!(
            cells(&free_cell_ranges(
                &context,
                &state,
                at("10:00"),
                at("11:30")
            )),
            Vec::new()
        );
        assert_eq!(
            cells(&free_cell_ranges(
                &context,
                &state,
                at("12:00"),
                at("12:00")
            )),
            Vec::new()
        );
    }

    #[test]
    fn a_free_run_holds_what_the_daily_cap_and_the_break_rule_leave_of_it() {
        let usable = |extra: &serde_json::Value, blocks: &[(usize, &str, &str)], min_units: f64| {
            let input = day(&[task("A", 60, &[]), task("F", 120, &[])], extra);
            let context = Context::build(&input).unwrap();
            let state = state_with(&context, blocks);
            free_runs(&context, &state, at("09:00"), at("17:00"), min_units)
                .iter()
                .map(|run| {
                    (
                        run.start_ms,
                        run.cell_count,
                        run.usable_cells,
                        run.day_load_min,
                    )
                })
                .collect::<Vec<_>>()
        };
        // An hour is planned and the day allows three: two more hours fit,
        // in a run of one hour and in a run of six.
        let hour = [(1, "10:00", "11:00")];
        assert_eq!(
            usable(&json!({"prefs": prefs(180, 480)}), &hour, 6.0),
            [
                (at("09:00"), 12.0, 12.0, 60.0),
                (at("11:00"), 72.0, 24.0, 60.0),
            ]
        );
        // A run that cannot host one minimum session is dropped ...
        assert_eq!(
            usable(&json!({"prefs": prefs(180, 480)}), &hour, 13.0),
            [(at("11:00"), 72.0, 24.0, 60.0)]
        );
        // ... and so is one whose share of the day cannot.
        assert_eq!(
            usable(&json!({"prefs": prefs(100, 480)}), &hour, 9.0),
            Vec::new()
        );

        // A two-hour block under a two-hour focus limit: a session beside it
        // must keep a break away, on either side. The 150 free minutes
        // before it hold 120 focus minutes, the 210 after it 180.
        let full = [(1, "11:30", "13:30")];
        assert_eq!(
            usable(&json!({"prefs": prefs(480, 120)}), &full, 6.0),
            [
                (at("09:00"), 30.0, 24.0, 120.0),
                (at("13:30"), 42.0, 36.0, 120.0),
            ]
        );
        // Without the block the same day is one run: 480 minutes, 24 cells
        // of focus and 3 of break at a time.
        assert_eq!(
            usable(&json!({"prefs": prefs(480, 120)}), &[], 6.0),
            [(at("09:00"), 96.0, 87.0, 0.0)]
        );
    }

    #[test]
    fn a_session_may_start_at_once_a_break_later_or_where_it_can_join_what_follows() {
        let starts = |extra: &serde_json::Value, blocks: &[(usize, &str, &str)], from: f64| {
            let input = day(&[task("A", 120, &[]), task("F", 60, &[])], extra);
            let context = Context::build(&input).unwrap();
            let state = state_with(&context, blocks);
            let runs = free_runs(&context, &state, at("09:00"), at("17:00"), 1.0);
            start_offsets(&context, &state, &runs[0], from)
        };
        let limit = |break_after: u32, break_min: u32| {
            let mut prefs = prefs(480, break_after);
            prefs["breakMin"] = json!(break_min);
            json!({"now": instant("09:00"), "prefs": prefs})
        };
        // F ends where the run begins: start at once (joining F) or a full
        // break later (cell 3).
        let after_f = json!({
            "prefs": prefs(480, 120),
            "horizon": {"start": instant("10:00"), "end": instant("17:00")},
            "now": instant("10:00"),
            "existingBlocks": [block("F", "09:00", "10:00")],
        });
        assert_eq!(starts(&after_f, &[], 0.0), [0.0, 3.0]);
        // Further into the run the break is already over.
        assert_eq!(starts(&after_f, &[], 6.0), [6.0]);

        // F (10:10–10:35) follows the run under a 90-minute limit: a session
        // that reaches F may start no earlier than 09:05 (cell 1).
        assert_eq!(
            starts(&limit(90, 30), &[(1, "10:10", "10:35")], 0.0),
            [0.0, 1.0]
        );
        // A longer limit lets a session from the first cell join F.
        assert_eq!(
            starts(&limit(240, 30), &[(1, "10:10", "10:35")], 0.0),
            [0.0]
        );
        // Nothing beside the run, or the rule off: one start.
        assert_eq!(starts(&limit(90, 30), &[], 0.0), [0.0]);
        assert_eq!(starts(&limit(0, 30), &[(1, "10:10", "10:35")], 0.0), [0.0]);
    }

    #[test]
    fn the_latest_start_with_room_counts_back_from_the_limit() {
        let input = day(&[task("A", 60, &[]), task("B", 60, &[])], &json!({}));
        let context = Context::build(&input).unwrap();
        let state = state_with(&context, &[(0, "12:00", "13:00")]);
        let ranges = free_cell_ranges(&context, &state, at("09:00"), at("17:00"));
        assert_eq!(cells(&ranges), [(0, 36), (48, 96)]);
        let latest = |limit: &str, need: f64, piece: f64, contiguous: bool| {
            latest_start_with_room(
                &context,
                &ranges,
                at("09:00"),
                at(limit),
                need,
                piece,
                contiguous,
            )
        };
        // An hour before 17:00 starts at 16:00 at the latest.
        assert_eq!(latest("17:00", 12.0, 6.0, false), Some(at("16:00")));
        // Before 13:30 only half an hour is free after the block: the other
        // half comes from before it.
        assert_eq!(latest("13:30", 12.0, 6.0, false), Some(at("11:30")));
        // In one piece the hour has to lie before the block.
        assert_eq!(latest("13:30", 12.0, 12.0, true), Some(at("11:00")));
        // A range too short for one session does not count.
        assert_eq!(latest("13:20", 12.0, 6.0, false), Some(at("11:00")));
        // More than the day holds, or a piece no range holds: no room.
        assert_eq!(latest("17:00", 85.0, 6.0, false), None);
        assert_eq!(latest("17:00", 49.0, 49.0, true), None);
        assert_eq!(latest("09:00", 1.0, 1.0, false), None);
    }

    #[test]
    fn a_predecessor_must_end_before_the_room_its_dependents_still_need() {
        // P ← S ← T, an hour each, all due at 17:00.
        let chain = [
            task("P", 60, &[]),
            task("S", 60, &["P"]),
            task("T", 60, &["S"]),
        ];
        let input = day(&chain, &json!({}));
        let context = Context::build(&input).unwrap();
        let ordered = [0, 1, 2];
        let empty = context.create_state();
        // T needs 16:00–17:00, so S must end by 16:00 and needs 15:00–16:00.
        assert_eq!(
            successor_bound(&context, &empty, &ordered, 0, 0.0),
            at("15:00")
        );
        assert_eq!(
            successor_bound(&context, &empty, &ordered, 1, 0.0),
            at("16:00")
        );
        // Nothing depends on T.
        assert_eq!(
            successor_bound(&context, &empty, &ordered, 2, 0.0),
            f64::INFINITY
        );
        // Slack keeps a break free before each dependent's room.
        let quarter = 15.0 * 60_000.0;
        assert_eq!(
            successor_bound(&context, &empty, &ordered, 0, quarter),
            at("14:30")
        );
        // A dependent that already has its blocks bounds by where it starts.
        let placed = state_with(&context, &[(1, "11:00", "12:00")]);
        assert_eq!(
            successor_bound(&context, &placed, &ordered, 0, 0.0),
            at("11:00")
        );

        // A dependent that can never be placed imposes no bound.
        let mut never = day(&chain[..2], &json!({}));
        never.tasks[1].estimate.p50_min = 600.0;
        never.tasks[1].estimate.p90_min = 600.0;
        never.tasks[1].splittable = false;
        never.tasks[1].min_session_min = 600.0;
        never.tasks[1].max_session_min = 600.0;
        let context = Context::build(&never).unwrap();
        let empty = context.create_state();
        assert_eq!(
            successor_bound(&context, &empty, &[0, 1], 0, 0.0),
            f64::INFINITY
        );
    }

    #[test]
    fn a_task_is_split_into_the_gaps_only_when_a_complete_split_exists() {
        // 09:00–17:00 with a commitment 10:55–14:10 leaves 115 + 170 minutes.
        let around = json!({"commitments": [{"start": instant("10:55"), "end": instant("14:10")}]});
        let mut input = day(&[task("A", 175, &[])], &around);
        input.tasks[0].max_session_min = 180.0;
        let context = Context::build(&input).unwrap();
        let fit = |state: &mut State, policy: PolicyName, minutes: f64| {
            fit_sessions_into_gaps(
                &context,
                state,
                policy,
                0,
                minutes,
                at("09:00"),
                at("17:00"),
                &[],
                false,
            )
            .unwrap()
        };
        // front_loaded fills the earliest gap first.
        let mut state = context.create_state();
        let sessions = fit(&mut state, PolicyName::FrontLoaded, 175.0).unwrap();
        assert_eq!(
            spans(&sessions),
            [(at("09:00"), at("10:55")), (at("14:10"), at("15:10"))]
        );
        // The split is committed to the state.
        assert_eq!(spans(&state.placements), spans(&sessions));
        // focus_blocked takes the longest gap first and leaves a valid rest.
        let mut state = context.create_state();
        let sessions = fit(&mut state, PolicyName::FocusBlocked, 175.0).unwrap();
        assert_eq!(
            spans(&sessions),
            [(at("09:00"), at("09:30")), (at("14:10"), at("16:35"))]
        );

        // No complete split: nothing is returned and the state is untouched.
        let mut state = context.create_state();
        assert!(fit(&mut state, PolicyName::FrontLoaded, 290.0).is_none());
        assert!(state.placements.is_empty());
        // Off the grid, nothing to place, or below one session.
        for minutes in [172.0, 0.0, -5.0, 25.0] {
            assert!(
                fit(&mut state, PolicyName::FrontLoaded, minutes).is_none(),
                "{minutes}"
            );
        }
        // A task that may not be split is never split.
        let mut whole = input.clone();
        whole.tasks[0].splittable = false;
        let context = Context::build(&whole).unwrap();
        let mut state = context.create_state();
        let sessions = fit_sessions_into_gaps(
            &context,
            &mut state,
            PolicyName::FrontLoaded,
            0,
            175.0,
            at("09:00"),
            at("17:00"),
            &[],
            false,
        )
        .unwrap();
        assert!(sessions.is_none());
    }
}
