//! The plan generator: a port of `packages/scheduler/src/generate.ts`.
//!
//! [`generate`] returns one candidate per requested policy (06 §4). The
//! generator and the validator are deliberately separate: only candidates
//! whose blocks produce zero violations are marked feasible. Infeasible
//! candidates are still returned with their partial blocks, their own H7
//! shortfall, the separate capacity bound, validator violations and
//! heuristic reasons, so no hard violation is hidden.
//!
//! Replanning seeds still-valid existing blocks (start >= now) and re-places
//! only the affected tasks plus any predecessors released by the staged
//! feasibility expansion (06 §7). Existing blocks whose start is before
//! `now` are history (06 §7.1): they occupy time for H1/H6 but are exempt
//! from H2/H4/H5 and do not reduce `remainingMin`. New placements start at
//! or after max(horizon.start, now).
//!
//! For the same input and options the result is the reference's, byte for
//! byte: same blocks, same floats in the metrics, same explanation text.

mod context;
mod gapfit;
mod improve;
mod order;
mod place;
mod replan;
mod state;

use serde_json::{Map, Value};

use self::context::{Context, block_key, bounded_minute_add};
use self::improve::{count_context_switches, min_slack_minutes};
use self::place::blocks_from_placements;
use self::replan::{ReplanPlan, best_replan_attempt, prepare_replan};
use self::state::{MINUTE_MS_F, State};
use crate::canonical::number_value;
use crate::codes::{
    DiversityNoteCode, DiversityNoteItem, ExplanationCode, ExplanationItem,
    GeneratorExplanationCode, Params,
};
use crate::explain::deficit;
use crate::input_hash::{effective_max_local_improvement, input_hash_of};
use crate::js::{self, number_to_string};
use crate::policies::profile;
use crate::requirements::task_required_minutes;
use crate::time::{TimeError, parse_instant};
use crate::types::{
    AutoSplitReason, Block, Commitment, GenerateOptions, PolicyName, ScheduleInput,
};
use crate::validate::{InputIssue, Violation, validate_input};

pub const GENERATOR_VERSION: &str = "m3-02.8";

/// Explanation prefix used when a replan exceeds its 06 §7 change bound.
const REPLAN_BOUND_PREFIX: &str = "Replan change bound exceeded:";

/// Longest `diversityNote` the contract takes, in UTF-16 code units.
pub const MAX_DIVERSITY_NOTE_LENGTH: usize = 500;

/// FU-96: at most this many `auto_split_long_task` lines per candidate. The
/// other lines are bounded (3 summary + 4 violations + 6 heuristic reasons +
/// 3 trailing = 16), so a candidate stays within the contract's 50 lines.
pub const MAX_AUTO_SPLIT_LINES: usize = 20;

/// Deterministic metrics of one candidate (06 §6).
///
/// Daily loads use the ADR-017 local-date semantics, including locked
/// blocks. `min_slack_min` is the smallest due-buffer slack in the final
/// plan; when no task has a deadline it falls back to the horizon end minus
/// the last block. `p90_coverage_ratio` compares each task's placed minutes
/// with its effective requirement, capped per task. `changed_blocks` is the
/// symmetric difference between the returned (movable) blocks and the
/// non-fixed existing blocks. `deficit_min` is the candidate's own H7
/// shortfall, `capacity_deficit_min` the pre-generation capacity bound.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanMetrics {
    pub total_focus_min: f64,
    pub min_slack_min: f64,
    pub max_daily_load_min: f64,
    pub avg_daily_load_min: f64,
    pub context_switches: f64,
    pub changed_blocks: f64,
    pub deficit_min: f64,
    pub capacity_deficit_min: f64,
    pub p90_coverage_ratio: f64,
}

