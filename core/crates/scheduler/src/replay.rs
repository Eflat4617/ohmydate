//! Replays one oracle case: runs every ported layer on an input and returns
//! what the reference exporter records for it, in the same JSON shape.
//!
//! The differential test (`tests/oracle.rs`), the `sched-diff` binary and
//! through it the oracle shrinker (`packages/scheduler/scripts/shrink-oracle.mts`)
//! all compare this value with the reference's.

use serde_json::{Map, Value};

use crate::canonical::{canonical_json, sha256_hex};
use crate::explain::deficit;
use crate::generate::generate;
use crate::slots::compute_available_slots;
use crate::time::parse_instant;
use crate::types::{Block, GenerateOptions, ScheduleInput, ShapeError, Slot};
use crate::validate::{ValidateOptions, Violation, validate, validate_input};

/// The existing blocks that started before `now`: the history the exporter
/// passes to `validate`. Empty when `now` or any block start cannot be read.
#[must_use]
pub fn history_blocks(input: &ScheduleInput) -> Vec<Block> {
    let Ok(now_ms) = parse_instant(&input.now) else {
        return Vec::new();
    };
    let mut history = Vec::new();
    for block in input.existing() {
        match parse_instant(&block.start) {
            Ok(start_ms) if start_ms < now_ms => history.push(block.clone()),
            Ok(_) => {}
            Err(_) => return Vec::new(),
        }
    }
    history
}

/// `validate(input, blocks, { riskLevel, historyBlocks })` as the exporter
/// records it: the violations, or `null` where the reference throws.
#[must_use]
pub fn audit(input: &ScheduleInput, history: &[Block], blocks: &[Block]) -> Value {
    let options = ValidateOptions {
        risk_level: input.prefs.risk_level,
        history_blocks: history,
    };
    validate(input, blocks, &options).map_or(Value::Null, |violations| {
        Value::Array(violations.iter().map(Violation::to_json).collect())
    })
}

/// Reads a plan: a JSON array of `{ taskId, start, end }`.
pub fn read_plan(value: &Value, pointer: &str) -> Result<Vec<Block>, ShapeError> {
    value
        .as_array()
        .ok_or_else(|| ShapeError {
            pointer: pointer.to_owned(),
            problem: crate::types::ShapeProblem::NotAnArray,
        })?
        .iter()
        .enumerate()
        .map(|(index, block)| Block::from_json(block, &format!("{pointer}/{index}")))
        .collect()
}

/// Everything the scheduler computes for one case, as the exporter records
/// it: `inputIssues`, `slots`, `deficit`, `result` with its `resultHash`,
/// and `validation` of every candidate.
///
/// `plans` are extra block lists to audit (the exporter's `probes`); their
/// verdicts come back as `plans[].violations`. `result` is `null` where the
/// reference's `generate` throws.
pub fn replay(input: &Value, options: &Value, plans: &[Value]) -> Result<Value, ShapeError> {
    let input = ScheduleInput::from_json(input)?;
    let options = GenerateOptions::from_json(options)?;
    let history = history_blocks(&input);

    let mut output = Map::new();
    output.insert(
        "inputIssues".into(),
        Value::Array(
            validate_input(&input)
                .iter()
                .map(crate::validate::InputIssue::to_json)
                .collect(),
        ),
    );
    output.insert(
        "slots".into(),
        compute_available_slots(&input).map_or(Value::Null, |slots| {
            Value::Array(slots.iter().map(Slot::to_json).collect())
        }),
    );
    output.insert(
        "deficit".into(),
        deficit(&input).map_or(Value::Null, |report| report.to_json()),
    );
    match generate(&input, &options) {
        Ok(result) => {
            let validation: Vec<Value> = result
                .candidates
                .iter()
                .map(|candidate| {
                    let mut entry = Map::new();
                    entry.insert(
                        "policy".into(),
                        Value::String(candidate.policy.as_str().into()),
                    );
                    entry.insert(
                        "violations".into(),
                        audit(&input, &history, &candidate.blocks),
                    );
                    Value::Object(entry)
                })
                .collect();
            let result = result.to_json();
            output.insert(
                "resultHash".into(),
                Value::String(sha256_hex(&canonical_json(&result))),
            );
            output.insert("result".into(), result);
            output.insert("validation".into(), Value::Array(validation));
        }
        Err(_) => {
            output.insert("result".into(), Value::Null);
        }
    }
    let mut audited = Vec::with_capacity(plans.len());
    for (index, plan) in plans.iter().enumerate() {
        let blocks = read_plan(plan, &format!("/plans/{index}"))?;
        let mut entry = Map::new();
        entry.insert("violations".into(), audit(&input, &history, &blocks));
        audited.push(Value::Object(entry));
    }
    output.insert("plans".into(), Value::Array(audited));
    Ok(Value::Object(output))
}
