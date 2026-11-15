//! Scheduler input types: a port of the input half of
//! `packages/scheduler/src/types.ts`, with its JSON form.
//!
//! Wall-clock fields use one canonical IANA time zone per [`ScheduleInput`].
//! Instants are ISO-8601 strings with an offset; every interval this crate
//! returns is written in UTC.
//!
//! Numbers stay `f64`, as in the reference: `validate_input` is what decides
//! that an estimate of `12.5` or `1e21` minutes is wrong, so the types must
//! be able to carry it. Closed string sets are enums.
//!
//! [`ScheduleInput::from_json`] reads the reference's JSON and
//! [`ScheduleInput::to_json`] writes it back without loss, which is what
//! keeps `inputHash` equal on both sides. Fields of tasks, availability
//! rules, exceptions and preferences that this crate does not know are
//! refused instead of dropped, because the reference hashes them.

use std::fmt;

use serde_json::{Map, Value};

use crate::canonical::number_value;

pub type Id = String;
/// An ISO-8601 instant with an offset, for example `2026-11-13T09:00:00Z`.
pub type Instant = String;

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            /// Every value, in the reference's declaration order.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// The reference's spelling.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            /// The value spelled `text`, if any.
            #[must_use]
            pub fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

string_enum! {
    /// Which estimate a plan must cover.
    RiskLevel { P50 => "p50", P90 => "p90" }
}

string_enum! {
    AvailabilityKind { Work => "work", Focus => "focus" }
}

string_enum! {
    ExceptionKind { Off => "off", Extra => "extra" }
}

string_enum! {
    /// Part of the day a task prefers: 06–12, 12–18, 18–24 local time.
    WindowKind { Morning => "morning", Afternoon => "afternoon", Evening => "evening" }
}

string_enum! {
    /// FU-96: which H6 limit made a non-splittable task too long for one
    /// block. `break_after` is `prefs.breakAfterMin`, `daily_cap` is
    /// `prefs.maxDailyFocusMin`.
    AutoSplitReason { BreakAfter => "break_after", DailyCap => "daily_cap" }
}

