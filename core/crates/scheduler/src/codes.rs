//! Stable explanation and violation codes: a port of
//! `packages/scheduler/src/codes.ts` (FU-62, 06 §6.1).
//!
//! Every explanation line the generator writes and every message the
//! validators write carries one of these closed codes plus parameters, so a
//! client can render its own language instead of the English text. The
//! English strings are kept unchanged for logs and compatibility; the codes
//! are the contract (`packages/contracts` mirrors the lists, and a test here
//! holds the two together).
//!
//! Parameter values are only numbers (minutes, counts, limits) or opaque
//! tokens: task ids, UTC instants, civil dates and closed enum values. They
//! never carry task titles, note text or other user-written strings.

use serde_json::{Map, Value};

use crate::canonical::number_value;

string_enum! {
    /// Hard constraints H1–H8 plus the H0 preconditions (`Violation.code`).
    ///
    /// `H0_horizon` rejects candidate blocks outside the horizon; locked
    /// blocks are exempt from it. `H0_unknown_task` rejects candidate and
    /// locked blocks whose task is not in the input.
    ViolationCode {
        H0Horizon => "H0_horizon",
        H0UnknownTask => "H0_unknown_task",
        H1 => "H1",
        H2 => "H2",
        H3 => "H3",
        H4 => "H4",
        H5 => "H5",
        H6 => "H6",
        H7 => "H7",
        H8 => "H8",
    }
}

string_enum! {
    /// Validator findings, one code per message template. The H-kind is the
    /// prefix.
    ViolationMessageCode {
        H0UnknownTask => "h0_unknown_task",
        H0OutsideHorizon => "h0_outside_horizon",
        H1SameTaskOverlap => "h1_same_task_overlap",
        H1TasksOverlap => "h1_tasks_overlap",
        H1CommitmentOverlap => "h1_commitment_overlap",
        H2OutsideAvailability => "h2_outside_availability",
        H3DependencyOrder => "h3_dependency_order",
        H4BeforeEarliestStart => "h4_before_earliest_start",
        H4InsideDueBuffer => "h4_inside_due_buffer",
        H4AfterDue => "h4_after_due",
        H5UnsplittableNoRemaining => "h5_unsplittable_no_remaining",
        H5UnsplittableRequiredOutOfBounds => "h5_unsplittable_required_out_of_bounds",
        H5UnsplittableSingleBlock => "h5_unsplittable_single_block",
        H5SessionOutOfBounds => "h5_session_out_of_bounds",
        H6DailyFocusExceeded => "h6_daily_focus_exceeded",
        H6BreakMissing => "h6_break_missing",
        H7Deficit => "h7_deficit",
        H7Overallocated => "h7_overallocated",
        H8InvalidTimeZone => "h8_invalid_time_zone",
        H8InvalidHorizon => "h8_invalid_horizon",
        H8InvalidInstant => "h8_invalid_instant",
        H8SubMillisecond => "h8_sub_millisecond",
        H8OffGrid => "h8_off_grid",
        H8EndBeforeStart => "h8_end_before_start",
    }
}

impl ViolationMessageCode {
    /// The hard constraint a finding belongs to.
    #[must_use]
    pub const fn kind(self) -> ViolationCode {
        match self {
            Self::H0UnknownTask => ViolationCode::H0UnknownTask,
            Self::H0OutsideHorizon => ViolationCode::H0Horizon,
            Self::H1SameTaskOverlap | Self::H1TasksOverlap | Self::H1CommitmentOverlap => {
                ViolationCode::H1
            }
            Self::H2OutsideAvailability => ViolationCode::H2,
            Self::H3DependencyOrder => ViolationCode::H3,
            Self::H4BeforeEarliestStart | Self::H4InsideDueBuffer | Self::H4AfterDue => {
                ViolationCode::H4
            }
            Self::H5UnsplittableNoRemaining
            | Self::H5UnsplittableRequiredOutOfBounds
            | Self::H5UnsplittableSingleBlock
            | Self::H5SessionOutOfBounds => ViolationCode::H5,
            Self::H6DailyFocusExceeded | Self::H6BreakMissing => ViolationCode::H6,
            Self::H7Deficit | Self::H7Overallocated => ViolationCode::H7,
            Self::H8InvalidTimeZone
            | Self::H8InvalidHorizon
            | Self::H8InvalidInstant
            | Self::H8SubMillisecond
            | Self::H8OffGrid
            | Self::H8EndBeforeStart => ViolationCode::H8,
        }
    }
}

