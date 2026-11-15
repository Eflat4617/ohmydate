//! The plan being built: placements, occupied intervals and daily loads,
//! with the H1/H6 checks a new block has to pass.

use super::context::Context;
use crate::time::{GRID_MS, LocalDate, MINUTE_MS, TimeError};

/// Epoch milliseconds as the float the reference computes with: instants
/// are whole numbers, and `±∞` marks "no bound" and "never".
pub(super) type Ms = f64;

pub(super) const GRID_MS_F: f64 = GRID_MS as f64;
pub(super) const MINUTE_MS_F: f64 = MINUTE_MS as f64;

/// An occupied interval of one task.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Interval {
    pub start_ms: Ms,
    pub end_ms: Ms,
    /// Index of the task in the input.
    pub task: usize,
}

impl Interval {
    pub fn minutes(&self) -> f64 {
        (self.end_ms - self.start_ms) / MINUTE_MS_F
    }
}

/// One movable block of the plan.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Placement {
    pub task: usize,
    pub duration_min: f64,
    pub start_ms: Ms,
    pub end_ms: Ms,
    /// The slot that holds the block; `None` for a frozen block that no
    /// longer lies inside one.
    pub slot_id: Option<usize>,
    /// Local wall-clock hour at the midpoint (for preferred windows).
    pub local_hour: i64,
    /// True when the placement is a still-valid existing block.
    pub seeded: bool,
}

impl Placement {
    pub fn same_block(&self, other: &Placement) -> bool {
        self.task == other.task && self.start_ms == other.start_ms && self.end_ms == other.end_ms
    }
}

/// Minutes per local date of one block, in the order the dates are met
/// (`blockDailyLoads`). Almost always one or two dates, so they are kept
/// inline.
#[derive(Debug, Clone)]
pub(super) struct Loads {
    inline: [(LocalDate, f64); Self::INLINE],
    len: usize,
    spill: Vec<(LocalDate, f64)>,
}

impl Loads {
    const INLINE: usize = 3;

    pub fn new() -> Self {
        Self {
            inline: [(LocalDate::from_days(0), 0.0); Self::INLINE],
            len: 0,
            spill: Vec::new(),
        }
    }

    /// One date with its minutes.
    pub fn single(date: LocalDate, minutes: f64) -> Self {
        let mut loads = Self::new();
        loads.add(date, minutes);
        loads
    }

    pub fn add(&mut self, date: LocalDate, minutes: f64) {
        if let Some(entry) = self.inline[..self.len]
            .iter_mut()
            .chain(self.spill.iter_mut())
            .find(|(known, _)| *known == date)
        {
            entry.1 += minutes;
        } else if self.len < Self::INLINE {
            self.inline[self.len] = (date, minutes);
            self.len += 1;
        } else {
            self.spill.push((date, minutes));
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (LocalDate, f64)> + '_ {
        self.inline[..self.len]
            .iter()
            .chain(self.spill.iter())
            .copied()
    }

    pub fn get(&self, date: LocalDate) -> Option<f64> {
        self.iter()
            .find(|(known, _)| *known == date)
            .map(|(_, minutes)| minutes)
    }
}

/// Focus minutes per local date with the iteration order of a JavaScript
/// `Map`: insertion order, a deleted date re-enters at the end.
#[derive(Debug, Clone, Default)]
pub(super) struct DailyLoad {
    entries: Vec<(LocalDate, f64)>,
}

impl DailyLoad {
    pub fn get(&self, date: LocalDate) -> Option<f64> {
        self.entries
            .iter()
            .find(|(known, _)| *known == date)
            .map(|(_, minutes)| *minutes)
    }

    pub fn contains(&self, date: LocalDate) -> bool {
        self.entries.iter().any(|(known, _)| *known == date)
    }