string_enum! {
    /// Published generator policy names (06 §4).
    PolicyName {
        FrontLoaded => "front_loaded",
        Balanced => "balanced",
        FocusBlocked => "focus_blocked",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskEstimate {
    pub p50_min: f64,
    pub p90_min: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub id: Id,
    pub due_at: Option<Instant>,
    pub earliest_start_at: Option<Instant>,
    pub estimate: TaskEstimate,
    /// Minutes still needed going forward. When supplied it is authoritative
    /// and does not include past or in-progress history blocks (06 §7.1).
    pub remaining_min: Option<f64>,
    pub splittable: bool,
    pub min_session_min: f64,
    pub max_session_min: f64,
    /// 1 (highest) to 4.
    pub priority: f64,
    pub depends_on: Vec<Id>,
    /// Minutes reserved before `due_at`.
    pub buffer_before_due_min: Option<f64>,
    pub preferred_windows: Option<Vec<WindowKind>>,
    /// FU-96 caller annotation (06 §3): the user marked the task
    /// non-splittable, but it is longer than the longest H6-legal block, so
    /// the caller sends it splittable with capped session bounds. The
    /// generator only adds one explanation line for it.
    pub auto_split: Option<AutoSplitReason>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AvailabilityRule {
    /// ISO weekday: Monday = 1 … Sunday = 7.
    pub weekday: f64,
    /// Local wall clock, `HH:mm`; must be earlier than `end_local`.
    pub start_local: String,
    /// Local wall clock, `HH:mm`; `24:00` is the following midnight.
    pub end_local: String,
    pub kind: AvailabilityKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExceptionRule {
    /// Local calendar date, `YYYY-MM-DD`.
    pub date: String,
    pub kind: ExceptionKind,
    pub start_local: Option<String>,
    pub end_local: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commitment {
    pub start: Instant,
    pub end: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub task_id: Id,
    pub start: Instant,
    pub end: Instant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preferences {
    pub max_daily_focus_min: f64,
    pub break_after_min: f64,
    pub break_min: f64,
    pub risk_level: RiskLevel,
    pub day_start_local: String,
    pub day_end_local: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Horizon {
    pub start: Instant,
    /// At most 366 days after `start`.
    pub end: Instant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleInput {
    pub now: Instant,
    pub time_zone: String,
    pub horizon: Horizon,
    pub tasks: Vec<Task>,
    pub availability: Vec<AvailabilityRule>,
    pub exceptions: Vec<ExceptionRule>,
    pub commitments: Vec<Commitment>,
    pub locked_blocks: Vec<Block>,
    /// Previous plan blocks. Entries that start before `now` are history:
    /// they occupy time for H1/H6 but are not audited otherwise (06 §7.1).
    pub existing_blocks: Option<Vec<Block>>,
    /// 06 §7.1 (FU-59): tasks a replan must release even when their existing
    /// blocks still look valid.
    pub affected_task_ids: Option<Vec<Id>>,
    pub prefs: Preferences,
    pub seed: f64,
}

/// A merged UTC interval on the scheduler's 5-minute grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub start: Instant,
    pub end: Instant,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GenerateOptions {
    pub policies: Option<Vec<PolicyName>>,
    /// Overrides `ScheduleInput::seed` when supplied.
    pub seed: Option<f64>,
    /// Local-improvement evaluation cap; defaults to 200 (06 §4).
    pub max_local_improvement: Option<f64>,
}

/// JSON that does not have the shape of the type being read.
///
/// The message names the place and the kind of problem, never a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeError {
    /// JSON pointer of the offending value.
    pub pointer: String,
    pub problem: ShapeProblem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeProblem {
    Missing,
    NotAnObject,
    NotAnArray,
    NotAString,
    NotANumber,
    NotABoolean,
    UnknownValue,
    UnknownField,
}

impl fmt::Display for ShapeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let problem = match self.problem {
            ShapeProblem::Missing => "is missing",
            ShapeProblem::NotAnObject => "is not an object",
            ShapeProblem::NotAnArray => "is not an array",
            ShapeProblem::NotAString => "is not a string",
            ShapeProblem::NotANumber => "is not a number",
            ShapeProblem::NotABoolean => "is not a boolean",
            ShapeProblem::UnknownValue => "is not one of the allowed values",
            ShapeProblem::UnknownField => "is not a known field",
        };
        write!(formatter, "{} {problem}", self.pointer)
    }
}

impl std::error::Error for ShapeError {}

/// One JSON object being read, and where it sits.
struct Reader<'a> {
    map: &'a Map<String, Value>,
    pointer: String,
}

impl<'a> Reader<'a> {
    fn new(value: &'a Value, pointer: &str) -> Result<Self, ShapeError> {
        match value {
            Value::Object(map) => Ok(Self {
                map,
                pointer: pointer.to_owned(),
            }),
            _ => Err(ShapeError {
                pointer: pointer.to_owned(),
                problem: ShapeProblem::NotAnObject,
            }),
        }
    }

    fn at(&self, name: &str) -> String {
        format!("{}/{name}", self.pointer)
    }

    fn fail<T>(&self, name: &str, problem: ShapeProblem) -> Result<T, ShapeError> {
        Err(ShapeError {
            pointer: self.at(name),
            problem,
        })
    }

    fn required(&self, name: &str) -> Result<&'a Value, ShapeError> {
        match self.map.get(name) {
            Some(value) => Ok(value),
            None => self.fail(name, ShapeProblem::Missing),
        }
    }

    fn string(&self, name: &str) -> Result<String, ShapeError> {
        match self.required(name)? {
            Value::String(text) => Ok(text.clone()),
            _ => self.fail(name, ShapeProblem::NotAString),
        }
    }

    fn optional_string(&self, name: &str) -> Result<Option<String>, ShapeError> {
        match self.map.get(name) {
            None => Ok(None),
            Some(_) => self.string(name).map(Some),
        }
    }

    fn number(&self, name: &str) -> Result<f64, ShapeError> {
        match self.required(name)?.as_f64() {
            Some(number) => Ok(number),
            None => self.fail(name, ShapeProblem::NotANumber),
        }
    }

    fn optional_number(&self, name: &str) -> Result<Option<f64>, ShapeError> {
        match self.map.get(name) {
            None => Ok(None),
            Some(_) => self.number(name).map(Some),
        }
    }

    fn boolean(&self, name: &str) -> Result<bool, ShapeError> {
        match self.required(name)? {
            Value::Bool(flag) => Ok(*flag),
            _ => self.fail(name, ShapeProblem::NotABoolean),
        }
    }

    fn items(&self, name: &str) -> Result<&'a [Value], ShapeError> {
        match self.required(name)? {
            Value::Array(items) => Ok(items),
            _ => self.fail(name, ShapeProblem::NotAnArray),
        }
    }

    fn optional_items(&self, name: &str) -> Result<Option<&'a [Value]>, ShapeError> {
        match self.map.get(name) {
            None => Ok(None),
            Some(_) => self.items(name).map(Some),
        }
    }

    /// Reads every element of an array field with `read`, which receives the
    /// element and its pointer.
    fn list<T>(
        &self,
        name: &str,
        read: impl Fn(&'a Value, &str) -> Result<T, ShapeError>,
    ) -> Result<Vec<T>, ShapeError> {
        read_items(self.items(name)?, &self.at(name), read)
    }

    fn optional_list<T>(
        &self,
        name: &str,
        read: impl Fn(&'a Value, &str) -> Result<T, ShapeError>,
    ) -> Result<Option<Vec<T>>, ShapeError> {
        match self.optional_items(name)? {
            None => Ok(None),
            Some(items) => read_items(items, &self.at(name), read).map(Some),
        }
    }

    /// Refuses fields outside `known`: the reference would hash them.
    fn only(&self, known: &[&str]) -> Result<(), ShapeError> {
        match self.map.keys().find(|key| !known.contains(&key.as_str())) {
            None => Ok(()),
            // The field name is caller data; point at the object instead.
            Some(_) => Err(ShapeError {
                pointer: self.pointer.clone(),
                problem: ShapeProblem::UnknownField,
            }),
        }
    }
}

fn read_items<'a, T>(
    items: &'a [Value],
    pointer: &str,
    read: impl Fn(&'a Value, &str) -> Result<T, ShapeError>,
) -> Result<Vec<T>, ShapeError> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| read(item, &format!("{pointer}/{index}")))
        .collect()
}

fn read_string(value: &Value, pointer: &str) -> Result<String, ShapeError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        _ => Err(ShapeError {
            pointer: pointer.to_owned(),
            problem: ShapeProblem::NotAString,
        }),
    }
}

