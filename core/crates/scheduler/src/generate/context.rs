//! Everything about one input that every policy and every attempt reads
//! (`buildContext`): tasks by index, slots as grid cells with their local
//! dates, locked and history intervals, and the zone's offsets in memory.

use std::collections::BTreeMap;

use super::state::{Interval, Loads, MINUTE_MS_F, Ms, State, insert_interval};
use crate::canonical::compare_utf16;
use crate::js;
use crate::requirements::task_required_minutes;
use crate::slots::available_intervals;
use crate::time::{GRID_MINUTES, LocalDate, TimeError, Zone, ZoneWindow, parse_instant};
use crate::types::{Block, RiskLevel, ScheduleInput, Task, WindowKind};

pub(super) const GRID_MINUTES_F: f64 = GRID_MINUTES as f64;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Saturating addition for minute totals (`boundedMinuteAdd`): non-finite
/// and non-positive values are skipped, and the sum stays finite.
pub(super) fn bounded_minute_add(total: f64, value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return total;
    }
    if !total.is_finite() || total > MAX_SAFE_INTEGER - value {
        return MAX_SAFE_INTEGER;
    }
    total + value
}

// Epoch milliseconds stay far below 2^53.
#[allow(clippy::cast_precision_loss)]
pub(super) fn ms(value: i64) -> Ms {
    value as f64
}

/// A finite whole number of milliseconds back as an integer.
#[allow(clippy::cast_possible_truncation)]
pub(super) fn whole(value: Ms) -> i64 {
    value as i64
}

/// One task with what the generator needs of it, read once.
#[derive(Debug, Clone)]
pub(super) struct TaskInfo<'a> {
    pub task: &'a Task,
    pub required_min: f64,
    /// `earliestStartAt`, when the task has one.
    pub earliest_ms: Option<Ms>,
    /// `dueAt`, when the task has one.
    pub due_ms: Option<Ms>,
    pub buffer_ms: Ms,
    /// Indices of the tasks it depends on, in the order written (unknown
    /// ids cannot occur: the input was validated).
    pub depends_on: Vec<usize>,
    /// Indices of the tasks that depend on it, once per written dependency.
    pub dependents: Vec<usize>,
}

impl TaskInfo<'_> {
    pub fn prefers(&self, hour: i64) -> bool {
        self.task
            .preferred_windows
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|window| match window {
                WindowKind::Morning => (6..12).contains(&hour),
                WindowKind::Afternoon => (12..18).contains(&hour),
                WindowKind::Evening => (18..24).contains(&hour),
            })
    }

    pub fn has_preferred_windows(&self) -> bool {
        self.task
            .preferred_windows
            .as_ref()
            .is_some_and(|windows| !windows.is_empty())
    }
}

/// One available slot as 5-minute cells.
#[derive(Debug, Clone)]
pub(super) struct SlotInfo {
    pub id: usize,
    pub start_ms: Ms,
    pub end_ms: Ms,
    pub cell_starts: Vec<Ms>,
    /// The local date each cell starts on.
    pub cell_dates: Vec<LocalDate>,
}

/// A block as the key the reference compares blocks by: task, start, end.
pub(super) type BlockKey = (usize, i64, i64);

pub(super) fn block_key(task: usize, start_ms: Ms, end_ms: Ms) -> BlockKey {
    (task, whole(start_ms), whole(end_ms))
}

