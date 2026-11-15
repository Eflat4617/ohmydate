//! Available time: a port of `packages/scheduler/src/slots.ts`.
//!
//! ADR-017: the horizon is partitioned at every offset transition and then at
//! local midnights inside each constant-offset piece. Every piece belongs to
//! one local date, so rules and exceptions are projected with that piece's
//! offset and clipped to it. A date can appear in several pieces after a
//! backward transition; all of them contribute.
//!
//! Then extra exceptions are added, off exceptions removed, and commitments
//! and locked blocks cut out. Only intervals that survive horizon clipping
//! and inward 5-minute grid alignment are returned.
//!
//! The reference throws on input it cannot read; here that is the `Err`. It
//! reads lazily, and so does this port: a malformed clock in a rule whose
//! weekday never occurs in the horizon is not an error.

use crate::time::{
    DAY_MS, LocalDate, LocalDaySegment, TimeError, Zone, align_down_to_grid, align_up_to_grid,
    instant_to_utc, parse_instant, project_window_on_segment,
};
use crate::types::{ExceptionKind, ExceptionRule, ScheduleInput, Slot};

/// A half-open UTC interval `[start_ms, end_ms)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntervalMs {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Sorts, drops empty intervals and joins the ones that touch or overlap.
fn merge_intervals(intervals: &[IntervalMs]) -> Vec<IntervalMs> {
    let mut sorted = intervals.to_vec();
    sorted.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));
    let mut merged: Vec<IntervalMs> = Vec::with_capacity(sorted.len());
    for current in sorted {
        if current.end_ms <= current.start_ms {
            continue;
        }
        match merged.last_mut() {
            Some(last) if current.start_ms <= last.end_ms => {
                last.end_ms = last.end_ms.max(current.end_ms);
            }
            _ => merged.push(current),
        }
    }
    merged
}

/// `bases` minus `cuts`, merged.
fn subtract_intervals(bases: &[IntervalMs], cuts: &[IntervalMs]) -> Vec<IntervalMs> {
    let merged_cuts = merge_intervals(cuts);
    let merged_bases = merge_intervals(bases);
    if merged_cuts.is_empty() {
        return merged_bases;
    }
    let mut result = Vec::new();
    for base in merged_bases {
        let mut cursor = base.start_ms;
        for cut in &merged_cuts {
            if cut.end_ms <= cursor || cut.start_ms >= base.end_ms {
                continue;
            }
            if cut.start_ms > cursor {
                result.push(IntervalMs {
                    start_ms: cursor,
                    end_ms: cut.start_ms.min(base.end_ms),
                });
            }
            cursor = cursor.max(cut.end_ms);
            if cursor >= base.end_ms {
                break;
            }
        }
        if cursor < base.end_ms {
            result.push(IntervalMs {
                start_ms: cursor,
                end_ms: base.end_ms,
            });
        }
    }
    result
}

fn clip_intervals(intervals: &[IntervalMs], start_ms: i64, end_ms: i64) -> Vec<IntervalMs> {
    let clipped: Vec<IntervalMs> = intervals
        .iter()
        .map(|interval| IntervalMs {
            start_ms: start_ms.max(interval.start_ms),
            end_ms: end_ms.min(interval.end_ms),
        })
        .filter(|interval| interval.end_ms > interval.start_ms)
        .collect();
    merge_intervals(&clipped)
}

fn align_intervals(intervals: &[IntervalMs]) -> Vec<IntervalMs> {
    let aligned: Vec<IntervalMs> = intervals
        .iter()
        .map(|interval| IntervalMs {
            start_ms: align_up_to_grid(interval.start_ms),
            end_ms: align_down_to_grid(interval.end_ms),
        })
        .filter(|interval| interval.end_ms > interval.start_ms)
        .collect();
    merge_intervals(&aligned)
}