    pub fn iter(&self) -> impl Iterator<Item = (LocalDate, f64)> + '_ {
        self.entries.iter().copied()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `addLoads`: adds `sign * minutes` per date; a date whose load returns
    /// to zero is removed.
    fn apply(&mut self, loads: &Loads, sign: f64) {
        for (date, minutes) in loads.iter() {
            let position = self.entries.iter().position(|(known, _)| *known == date);
            let next = position.map_or(0.0, |index| self.entries[index].1) + sign * minutes;
            match position {
                Some(index) if next.abs() < 1e-9 => {
                    self.entries.remove(index);
                }
                Some(index) => self.entries[index].1 = next,
                None if next.abs() < 1e-9 => {}
                None => self.entries.push((date, next)),
            }
        }
    }

    pub fn add(&mut self, loads: &Loads) {
        self.apply(loads, 1.0);
    }

    pub fn subtract(&mut self, loads: &Loads) {
        self.apply(loads, -1.0);
    }
}

/// The plan under construction.
#[derive(Debug, Clone, Default)]
pub(super) struct State {
    pub placements: Vec<Placement>,
    /// Locked, history and placed intervals, sorted by start then end.
    pub intervals: Vec<Interval>,
    pub daily_load: DailyLoad,
}

/// Inserts after every interval that starts earlier, or starts at the same
/// instant and does not end later.
pub(super) fn insert_interval(intervals: &mut Vec<Interval>, interval: Interval) {
    let position = intervals.partition_point(|current| {
        current.start_ms < interval.start_ms
            || (current.start_ms == interval.start_ms && current.end_ms <= interval.end_ms)
    });
    intervals.insert(position, interval);
}

/// Whether `[start_ms, end_ms)` overlaps an occupied interval.
pub(super) fn overlaps_any(intervals: &[Interval], start_ms: Ms, end_ms: Ms) -> bool {
    for interval in intervals {
        if interval.start_ms >= end_ms {
            break;
        }
        if interval.end_ms > start_ms {
            return true;
        }
    }
    false
}

/// Whether a block at `[start_ms, end_ms)` would make a focus run longer
/// than `breakAfterMin` (H6).
///
/// Occupied intervals may nest or overlap (legitimate history, 06 §7.1), so
/// a backward scan cannot stop at the first gap: an earlier interval can
/// reach past the nearest one. The run grows until no interval joins within
/// `breakMin` on either side.
pub(super) fn h6_would_break(
    context: &Context<'_>,
    intervals: &[Interval],
    start_ms: Ms,
    end_ms: Ms,
) -> bool {
    if context.break_after_ms <= 0.0 {
        return false;
    }
    let mut run_start = start_ms;
    let mut run_end = end_ms;
    let mut changed = true;
    while changed {
        changed = false;
        for interval in intervals {
            let joins = if interval.end_ms <= run_start {
                run_start - interval.end_ms < context.break_ms
            } else if interval.start_ms >= run_end {
                interval.start_ms - run_end < context.break_ms
            } else {
                interval.start_ms < run_end && interval.end_ms > run_start
            };
            if !joins {
                continue;
            }
            let next_start = run_start.min(interval.start_ms);
            let next_end = run_end.max(interval.end_ms);
            if next_start != run_start || next_end != run_end {
                run_start = next_start;
                run_end = next_end;
                changed = true;
            }
        }
    }
    run_end - run_start > context.break_after_ms
}

/// Whether a new block at `[start_ms, end_ms)` keeps H1, H6 and the daily
/// focus cap (`passes`).
pub(super) fn passes(
    context: &Context<'_>,
    state: &State,
    start_ms: Ms,
    end_ms: Ms,
) -> Result<bool, TimeError> {
    if overlaps_any(&state.intervals, start_ms, end_ms) {
        return Ok(false);
    }
    if h6_would_break(context, &state.intervals, start_ms, end_ms) {
        return Ok(false);
    }
    let loads = context.block_daily_loads(start_ms, end_ms)?;
    for (date, minutes) in loads.iter() {
        if state.daily_load.get(date).unwrap_or(0.0) + minutes > context.max_daily_focus_min {
            return Ok(false);
        }
    }
    Ok(true)
}

impl State {
    pub fn add_placement(
        &mut self,
        context: &Context<'_>,
        placement: Placement,
    ) -> Result<(), TimeError> {
        self.placements.push(placement);
        insert_interval(
            &mut self.intervals,
            Interval {
                start_ms: placement.start_ms,
                end_ms: placement.end_ms,
                task: placement.task,
            },
        );
        self.daily_load
            .add(&context.block_daily_loads(placement.start_ms, placement.end_ms)?);
        Ok(())
    }