string_enum! {
    /// The coarse kind of an input issue (`InputIssue.code`).
    InputIssueCode {
        InvalidTimezone => "invalid_timezone",
        InvalidInstant => "invalid_instant",
        InvalidWindow => "invalid_window",
        InvalidInput => "invalid_input",
        DuplicateTask => "duplicate_task",
        InvalidEstimate => "invalid_estimate",
        InvalidSession => "invalid_session",
        UnknownDependency => "unknown_dependency",
        DependencyCycle => "dependency_cycle",
        UnknownTask => "unknown_task",
        InvalidPrecision => "invalid_precision",
    }
}

string_enum! {
    /// `validate_input` issues, one code per message template.
    InputIssueMessageCode {
        InvalidTimeZone => "input_invalid_time_zone",
        InvalidHorizonInstant => "input_invalid_horizon_instant",
        HorizonNotIncreasing => "input_horizon_not_increasing",
        HorizonTooLong => "input_horizon_too_long",
        InvalidNow => "input_invalid_now",
        DuplicateTask => "input_duplicate_task",
        InvalidEstimate => "input_invalid_estimate",
        InvalidBuffer => "input_invalid_buffer",
        InvalidSessionMinutes => "input_invalid_session_minutes",
        InvalidSessionBounds => "input_invalid_session_bounds",
        InvalidTaskWindowInstant => "input_invalid_task_window_instant",
        TaskWindowEmpty => "input_task_window_empty",
        InvalidPreference => "input_invalid_preference",
        UnknownDependency => "input_unknown_dependency",
        DependencyCycle => "input_dependency_cycle",
        InvalidWeekday => "input_invalid_weekday",
        InvalidAvailabilityWindow => "input_invalid_availability_window",
        InvalidExceptionDate => "input_invalid_exception_date",
        ExceptionPartialWindow => "input_exception_partial_window",
        InvalidExceptionWindow => "input_invalid_exception_window",
        CommitmentInvalidInstant => "input_commitment_invalid_instant",
        CommitmentEndBeforeStart => "input_commitment_end_before_start",
        CommitmentTooLong => "input_commitment_too_long",
        UnknownBlockTask => "input_unknown_block_task",
        InvalidBlockInstant => "input_invalid_block_instant",
        BlockSubMillisecond => "input_block_sub_millisecond",
        BlockOffGrid => "input_block_off_grid",
        BlockEndBeforeStart => "input_block_end_before_start",
        BlockTooLong => "input_block_too_long",
    }
}

string_enum! {
    /// Generator lines that are not a violation or an input issue.
    GeneratorExplanationCode {
        PolicySummary => "policy_summary",
        PlacementSummary => "placement_summary",
        ConstraintsSatisfied => "constraints_satisfied",
        InfeasibleSummary => "infeasible_summary",
        HeuristicInsufficientAvailableTime => "heuristic_insufficient_available_time",
        HeuristicNoContiguousWindow => "heuristic_no_contiguous_window",
        HeuristicEstimateNotGridAligned => "heuristic_estimate_not_grid_aligned",
        HeuristicEstimateBelowGrid => "heuristic_estimate_below_grid",
        HeuristicSessionBoundsInfeasible => "heuristic_session_bounds_infeasible",
        UnplacedMinutes => "unplaced_minutes",
        CapacityDeficit => "capacity_deficit",
        ReplanBoundExceeded => "replan_bound_exceeded",
        InputRejected => "input_rejected",
        HeuristicBlockedByPredecessor => "heuristic_blocked_by_predecessor",
        AutoSplitLongTask => "auto_split_long_task",
    }
}

string_enum! {
    /// Diversity-note sentences (FU-68). The replan change-bound sentence
    /// appended to a note reuses the generator's `replan_bound_exceeded`
    /// parameters.
    DiversityNoteCode {
        DiversityDropped => "diversity_dropped",
        DiversityDistinct => "diversity_distinct",
        ReplanBoundExceeded => "replan_bound_exceeded",
    }
}

/// The code of one explanation line: a generator line, an input issue or a
/// validator finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExplanationCode {
    Generator(GeneratorExplanationCode),
    InputIssue(InputIssueMessageCode),
    Violation(ViolationMessageCode),
}

