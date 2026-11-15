//! The independent one-minute oracle of the reference tests
//! (`packages/scheduler/test/minuteOracle.ts`).
//!
//! It classifies one UTC minute at a time by converting it to local civil
//! time with `jiff` and testing raw rule membership. It shares no splitting
//! or projection logic with the crate under test.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use ohmydate_scheduler::types::{Block, ExceptionKind, ScheduleInput, Slot};

const MINUTE_MS: i64 = 60 * 1000;

struct LocalMinute {
    date: String,
    weekday: u8,
    minute_of_day: i64,
}

fn zone(time_zone: &str) -> TimeZone {
    TimeZone::get(time_zone).unwrap_or_else(|error| panic!("{time_zone}: {error}"))
}

pub fn instant_ms(text: &str) -> i64 {
    text.parse::<Timestamp>()
        .unwrap_or_else(|error| panic!("{text}: {error}"))
        .as_millisecond()
}

fn instant_text(epoch_ms: i64) -> String {
    Timestamp::from_millisecond(epoch_ms).unwrap().to_string()
}

fn local_minute(epoch_ms: i64, zone: &TimeZone) -> LocalMinute {
    let zoned = Timestamp::from_millisecond(epoch_ms)
        .unwrap()
        .to_zoned(zone.clone());
    LocalMinute {
        date: zoned.date().to_string(),
        weekday: u8::try_from(zoned.weekday().to_monday_one_offset()).unwrap(),
        minute_of_day: i64::from(zoned.hour()) * 60 + i64::from(zoned.minute()),
    }
}

