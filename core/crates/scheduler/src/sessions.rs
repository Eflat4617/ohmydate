//! H6-legal session lengths: a port of `packages/scheduler/src/sessions.ts`
//! (FU-96, 06 §3).

use crate::js;
use crate::time::GRID_MINUTES;
use crate::types::AutoSplitReason;

// The grid step as the float the reference computes with.
#[allow(clippy::cast_precision_loss)]
const GRID_MINUTES_F64: f64 = GRID_MINUTES as f64;

/// The longest single block H6 allows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LegalSessionLimit {
    /// Longest single block, in minutes on the 5-minute grid.
    pub cap_min: f64,
    /// The H6 limit that sets `cap_min`.
    pub reason: AutoSplitReason,
}

/// The longest block that satisfies H6 on its own (`maxLegalSessionMin`).
///
/// * H6 break rule: a continuous run longer than `break_after_min` needs a
///   break, and one block is a continuous run, so a block may last at most
///   `break_after_min` minutes. The rule is off when `break_after_min <= 0`.
/// * H6 daily cap: a block can never be longer than `max_daily_focus_min`.
///
/// The smaller limit wins (`break_after` on a tie) and is floored to the
/// grid. `None` means no block of at least 5 minutes is legal, or the
/// preferences are not finite, so there is nothing to split into.
#[must_use]
pub fn max_legal_session_min(
    break_after_min: f64,
    max_daily_focus_min: f64,
) -> Option<LegalSessionLimit> {
    let break_after_min = if break_after_min > 0.0 {
        break_after_min
    } else {
        f64::INFINITY
    };
    let limit_min = js::min(break_after_min, max_daily_focus_min);
    if !limit_min.is_finite() {
        return None;
    }
    let cap_min = (limit_min / GRID_MINUTES_F64).floor() * GRID_MINUTES_F64;
    if cap_min < GRID_MINUTES_F64 {
        return None;
    }
    Some(LegalSessionLimit {
        cap_min,
        reason: if break_after_min <= max_daily_focus_min {
            AutoSplitReason::BreakAfter
        } else {
            AutoSplitReason::DailyCap
        },
    })
}

/// Shortest session for a task auto-split into sessions of at most `cap_min`
/// (`autoSplitMinSessionMin`): the caller's default minimum, but never more
/// than half the cap (on the grid, at least one grid cell). With
/// `min <= cap / 2` every remaining length above the cap divides into
/// whole-grid sessions inside `[min, cap]`, so an auto-split task never fails
/// on its session bounds alone.
#[must_use]
pub fn auto_split_min_session_min(cap_min: f64, default_min_session_min: f64) -> f64 {
    let half_cap_min = (cap_min / 2.0 / GRID_MINUTES_F64).floor() * GRID_MINUTES_F64;
    js::max(
        GRID_MINUTES_F64,
        js::min(default_min_session_min, half_cap_min),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit(break_after_min: f64, max_daily_focus_min: f64) -> Option<(f64, AutoSplitReason)> {
        max_legal_session_min(break_after_min, max_daily_focus_min)
            .map(|limit| (limit.cap_min, limit.reason))
    }

    #[test]
    fn the_smaller_h6_limit_wins_and_break_after_wins_a_tie() {
        assert_eq!(
            limit(90.0, 240.0),
            Some((90.0, AutoSplitReason::BreakAfter))
        );
        assert_eq!(
            limit(300.0, 240.0),
            Some((240.0, AutoSplitReason::DailyCap))
        );
        assert_eq!(
            limit(120.0, 120.0),
            Some((120.0, AutoSplitReason::BreakAfter))
        );
        // The break rule is off at 0 or below: only the daily cap is left.
        assert_eq!(limit(0.0, 240.0), Some((240.0, AutoSplitReason::DailyCap)));
        assert_eq!(limit(-5.0, 240.0), Some((240.0, AutoSplitReason::DailyCap)));
    }

    #[test]
    fn the_cap_is_floored_to_the_grid() {
        assert_eq!(
            limit(52.0, 240.0),
            Some((50.0, AutoSplitReason::BreakAfter))
        );
        assert_eq!(limit(90.0, 44.9), Some((40.0, AutoSplitReason::DailyCap)));
        assert_eq!(limit(5.0, 240.0), Some((5.0, AutoSplitReason::BreakAfter)));
    }

    #[test]
    fn no_legal_block_means_no_limit() {
        // Shorter than one grid cell.
        assert_eq!(limit(4.0, 240.0), None);
        assert_eq!(limit(90.0, 0.0), None);
        assert_eq!(limit(90.0, -30.0), None);
        // Not finite.
        assert_eq!(limit(0.0, f64::INFINITY), None);
        assert_eq!(limit(90.0, f64::NAN), None);
        assert_eq!(limit(f64::NAN, f64::INFINITY), None);
        // A NaN break rule counts as off, like `NaN > 0` in the reference.
        assert_eq!(
            limit(f64::NAN, 60.0),
            Some((60.0, AutoSplitReason::DailyCap))
        );
    }

    #[test]
    fn the_auto_split_minimum_is_at_most_half_the_cap_and_at_least_one_cell() {
        assert_eq!(auto_split_min_session_min(90.0, 30.0), 30.0);
        assert_eq!(auto_split_min_session_min(50.0, 30.0), 25.0);
        assert_eq!(auto_split_min_session_min(45.0, 30.0), 20.0);
        assert_eq!(auto_split_min_session_min(5.0, 30.0), 5.0);
        assert_eq!(auto_split_min_session_min(120.0, 0.0), 5.0);
        assert_eq!(auto_split_min_session_min(120.0, 15.0), 15.0);
    }
}
