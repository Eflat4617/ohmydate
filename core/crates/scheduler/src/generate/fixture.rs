//! Inputs for the generator's unit tests: one Monday in UTC.

use serde_json::{Value, json};

use super::context::Context;
use super::state::{MINUTE_MS_F, Ms, Placement, State};
use crate::time::parse_instant;
use crate::types::ScheduleInput;

/// `2026-11-09T<clock>:00Z` as epoch milliseconds.
pub(super) fn at(clock: &str) -> Ms {
    #[allow(clippy::cast_precision_loss)]
    let epoch_ms = parse_instant(&instant(clock)).unwrap() as Ms;
    epoch_ms
}

pub(super) fn instant(clock: &str) -> String {
    format!("2026-11-09T{clock}:00Z")
}

/// A splittable task in sessions of 30–120 minutes.
pub(super) fn task(id: &str, minutes: u32, depends_on: &[&str]) -> Value {
    json!({
        "id": id,
        "estimate": {"p50Min": minutes, "p90Min": minutes},
        "splittable": true,
        "minSessionMin": 30,
        "maxSessionMin": 120,
        "priority": 1,
        "dependsOn": depends_on,
    })
}

pub(super) fn block(task_id: &str, start: &str, end: &str) -> Value {
    json!({"taskId": task_id, "start": instant(start), "end": instant(end)})
}

/// Monday 2026-11-09 from 09:00 to 17:00 in UTC, `now` at 09:00, a
/// 480-minute day and break limit, 15-minute breaks. `extra` overrides or
/// adds top-level members (and `prefs` as a whole).
pub(super) fn day(tasks: &[Value], extra: &Value) -> ScheduleInput {
    let mut document = json!({
        "now": instant("09:00"),
        "timeZone": "UTC",
        "horizon": {"start": instant("09:00"), "end": instant("17:00")},
        "tasks": tasks,
        "availability": [{"weekday": 1, "startLocal": "09:00", "endLocal": "17:00", "kind": "work"}],
        "exceptions": [],
        "commitments": [],
        "lockedBlocks": [],
        "prefs": prefs(480, 480),
        "seed": 1,
    });
    if let (Some(target), Some(extra)) = (document.as_object_mut(), extra.as_object()) {
        for (name, value) in extra {
            target.insert(name.clone(), value.clone());
        }
    }
    ScheduleInput::from_json(&document).unwrap()
}

pub(super) fn prefs(max_daily_focus_min: u32, break_after_min: u32) -> Value {
    json!({
        "maxDailyFocusMin": max_daily_focus_min,
        "breakAfterMin": break_after_min,
        "breakMin": 15,
        "riskLevel": "p50",
        "dayStartLocal": "00:00",
        "dayEndLocal": "24:00",
    })
}

/// A block of the task at `index` as the generator holds it.
pub(super) fn placement(context: &Context<'_>, index: usize, start: &str, end: &str) -> Placement {
    let (start_ms, end_ms) = (at(start), at(end));
    Placement {
        task: index,
        duration_min: (end_ms - start_ms) / MINUTE_MS_F,
        start_ms,
        end_ms,
        slot_id: context
            .find_containing_slot(start_ms, end_ms)
            .map(|slot| slot.id),
        local_hour: context.local_hour_of(start_ms, end_ms).unwrap(),
        seeded: false,
    }
}

/// A state that holds the given blocks, `(task index, start, end)`.
pub(super) fn state_with(context: &Context<'_>, blocks: &[(usize, &str, &str)]) -> State {
    let mut state = context.create_state();
    for (index, start, end) in blocks {
        state
            .add_placement(context, placement(context, *index, start, end))
            .unwrap();
    }
    state
}