impl PlanMetrics {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        for (name, value) in [
            ("totalFocusMin", self.total_focus_min),
            ("minSlackMin", self.min_slack_min),
            ("maxDailyLoadMin", self.max_daily_load_min),
            ("avgDailyLoadMin", self.avg_daily_load_min),
            ("contextSwitches", self.context_switches),
            ("changedBlocks", self.changed_blocks),
            ("deficitMin", self.deficit_min),
            ("capacityDeficitMin", self.capacity_deficit_min),
            ("p90CoverageRatio", self.p90_coverage_ratio),
        ] {
            object.insert(name.to_owned(), number_value(value));
        }
        Value::Object(object)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanCandidate {
    pub policy: PolicyName,
    /// Movable and seeded blocks only. Locked blocks are audited separately;
    /// existing blocks that started before `now` are history, so neither
    /// kind is repeated here.
    pub blocks: Vec<Block>,
    pub metrics: PlanMetrics,
    pub feasible: bool,
    /// This candidate's own H7 shortfall in minutes (unplaced work).
    pub deficit_min: f64,
    /// Capacity upper bound from `deficit()` before generation.
    pub capacity_deficit_min: f64,
    pub explanation: Vec<String>,
    /// The stable form of `explanation` (FU-62): `explanation_items[i]` is
    /// the coded item of `explanation[i]`.
    pub explanation_items: Vec<ExplanationItem>,
    /// SHA-256 of the canonical input with the effective seed and
    /// improvement cap.
    pub input_hash: String,
    pub generator_version: &'static str,
}

impl PlanCandidate {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("policy".into(), Value::String(self.policy.as_str().into()));
        object.insert(
            "blocks".into(),
            Value::Array(self.blocks.iter().map(Block::to_json).collect()),
        );
        object.insert("metrics".into(), self.metrics.to_json());
        object.insert("feasible".into(), Value::Bool(self.feasible));
        object.insert("deficitMin".into(), number_value(self.deficit_min));
        object.insert(
            "capacityDeficitMin".into(),
            number_value(self.capacity_deficit_min),
        );
        object.insert(
            "explanation".into(),
            Value::Array(
                self.explanation
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        object.insert(
            "explanationItems".into(),
            Value::Array(
                self.explanation_items
                    .iter()
                    .map(ExplanationItem::to_json)
                    .collect(),
            ),
        );
        object.insert("inputHash".into(), Value::String(self.input_hash.clone()));
        object.insert(
            "generatorVersion".into(),
            Value::String(self.generator_version.into()),
        );
        Value::Object(object)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GenerateResult {
    pub candidates: Vec<PlanCandidate>,
    /// FU-68: English note for logs and legacy clients, with one coded
    /// sentence per element of `diversity_note_items` (same order, joined
    /// by a space).
    pub diversity_note: Option<String>,
    pub diversity_note_items: Option<Vec<DiversityNoteItem>>,
}

impl GenerateResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert(
            "candidates".into(),
            Value::Array(self.candidates.iter().map(PlanCandidate::to_json).collect()),
        );
        if let Some(note) = &self.diversity_note {
            object.insert("diversityNote".into(), Value::String(note.clone()));
        }
        if let Some(items) = &self.diversity_note_items {
            object.insert(
                "diversityNoteItems".into(),
                Value::Array(items.iter().map(DiversityNoteItem::to_json).collect()),
            );
        }
        Value::Object(object)
    }
}

/// One explanation line: the English text always travels with its coded
/// item, so the two lists of a candidate cannot drift apart (FU-62).
struct ExplainedLine {
    item: ExplanationItem,
    text: String,
}

fn generator_line(code: GeneratorExplanationCode, params: Params, text: String) -> ExplainedLine {
    ExplainedLine {
        item: ExplanationItem {
            code: ExplanationCode::Generator(code),
            params,
        },
        text,
    }
}

fn policy_line(policy: PolicyName) -> ExplainedLine {
    let profile = profile(policy);
    generator_line(
        GeneratorExplanationCode::PolicySummary,
        Params::none()
            .text("policy", policy.as_str())
            .text("policyVersion", profile.version),
        format!("Policy {policy} v{}: {}", profile.version, profile.summary),
    )
}

/// One line per task the caller auto-split (`Task.autoSplit`, 06 §3), in
/// input order. A marker on a task that is not splittable is ignored.
fn auto_split_lines(input: &ScheduleInput) -> Vec<ExplainedLine> {
    let mut lines = Vec::new();
    for task in &input.tasks {
        if lines.len() >= MAX_AUTO_SPLIT_LINES {
            break;
        }
        let Some(reason) = task.auto_split.filter(|_| task.splittable) else {
            continue;
        };
        let limit = match reason {
            AutoSplitReason::BreakAfter => format!(
                "the {}-minute limit before a break",
                number_to_string(input.prefs.break_after_min)
            ),
            AutoSplitReason::DailyCap => format!(
                "the {}-minute daily focus cap",
                number_to_string(input.prefs.max_daily_focus_min)
            ),
        };
        lines.push(generator_line(
            GeneratorExplanationCode::AutoSplitLongTask,
            Params::none()
                .text("taskId", task.id.as_str())
                .number("sessionMaxMin", task.max_session_min)
                .text("reason", reason.as_str()),
            format!(
                "Non-splittable task \"{}\" is longer than {limit}; scheduled in sessions of at most {} min.",
                task.id,
                number_to_string(task.max_session_min)
            ),
        ));
    }
    lines
}

fn candidate(
    policy: PolicyName,
    blocks: Vec<Block>,
    metrics: PlanMetrics,
    feasible: bool,
    lines: Vec<ExplainedLine>,
    input_hash: &str,
) -> PlanCandidate {
    let (explanation, explanation_items) =
        lines.into_iter().map(|line| (line.text, line.item)).unzip();
    PlanCandidate {
        policy,
        blocks,
        metrics,
        feasible,
        deficit_min: metrics.deficit_min,
        capacity_deficit_min: metrics.capacity_deficit_min,
        explanation,
        explanation_items,
        input_hash: input_hash.to_owned(),
        generator_version: GENERATOR_VERSION,
    }
}

/// The policies to generate: the requested ones without repeats, or all.
fn normalize_policies(policies: Option<&[PolicyName]>) -> Vec<PolicyName> {
    let mut result: Vec<PolicyName> = Vec::new();
    for policy in policies.unwrap_or(PolicyName::ALL) {
        if !result.contains(policy) {
            result.push(*policy);
        }
    }
    result
}

/// The total required minutes of an input, staying finite for invalid
/// estimates (`finiteRequiredTotal`).
fn required_total(input: &ScheduleInput) -> f64 {
    input.tasks.iter().fold(0.0, |total, task| {
        bounded_minute_add(total, task_required_minutes(task, input.prefs.risk_level))
    })
}

fn invalid_input_candidate(
    policy: PolicyName,
    input_hash: &str,
    issues: &[InputIssue],
    required_total: f64,
) -> PlanCandidate {
    let kinds: Vec<&str> = issues.iter().map(|issue| issue.code.as_str()).collect();
    // Issue counts are small whole numbers: exact as floats.
    #[allow(clippy::cast_precision_loss)]
    let issue_count = issues.len() as f64;
    let mut lines = vec![
        policy_line(policy),
        generator_line(
            GeneratorExplanationCode::InputRejected,
            Params::none().number("issueCount", issue_count),
            format!("Input rejected before generation: {}.", kinds.join(", ")),
        ),
    ];
    lines.extend(issues.iter().take(5).map(|issue| ExplainedLine {
        item: issue.item(),
        text: format!("{}: {}", issue.code, issue.message),
    }));
    candidate(
        policy,
        Vec::new(),
        PlanMetrics {
            total_focus_min: 0.0,
            min_slack_min: 0.0,
            max_daily_load_min: 0.0,
            avg_daily_load_min: 0.0,
            context_switches: 0.0,
            changed_blocks: 0.0,
            deficit_min: required_total,
            capacity_deficit_min: required_total,
            p90_coverage_ratio: 1.0,
        },
        false,
        lines,
        input_hash,
    )
}

/// The capacity upper bound before generation: `deficit()` with history
/// occupying time (but not credited as work), or the total requirement when
/// the report cannot be made (`capacityDeficit`).
fn capacity_deficit(context: &Context<'_>) -> f64 {
    let input = context.input;
    let report = if context.history_blocks.is_empty() {
        deficit(input)
    } else {
        let mut capacity_input = input.clone();
        capacity_input
            .commitments
            .extend(context.history_blocks.iter().map(|block| Commitment {
                start: block.start.clone(),
                end: block.end.clone(),
            }));
        deficit(&capacity_input)
    };
    report.map_or_else(|_| required_total(input), |report| report.total.deficit_min)
}

#[allow(clippy::cast_precision_loss)]
fn count(value: usize) -> f64 {
    value as f64
}

fn build_metrics(
    context: &Context<'_>,
    state: &State,
    replan: &ReplanPlan,
    capacity_deficit_min: f64,
) -> Result<PlanMetrics, TimeError> {
    let total_focus_min = state.intervals.iter().fold(0.0, |total, interval| {
        total + (interval.end_ms - interval.start_ms) / MINUTE_MS_F
    });

    let mut max_daily_load_min = 0.0;
    let mut daily_total = 0.0;
    for (_, minutes) in state.daily_load.iter() {
        max_daily_load_min = js::max(max_daily_load_min, minutes);
        daily_total += minutes;
    }
    let active_days = count(state.daily_load.len());
    let avg_daily_load_min = if active_days > 0.0 {
        daily_total / active_days
    } else {
        0.0
    };

    // Blocks in the plan but not among the movable existing ones, plus the
    // reverse: both as sets of (task, start, end).
    let sorted_keys = |keys: &mut dyn Iterator<Item = context::BlockKey>| {
        let mut keys: Vec<_> = keys.collect();
        keys.sort_by(Ord::cmp);
        keys.dedup();
        keys
    };
    let candidate_keys = sorted_keys(
        &mut state
            .placements
            .iter()
            .map(|placement| block_key(placement.task, placement.start_ms, placement.end_ms)),
    );
    let existing_keys = sorted_keys(&mut replan.movable_existing.iter().copied());
    let missing = |from: &[context::BlockKey], other: &[context::BlockKey]| {
        from.iter()
            .filter(|key| other.binary_search(key).is_err())
            .count()
    };
    let changed_blocks =
        missing(&candidate_keys, &existing_keys) + missing(&existing_keys, &candidate_keys);

    // H7, deficitMin and p90CoverageRatio cover the live plan only:
    // candidate placements plus locked blocks. Past or in-progress history
    // occupies time for H1/H6 but must not be credited as placed work
    // (06 §7.1).
    let mut placed_by_task = vec![0.0; context.tasks.len()];
    for placement in &state.placements {
        placed_by_task[placement.task] += placement.duration_min;
    }
    for interval in &context.locked_intervals {
        placed_by_task[interval.task] += interval.minutes();
    }
    let mut shortfall = 0.0;
    let mut coverage_target = 0.0;
    let mut coverage_covered = 0.0;
    for (info, placed) in context.tasks.iter().zip(&placed_by_task) {
        shortfall += js::max(0.0, info.required_min - placed);
        coverage_target += info.required_min;
        coverage_covered += js::min(info.required_min, *placed);
    }

    Ok(PlanMetrics {
        total_focus_min,
        min_slack_min: min_slack_minutes(context, state),
        max_daily_load_min,
        avg_daily_load_min,
        context_switches: count_context_switches(context, &state.intervals)?,
        changed_blocks: count(changed_blocks),
        deficit_min: shortfall,
        capacity_deficit_min,
        p90_coverage_ratio: if coverage_target > 0.0 {
            coverage_covered / coverage_target
        } else {
            1.0
        },
    })
}

/// The distinct violation kinds of a plan, sorted, joined by `", "`
/// (`uniqueCodes`).
fn unique_codes(violations: &[Violation]) -> String {
    let mut kinds: Vec<&str> = violations
        .iter()
        .map(|violation| violation.code.as_str())
        .collect();
    kinds.sort();
    kinds.dedup();
    kinds.join(", ")
}

fn generate_for_policy(
    context: &Context<'_>,
    replan: &ReplanPlan,
    policy: PolicyName,
    seed: f64,
    input_hash: &str,
    capacity_deficit_min: f64,
    max_improvement: f64,
) -> Result<PlanCandidate, TimeError> {
    let chosen = best_replan_attempt(context, replan, policy, seed, max_improvement)?;
    let result = &chosen.result;
    // Existing blocks emitted unchanged: the attempt's seeds plus any own
    // block a gap-fitted split kept.
    let retained_seeds = count(
        result
            .placements
            .iter()
            .filter(|placement| placement.seeded)
            .count(),
    );

    let mut final_state = context.create_state();
    for placement in &result.placements {
        final_state.add_placement(context, *placement)?;
    }
    let blocks = blocks_from_placements(context, &final_state.placements)?;
    let metrics = build_metrics(context, &final_state, replan, capacity_deficit_min)?;
    let feasible = result.is_feasible();
    let required_total_min = required_total(context.input);
    let placed_total_min = js::max(0.0, required_total_min - metrics.deficit_min);
    let violation_count = count(result.violations.len());

    let mut lines = vec![
        policy_line(policy),
        generator_line(
            GeneratorExplanationCode::PlacementSummary,
            Params::none()
                .number("placedMin", placed_total_min)
                .number("requiredMin", required_total_min)
                .number("blockCount", count(blocks.len()))
                .number("retainedCount", retained_seeds),
            format!(
                "Placed {} of {} required minutes in {} movable block(s), retaining {} existing block(s).",
                number_to_string(placed_total_min),
                number_to_string(required_total_min),
                blocks.len(),
                number_to_string(retained_seeds)
            ),
        ),
        if feasible {
            generator_line(
                GeneratorExplanationCode::ConstraintsSatisfied,
                Params::none(),
                "All hard constraints H1-H8 satisfied.".to_owned(),
            )
        } else {
            generator_line(
                GeneratorExplanationCode::InfeasibleSummary,
                Params::none().number("violationCount", violation_count),
                format!(
                    "Infeasible with {} hard violation(s): {}.",
                    result.violations.len(),
                    unique_codes(&result.violations)
                ),
            )
        },
    ];
    if !feasible {
        lines.extend(
            result
                .violations
                .iter()
                .take(4)
                .map(|violation| ExplainedLine {
                    item: violation.item(),
                    text: violation.message.clone(),
                }),
        );
    }
    lines.extend(auto_split_lines(context.input));
    lines.extend(result.reasons.sorted().map(|reason| {
        generator_line(
            reason.code(),
            Params::none(),
            format!("Heuristic reason: {}.", reason.as_str()),
        )
    }));
    lines.push(generator_line(
        GeneratorExplanationCode::UnplacedMinutes,
        Params::none().number("deficitMin", metrics.deficit_min),
        format!(
            "Unplaced minutes (H7 shortfall): {} min.",
            number_to_string(metrics.deficit_min)
        ),
    ));
    lines.push(generator_line(
        GeneratorExplanationCode::CapacityDeficit,
        Params::none().number("capacityDeficitMin", capacity_deficit_min),
        format!(
            "Capacity deficit: {} min.",
            number_to_string(capacity_deficit_min)
        ),
    ));

    if !replan.movable_existing.is_empty() {
        let affected_existing_blocks = count(chosen.scope.affected_existing_blocks);
        let bound = affected_existing_blocks * 2.0 + 2.0;
        if metrics.changed_blocks > bound {
            lines.push(generator_line(
                GeneratorExplanationCode::ReplanBoundExceeded,
                Params::none()
                    .number("changedBlocks", metrics.changed_blocks)
                    .number("bound", bound)
                    .number("affectedExistingBlocks", affected_existing_blocks),
                format!(
                    "{REPLAN_BOUND_PREFIX} {} changed block(s) > {} (2 × {} affected existing block(s) + 2). Unaffected blocks were preserved; this candidate is the best available.",
                    number_to_string(metrics.changed_blocks),
                    number_to_string(bound),
                    number_to_string(affected_existing_blocks)
                ),
            ));
        }
    }

    Ok(candidate(
        policy, blocks, metrics, feasible, lines, input_hash,
    ))
}

/// A half-open interval of one task, for the distance of two plans.
type Span = (i64, i64);

/// The blocks of a plan per task, tasks in the order they first appear.
fn group_task_intervals(blocks: &[Block]) -> Vec<(&str, Vec<Span>)> {
    let mut grouped: Vec<(&str, Vec<Span>)> = Vec::new();
    for block in blocks {
        // Candidate blocks are written by this module: they always parse.
        let (Ok(start_ms), Ok(end_ms)) = (parse_instant(&block.start), parse_instant(&block.end))
        else {
            continue;
        };
        match grouped
            .iter_mut()
            .find(|(task_id, _)| *task_id == block.task_id)
        {
            Some((_, spans)) => spans.push((start_ms, end_ms)),
            None => grouped.push((block.task_id.as_str(), vec![(start_ms, end_ms)])),
        }
    }
    grouped
}

fn merge_spans(spans: &[Span]) -> Vec<Span> {
    let mut sorted = spans.to_vec();
    sorted.sort_by(Ord::cmp);
    let mut merged: Vec<Span> = Vec::new();
    for span in sorted {
        match merged.last_mut() {
            Some(last) if span.0 <= last.1 => last.1 = last.1.max(span.1),
            _ => merged.push(span),
        }
    }
    merged
}

#[allow(clippy::cast_precision_loss)]
fn span_minutes(length_ms: i64) -> f64 {
    length_ms as f64 / MINUTE_MS_F
}

fn intersection_minutes(a: &[Span], b: &[Span]) -> f64 {
    let (mut left, mut right) = (0, 0);
    let mut total = 0.0;
    while left < a.len() && right < b.len() {
        let (first, second) = (a[left], b[right]);
        total += span_minutes((first.1.min(second.1) - first.0.max(second.0)).max(0));
        if first.1 <= second.1 {
            left += 1;
        } else {
            right += 1;
        }
    }
    total
}

/// How different two plans are: 1 minus the share of per-task minutes they
/// place at the same time (`candidateDistance`).
fn candidate_distance(a: &[Block], b: &[Block]) -> f64 {
    let by_task_a = group_task_intervals(a);
    let by_task_b = group_task_intervals(b);
    let mut task_ids: Vec<&str> = by_task_a.iter().map(|(task_id, _)| *task_id).collect();
    for (task_id, _) in &by_task_b {
        if !task_ids.contains(task_id) {
            task_ids.push(task_id);
        }
    }
    let spans_of = |grouped: &[(&str, Vec<Span>)], task_id: &str| {
        grouped
            .iter()
            .find(|(known, _)| *known == task_id)
            .map_or_else(Vec::new, |(_, spans)| merge_spans(spans))
    };
    let minutes = |spans: &[Span]| {
        spans
            .iter()
            .fold(0.0, |total, span| total + span_minutes(span.1 - span.0))
    };
    let mut total = 0.0;
    let mut overlap = 0.0;
    for task_id in task_ids {
        let spans_a = spans_of(&by_task_a, task_id);
        let spans_b = spans_of(&by_task_b, task_id);
        total += js::max(minutes(&spans_a), minutes(&spans_b));
        overlap += intersection_minutes(&spans_a, &spans_b);
    }
    if total <= 0.0 {
        return 0.0;
    }
    1.0 - overlap / total
}

/// Drops candidates that are too similar to an earlier one (distance below
/// 0.15), preferring a feasible plan over similar infeasible ones, and
/// writes the diversity note (`finalize`).
fn finalize(candidates: Vec<PlanCandidate>) -> GenerateResult {
    let total = candidates.len();
    let mut kept: Vec<PlanCandidate> = Vec::new();
    let mut dropped = 0_usize;
    for candidate in candidates {
        let similar: Vec<usize> = kept
            .iter()
            .enumerate()
            .filter(|(_, earlier)| candidate_distance(&earlier.blocks, &candidate.blocks) < 0.15)
            .map(|(index, _)| index)
            .collect();
        if similar.is_empty() {
            kept.push(candidate);
            continue;
        }
        if !candidate.feasible || similar.iter().any(|index| kept[*index].feasible) {
            dropped += 1;
            continue;
        }
        // A feasible newcomer wins over every similar infeasible plan.
        // Remove all of them first so the kept set stays pairwise diverse.
        dropped += similar.len();
        let mut index = 0;
        kept.retain(|_| {
            index += 1;
            !similar.contains(&(index - 1))
        });
        kept.push(candidate);
    }

    let (note, item) = if dropped > 0 {
        (
            Some(format!(
                "{} distinct plan(s) from {total} policy candidate(s); {dropped} candidate(s) dropped as too similar (distance < 0.15).",
                kept.len()
            )),
            Some(DiversityNoteItem {
                code: DiversityNoteCode::DiversityDropped,
                params: Params::none()
                    .number("kept", count(kept.len()))
                    .number("total", count(total))
                    .number("dropped", count(dropped)),
            }),
        )
    } else if total > 1 {
        (
            Some(format!(
                "{} distinct plans from {total} policy candidates (pairwise distance >= 0.15).",
                kept.len()
            )),
            Some(DiversityNoteItem {
                code: DiversityNoteCode::DiversityDistinct,
                params: Params::none().number("total", count(total)),
            }),
        )
    } else {
        (None, None)
    };
    GenerateResult {
        candidates: kept,
        diversity_note: note,
        diversity_note_items: item.map(|item| vec![item]),
    }
}

fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// FU-68: appends the replan-bound sentences without exceeding the
/// contract's 500-character note limit. A sentence that would overflow is
/// dropped together with its coded item, so text and items stay paired.
/// Items are all-or-nothing (FU-88): if any kept line lacks a coded item, no
/// items are returned and clients fall back to the full English note
/// (`appendBoundDiversityLines`).
#[must_use]
pub fn append_bound_diversity_lines(
    base_note: Option<&str>,
    base_items: &[DiversityNoteItem],
    bound_lines: &[(String, Option<DiversityNoteItem>)],
) -> (Option<String>, Vec<DiversityNoteItem>) {
    let mut parts: Vec<&str> = base_note.into_iter().collect();
    let mut items = base_items.to_vec();
    let mut length = base_note.map_or(0, utf16_length);
    let mut all_paired = true;
    for (line, item) in bound_lines {
        let added = usize::from(!parts.is_empty()) + utf16_length(line);
        if length + added > MAX_DIVERSITY_NOTE_LENGTH {
            continue;
        }
        parts.push(line);
        match item {
            Some(item) => items.push(item.clone()),
            None => all_paired = false,
        }
        length += added;
    }
    (
        (!parts.is_empty()).then(|| parts.join(" ")),
        if all_paired { items } else { Vec::new() },
    )
}

/// Generates one candidate per requested policy (`generate`).
///
/// An input that `validate_input` rejects still gives one candidate per
/// policy: infeasible, without blocks, explaining the issues.
///
/// # Errors
///
/// Only for a time zone failure on a validated input (an instant the
/// calendar cannot represent, or the transition walk's guard): conditions
/// the reference answers with an exception.
pub fn generate(
    input: &ScheduleInput,
    options: &GenerateOptions,
) -> Result<GenerateResult, TimeError> {
    let seed = options.seed.unwrap_or(input.seed);
    let requested = normalize_policies(options.policies.as_deref());
    let max_improvement = effective_max_local_improvement(options);
    let input_hash = input_hash_of(input, options);

    let issues = validate_input(input);
    if !issues.is_empty() {
        let required_total = required_total(input);
        return Ok(finalize(
            requested
                .iter()
                .map(|policy| {
                    invalid_input_candidate(*policy, &input_hash, &issues, required_total)
                })
                .collect(),
        ));
    }

    let context = Context::build(input)?;
    let replan = prepare_replan(&context)?;
    let capacity_deficit_min = capacity_deficit(&context);
    let mut candidates = Vec::with_capacity(requested.len());
    for policy in requested {
        candidates.push(generate_for_policy(
            &context,
            &replan,
            policy,
            seed,
            &input_hash,
            capacity_deficit_min,
            max_improvement,
        )?);
    }

    // The bound sentences of every candidate (dropped ones included), each
    // once, in the order they were first written.
    let mut bound_lines: Vec<(String, Option<DiversityNoteItem>)> = Vec::new();
    for candidate in &candidates {
        for (line, item) in candidate
            .explanation
            .iter()
            .zip(&candidate.explanation_items)
        {
            if !line.starts_with(REPLAN_BOUND_PREFIX) {
                continue;
            }
            let item = (item.code
                == ExplanationCode::Generator(GeneratorExplanationCode::ReplanBoundExceeded))
            .then(|| DiversityNoteItem {
                code: DiversityNoteCode::ReplanBoundExceeded,
                params: item.params.clone(),
            });
            match bound_lines.iter_mut().find(|(known, _)| known == line) {
                Some(entry) => entry.1 = item,
                None => bound_lines.push((line.clone(), item)),
            }
        }
    }
    let mut result = finalize(candidates);
    if !bound_lines.is_empty() {
        let (note, items) = append_bound_diversity_lines(
            result.diversity_note.as_deref(),
            result.diversity_note_items.as_deref().unwrap_or(&[]),
            &bound_lines,
        );
        if note.is_some() {
            result.diversity_note = note;
        }
        // FU-88: all-or-nothing. A kept bound line without its coded item
        // means the text can no longer be paired, so clients get the full
        // English note.
        result.diversity_note_items = (!items.is_empty()).then_some(items);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(task_id: &str, start: &str, end: &str) -> Block {
        Block {
            task_id: task_id.to_owned(),
            start: format!("2026-11-09T{start}:00Z"),
            end: format!("2026-11-09T{end}:00Z"),
        }
    }

    fn plan(policy: PolicyName, feasible: bool, blocks: Vec<Block>) -> PlanCandidate {
        candidate(
            policy,
            blocks,
            PlanMetrics {
                total_focus_min: 0.0,
                min_slack_min: 0.0,
                max_daily_load_min: 0.0,
                avg_daily_load_min: 0.0,
                context_switches: 0.0,
                changed_blocks: 0.0,
                deficit_min: if feasible { 0.0 } else { 30.0 },
                capacity_deficit_min: 0.0,
                p90_coverage_ratio: 1.0,
            },
            feasible,
            vec![policy_line(policy)],
            "hash",
        )
    }

    #[test]
    fn the_distance_of_two_plans_is_the_share_of_minutes_they_place_apart() {
        let morning = vec![block("A", "09:00", "10:00"), block("B", "10:00", "11:00")];
        assert_eq!(candidate_distance(&morning, &morning), 0.0);
        let afternoon = vec![block("A", "13:00", "14:00"), block("B", "14:00", "15:00")];
        assert_eq!(candidate_distance(&morning, &afternoon), 1.0);
        // B moved by half an hour: 30 of 120 minutes differ.
        let shifted = vec![block("A", "09:00", "10:00"), block("B", "10:30", "11:30")];
        assert_eq!(candidate_distance(&morning, &shifted), 0.25);
        // The same time under another task is a different plan.
        let swapped = vec![block("B", "09:00", "10:00"), block("A", "10:00", "11:00")];
        assert_eq!(candidate_distance(&morning, &swapped), 1.0);
        // A task one plan lacks counts in full; two empty plans are equal.
        assert_eq!(candidate_distance(&morning, &morning[..1]), 0.5);
        assert_eq!(candidate_distance(&[], &[]), 0.0);
        // Sessions that touch are one stretch of time.
        let split = vec![
            block("A", "09:00", "09:30"),
            block("A", "09:30", "10:00"),
            block("B", "10:00", "11:00"),
        ];
        assert_eq!(candidate_distance(&morning, &split), 0.0);
    }

    #[test]
    fn similar_plans_are_dropped_and_a_feasible_one_replaces_similar_infeasible_ones() {
        let blocks = || vec![block("A", "09:00", "10:00")];
        let other = || vec![block("A", "15:00", "16:00")];
        // Three alike: the first is kept.
        let result = finalize(vec![
            plan(PolicyName::FrontLoaded, true, blocks()),
            plan(PolicyName::Balanced, true, blocks()),
            plan(PolicyName::FocusBlocked, true, blocks()),
        ]);
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].policy, PolicyName::FrontLoaded);
        assert_eq!(
            result.diversity_note.as_deref(),
            Some(
                "1 distinct plan(s) from 3 policy candidate(s); 2 candidate(s) dropped as too similar (distance < 0.15)."
            )
        );
        // An infeasible newcomer never replaces anything.
        let result = finalize(vec![
            plan(PolicyName::FrontLoaded, true, blocks()),
            plan(PolicyName::Balanced, false, blocks()),
        ]);
        assert_eq!(result.candidates[0].policy, PolicyName::FrontLoaded);
        assert_eq!(result.candidates.len(), 1);
        // A feasible newcomer replaces every similar infeasible plan and
        // leaves a dissimilar one alone.
        let result = finalize(vec![
            plan(PolicyName::FrontLoaded, false, blocks()),
            plan(PolicyName::Balanced, false, other()),
            plan(PolicyName::FocusBlocked, true, blocks()),
        ]);
        let policies: Vec<PolicyName> = result.candidates.iter().map(|c| c.policy).collect();
        assert_eq!(policies, [PolicyName::Balanced, PolicyName::FocusBlocked]);
        // Distinct plans are all kept, and said to be distinct.
        let result = finalize(vec![
            plan(PolicyName::FrontLoaded, true, blocks()),
            plan(PolicyName::Balanced, true, other()),
        ]);
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(
            result.diversity_note.as_deref(),
            Some("2 distinct plans from 2 policy candidates (pairwise distance >= 0.15).")
        );
        assert_eq!(
            result.diversity_note_items.unwrap()[0].code,
            DiversityNoteCode::DiversityDistinct
        );
        // One candidate, or none, needs no note.
        let single = finalize(vec![plan(PolicyName::Balanced, true, blocks())]);
        assert_eq!(
            (single.diversity_note, single.diversity_note_items),
            (None, None)
        );
        assert_eq!(finalize(Vec::new()).candidates.len(), 0);
    }

