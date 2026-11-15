//! The hard-constraint validator: a port of
//! `packages/scheduler/src/validate.ts`.
//!
//! [`validate`] audits a candidate plan against H1–H8 and the H0
//! preconditions; [`validate_input`] checks a `ScheduleInput` before any
//! plan is made.
//!
//! The validator is deliberately a separate implementation from the
//! generator (06 §5): it has its own local-date partition ([`local`]) and H2
//! classifies single instants by raw rule membership instead of building or
//! subtracting availability intervals. Only candidates on which it reports
//! nothing are called feasible.

mod input;
mod local;

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

pub use self::input::validate_input;
pub use self::local::ORACLE_MAX_TRANSITIONS;
use self::local::{Availability, OracleZone};
use crate::codes::{
    ExplanationCode, ExplanationItem, InputIssueCode, InputIssueMessageCode, Params, ViolationCode,
    ViolationMessageCode,
};
use crate::js::number_to_string;
use crate::requirements::task_required_minutes;
use crate::time::{MINUTE_MS, TimeError, Zone, instant_nanoseconds, instant_to_utc, parse_instant};
use crate::types::{Block, RiskLevel, ScheduleInput, Task};

/// Upper bound of every minute-valued input field (estimates, remaining
/// minutes, session bounds, preferences). Larger values are rejected as
/// invalid input instead of producing an unreasonably long plan.
pub const MAX_INPUT_MINUTES: f64 = 100_000.0;

/// Longest supported planning horizon and occupied-block span, in days.
pub const MAX_HORIZON_DAYS: i64 = 366;
const MAX_HORIZON_MS: i64 = MAX_HORIZON_DAYS * 24 * 60 * MINUTE_MS;

const NS_PER_MS: i128 = 1_000_000;
const GRID_NS: i128 = 300_000_000_000;

/// A validator finding. `message` is English text for logs; `message_code`
/// and `params` are the stable, renderable form of the same finding (FU-62).
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    pub code: ViolationCode,
    pub message: String,
    pub message_code: ViolationMessageCode,
    pub params: Params,
    pub task_id: Option<String>,
    pub blocks: Option<Vec<Block>>,
}

impl Violation {
    fn new(message_code: ViolationMessageCode, message: String, params: Params) -> Self {
        Self {
            code: message_code.kind(),
            message,
            message_code,
            params,
            task_id: None,
            blocks: None,
        }
    }

    fn for_task(mut self, task_id: &str) -> Self {
        self.task_id = Some(task_id.to_owned());
        self
    }

    fn with_blocks(mut self, blocks: Vec<Block>) -> Self {
        self.blocks = Some(blocks);
        self
    }

    /// The coded explanation item of this finding (`itemFromMessage`).
    #[must_use]
    pub fn item(&self) -> ExplanationItem {
        ExplanationItem {
            code: ExplanationCode::Violation(self.message_code),
            params: self.params.clone(),
        }
    }

    /// The reference's JSON form.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("code".into(), Value::String(self.code.as_str().into()));
        object.insert("message".into(), Value::String(self.message.clone()));
        object.insert(
            "messageCode".into(),
            Value::String(self.message_code.as_str().into()),
        );
        object.insert("params".into(), self.params.to_json());
        if let Some(task_id) = &self.task_id {
            object.insert("taskId".into(), Value::String(task_id.clone()));
        }
        if let Some(blocks) = &self.blocks {
            object.insert(
                "blocks".into(),
                Value::Array(blocks.iter().map(Block::to_json).collect()),
            );
        }
        Value::Object(object)
    }
}

/// An input issue; `message_code` and `params` are its stable form (FU-62).
#[derive(Debug, Clone, PartialEq)]
pub struct InputIssue {
    pub code: InputIssueCode,
    pub message: String,
    pub message_code: InputIssueMessageCode,
    pub params: Params,
    pub task_id: Option<String>,
}

impl InputIssue {
    /// The coded explanation item of this issue (`itemFromMessage`).
    #[must_use]
    pub fn item(&self) -> ExplanationItem {
        ExplanationItem {
            code: ExplanationCode::InputIssue(self.message_code),
            params: self.params.clone(),
        }
    }

