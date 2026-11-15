//! What the replan tests share: block identity, the set of tasks a change
//! reaches, and the measure of how far a replan moved from the plan before
//! it. Written from 06 §7, not from the generator.

use std::collections::BTreeSet;

use ohmydate_scheduler::generate::{GenerateResult, PlanCandidate, generate};
use ohmydate_scheduler::types::{
    Block, Commitment, GenerateOptions, PolicyName, ScheduleInput, Task,
};

use super::minute_oracle::instant_ms;

/// `(task, start, end)`: what makes two blocks the same block.
pub type BlockKey = (String, String, String);

pub fn block_key(block: &Block) -> BlockKey {
    (
        block.task_id.clone(),
        block.start.clone(),
        block.end.clone(),
    )
}

/// The blocks of one task, in a fixed order.
pub fn task_blocks(blocks: &[Block], task_id: &str) -> Vec<BlockKey> {
    let mut keys: Vec<BlockKey> = blocks
        .iter()
        .filter(|block| block.task_id == task_id)
        .map(block_key)
        .collect();
    keys.sort();
    keys
}

pub fn ids(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

/// The given tasks and everything that depends on them, directly or not.
pub fn affected_tasks(tasks: &[Task], hit: &BTreeSet<String>) -> BTreeSet<String> {
    let mut affected = hit.clone();
    loop {
        let before = affected.len();
        for task in tasks {
            if task.depends_on.iter().any(|id| affected.contains(id)) {
                affected.insert(task.id.clone());
            }
        }
        if affected.len() == before {
            return affected;
        }
    }
}

/// 06 §7 maximum replan scope: the trigger set plus successors, with direct
/// predecessors released one stage at a time and their successors re-added,
/// until the set stops growing.
pub fn expanded_scope(tasks: &[Task], start: &BTreeSet<String>) -> BTreeSet<String> {
    let mut scope = affected_tasks(tasks, start);
    loop {
        let before = scope.len();
        for task in tasks {
            if scope.contains(&task.id) {
                scope.extend(task.depends_on.iter().cloned());
            }
        }
        scope = affected_tasks(tasks, &scope);
        if scope.len() == before {
            return scope;
        }
    }
}

/// The tasks with a block that overlaps the commitment.
pub fn hit_tasks(blocks: &[Block], commitment: &Commitment) -> BTreeSet<String> {
    let (start_ms, end_ms) = (instant_ms(&commitment.start), instant_ms(&commitment.end));
    blocks
        .iter()
        .filter(|block| instant_ms(&block.start) < end_ms && instant_ms(&block.end) > start_ms)
        .map(|block| block.task_id.clone())
        .collect()
}

/// How many blocks are in one plan and not in the other.
pub fn symmetric_difference(a: &[Block], b: &[Block]) -> usize {
    let keys_a: BTreeSet<BlockKey> = a.iter().map(block_key).collect();
    let keys_b: BTreeSet<BlockKey> = b.iter().map(block_key).collect();
    keys_a.symmetric_difference(&keys_b).count()
}

pub fn block_minutes(block: &Block) -> i64 {
    (instant_ms(&block.end) - instant_ms(&block.start)) / 60_000
}

/// The minutes the plan gives a task.
pub fn task_minutes(blocks: &[Block], task_id: &str) -> i64 {
    blocks
        .iter()
        .filter(|block| block.task_id == task_id)
        .map(block_minutes)
        .sum()
}

pub fn options(policy: PolicyName, seed: f64) -> GenerateOptions {
    GenerateOptions {
        policies: Some(vec![policy]),
        seed: Some(seed),
        max_local_improvement: None,
    }
}

pub fn run(input: &ScheduleInput, options: &GenerateOptions) -> GenerateResult {
    generate(input, options).unwrap()
}

/// The candidate of one policy.
pub fn plan(input: &ScheduleInput, policy: PolicyName, seed: f64) -> PlanCandidate {
    run(input, &options(policy, seed)).candidates.remove(0)
}

/// The same input as a replan over `existing`.
pub fn replanned(input: &ScheduleInput, existing: &[Block]) -> ScheduleInput {
    let mut input = input.clone();
    input.existing_blocks = Some(existing.to_vec());
    input
}

pub fn commitment(start: &str, end: &str) -> Commitment {
    Commitment {
        start: start.to_owned(),
        end: end.to_owned(),
    }
}

pub fn explains(candidate: &PlanCandidate, needle: &str) -> bool {
    candidate
        .explanation
        .iter()
        .any(|line| line.contains(needle))
}

pub fn codes(candidate: &PlanCandidate) -> Vec<&'static str> {
    candidate
        .explanation_items
        .iter()
        .map(|item| item.code.as_str())
        .collect()
}