pub(super) struct Context<'a> {
    pub input: &'a ScheduleInput,
    pub zone: Zone,
    pub window: ZoneWindow,
    pub tasks: Vec<TaskInfo<'a>>,
    pub task_index: BTreeMap<&'a str, usize>,
    pub slots_by_start: Vec<SlotInfo>,
    /// Slot ids, longest slot first, earlier first among equals.
    pub slots_by_length: Vec<usize>,
    /// Approved locked blocks; they are audited normally and credited.
    pub locked_intervals: Vec<Interval>,
    pub locked_by_task: Vec<Vec<Interval>>,
    /// Past or in-progress existing blocks: they only occupy time (06 §7.1).
    pub history_blocks: Vec<Block>,
    pub history_by_task: Vec<Vec<Interval>>,
    /// Future (start >= now), non-locked existing blocks per task in start
    /// order: the blocks a replan may keep or move.
    pub future_existing_by_task: Vec<Vec<Interval>>,
    /// Every existing block, for the retain-existing objective term.
    pub existing_intervals: Vec<Interval>,
    /// Keys of the locked blocks, sorted.
    pub locked_keys: Vec<BlockKey>,
    pub break_after_ms: Ms,
    pub break_ms: Ms,
    pub max_daily_focus_min: f64,
    pub horizon_start_ms: Ms,
    pub horizon_end_ms: Ms,
    pub now_ms: Ms,
    pub risk_level: RiskLevel,
    /// False when the unplaced work certainly exceeds the placeable time
    /// (grid cells from max(horizon.start, now), capped per local date by
    /// the daily focus cap). No plan can be feasible then, so the repair
    /// pass is skipped and the plain partial plan is reported.
    pub repair_plausible: bool,
    /// Locked and history intervals with their daily loads: the state every
    /// attempt starts from (`createState`).
    base_state: State,
}

/// The non-empty intervals of blocks, with their task's index.
fn to_intervals(
    blocks: &[Block],
    task_index: &BTreeMap<&str, usize>,
) -> Result<Vec<Interval>, TimeError> {
    let mut intervals = Vec::with_capacity(blocks.len());
    for block in blocks {
        let start_ms = parse_instant(&block.start)?;
        let end_ms = parse_instant(&block.end)?;
        // A block of a task the input does not have cannot reach here: the
        // input validator rejects it.
        let Some(&task) = task_index.get(block.task_id.as_str()) else {
            continue;
        };
        if end_ms > start_ms {
            intervals.push(Interval {
                start_ms: ms(start_ms),
                end_ms: ms(end_ms),
                task,
            });
        }
    }
    Ok(intervals)
}

fn group_by_task(intervals: &[Interval], task_count: usize) -> Vec<Vec<Interval>> {
    let mut grouped = vec![Vec::new(); task_count];
    for interval in intervals {
        grouped[interval.task].push(*interval);
    }
    grouped
}

pub(super) fn minutes_of(intervals: &[Interval]) -> f64 {
    intervals
        .iter()
        .fold(0.0, |sum, interval| sum + interval.minutes())
}