    /// The reference's JSON form.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("code".into(), Value::String(self.code.as_str().into()));
        object.insert("message".into(), Value::String(self.message.clone()));
        object.insert(
            "messageCode".into(),
            Value::String(self.message_code.as_str().into()),
        );
        object.insert("params".into(), self.params.to_json());
        if let Some(task_id) = &self.task_id {
            object.insert("taskId".into(), Value::String(task_id.clone()));
        }
        Value::Object(object)
    }
}

/// How to audit a plan.
#[derive(Debug, Clone, Copy)]
pub struct ValidateOptions<'a> {
    pub risk_level: RiskLevel,
    /// Past or in-progress history blocks: audited for H1 only against
    /// candidate blocks, and counted for H6 only on days and runs that
    /// contain an audited minute. History-only collisions, days and runs are
    /// exempt, as is history from H2, H4, H5 and H7 (06 §7.1).
    pub history_blocks: &'a [Block],
}

/// Whole minutes in `[0, MAX_INPUT_MINUTES]`; rejects NaN and the
/// infinities.
fn is_whole_minute(value: f64) -> bool {
    crate::js::is_integer(value) && (0.0..=MAX_INPUT_MINUTES).contains(&value)
}

/// A usable buffer value, or 0 when the input is invalid (and rejected by
/// `validate_input`).
fn usable_buffer_minutes(task: &Task) -> f64 {
    match task.buffer_before_due_min {
        Some(value) if is_whole_minute(value) => value,
        _ => 0.0,
    }
}

// Epoch milliseconds and minute counts stay far below 2^53.
#[allow(clippy::cast_precision_loss)]
fn as_f64(value: i64) -> f64 {
    value as f64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Candidate,
    Locked,
    History,
}

#[derive(Debug, Clone, Copy)]
struct Parsed<'a> {
    block: &'a Block,
    start_ms: i64,
    end_ms: i64,
    origin: Origin,
}

impl Parsed<'_> {
    fn minutes(&self) -> f64 {
        as_f64(self.end_ms - self.start_ms) / as_f64(MINUTE_MS)
    }

    /// Candidate and locked blocks are the audited plan; history is not.
    fn is_audited(&self) -> bool {
        self.origin != Origin::History
    }
}

/// Coded parameters of a finding about one block (UTC instants, FU-62).
fn block_params(parsed: &Parsed<'_>) -> Result<Params, TimeError> {
    Ok(Params::none()
        .text("taskId", parsed.block.task_id.as_str())
        .text("startAt", instant_to_utc(parsed.start_ms)?)
        .text("endAt", instant_to_utc(parsed.end_ms)?))
}

fn by_start_then_end(a: &Parsed<'_>, b: &Parsed<'_>) -> std::cmp::Ordering {
    a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms))
}

/// The plan's blocks per task id, each list in time order. Used for lookups
/// only, so the map's own order does not matter.
fn group_by_task<'a, 'b>(plan: &'b [Parsed<'a>]) -> BTreeMap<&'a str, Vec<&'b Parsed<'a>>> {
    let mut by_task: BTreeMap<&str, Vec<&Parsed<'_>>> = BTreeMap::new();
    for parsed in plan {
        by_task
            .entry(parsed.block.task_id.as_str())
            .or_default()
            .push(parsed);
    }
    for list in by_task.values_mut() {
        list.sort_by(|a, b| by_start_then_end(a, b));
    }
    by_task
}