    #[test]
    fn policies_are_generated_once_each_in_the_order_asked() {
        assert_eq!(normalize_policies(None), PolicyName::ALL);
        assert_eq!(
            normalize_policies(Some(&[
                PolicyName::Balanced,
                PolicyName::FrontLoaded,
                PolicyName::Balanced
            ])),
            [PolicyName::Balanced, PolicyName::FrontLoaded]
        );
        assert_eq!(normalize_policies(Some(&[])), Vec::new());
    }

    #[test]
    fn a_result_writes_optional_parts_only_when_present() {
        let mut result = finalize(vec![plan(PolicyName::Balanced, true, Vec::new())]);
        let json = result.to_json();
        assert!(json.get("diversityNote").is_none());
        assert!(json.get("diversityNoteItems").is_none());
        assert_eq!(json["candidates"][0]["policy"], "balanced");
        assert_eq!(json["candidates"][0]["generatorVersion"], GENERATOR_VERSION);
        assert_eq!(
            json["candidates"][0]["explanation"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        result.diversity_note = Some("note".to_owned());
        assert_eq!(result.to_json()["diversityNote"], "note");
        // The note limit counts UTF-16 code units, as the contract does.
        assert_eq!(utf16_length("× 2"), 3);
        assert_eq!(utf16_length("😀"), 2);
    }
}