    /// Removes the first placement with the block of `placement`; nothing
    /// happens when there is none.
    pub fn remove_placement(
        &mut self,
        context: &Context<'_>,
        placement: &Placement,
    ) -> Result<(), TimeError> {
        let Some(index) = self
            .placements
            .iter()
            .position(|candidate| candidate.same_block(placement))
        else {
            return Ok(());
        };
        self.placements.remove(index);
        if let Some(index) = self.intervals.iter().position(|interval| {
            interval.task == placement.task
                && interval.start_ms == placement.start_ms
                && interval.end_ms == placement.end_ms
        }) {
            self.intervals.remove(index);
        }
        self.daily_load
            .subtract(&context.block_daily_loads(placement.start_ms, placement.end_ms)?);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(number: i64) -> LocalDate {
        LocalDate::from_days(number)
    }

    #[test]
    fn daily_loads_iterate_like_a_javascript_map() {
        let mut load = DailyLoad::default();
        load.add(&Loads::single(day(3), 60.0));
        load.add(&Loads::single(day(1), 30.0));
        load.add(&Loads::single(day(3), 15.0));
        // Updating a date keeps its place.
        assert_eq!(
            load.iter().collect::<Vec<_>>(),
            [(day(3), 75.0), (day(1), 30.0)]
        );
        // A date whose load returns to zero leaves, and re-enters at the end.
        load.subtract(&Loads::single(day(3), 75.0));
        assert_eq!(load.iter().collect::<Vec<_>>(), [(day(1), 30.0)]);
        assert!(!load.contains(day(3)));
        load.add(&Loads::single(day(3), 5.0));
        assert_eq!(
            load.iter().collect::<Vec<_>>(),
            [(day(1), 30.0), (day(3), 5.0)]
        );
        assert_eq!(load.get(day(1)), Some(30.0));
        assert_eq!(load.get(day(2)), None);
        assert_eq!(load.len(), 2);
        // Adding nothing to an absent date does not create it.
        load.add(&Loads::single(day(9), 0.0));
        assert_eq!(load.len(), 2);
    }

    #[test]
    fn block_loads_add_up_per_date_in_first_seen_order() {
        let mut loads = Loads::new();
        for (date, minutes) in [
            (5, 10.0),
            (4, 1.0),
            (5, 20.0),
            (6, 3.0),
            (7, 4.0),
            (4, 2.0),
            (8, 5.0),
        ] {
            loads.add(day(date), minutes);
        }
        assert_eq!(
            loads.iter().collect::<Vec<_>>(),
            [
                (day(5), 30.0),
                (day(4), 3.0),
                (day(6), 3.0),
                (day(7), 4.0),
                (day(8), 5.0)
            ]
        );
        assert_eq!(loads.get(day(7)), Some(4.0));
        assert_eq!(loads.get(day(9)), None);
    }

    #[test]
    fn intervals_stay_sorted_and_equal_starts_keep_insertion_order() {
        let mut intervals = Vec::new();
        let interval = |start_ms: f64, end_ms: f64, task: usize| Interval {
            start_ms,
            end_ms,
            task,
        };
        for entry in [
            interval(30.0, 40.0, 0),
            interval(10.0, 20.0, 1),
            interval(10.0, 15.0, 2),
            interval(10.0, 20.0, 3),
            interval(5.0, 50.0, 4),
        ] {
            insert_interval(&mut intervals, entry);
        }
        let order: Vec<usize> = intervals.iter().map(|interval| interval.task).collect();
        assert_eq!(order, [4, 2, 1, 3, 0]);
        assert!(overlaps_any(&intervals, 45.0, 60.0));
        assert!(!overlaps_any(&intervals, 50.0, 60.0));
        assert!(!overlaps_any(&intervals, 0.0, 5.0));
        assert!(!overlaps_any(&[], 0.0, 5.0));
    }
}