fn read_enum<T>(
    value: &Value,
    pointer: &str,
    parse: impl Fn(&str) -> Option<T>,
) -> Result<T, ShapeError> {
    let fail = |problem| ShapeError {
        pointer: pointer.to_owned(),
        problem,
    };
    let text = value
        .as_str()
        .ok_or_else(|| fail(ShapeProblem::NotAString))?;
    parse(text).ok_or_else(|| fail(ShapeProblem::UnknownValue))
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

/// Builds a JSON object from `(name, value)` pairs, leaving out the `None`s
/// the way `JSON.stringify` leaves out `undefined`.
fn object<const N: usize>(fields: [(&str, Option<Value>); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(name, value)| value.map(|value| (name.to_owned(), value)))
            .collect(),
    )
}

impl TaskEstimate {
    fn from_json(value: &Value, pointer: &str) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, pointer)?;
        reader.only(&["p50Min", "p90Min"])?;
        Ok(Self {
            p50_min: reader.number("p50Min")?,
            p90_min: reader.number("p90Min")?,
        })
    }

    fn to_json(&self) -> Value {
        object([
            ("p50Min", Some(number_value(self.p50_min))),
            ("p90Min", Some(number_value(self.p90_min))),
        ])
    }
}

impl Task {
    const FIELDS: &'static [&'static str] = &[
        "id",
        "dueAt",
        "earliestStartAt",
        "estimate",
        "remainingMin",
        "splittable",
        "minSessionMin",
        "maxSessionMin",
        "priority",
        "dependsOn",
        "bufferBeforeDueMin",
        "preferredWindows",
        "autoSplit",
    ];

    /// Reads one task of the reference's JSON.
    pub fn from_json(value: &Value, pointer: &str) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, pointer)?;
        reader.only(Self::FIELDS)?;
        Ok(Self {
            id: reader.string("id")?,
            due_at: reader.optional_string("dueAt")?,
            earliest_start_at: reader.optional_string("earliestStartAt")?,
            estimate: TaskEstimate::from_json(
                reader.required("estimate")?,
                &reader.at("estimate"),
            )?,
            remaining_min: reader.optional_number("remainingMin")?,
            splittable: reader.boolean("splittable")?,
            min_session_min: reader.number("minSessionMin")?,
            max_session_min: reader.number("maxSessionMin")?,
            priority: reader.number("priority")?,
            depends_on: reader.list("dependsOn", read_string)?,
            buffer_before_due_min: reader.optional_number("bufferBeforeDueMin")?,
            preferred_windows: reader.optional_list("preferredWindows", |item, at| {
                read_enum(item, at, WindowKind::parse)
            })?,
            auto_split: match reader.map.get("autoSplit") {
                None => None,
                Some(reason) => Some(read_enum(
                    reason,
                    &reader.at("autoSplit"),
                    AutoSplitReason::parse,
                )?),
            },
        })
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        object([
            ("id", Some(Value::String(self.id.clone()))),
            ("dueAt", self.due_at.clone().map(Value::String)),
            (
                "earliestStartAt",
                self.earliest_start_at.clone().map(Value::String),
            ),
            ("estimate", Some(self.estimate.to_json())),
            ("remainingMin", self.remaining_min.map(number_value)),
            ("splittable", Some(Value::Bool(self.splittable))),
            ("minSessionMin", Some(number_value(self.min_session_min))),
            ("maxSessionMin", Some(number_value(self.max_session_min))),
            ("priority", Some(number_value(self.priority))),
            ("dependsOn", Some(strings(&self.depends_on))),
            (
                "bufferBeforeDueMin",
                self.buffer_before_due_min.map(number_value),
            ),
            (
                "preferredWindows",
                self.preferred_windows.as_ref().map(|windows| {
                    Value::Array(
                        windows
                            .iter()
                            .map(|window| Value::String(window.as_str().to_owned()))
                            .collect(),
                    )
                }),
            ),
            (
                "autoSplit",
                self.auto_split
                    .map(|reason| Value::String(reason.as_str().to_owned())),
            ),
        ])
    }
}