fn clock_minutes(value: Option<&str>) -> Option<i64> {
    let (hour, minute) = value?.split_once(':')?;
    let digits = |part: &str, lengths: std::ops::RangeInclusive<usize>| -> Option<i64> {
        if !lengths.contains(&part.len()) || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let hour = digits(hour, 1..=2)?;
    let minute = digits(minute, 2..=2)?;
    (minute <= 59).then_some(hour * 60 + minute)
}

fn range_contains(start_local: Option<&str>, end_local: Option<&str>, minute_of_day: i64) -> bool {
    match (clock_minutes(start_local), clock_minutes(end_local)) {
        (Some(start), Some(end)) => end > start && minute_of_day >= start && minute_of_day < end,
        _ => false,
    }
}

fn minute_available(input: &ScheduleInput, zone: &TimeZone, epoch_ms: i64) -> bool {
    let local = local_minute(epoch_ms, zone);
    let exceptions: Vec<_> = input
        .exceptions
        .iter()
        .filter(|exception| exception.date == local.date)
        .collect();
    if exceptions.iter().any(|exception| {
        exception.kind == ExceptionKind::Off
            && exception.start_local.is_none()
            && exception.end_local.is_none()
    }) {
        return false;
    }
    let from_rule = input.availability.iter().any(|rule| {
        rule.weekday == f64::from(local.weekday)
            && range_contains(
                Some(&rule.start_local),
                Some(&rule.end_local),
                local.minute_of_day,
            )
    });
    let from_extra = exceptions.iter().any(|exception| {
        exception.kind == ExceptionKind::Extra
            && if exception.start_local.is_none() && exception.end_local.is_none() {
                true
            } else {
                range_contains(
                    exception.start_local.as_deref(),
                    exception.end_local.as_deref(),
                    local.minute_of_day,
                )
            }
    });
    let from_off = exceptions.iter().any(|exception| {
        exception.kind == ExceptionKind::Off
            && exception.start_local.is_some()
            && exception.end_local.is_some()
            && range_contains(
                exception.start_local.as_deref(),
                exception.end_local.as_deref(),
                local.minute_of_day,
            )
    });
    (from_rule || from_extra) && !from_off
}

/// Whether one UTC minute is inside local availability.
pub fn is_minute_locally_available(input: &ScheduleInput, epoch_ms: i64) -> bool {
    minute_available(input, &zone(&input.time_zone), epoch_ms)
}

/// True when every whole UTC minute of `[start_ms, end_ms)` is locally
/// available.
pub fn is_covered_by_minutes(input: &ScheduleInput, start_ms: i64, end_ms: i64) -> bool {
    let zone = zone(&input.time_zone);
    (start_ms..end_ms)
        .step_by(usize::try_from(MINUTE_MS).unwrap())
        .all(|cursor| minute_available(input, &zone, cursor))
}

fn blocked_intervals(input: &ScheduleInput) -> Vec<(i64, i64)> {
    input
        .commitments
        .iter()
        .map(|commitment| (commitment.start.as_str(), commitment.end.as_str()))
        .chain(
            input
                .locked_blocks
                .iter()
                .map(|block| (block.start.as_str(), block.end.as_str())),
        )
        .map(|(start, end)| (instant_ms(start), instant_ms(end)))
        .collect()
}

/// For every minute of the horizon: is it available and not blocked?
fn free_minutes(input: &ScheduleInput) -> Vec<(i64, bool)> {
    let zone = zone(&input.time_zone);
    let blocked = blocked_intervals(input);
    let start_ms = instant_ms(&input.horizon.start);
    let end_ms = instant_ms(&input.horizon.end);
    (start_ms..end_ms)
        .step_by(usize::try_from(MINUTE_MS).unwrap())
        .map(|cursor| {
            let blocked_here = blocked
                .iter()
                .any(|&(start, end)| cursor >= start && cursor < end);
            (
                cursor,
                minute_available(input, &zone, cursor) && !blocked_here,
            )
        })
        .collect()
}

/// Counts every locally available minute of the horizon that is not blocked.
pub fn available_slot_minutes(input: &ScheduleInput) -> i64 {
    i64::try_from(free_minutes(input).iter().filter(|(_, free)| *free).count()).unwrap()
}

/// Exact slot intervals from the one-minute walk, including the inward
/// 5-minute grid contract: contiguous free minutes are grouped into runs,
/// each run is aligned inwards, and touching runs are merged.
pub fn aligned_available_slots(input: &ScheduleInput) -> Vec<Slot> {
    let grid_ms = 5 * MINUTE_MS;
    let horizon_end_ms = instant_ms(&input.horizon.end);
    let mut runs: Vec<(i64, i64)> = Vec::new();
    let mut run_start: Option<i64> = None;
    for (cursor, free) in free_minutes(input) {
        match (free, run_start) {
            (true, None) => run_start = Some(cursor),
            (false, Some(start)) => {
                runs.push((start, cursor));
                run_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = run_start {
        runs.push((start, horizon_end_ms));
    }

    let mut aligned: Vec<(i64, i64)> = runs
        .into_iter()
        .map(|(start, end)| {
            (
                (start + grid_ms - 1).div_euclid(grid_ms) * grid_ms,
                end.div_euclid(grid_ms) * grid_ms,
            )
        })
        .filter(|(start, end)| end > start)
        .collect();
    aligned.sort();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (start, end) in aligned {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
        .into_iter()
        .map(|(start, end)| Slot {
            start: instant_text(start),
            end: instant_text(end),
        })
        .collect()
}

/// Minute-walk slot total including the inward 5-minute grid contract.
pub fn aligned_available_slot_minutes(input: &ScheduleInput) -> i64 {
    aligned_available_slots(input)
        .iter()
        .map(|slot| (instant_ms(&slot.end) - instant_ms(&slot.start)) / MINUTE_MS)
        .sum()
}

/// Block minutes per local date from a one-minute UTC walk, in the order the
/// dates are first met.
pub fn daily_loads_by_minute(blocks: &[Block], time_zone: &str) -> Vec<(String, i64)> {
    let zone = zone(time_zone);
    let mut loads: Vec<(String, i64)> = Vec::new();
    for block in blocks {
        for cursor in (instant_ms(&block.start)..instant_ms(&block.end))
            .step_by(usize::try_from(MINUTE_MS).unwrap())
        {
            let date = local_minute(cursor, &zone).date;
            match loads.iter_mut().find(|(known, _)| *known == date) {
                Some((_, minutes)) => *minutes += 1,
                None => loads.push((date, 1)),
            }
        }
    }
    loads
}

/// Minutes on one date of [`daily_loads_by_minute`]; 0 when the date has none.
pub fn load_on(loads: &[(String, i64)], date: &str) -> i64 {
    loads
        .iter()
        .find(|(known, _)| known == date)
        .map_or(0, |(_, minutes)| *minutes)
}

pub fn has_daily_cap_violation_by_minute(input: &ScheduleInput, blocks: &[Block]) -> bool {
    daily_loads_by_minute(blocks, &input.time_zone)
        .iter()
        .any(|(_, minutes)| {
            // A minute count is far below 2^53.
            #[allow(clippy::cast_precision_loss)]
            let minutes = *minutes as f64;
            minutes > input.prefs.max_daily_focus_min
        })
}