impl<'a> Context<'a> {
    /// Reads a validated input.
    pub fn build(input: &'a ScheduleInput) -> Result<Self, TimeError> {
        let horizon_start = parse_instant(&input.horizon.start)?;
        let horizon_end = parse_instant(&input.horizon.end)?;
        let now = parse_instant(&input.now)?;
        let zone = Zone::get(&input.time_zone)?;

        let mut task_index: BTreeMap<&str, usize> = BTreeMap::new();
        for (index, task) in input.tasks.iter().enumerate() {
            task_index.insert(task.id.as_str(), index);
        }
        let task_count = input.tasks.len();

        let locked_intervals = to_intervals(&input.locked_blocks, &task_index)?;
        let mut locked_keys: Vec<BlockKey> = locked_intervals
            .iter()
            .map(|interval| block_key(interval.task, interval.start_ms, interval.end_ms))
            .collect();
        locked_keys.sort_by(Ord::cmp);
        locked_keys.dedup();
        let is_locked = |interval: &Interval| {
            locked_keys
                .binary_search(&block_key(
                    interval.task,
                    interval.start_ms,
                    interval.end_ms,
                ))
                .is_ok()
        };

        let existing_intervals = to_intervals(input.existing(), &task_index)?;
        // History: existing blocks that started before now and are not also
        // locked. `to_intervals` keeps the order and drops the same empty
        // blocks the reference's filter drops.
        let mut history_blocks = Vec::new();
        for block in input.existing() {
            let start_ms = parse_instant(&block.start)?;
            let end_ms = parse_instant(&block.end)?;
            let Some(&task) = task_index.get(block.task_id.as_str()) else {
                continue;
            };
            if start_ms >= now || end_ms <= start_ms {
                continue;
            }
            if locked_keys
                .binary_search(&(task, start_ms, end_ms))
                .is_err()
            {
                history_blocks.push(block.clone());
            }
        }
        let history_intervals = to_intervals(&history_blocks, &task_index)?;
        let mut future_existing: Vec<Interval> = existing_intervals
            .iter()
            .filter(|interval| interval.start_ms >= ms(now) && !is_locked(interval))
            .copied()
            .collect();
        future_existing.sort_by(|a, b| {
            a.start_ms
                .total_cmp(&b.start_ms)
                .then(a.end_ms.total_cmp(&b.end_ms))
        });

        // The zone's offsets over everything the generator can ask about:
        // the horizon and every block.
        let extent = locked_intervals.iter().chain(&existing_intervals).fold(
            (horizon_start, horizon_end),
            |(low, high), interval| {
                (
                    low.min(whole(interval.start_ms)),
                    high.max(whole(interval.end_ms)),
                )
            },
        );
        let window = zone.window(extent.0, extent.1)?;

        let placement_start = horizon_start.max(now);
        // Per local date in first-seen order: grid cells a new block may use.
        let mut placeable_cells: Vec<(LocalDate, f64)> = Vec::new();
        let mut slots_by_start: Vec<SlotInfo> = Vec::new();
        for slot in available_intervals(input)? {
            let mut cell_starts = Vec::new();
            let mut cell_dates = Vec::new();
            let mut cursor = slot.start_ms;
            while cursor + crate::time::GRID_MS <= slot.end_ms {
                let date = window.local_date_at(cursor)?;
                cell_starts.push(ms(cursor));
                cell_dates.push(date);
                if cursor >= placement_start {
                    match placeable_cells.iter_mut().find(|(known, _)| *known == date) {
                        Some(entry) => entry.1 += 1.0,
                        None => placeable_cells.push((date, 1.0)),
                    }
                }
                cursor += crate::time::GRID_MS;
            }
            if !cell_starts.is_empty() {
                slots_by_start.push(SlotInfo {
                    id: slots_by_start.len(),
                    start_ms: ms(slot.start_ms),
                    end_ms: ms(slot.end_ms),
                    cell_starts,
                    cell_dates,
                });
            }
        }
        let mut slots_by_length: Vec<usize> = (0..slots_by_start.len()).collect();
        slots_by_length.sort_by(|a, b| {
            let (a, b) = (&slots_by_start[*a], &slots_by_start[*b]);
            (b.end_ms - b.start_ms)
                .total_cmp(&(a.end_ms - a.start_ms))
                .then(a.start_ms.total_cmp(&b.start_ms))
        });

        let locked_by_task = group_by_task(&locked_intervals, task_count);
        let risk_level = input.prefs.risk_level;
        let mut tasks: Vec<TaskInfo<'a>> = Vec::with_capacity(task_count);
        let mut unplaced_min = 0.0;
        for (index, task) in input.tasks.iter().enumerate() {
            let required_min = task_required_minutes(task, risk_level);
            unplaced_min = bounded_minute_add(
                unplaced_min,
                required_min - minutes_of(&locked_by_task[index]),
            );
            tasks.push(TaskInfo {
                task,
                required_min,
                earliest_ms: match &task.earliest_start_at {
                    Some(text) => Some(ms(parse_instant(text)?)),
                    None => None,
                },
                due_ms: match &task.due_at {
                    Some(text) => Some(ms(parse_instant(text)?)),
                    None => None,
                },
                buffer_ms: task.buffer_before_due_min.unwrap_or(0.0) * MINUTE_MS_F,
                depends_on: task
                    .depends_on
                    .iter()
                    .filter_map(|id| task_index.get(id.as_str()).copied())
                    .collect(),
                dependents: Vec::new(),
            });
        }
        for index in 0..task_count {
            for dependency in tasks[index].depends_on.clone() {
                tasks[dependency].dependents.push(index);
            }
        }

        // One grid step of slack per date: a cell is dated by its start and
        // may reach under one step into the next local date.
        let max_daily_focus_min = input.prefs.max_daily_focus_min;
        let placeable_min = placeable_cells.iter().fold(0.0, |sum, (_, cells)| {
            sum + js::min(
                (cells + 1.0) * GRID_MINUTES_F,
                max_daily_focus_min + GRID_MINUTES_F,
            )
        });

        let mut context = Self {
            input,
            zone,
            window,
            tasks,
            task_index,
            slots_by_start,
            slots_by_length,
            locked_by_task,
            history_by_task: group_by_task(&history_intervals, task_count),
            future_existing_by_task: group_by_task(&future_existing, task_count),
            existing_intervals,
            locked_keys,
            history_blocks,
            break_after_ms: input.prefs.break_after_min * MINUTE_MS_F,
            break_ms: input.prefs.break_min * MINUTE_MS_F,
            max_daily_focus_min,
            horizon_start_ms: ms(horizon_start),
            horizon_end_ms: ms(horizon_end),
            now_ms: ms(now),
            risk_level,
            repair_plausible: unplaced_min <= placeable_min,
            base_state: State::default(),
            locked_intervals,
        };
        let mut base_state = State::default();
        for interval in context.locked_intervals.iter().chain(&history_intervals) {
            insert_interval(&mut base_state.intervals, *interval);
            base_state
                .daily_load
                .add(&context.block_daily_loads(interval.start_ms, interval.end_ms)?);
        }
        context.base_state = base_state;
        Ok(context)
    }