fn blocks_of(parsed: &[&Parsed<'_>]) -> Vec<Block> {
    parsed.iter().map(|entry| entry.block.clone()).collect()
}

/// Reads plan blocks, reporting H8 for those that cannot be used at all.
fn parse_plan_blocks<'a>(
    blocks: &'a [Block],
    origin: Origin,
    violations: &mut Vec<Violation>,
) -> Vec<Parsed<'a>> {
    let mut parsed = Vec::with_capacity(blocks.len());
    for block in blocks {
        let task_id = block.task_id.as_str();
        let reject = |message_code, text: &str| {
            Violation::new(
                message_code,
                format!("Block for task \"{task_id}\" {text}"),
                Params::none().text("taskId", task_id),
            )
            .for_task(task_id)
            .with_blocks(vec![block.clone()])
        };
        let (Ok(start_ns), Ok(end_ns)) = (
            instant_nanoseconds(&block.start),
            instant_nanoseconds(&block.end),
        ) else {
            violations.push(reject(
                ViolationMessageCode::H8InvalidInstant,
                "has an invalid instant.",
            ));
            continue;
        };
        if start_ns % NS_PER_MS != 0 || end_ns % NS_PER_MS != 0 {
            violations.push(reject(
                ViolationMessageCode::H8SubMillisecond,
                "has sub-millisecond precision.",
            ));
            continue;
        }
        if start_ns % GRID_NS != 0 || end_ns % GRID_NS != 0 {
            violations.push(reject(
                ViolationMessageCode::H8OffGrid,
                "is not aligned to the 5-minute grid.",
            ));
            continue;
        }
        let (Ok(start_ms), Ok(end_ms)) = (
            i64::try_from(start_ns / NS_PER_MS),
            i64::try_from(end_ns / NS_PER_MS),
        ) else {
            continue;
        };
        if end_ms <= start_ms {
            violations.push(reject(
                ViolationMessageCode::H8EndBeforeStart,
                "ends before it starts.",
            ));
            continue;
        }
        parsed.push(Parsed {
            block,
            start_ms,
            end_ms,
            origin,
        });
    }
    parsed
}

/// Audits a candidate plan against the hard constraints H1–H8 (`validate`).
///
/// Candidate blocks must lie inside the horizon (`H0_horizon`) and every
/// block must name a known task (`H0_unknown_task`); locked blocks are exempt
/// only from the horizon check. An empty result means the plan is feasible.
///
/// # Errors
///
/// Only when a time zone lookup fails for an instant the calendar cannot
/// represent, or the transition walk hits its guard — both programming-error
/// conditions the reference answers with an exception.
pub fn validate(
    input: &ScheduleInput,
    blocks: &[Block],
    options: &ValidateOptions<'_>,
) -> Result<Vec<Violation>, TimeError> {
    let Ok(zone) = Zone::get(&input.time_zone) else {
        return Ok(vec![Violation::new(
            ViolationMessageCode::H8InvalidTimeZone,
            format!("Invalid IANA time zone: {}", input.time_zone),
            Params::none(),
        )]);
    };
    validate_in_zone(input, &zone, blocks, options)
}

/// [`validate`] for a zone that is already resolved. The generator audits
/// many plans of one input; resolving the zone once keeps the database
/// lookup out of that loop.
pub(crate) fn validate_in_zone(
    input: &ScheduleInput,
    zone: &Zone,
    blocks: &[Block],
    options: &ValidateOptions<'_>,
) -> Result<Vec<Violation>, TimeError> {
    let zone = OracleZone::new(zone.to_time_zone());
    let mut violations = Vec::new();

    let candidate = parse_plan_blocks(blocks, Origin::Candidate, &mut violations);
    let locked = parse_plan_blocks(&input.locked_blocks, Origin::Locked, &mut violations);
    let history = parse_plan_blocks(options.history_blocks, Origin::History, &mut violations);
    // H2–H5 and H7 audit the live plan only. History is audited for H1 only
    // against candidate blocks; H6 counts it only on days and runs with an
    // audited minute (06 §7.1).
    let audited: Vec<Parsed<'_>> = candidate.iter().chain(&locked).copied().collect();
    let occupied: Vec<Parsed<'_>> = audited.iter().chain(&history).copied().collect();

    check_unknown_task_ids(input, &audited, &mut violations);
    check_horizon(input, &candidate, &mut violations)?;
    check_h1(input, &audited, &occupied, &mut violations)?;
    check_h2(input, &zone, &audited, &mut violations)?;
    let by_task = group_by_task(&audited);
    check_h3(input, &by_task, &mut violations);
    check_h4(input, &by_task, &mut violations)?;
    check_h5(input, &by_task, options, &mut violations)?;
    check_h6(input, &zone, &occupied, &mut violations)?;
    check_h7(input, &by_task, options, &mut violations);
    Ok(violations)
}