impl AvailabilityRule {
    fn from_json(value: &Value, pointer: &str) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, pointer)?;
        reader.only(&["weekday", "startLocal", "endLocal", "kind"])?;
        Ok(Self {
            weekday: reader.number("weekday")?,
            start_local: reader.string("startLocal")?,
            end_local: reader.string("endLocal")?,
            kind: read_enum(
                reader.required("kind")?,
                &reader.at("kind"),
                AvailabilityKind::parse,
            )?,
        })
    }

    fn to_json(&self) -> Value {
        object([
            ("weekday", Some(number_value(self.weekday))),
            ("startLocal", Some(Value::String(self.start_local.clone()))),
            ("endLocal", Some(Value::String(self.end_local.clone()))),
            ("kind", Some(Value::String(self.kind.as_str().to_owned()))),
        ])
    }
}

impl ExceptionRule {
    fn from_json(value: &Value, pointer: &str) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, pointer)?;
        reader.only(&["date", "kind", "startLocal", "endLocal"])?;
        Ok(Self {
            date: reader.string("date")?,
            kind: read_enum(
                reader.required("kind")?,
                &reader.at("kind"),
                ExceptionKind::parse,
            )?,
            start_local: reader.optional_string("startLocal")?,
            end_local: reader.optional_string("endLocal")?,
        })
    }

    fn to_json(&self) -> Value {
        object([
            ("date", Some(Value::String(self.date.clone()))),
            ("kind", Some(Value::String(self.kind.as_str().to_owned()))),
            ("startLocal", self.start_local.clone().map(Value::String)),
            ("endLocal", self.end_local.clone().map(Value::String)),
        ])
    }
}