impl ExplanationCode {
    /// The reference's spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Generator(code) => code.as_str(),
            Self::InputIssue(code) => code.as_str(),
            Self::Violation(code) => code.as_str(),
        }
    }

    /// Every explanation code in contract order: generator lines, input
    /// issues, violations (`EXPLANATION_CODES`).
    #[must_use]
    pub fn all() -> Vec<Self> {
        GeneratorExplanationCode::ALL
            .iter()
            .copied()
            .map(Self::Generator)
            .chain(
                InputIssueMessageCode::ALL
                    .iter()
                    .copied()
                    .map(Self::InputIssue),
            )
            .chain(
                ViolationMessageCode::ALL
                    .iter()
                    .copied()
                    .map(Self::Violation),
            )
            .collect()
    }

    /// The code spelled `text`, if any.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        GeneratorExplanationCode::parse(text)
            .map(Self::Generator)
            .or_else(|| InputIssueMessageCode::parse(text).map(Self::InputIssue))
            .or_else(|| ViolationMessageCode::parse(text).map(Self::Violation))
    }
}

impl std::fmt::Display for ExplanationCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A parameter value: a number, or an opaque id / instant / date / enum
/// token (`ExplanationParamValue`).
#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Number(f64),
    Text(String),
}

/// The parameters of one coded message, by name.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Params(Vec<(&'static str, ParamValue)>);

impl Params {
    /// No parameters.
    #[must_use]
    pub const fn none() -> Self {
        Self(Vec::new())
    }

    /// Adds a number.
    #[must_use]
    pub fn number(mut self, name: &'static str, value: f64) -> Self {
        self.0.push((name, ParamValue::Number(value)));
        self
    }

    /// Adds a token.
    #[must_use]
    pub fn text(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.0.push((name, ParamValue::Text(value.into())));
        self
    }

    /// The value of a parameter.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&ParamValue> {
        self.0
            .iter()
            .find(|(known, _)| *known == name)
            .map(|(_, value)| value)
    }

    /// Names and values, in the order they were added.
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &ParamValue)> {
        self.0.iter().map(|(name, value)| (*name, value))
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The JSON object of the parameters.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        for (name, value) in &self.0 {
            object.insert(
                (*name).to_owned(),
                match value {
                    ParamValue::Number(number) => number_value(*number),
                    ParamValue::Text(text) => Value::String(text.clone()),
                },
            );
        }
        Value::Object(object)
    }
}

/// One explanation line as a code with its parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct ExplanationItem {
    pub code: ExplanationCode,
    pub params: Params,
}

impl ExplanationItem {
    #[must_use]
    pub fn to_json(&self) -> Value {
        coded_json(self.code.as_str(), &self.params)
    }
}

/// One diversity-note sentence as a code with its parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct DiversityNoteItem {
    pub code: DiversityNoteCode,
    pub params: Params,
}

impl DiversityNoteItem {
    #[must_use]
    pub fn to_json(&self) -> Value {
        coded_json(self.code.as_str(), &self.params)
    }
}