    /// A state holding the locked and history intervals (`createState`).
    pub fn create_state(&self) -> State {
        self.base_state.clone()
    }

    /// Minutes per local date of `[start_ms, end_ms)` (`blockDailyLoads`).
    pub fn block_daily_loads(&self, start_ms: Ms, end_ms: Ms) -> Result<Loads, TimeError> {
        let mut loads = Loads::new();
        self.window
            .for_each_segment(whole(start_ms), whole(end_ms), |segment| {
                loads.add(
                    segment.date,
                    ms(segment.end_ms - segment.start_ms) / MINUTE_MS_F,
                );
            })?;
        Ok(loads)
    }

    /// The local date at an instant.
    pub fn local_date_at(&self, epoch_ms: Ms) -> Result<LocalDate, TimeError> {
        self.window.local_date_at(whole(epoch_ms))
    }

    /// Local wall-clock hour at the midpoint of a block (`localHourOf`).
    pub fn local_hour_of(&self, start_ms: Ms, end_ms: Ms) -> Result<i64, TimeError> {
        self.window
            .local_hour_at(whole(((start_ms + end_ms) / 2.0).floor()))
    }

    /// The slot that holds `[start_ms, end_ms)` (`findContainingSlot`).
    pub fn find_containing_slot(&self, start_ms: Ms, end_ms: Ms) -> Option<&SlotInfo> {
        for slot in &self.slots_by_start {
            if slot.start_ms > start_ms {
                break;
            }
            if start_ms >= slot.start_ms && end_ms <= slot.end_ms {
                return Some(slot);
            }
        }
        None
    }

    pub fn is_locked_key(&self, task: usize, start_ms: Ms, end_ms: Ms) -> bool {
        self.locked_keys
            .binary_search(&block_key(task, start_ms, end_ms))
            .is_ok()
    }

    /// The reference's order of task ids (`compareText`).
    pub fn compare_task_ids(&self, a: usize, b: usize) -> std::cmp::Ordering {
        compare_utf16(&self.tasks[a].task.id, &self.tasks[b].task.id)
    }
}