fn check_unknown_task_ids(
    input: &ScheduleInput,
    plan: &[Parsed<'_>],
    violations: &mut Vec<Violation>,
) {
    let known: BTreeSet<&str> = input.tasks.iter().map(|task| task.id.as_str()).collect();
    for parsed in plan {
        let task_id = parsed.block.task_id.as_str();
        if !known.contains(task_id) {
            violations.push(
                Violation::new(
                    ViolationMessageCode::H0UnknownTask,
                    format!("Block references unknown task \"{task_id}\"."),
                    Params::none().text("taskId", task_id),
                )
                .for_task(task_id)
                .with_blocks(vec![parsed.block.clone()]),
            );
        }
    }
}

fn check_horizon(
    input: &ScheduleInput,
    candidate: &[Parsed<'_>],
    violations: &mut Vec<Violation>,
) -> Result<(), TimeError> {
    let (Ok(horizon_start), Ok(horizon_end)) = (
        parse_instant(&input.horizon.start),
        parse_instant(&input.horizon.end),
    ) else {
        violations.push(Violation::new(
            ViolationMessageCode::H8InvalidHorizon,
            "Horizon contains an invalid instant.".to_owned(),
            Params::none(),
        ));
        return Ok(());
    };
    for parsed in candidate {
        if parsed.start_ms < horizon_start || parsed.end_ms > horizon_end {
            let task_id = parsed.block.task_id.as_str();
            violations.push(
                Violation::new(
                    ViolationMessageCode::H0OutsideHorizon,
                    format!("Block for task \"{task_id}\" is outside the planning horizon."),
                    block_params(parsed)?,
                )
                .for_task(task_id)
                .with_blocks(vec![parsed.block.clone()]),
            );
        }
    }
    Ok(())
}

fn check_h1(
    input: &ScheduleInput,
    audited: &[Parsed<'_>],
    occupied: &[Parsed<'_>],
    violations: &mut Vec<Violation>,
) -> Result<(), TimeError> {
    let mut sorted: Vec<&Parsed<'_>> = occupied.iter().collect();
    sorted.sort_by(|a, b| by_start_then_end(a, b));
    for (index, current) in sorted.iter().enumerate() {
        for next in &sorted[index + 1..] {
            if next.start_ms >= current.end_ms {
                break;
            }
            if next.end_ms <= current.start_ms {
                continue;
            }
            // History-only collisions are facts, not plan violations
            // (06 §7.1). A history block is audited only against a candidate
            // block; locked blocks are audited against each other and
            // against candidates.
            let involves_history =
                current.origin == Origin::History || next.origin == Origin::History;
            let involves_candidate =
                current.origin == Origin::Candidate || next.origin == Origin::Candidate;
            if involves_history && !involves_candidate {
                continue;
            }
            let (first, second) = (current.block.task_id.as_str(), next.block.task_id.as_str());
            let violation = if first == second {
                Violation::new(
                    ViolationMessageCode::H1SameTaskOverlap,
                    format!("Blocks for task \"{first}\" overlap."),
                    Params::none().text("taskId", first),
                )
            } else {
                Violation::new(
                    ViolationMessageCode::H1TasksOverlap,
                    format!("Blocks for tasks \"{first}\" and \"{second}\" overlap."),
                    Params::none()
                        .text("taskId", first)
                        .text("otherTaskId", second),
                )
            };
            violations.push(violation.with_blocks(vec![current.block.clone(), next.block.clone()]));
        }
    }

    let commitments: Vec<(i64, i64)> = input
        .commitments
        .iter()
        .filter_map(|commitment| {
            Some((
                parse_instant(&commitment.start).ok()?,
                parse_instant(&commitment.end).ok()?,
            ))
        })
        .collect();
    for parsed in audited {
        for &(start_ms, end_ms) in &commitments {
            if parsed.start_ms < end_ms && parsed.end_ms > start_ms {
                let task_id = parsed.block.task_id.as_str();
                violations.push(
                    Violation::new(
                        ViolationMessageCode::H1CommitmentOverlap,
                        format!("Block for task \"{task_id}\" overlaps a commitment."),
                        block_params(parsed)?,
                    )
                    .for_task(task_id)
                    .with_blocks(vec![parsed.block.clone()]),
                );
            }
        }
    }
    Ok(())
}

fn check_h2(
    input: &ScheduleInput,
    zone: &OracleZone,
    plan: &[Parsed<'_>],
    violations: &mut Vec<Violation>,
) -> Result<(), TimeError> {
    let availability = Availability::new(&input.availability, &input.exceptions);
    for parsed in plan {
        if !availability.covers(zone, parsed.start_ms, parsed.end_ms)? {
            let task_id = parsed.block.task_id.as_str();
            violations.push(
                Violation::new(
                    ViolationMessageCode::H2OutsideAvailability,
                    format!("Block for task \"{task_id}\" is outside availability."),
                    block_params(parsed)?,
                )
                .for_task(task_id)
                .with_blocks(vec![parsed.block.clone()]),
            );
        }
    }
    Ok(())
}

fn check_h3(
    input: &ScheduleInput,
    by_task: &BTreeMap<&str, Vec<&Parsed<'_>>>,
    violations: &mut Vec<Violation>,
) {
    for task in &input.tasks {
        let Some(successor_first) = by_task.get(task.id.as_str()).and_then(|list| list.first())
        else {
            continue;
        };
        for dependency_id in &task.depends_on {
            let Some(dependency_last) = by_task
                .get(dependency_id.as_str())
                .and_then(|list| list.last())
            else {
                continue;
            };
            if dependency_last.end_ms > successor_first.start_ms {
                violations.push(
                    Violation::new(
                        ViolationMessageCode::H3DependencyOrder,
                        format!(
                            "Task \"{}\" starts before dependency \"{dependency_id}\" finishes.",
                            task.id
                        ),
                        Params::none()
                            .text("taskId", task.id.as_str())
                            .text("dependencyId", dependency_id.as_str()),
                    )
                    .for_task(&task.id)
                    .with_blocks(vec![
                        dependency_last.block.clone(),
                        successor_first.block.clone(),
                    ]),
                );
            }
        }
    }
}

fn check_h4(
    input: &ScheduleInput,
    by_task: &BTreeMap<&str, Vec<&Parsed<'_>>>,
    violations: &mut Vec<Violation>,
) -> Result<(), TimeError> {
    for task in &input.tasks {
        let Some(task_blocks) = by_task.get(task.id.as_str()) else {
            continue;
        };
        let (Some(first), Some(last)) = (task_blocks.first(), task_blocks.last()) else {
            continue;
        };

        if let Some(earliest_ms) = task
            .earliest_start_at
            .as_deref()
            .and_then(|text| parse_instant(text).ok())
            && first.start_ms < earliest_ms
        {
            violations.push(
                Violation::new(
                    ViolationMessageCode::H4BeforeEarliestStart,
                    format!("Task \"{}\" starts before earliestStartAt.", task.id),
                    Params::none()
                        .text("taskId", task.id.as_str())
                        .text("earliestStartAt", instant_to_utc(earliest_ms)?),
                )
                .for_task(&task.id)
                .with_blocks(vec![first.block.clone()]),
            );
        }

        if let Some(due_ms) = task
            .due_at
            .as_deref()
            .and_then(|text| parse_instant(text).ok())
        {
            let buffer_min = usable_buffer_minutes(task);
            let buffer_ms = buffer_min * as_f64(MINUTE_MS);
            if as_f64(last.end_ms) > as_f64(due_ms) - buffer_ms {
                let due_at = instant_to_utc(due_ms)?;
                let violation = if buffer_ms > 0.0 {
                    Violation::new(
                        ViolationMessageCode::H4InsideDueBuffer,
                        format!("Task \"{}\" ends inside its pre-due buffer.", task.id),
                        Params::none()
                            .text("taskId", task.id.as_str())
                            .text("dueAt", due_at)
                            .number("bufferMin", buffer_ms / as_f64(MINUTE_MS)),
                    )
                } else {
                    Violation::new(
                        ViolationMessageCode::H4AfterDue,
                        format!("Task \"{}\" ends after its due time.", task.id),
                        Params::none()
                            .text("taskId", task.id.as_str())
                            .text("dueAt", due_at),
                    )
                };
                violations.push(
                    violation
                        .for_task(&task.id)
                        .with_blocks(vec![last.block.clone()]),
                );
            }
        }
    }
    Ok(())
}

fn check_h5(
    input: &ScheduleInput,
    by_task: &BTreeMap<&str, Vec<&Parsed<'_>>>,
    options: &ValidateOptions<'_>,
    violations: &mut Vec<Violation>,
) -> Result<(), TimeError> {
    let none: Vec<&Parsed<'_>> = Vec::new();
    for task in &input.tasks {
        let task_blocks = by_task.get(task.id.as_str()).unwrap_or(&none);
        let (min_session, max_session) = (task.min_session_min, task.max_session_min);

        if !task.splittable {
            let required = task_required_minutes(task, options.risk_level);
            if required == 0.0 {
                // An in-progress or finished non-splittable task has no
                // forward need: the whole existing block is history
                // (06 §7.1). It needs no new block, and any candidate or
                // locked block would be a duplicate.
                if !task_blocks.is_empty() {
                    violations.push(
                        Violation::new(
                            ViolationMessageCode::H5UnsplittableNoRemaining,
                            format!(
                                "Non-splittable task \"{}\" has no remaining minutes and must not have a block.",
                                task.id
                            ),
                            Params::none().text("taskId", task.id.as_str()),
                        )
                        .for_task(&task.id)
                        .with_blocks(blocks_of(task_blocks)),
                    );
                }
                continue;
            }
            if required < min_session || required > max_session {
                let mut violation = Violation::new(
                    ViolationMessageCode::H5UnsplittableRequiredOutOfBounds,
                    format!(
                        "Non-splittable task \"{}\" requires {} minutes, outside [{}, {}].",
                        task.id,
                        number_to_string(required),
                        number_to_string(min_session),
                        number_to_string(max_session)
                    ),
                    Params::none()
                        .text("taskId", task.id.as_str())
                        .number("requiredMin", required)
                        .number("minSessionMin", min_session)
                        .number("maxSessionMin", max_session),
                )
                .for_task(&task.id);
                if !task_blocks.is_empty() {
                    violation = violation.with_blocks(blocks_of(task_blocks));
                }
                violations.push(violation);
                continue;
            }
            let total: f64 = task_blocks
                .iter()
                .fold(0.0, |sum, parsed| sum + parsed.minutes());
            // `total != required` is also true for a NaN requirement.
            #[allow(clippy::float_cmp)]
            let wrong_cover = total != required;
            if !task_blocks.is_empty() && (task_blocks.len() != 1 || wrong_cover) {
                violations.push(
                    Violation::new(
                        ViolationMessageCode::H5UnsplittableSingleBlock,
                        format!(
                            "Non-splittable task \"{}\" must be one block covering {} minutes.",
                            task.id,
                            number_to_string(required)
                        ),
                        Params::none()
                            .text("taskId", task.id.as_str())
                            .number("requiredMin", required),
                    )
                    .for_task(&task.id)
                    .with_blocks(blocks_of(task_blocks)),
                );
            }
            continue;
        }

        for parsed in task_blocks {
            let duration = parsed.minutes();
            if duration < min_session || duration > max_session {
                violations.push(
                    Violation::new(
                        ViolationMessageCode::H5SessionOutOfBounds,
                        format!(
                            "Task \"{}\" has a {}-minute session outside [{}, {}].",
                            task.id,
                            number_to_string(duration),
                            number_to_string(min_session),
                            number_to_string(max_session)
                        ),
                        Params::none()
                            .text("taskId", task.id.as_str())
                            .number("durationMin", duration)
                            .number("minSessionMin", min_session)
                            .number("maxSessionMin", max_session)
                            .text("startAt", instant_to_utc(parsed.start_ms)?)
                            .text("endAt", instant_to_utc(parsed.end_ms)?),
                    )
                    .for_task(&task.id)
                    .with_blocks(vec![parsed.block.clone()]),
                );
            }
        }
    }
    Ok(())
}

fn check_h6(
    input: &ScheduleInput,
    zone: &OracleZone,
    occupied: &[Parsed<'_>],
    violations: &mut Vec<Violation>,
) -> Result<(), TimeError> {
    // Per local date in the order the dates are first met: all minutes, and
    // the minutes of audited blocks.
    let mut day_index: BTreeMap<jiff::civil::Date, usize> = BTreeMap::new();
    let mut days: Vec<(jiff::civil::Date, f64, f64)> = Vec::new();
    for parsed in occupied {
        for segment in zone.partition(parsed.start_ms, parsed.end_ms)? {
            let minutes = as_f64(segment.end_ms - segment.start_ms) / as_f64(MINUTE_MS);
            let index = *day_index.entry(segment.date).or_insert_with(|| {
                days.push((segment.date, 0.0, 0.0));
                days.len() - 1
            });
            let day = &mut days[index];
            day.1 += minutes;
            if parsed.is_audited() {
                day.2 += minutes;
            }
        }
    }
    let max_daily_focus_min = input.prefs.max_daily_focus_min;
    for (date, total, audited) in &days {
        // A day made of history alone is a fact, not a plan violation;
        // history minutes still count on days with an audited minute
        // (06 §7.1).
        if *audited > 0.0 && *total > max_daily_focus_min {
            let date = date.to_string();
            violations.push(Violation::new(
                ViolationMessageCode::H6DailyFocusExceeded,
                format!(
                    "Daily focus on {date} is {} minutes, above {}.",
                    number_to_string(*total),
                    number_to_string(max_daily_focus_min)
                ),
                Params::none()
                    .text("date", date.as_str())
                    .number("totalMin", *total)
                    .number("maxDailyFocusMin", max_daily_focus_min),
            ));
        }
    }

    let (break_after_min, break_min) = (input.prefs.break_after_min, input.prefs.break_min);
    let break_after_ms = break_after_min * as_f64(MINUTE_MS);
    let break_ms = break_min * as_f64(MINUTE_MS);
    if break_after_ms <= 0.0 {
        return Ok(());
    }

    let mut sorted: Vec<&Parsed<'_>> = occupied.iter().collect();
    sorted.sort_by(|a, b| by_start_then_end(a, b));
    // The current run of focus: start, end, whether it holds an audited
    // block.
    let mut run: Option<(i64, i64, bool)> = None;
    let mut report_run = |run: Option<(i64, i64, bool)>| -> Result<(), TimeError> {
        if let Some((run_start, run_end, true)) = run
            && as_f64(run_end - run_start) > break_after_ms
        {
            let date = zone.date_at(run_start)?.to_string();
            violations.push(Violation::new(
                ViolationMessageCode::H6BreakMissing,
                format!(
                    "Continuous focus starting on {date} exceeds {} minutes without a {}-minute break.",
                    number_to_string(break_after_min),
                    number_to_string(break_min)
                ),
                Params::none()
                    .text("date", date.as_str())
                    .number("breakAfterMin", break_after_min)
                    .number("breakMin", break_min),
            ));
        }
        Ok(())
    };
    for interval in sorted {
        let Some((run_start, run_end, has_audited)) = run else {
            run = Some((interval.start_ms, interval.end_ms, interval.is_audited()));
            continue;
        };
        if as_f64(interval.start_ms - run_end) >= break_ms {
            report_run(run)?;
            run = Some((interval.start_ms, interval.end_ms, interval.is_audited()));
        } else {
            run = Some((
                run_start,
                run_end.max(interval.end_ms),
                has_audited || interval.is_audited(),
            ));
        }
    }
    report_run(run)
}

fn check_h7(
    input: &ScheduleInput,
    by_task: &BTreeMap<&str, Vec<&Parsed<'_>>>,
    options: &ValidateOptions<'_>,
    violations: &mut Vec<Violation>,
) {
    let none: Vec<&Parsed<'_>> = Vec::new();
    for task in &input.tasks {
        let task_blocks = by_task.get(task.id.as_str()).unwrap_or(&none);
        let required = task_required_minutes(task, options.risk_level);
        let placed: f64 = task_blocks
            .iter()
            .fold(0.0, |sum, parsed| sum + parsed.minutes());
        // Exact comparison of minute counts, as in the reference; a NaN
        // requirement counts as different.
        #[allow(clippy::float_cmp)]
        let differs = placed != required;
        if !differs {
            continue;
        }
        let difference = (required - placed).abs();
        let mut violation = if placed < required {
            Violation::new(
                ViolationMessageCode::H7Deficit,
                format!(
                    "Task \"{}\" is short by {} minutes (deficit).",
                    task.id,
                    number_to_string(difference)
                ),
                Params::none()
                    .text("taskId", task.id.as_str())
                    .number("shortMin", difference),
            )
        } else {
            Violation::new(
                ViolationMessageCode::H7Overallocated,
                format!(
                    "Task \"{}\" is overallocated by {} minutes.",
                    task.id,
                    number_to_string(difference)
                ),
                Params::none()
                    .text("taskId", task.id.as_str())
                    .number("excessMin", difference),
            )
        }
        .for_task(&task.id);
        if !task_blocks.is_empty() {
            violation = violation.with_blocks(blocks_of(task_blocks));
        }
        violations.push(violation);
    }
}