impl Commitment {
    fn from_json(value: &Value, pointer: &str) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, pointer)?;
        Ok(Self {
            start: reader.string("start")?,
            end: reader.string("end")?,
        })
    }

    fn to_json(&self) -> Value {
        object([
            ("start", Some(Value::String(self.start.clone()))),
            ("end", Some(Value::String(self.end.clone()))),
        ])
    }
}

impl Block {
    /// Reads `{ taskId, start, end }`; other fields are ignored, as the
    /// reference ignores them.
    pub fn from_json(value: &Value, pointer: &str) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, pointer)?;
        Ok(Self {
            task_id: reader.string("taskId")?,
            start: reader.string("start")?,
            end: reader.string("end")?,
        })
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        object([
            ("taskId", Some(Value::String(self.task_id.clone()))),
            ("start", Some(Value::String(self.start.clone()))),
            ("end", Some(Value::String(self.end.clone()))),
        ])
    }
}

impl Preferences {
    fn from_json(value: &Value, pointer: &str) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, pointer)?;
        reader.only(&[
            "maxDailyFocusMin",
            "breakAfterMin",
            "breakMin",
            "riskLevel",
            "dayStartLocal",
            "dayEndLocal",
        ])?;
        Ok(Self {
            max_daily_focus_min: reader.number("maxDailyFocusMin")?,
            break_after_min: reader.number("breakAfterMin")?,
            break_min: reader.number("breakMin")?,
            risk_level: read_enum(
                reader.required("riskLevel")?,
                &reader.at("riskLevel"),
                RiskLevel::parse,
            )?,
            day_start_local: reader.string("dayStartLocal")?,
            day_end_local: reader.string("dayEndLocal")?,
        })
    }

    fn to_json(&self) -> Value {
        object([
            (
                "maxDailyFocusMin",
                Some(number_value(self.max_daily_focus_min)),
            ),
            ("breakAfterMin", Some(number_value(self.break_after_min))),
            ("breakMin", Some(number_value(self.break_min))),
            (
                "riskLevel",
                Some(Value::String(self.risk_level.as_str().to_owned())),
            ),
            (
                "dayStartLocal",
                Some(Value::String(self.day_start_local.clone())),
            ),
            (
                "dayEndLocal",
                Some(Value::String(self.day_end_local.clone())),
            ),
        ])
    }
}

fn blocks_to_json(blocks: &[Block]) -> Value {
    Value::Array(blocks.iter().map(Block::to_json).collect())
}

impl ScheduleInput {
    /// Reads a `ScheduleInput` as the reference serialises it.
    pub fn from_json(value: &Value) -> Result<Self, ShapeError> {
        let reader = Reader::new(value, "")?;
        let horizon = Reader::new(reader.required("horizon")?, &reader.at("horizon"))?;
        Ok(Self {
            now: reader.string("now")?,
            time_zone: reader.string("timeZone")?,
            horizon: Horizon {
                start: horizon.string("start")?,
                end: horizon.string("end")?,
            },
            tasks: reader.list("tasks", Task::from_json)?,
            availability: reader.list("availability", AvailabilityRule::from_json)?,
            exceptions: reader.list("exceptions", ExceptionRule::from_json)?,
            commitments: reader.list("commitments", Commitment::from_json)?,
            locked_blocks: reader.list("lockedBlocks", Block::from_json)?,
            existing_blocks: reader.optional_list("existingBlocks", Block::from_json)?,
            affected_task_ids: reader.optional_list("affectedTaskIds", read_string)?,
            prefs: Preferences::from_json(reader.required("prefs")?, &reader.at("prefs"))?,
            seed: reader.number("seed")?,
        })
    }