fn coded_json(code: &str, params: &Params) -> Value {
    let mut object = Map::new();
    object.insert("code".to_owned(), Value::String(code.to_owned()));
    object.insert("params".to_owned(), params.to_json());
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// The `const` lists of `packages/contracts/openapi.json` that hold
    /// `marker`: the contract writes a closed code set as `anyOf` of consts.
    fn contract_lists(marker: &str) -> Vec<Vec<String>> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/contracts/openapi.json");
        let contract: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut lists: Vec<Vec<String>> = Vec::new();
        let mut stack = vec![&contract];
        while let Some(value) = stack.pop() {
            match value {
                Value::Array(items) => {
                    let consts: Vec<String> = items
                        .iter()
                        .filter_map(|item| item.get("const").and_then(Value::as_str))
                        .map(str::to_owned)
                        .collect();
                    if consts.len() == items.len()
                        && consts.iter().any(|code| code == marker)
                        && !lists.contains(&consts)
                    {
                        lists.push(consts);
                    }
                    stack.extend(items);
                }
                Value::Object(map) => stack.extend(map.values()),
                _ => {}
            }
        }
        assert!(!lists.is_empty(), "the contract has no list with {marker}");
        lists
    }

    fn strings<T: Copy>(all: &[T], text: impl Fn(T) -> &'static str) -> Vec<String> {
        all.iter().map(|code| text(*code).to_owned()).collect()
    }

    /// `h1_active_block_overlap` is reported by the API's storage guard, not
    /// by the scheduler.
    fn without_api_codes(list: &[String]) -> Vec<String> {
        list.iter()
            .filter(|code| *code != "h1_active_block_overlap")
            .cloned()
            .collect()
    }

    #[test]
    fn the_code_lists_are_closed_and_free_of_duplicates() {
        let all = ExplanationCode::all();
        assert_eq!(all.len(), 15 + 29 + 24);
        let unique: BTreeSet<&str> = all.iter().map(|code| code.as_str()).collect();
        assert_eq!(unique.len(), all.len());
        for code in &all {
            assert_eq!(ExplanationCode::parse(code.as_str()), Some(*code));
        }
        assert_eq!(ExplanationCode::parse("h9_made_up"), None);
        assert_eq!(ViolationMessageCode::parse("H1"), None);
        assert_eq!(ViolationCode::ALL.len(), 10);
        assert_eq!(InputIssueCode::ALL.len(), 11);
        assert_eq!(DiversityNoteCode::ALL.len(), 3);
    }

    #[test]
    fn every_finding_code_is_prefixed_by_its_constraint() {
        for code in ViolationMessageCode::ALL {
            let prefix = match code.kind() {
                ViolationCode::H0Horizon | ViolationCode::H0UnknownTask => "h0_".to_owned(),
                kind => format!("{}_", kind.as_str().to_lowercase()),
            };
            assert!(code.as_str().starts_with(&prefix), "{code} / {prefix}");
        }
        assert_eq!(
            ViolationMessageCode::H0OutsideHorizon.kind(),
            ViolationCode::H0Horizon
        );
        assert_eq!(
            ViolationMessageCode::H0UnknownTask.kind(),
            ViolationCode::H0UnknownTask
        );
    }

    #[test]
    fn the_contract_publishes_the_same_codes_in_the_same_order() {
        let explanation = strings(&ExplanationCode::all(), ExplanationCode::as_str);
        let violations = strings(ViolationMessageCode::ALL, ViolationMessageCode::as_str);
        let diversity = strings(DiversityNoteCode::ALL, DiversityNoteCode::as_str);
        let policy_lists = contract_lists("policy_summary");
        assert!(
            policy_lists
                .iter()
                .any(|list| without_api_codes(list) == explanation),
            "no contract list equals the scheduler's explanation codes: {policy_lists:?}"
        );
        // Every contract list that names a violation code is either the
        // violation list or the explanation list — nothing the scheduler
        // does not know, nothing missing.
        for list in contract_lists("h7_deficit") {
            let list = without_api_codes(&list);
            assert!(
                list == violations || list == explanation,
                "unexpected contract code list: {list:?}"
            );
        }
        assert!(
            contract_lists("h7_deficit")
                .iter()
                .any(|list| without_api_codes(list) == violations)
        );
        assert!(contract_lists("diversity_dropped").contains(&diversity));
    }

    #[test]
    fn params_keep_names_values_and_json_numbers() {
        let params = Params::none()
            .text("taskId", "A")
            .number("shortMin", 25.0)
            .number("ratio", 0.5)
            .number("huge", f64::INFINITY);
        assert_eq!(
            params.get("taskId"),
            Some(&ParamValue::Text("A".to_owned()))
        );
        assert_eq!(params.get("shortMin"), Some(&ParamValue::Number(25.0)));
        assert_eq!(params.get("missing"), None);
        assert_eq!(params.iter().count(), 4);
        assert_eq!(
            params.to_json(),
            serde_json::json!({"taskId": "A", "shortMin": 25, "ratio": 0.5, "huge": null})
        );
        assert!(Params::none().is_empty());
        assert_eq!(Params::none().to_json(), serde_json::json!({}));
        let item = ExplanationItem {
            code: ExplanationCode::Violation(ViolationMessageCode::H7Deficit),
            params: Params::none().text("taskId", "A").number("shortMin", 25.0),
        };
        assert_eq!(
            item.to_json(),
            serde_json::json!({"code": "h7_deficit", "params": {"taskId": "A", "shortMin": 25}})
        );
    }
}