/// The non-empty `[start, end)` of each pair of instants.
fn cut_intervals_of<'a>(
    spans: impl Iterator<Item = (&'a str, &'a str)>,
) -> Result<Vec<IntervalMs>, TimeError> {
    let mut cuts = Vec::new();
    for (start, end) in spans {
        let start_ms = parse_instant(start)?;
        let end_ms = parse_instant(end)?;
        if end_ms > start_ms {
            cuts.push(IntervalMs { start_ms, end_ms });
        }
    }
    Ok(cuts)
}

fn has_time_range(exception: &ExceptionRule) -> bool {
    exception.start_local.is_some() || exception.end_local.is_some()
}

/// The part of a segment an exception covers: the whole local date without a
/// time range, the projected window with both ends, nothing with only one.
fn interval_for_exception(
    segment: &LocalDaySegment,
    exception: &ExceptionRule,
) -> Result<Option<IntervalMs>, TimeError> {
    match (&exception.start_local, &exception.end_local) {
        (None, None) => {
            let start_ms = segment.start_ms.max(segment.local_midnight_ms);
            let end_ms = segment.end_ms.min(segment.local_midnight_ms + DAY_MS);
            Ok((end_ms > start_ms).then_some(IntervalMs { start_ms, end_ms }))
        }
        (Some(start_local), Some(end_local)) => {
            Ok(project_window_on_segment(segment, start_local, end_local)?
                .map(|(start_ms, end_ms)| IntervalMs { start_ms, end_ms }))
        }
        _ => Ok(None),
    }
}

/// Merged availability of the horizon as epoch-millisecond intervals on the
/// 5-minute grid, in time order.
pub fn available_intervals(input: &ScheduleInput) -> Result<Vec<IntervalMs>, TimeError> {
    let horizon_start_ms = parse_instant(&input.horizon.start)?;
    let horizon_end_ms = parse_instant(&input.horizon.end)?;
    if horizon_end_ms <= horizon_start_ms {
        return Ok(Vec::new());
    }

    let zone = Zone::get(&input.time_zone)?;
    let segments = zone.partition(horizon_start_ms, horizon_end_ms)?;
    // The reference compares date strings; an exception whose date is not
    // spelled the way dates are printed matches no day.
    let exception_dates: Vec<Option<LocalDate>> = input
        .exceptions
        .iter()
        .map(|exception| LocalDate::from_printed(&exception.date))
        .collect();

    let mut windows: Vec<IntervalMs> = Vec::new();
    for segment in &segments {
        let exceptions: Vec<&ExceptionRule> = input
            .exceptions
            .iter()
            .zip(&exception_dates)
            .filter(|(_, date)| **date == Some(segment.date))
            .map(|(exception, _)| exception)
            .collect();
        if exceptions
            .iter()
            .any(|exception| exception.kind == ExceptionKind::Off && !has_time_range(exception))
        {
            continue;
        }

        let mut day_windows: Vec<IntervalMs> = Vec::new();
        for rule in &input.availability {
            if rule.weekday != f64::from(segment.weekday) {
                continue;
            }
            if let Some((start_ms, end_ms)) =
                project_window_on_segment(segment, &rule.start_local, &rule.end_local)?
            {
                day_windows.push(IntervalMs { start_ms, end_ms });
            }
        }
        for exception in &exceptions {
            if exception.kind == ExceptionKind::Extra {
                day_windows.extend(interval_for_exception(segment, exception)?);
            }
        }
        let mut off_cuts: Vec<IntervalMs> = Vec::new();
        for exception in &exceptions {
            if exception.kind == ExceptionKind::Off {
                off_cuts.extend(interval_for_exception(segment, exception)?);
            }
        }
        windows.extend(subtract_intervals(&day_windows, &off_cuts));
    }

    let mut blocked = cut_intervals_of(
        input
            .commitments
            .iter()
            .map(|commitment| (commitment.start.as_str(), commitment.end.as_str())),
    )?;
    blocked.extend(cut_intervals_of(
        input
            .locked_blocks
            .iter()
            .map(|block| (block.start.as_str(), block.end.as_str())),
    )?);

    let available = subtract_intervals(&windows, &blocked);
    let clipped = clip_intervals(&available, horizon_start_ms, horizon_end_ms);
    Ok(align_intervals(&clipped))
}