    /// The reference's JSON form. Reading it back gives an equal value.
    #[must_use]
    pub fn to_json(&self) -> Value {
        object([
            ("now", Some(Value::String(self.now.clone()))),
            ("timeZone", Some(Value::String(self.time_zone.clone()))),
            (
                "horizon",
                Some(object([
                    ("start", Some(Value::String(self.horizon.start.clone()))),
                    ("end", Some(Value::String(self.horizon.end.clone()))),
                ])),
            ),
            (
                "tasks",
                Some(Value::Array(self.tasks.iter().map(Task::to_json).collect())),
            ),
            (
                "availability",
                Some(Value::Array(
                    self.availability
                        .iter()
                        .map(AvailabilityRule::to_json)
                        .collect(),
                )),
            ),
            (
                "exceptions",
                Some(Value::Array(
                    self.exceptions.iter().map(ExceptionRule::to_json).collect(),
                )),
            ),
            (
                "commitments",
                Some(Value::Array(
                    self.commitments.iter().map(Commitment::to_json).collect(),
                )),
            ),
            ("lockedBlocks", Some(blocks_to_json(&self.locked_blocks))),
            (
                "existingBlocks",
                self.existing_blocks.as_deref().map(blocks_to_json),
            ),
            (
                "affectedTaskIds",
                self.affected_task_ids.as_deref().map(strings),
            ),
            ("prefs", Some(self.prefs.to_json())),
            ("seed", Some(number_value(self.seed))),
        ])
    }

    /// `existing_blocks`, empty when the input has none.
    #[must_use]
    pub fn existing(&self) -> &[Block] {
        self.existing_blocks.as_deref().unwrap_or(&[])
    }
}

impl Slot {
    #[must_use]
    pub fn to_json(&self) -> Value {
        object([
            ("start", Some(Value::String(self.start.clone()))),
            ("end", Some(Value::String(self.end.clone()))),
        ])
    }
}