/// Merged UTC availability of the horizon (`computeAvailableSlots`).
pub fn compute_available_slots(input: &ScheduleInput) -> Result<Vec<Slot>, TimeError> {
    available_intervals(input)?
        .into_iter()
        .map(|interval| {
            Ok(Slot {
                start: instant_to_utc(interval.start_ms)?,
                end: instant_to_utc(interval.end_ms)?,
            })
        })
        .collect()
}

fn slot_minutes(slot: &Slot) -> Result<f64, TimeError> {
    // Millisecond counts are far below 2^53: the conversion is exact.
    #[allow(clippy::cast_precision_loss)]
    let length_ms = (parse_instant(&slot.end)? - parse_instant(&slot.start)?) as f64;
    Ok(length_ms / 60_000.0)
}

/// Total length of the slots in minutes (`slotTotalMin`).
pub fn slot_total_min(slots: &[Slot]) -> Result<f64, TimeError> {
    let mut total = 0.0;
    for slot in slots {
        total += slot_minutes(slot)?;
    }
    Ok(total)
}

/// Length of the longest slot in minutes (`maxContiguousMin`).
pub fn max_contiguous_min(slots: &[Slot]) -> Result<f64, TimeError> {
    let mut maximum = 0.0;
    for slot in slots {
        maximum = crate::js::max(maximum, slot_minutes(slot)?);
    }
    Ok(maximum)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intervals(pairs: &[(i64, i64)]) -> Vec<IntervalMs> {
        pairs
            .iter()
            .map(|&(start_ms, end_ms)| IntervalMs { start_ms, end_ms })
            .collect()
    }

    #[test]
    fn merging_sorts_joins_touching_intervals_and_drops_empty_ones() {
        assert_eq!(
            merge_intervals(&intervals(&[
                (30, 40),
                (0, 10),
                (10, 20),
                (5, 8),
                (50, 50),
                (60, 55)
            ])),
            intervals(&[(0, 20), (30, 40)])
        );
        assert_eq!(merge_intervals(&[]), Vec::new());
    }

    #[test]
    fn subtracting_splits_trims_and_removes_bases() {
        let bases = intervals(&[(0, 100), (200, 300)]);
        assert_eq!(
            subtract_intervals(&bases, &intervals(&[(10, 20), (90, 210), (250, 260)])),
            intervals(&[(0, 10), (20, 90), (210, 250), (260, 300)])
        );
        // A cut that covers a base removes it; cuts outside change nothing.
        assert_eq!(
            subtract_intervals(&bases, &intervals(&[(0, 100), (400, 500)])),
            intervals(&[(200, 300)])
        );
        assert_eq!(subtract_intervals(&bases, &[]), bases);
        assert_eq!(subtract_intervals(&[], &intervals(&[(0, 10)])), Vec::new());
        // Touching is not overlapping.
        assert_eq!(
            subtract_intervals(&intervals(&[(10, 20)]), &intervals(&[(0, 10), (20, 30)])),
            intervals(&[(10, 20)])
        );
    }

    #[test]
    fn clipping_and_alignment_shrink_inwards() {
        assert_eq!(
            clip_intervals(&intervals(&[(0, 50), (60, 200), (300, 400)]), 40, 100),
            intervals(&[(40, 50), (60, 100)])
        );
        let grid = crate::time::GRID_MS;
        assert_eq!(
            align_intervals(&intervals(&[
                (1, 2 * grid + 1),
                (3 * grid + 1, 4 * grid - 1),
                (5 * grid, 6 * grid)
            ])),
            intervals(&[(grid, 2 * grid), (5 * grid, 6 * grid)])
        );
    }
}