impl GenerateOptions {
    /// Reads `GenerateOptions`; `null` is no options. Policy names the
    /// generator does not publish are dropped, as the reference drops them.
    pub fn from_json(value: &Value) -> Result<Self, ShapeError> {
        if value.is_null() {
            return Ok(Self::default());
        }
        let reader = Reader::new(value, "")?;
        Ok(Self {
            policies: reader.optional_list("policies", read_string)?.map(|names| {
                names
                    .iter()
                    .filter_map(|name| PolicyName::parse(name))
                    .collect()
            }),
            seed: reader.optional_number("seed")?,
            max_local_improvement: reader.optional_number("maxLocalImprovement")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::canonical::canonical_json;

    fn input() -> Value {
        json!({
            "now": "2026-11-13T09:00:00+09:00",
            "timeZone": "Asia/Seoul",
            "horizon": {"start": "2026-11-13T00:00:00Z", "end": "2026-11-20T00:00:00Z"},
            "tasks": [
                {
                    "id": "A",
                    "dueAt": "2026-11-19T09:00:00+09:00",
                    "earliestStartAt": "2026-11-13T00:00:00Z",
                    "estimate": {"p50Min": 60, "p90Min": 90},
                    "remainingMin": 45,
                    "splittable": true, "minSessionMin": 30, "maxSessionMin": 90,
                    "priority": 2, "dependsOn": ["B"],
                    "bufferBeforeDueMin": 15,
                    "preferredWindows": ["morning", "evening"],
                    "autoSplit": "daily_cap",
                },
                {
                    "id": "B",
                    "estimate": {"p50Min": 12.5, "p90Min": 1e21},
                    "splittable": false, "minSessionMin": 0, "maxSessionMin": 0,
                    "priority": 4, "dependsOn": [],
                },
            ],
            "availability": [
                {"weekday": 5, "startLocal": "09:00", "endLocal": "18:00", "kind": "work"},
                {"weekday": 9, "startLocal": "x", "endLocal": "24:00", "kind": "focus"},
            ],
            "exceptions": [
                {"date": "2026-11-14", "kind": "off"},
                {"date": "2026-11-15", "kind": "extra", "startLocal": "20:00", "endLocal": "23:00"},
            ],
            "commitments": [{"start": "2026-11-14T01:00:00Z", "end": "2026-11-14T02:00:00Z"}],
            "lockedBlocks": [{"taskId": "A", "start": "2026-11-13T01:00:00Z", "end": "2026-11-13T01:30:00Z"}],
            "existingBlocks": [],
            "affectedTaskIds": ["B", "A"],
            "prefs": {"maxDailyFocusMin": 240, "breakAfterMin": 60, "breakMin": 15, "riskLevel": "p90",
                      "dayStartLocal": "08:00", "dayEndLocal": "18:00"},
            "seed": 7,
        })
    }

    #[test]
    fn an_input_reads_into_typed_fields() {
        let parsed = ScheduleInput::from_json(&input()).unwrap();
        assert_eq!(parsed.time_zone, "Asia/Seoul");
        assert_eq!(parsed.tasks.len(), 2);
        let first = &parsed.tasks[0];
        assert_eq!(first.remaining_min, Some(45.0));
        assert_eq!(
            first.preferred_windows,
            Some(vec![WindowKind::Morning, WindowKind::Evening])
        );
        assert_eq!(first.auto_split, Some(AutoSplitReason::DailyCap));
        let second = &parsed.tasks[1];
        assert_eq!(second.due_at, None);
        assert_eq!(second.estimate.p50_min.to_bits(), 12.5_f64.to_bits());
        assert_eq!(second.estimate.p90_min.to_bits(), 1e21_f64.to_bits());
        assert_eq!(parsed.availability[1].weekday.to_bits(), 9.0_f64.to_bits());
        assert_eq!(parsed.exceptions[0].start_local, None);
        assert_eq!(parsed.prefs.risk_level, RiskLevel::P90);
        assert_eq!(parsed.existing_blocks, Some(Vec::new()));
        assert_eq!(parsed.existing(), &[]);
        assert_eq!(
            parsed.affected_task_ids,
            Some(vec!["B".to_owned(), "A".to_owned()])
        );
    }

    #[test]
    fn writing_an_input_back_gives_the_same_canonical_json() {
        let original = input();
        let parsed = ScheduleInput::from_json(&original).unwrap();
        assert_eq!(canonical_json(&parsed.to_json()), canonical_json(&original));
        assert_eq!(ScheduleInput::from_json(&parsed.to_json()), Ok(parsed));

        // Absent optional fields stay absent: `existingBlocks: []` and no
        // `existingBlocks` hash differently in the reference.
        let mut bare = original;
        let fields = bare.as_object_mut().unwrap();
        fields.remove("existingBlocks");
        fields.remove("affectedTaskIds");
        let parsed = ScheduleInput::from_json(&bare).unwrap();
        assert_eq!(parsed.existing_blocks, None);
        assert_eq!(parsed.existing(), &[]);
        assert_eq!(canonical_json(&parsed.to_json()), canonical_json(&bare));
    }

    #[test]
    fn shape_errors_name_the_place_and_never_a_value() {
        let broken = |edit: fn(&mut Value)| {
            let mut value = input();
            edit(&mut value);
            ScheduleInput::from_json(&value).unwrap_err()
        };
        let error = broken(|value| {
            value["tasks"][1]["estimate"]["p50Min"] = json!("secret title");
        });
        assert_eq!(error.pointer, "/tasks/1/estimate/p50Min");
        assert_eq!(error.problem, ShapeProblem::NotANumber);
        assert!(!error.to_string().contains("secret"));

        let error = broken(|value| {
            value.as_object_mut().unwrap().remove("timeZone");
        });
        assert_eq!(
            (error.pointer.as_str(), error.problem),
            ("/timeZone", ShapeProblem::Missing)
        );
        let error = broken(|value| value["prefs"]["riskLevel"] = json!("p75"));
        assert_eq!(
            (error.pointer.as_str(), error.problem),
            ("/prefs/riskLevel", ShapeProblem::UnknownValue)
        );
        let error = broken(|value| value["tasks"][0]["dueAt"] = Value::Null);
        assert_eq!(
            (error.pointer.as_str(), error.problem),
            ("/tasks/0/dueAt", ShapeProblem::NotAString)
        );
        let error = broken(|value| value["tasks"][0]["splittable"] = json!(1));
        assert_eq!(error.problem, ShapeProblem::NotABoolean);
        let error = broken(|value| value["tasks"] = json!({}));
        assert_eq!(
            (error.pointer.as_str(), error.problem),
            ("/tasks", ShapeProblem::NotAnArray)
        );
        let error = broken(|value| value["exceptions"][0] = json!("off"));
        assert_eq!(
            (error.pointer.as_str(), error.problem),
            ("/exceptions/0", ShapeProblem::NotAnObject)
        );
        assert_eq!(
            ScheduleInput::from_json(&json!([])).unwrap_err().problem,
            ShapeProblem::NotAnObject
        );
    }

    #[test]
    fn fields_the_reference_would_hash_are_refused_and_others_ignored() {
        let mut value = input();
        value["tasks"][0]["title"] = json!("secret title");
        let error = ScheduleInput::from_json(&value).unwrap_err();
        assert_eq!(
            (error.pointer.as_str(), error.problem),
            ("/tasks/0", ShapeProblem::UnknownField)
        );
        assert!(!error.to_string().contains("title"));
        for pointer in [
            "/prefs",
            "/availability/0",
            "/exceptions/0",
            "/tasks/1/estimate",
        ] {
            let mut value = input();
            *value.pointer_mut(pointer).unwrap() = {
                let mut object = value.pointer(pointer).unwrap().clone();
                object["extra"] = json!(1);
                object
            };
            assert_eq!(
                ScheduleInput::from_json(&value).unwrap_err().problem,
                ShapeProblem::UnknownField,
                "{pointer}"
            );
        }

        // The reference keeps only known parts of these, so extras are fine.
        let mut value = input();
        value["note"] = json!("ignored");
        value["horizon"]["label"] = json!("ignored");
        value["commitments"][0]["title"] = json!("ignored");
        value["lockedBlocks"][0]["id"] = json!("ignored");
        assert_eq!(
            ScheduleInput::from_json(&value),
            ScheduleInput::from_json(&input())
        );
    }

    #[test]
    fn options_read_with_defaults_and_drop_unknown_policies() {
        assert_eq!(
            GenerateOptions::from_json(&Value::Null),
            Ok(GenerateOptions::default())
        );
        assert_eq!(
            GenerateOptions::from_json(&json!({})),
            Ok(GenerateOptions::default())
        );
        let options = GenerateOptions::from_json(&json!({
            "policies": ["balanced", "made_up", "front_loaded", "balanced"],
            "seed": 9,
            "maxLocalImprovement": 50,
        }))
        .unwrap();
        assert_eq!(
            options.policies,
            Some(vec![
                PolicyName::Balanced,
                PolicyName::FrontLoaded,
                PolicyName::Balanced
            ])
        );
        assert_eq!(options.seed, Some(9.0));
        assert_eq!(options.max_local_improvement, Some(50.0));
        assert_eq!(
            GenerateOptions::from_json(&json!({"seed": "9"}))
                .unwrap_err()
                .problem,
            ShapeProblem::NotANumber
        );
    }

    #[test]
    fn enums_keep_the_reference_spelling_and_order() {
        assert_eq!(
            PolicyName::ALL
                .iter()
                .map(|policy| policy.as_str())
                .collect::<Vec<_>>(),
            ["front_loaded", "balanced", "focus_blocked"]
        );
        assert_eq!(RiskLevel::parse("p90"), Some(RiskLevel::P90));
        assert_eq!(RiskLevel::parse("P90"), None);
        assert_eq!(AutoSplitReason::BreakAfter.to_string(), "break_after");
        assert_eq!(ExceptionKind::parse("holiday"), None);
        assert_eq!(WindowKind::Afternoon.as_str(), "afternoon");
        assert_eq!(
            AvailabilityKind::parse("focus"),
            Some(AvailabilityKind::Focus)
        );
    }
}
