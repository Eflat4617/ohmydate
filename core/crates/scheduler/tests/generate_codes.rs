//! The generator half of `packages/scheduler/test/explanation-codes.test.ts`
//! (FU-62) and `fu64-68.test.ts` (FU-68): every explanation line and every
//! diversity-note sentence the generator writes travels with a closed code
//! whose parameters reproduce the English text.

#![allow(clippy::unwrap_used)]

mod support;

use std::collections::BTreeSet;
use std::path::PathBuf;

use ohmydate_scheduler::codes::{
    DiversityNoteCode, DiversityNoteItem, ExplanationCode, GeneratorExplanationCode, ParamValue,
    Params,
};
use ohmydate_scheduler::generate::{
    GenerateResult, MAX_DIVERSITY_NOTE_LENGTH, PlanCandidate, append_bound_diversity_lines,
    generate,
};
use ohmydate_scheduler::js::number_to_string;
use ohmydate_scheduler::types::{GenerateOptions, PolicyName, ScheduleInput};
use support::scenarios::{
    generator_scenarios, input, input_scenarios, multi_replan_input, violation_scenarios,
};
use support::templates::check_coded;

fn all(input: &ScheduleInput) -> GenerateResult {
    generate(input, &GenerateOptions::default()).unwrap()
}

fn golden_inputs() -> Vec<ScheduleInput> {
    let directory =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/scheduler/test/golden");
    let mut files: Vec<PathBuf> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| {
            let fixture: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            ScheduleInput::from_json(&fixture["input"]).unwrap()
        })
        .collect()
}

/// The FU-62 invariant for one candidate: one valid coded item per line.
fn check_coded_explanation(candidate: &PlanCandidate) -> Result<(), String> {
    if candidate.explanation.len() != candidate.explanation_items.len() {
        return Err(format!(
            "{} lines but {} items",
            candidate.explanation.len(),
            candidate.explanation_items.len()
        ));
    }
    for (line, item) in candidate
        .explanation
        .iter()
        .zip(&candidate.explanation_items)
    {
        // Input issue lines are `<issue kind>: <message>`.
        let text = match item.code {
            ExplanationCode::InputIssue(_) => line
                .split_once(": ")
                .filter(|(kind, _)| kind.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
                .map(|(_, message)| message)
                .ok_or_else(|| format!("not an issue line: {line}"))?,
            _ => line.as_str(),
        };
        check_coded(item.code, &item.params, text)?;
    }
    Ok(())
}

fn diversity_text(item: &DiversityNoteItem) -> String {
    let number = |name: &str| match item.params.get(name) {
        Some(ParamValue::Number(value)) if value.is_finite() => number_to_string(*value),
        other => panic!("{}: {name} is {other:?}", item.code),
    };
    match item.code {
        DiversityNoteCode::DiversityDropped => format!(
            "{} distinct plan(s) from {} policy candidate(s); {} candidate(s) dropped as too similar (distance < 0.15).",
            number("kept"),
            number("total"),
            number("dropped")
        ),
        // Kept candidates equal the input candidates in this branch.
        DiversityNoteCode::DiversityDistinct => format!(
            "{0} distinct plans from {0} policy candidates (pairwise distance >= 0.15).",
            number("total")
        ),
        DiversityNoteCode::ReplanBoundExceeded => bound_text(
            &number("changedBlocks"),
            &number("bound"),
            &number("affectedExistingBlocks"),
        ),
    }
}

fn bound_text(changed: &str, bound: &str, affected: &str) -> String {
    format!(
        "Replan change bound exceeded: {changed} changed block(s) > {bound} (2 × {affected} affected existing block(s) + 2). Unaffected blocks were preserved; this candidate is the best available."
    )
}

/// The FU-68 invariant: the note is its items' sentences joined by a space.
fn check_coded_diversity_note(result: &GenerateResult) -> Result<(), String> {
    match (&result.diversity_note, &result.diversity_note_items) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err("items without a note".to_owned()),
        (Some(_), None) => Err("a note without items".to_owned()),
        (Some(note), Some(items)) => {
            let rendered: Vec<String> = items.iter().map(diversity_text).collect();
            if items.is_empty() || rendered.join(" ") != *note {
                return Err(format!("the note is not its items: {note}"));
            }
            Ok(())
        }
    }
}

fn note_codes(result: &GenerateResult) -> Vec<&'static str> {
    result
        .diversity_note_items
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|item| item.code.as_str())
        .collect()
}

#[test]
fn emits_a_coded_item_for_every_explanation_line_the_generator_writes() {
    let mut seen = BTreeSet::new();
    let mut check = |name: &str, scenario: &ScheduleInput| {
        let result = all(scenario);
        assert!(!result.candidates.is_empty(), "{name}");
        for candidate in &result.candidates {
            check_coded_explanation(candidate).unwrap_or_else(|reason| panic!("{name}: {reason}"));
            seen.extend(
                candidate
                    .explanation_items
                    .iter()
                    .map(|item| item.code.as_str()),
            );
        }
    };
    for (name, scenario) in generator_scenarios().iter().chain(&input_scenarios()) {
        check(name, scenario);
    }
    for (name, mut scenario, blocks) in violation_scenarios() {
        // Use the scenario blocks as locked work so the generator reports
        // them.
        scenario.locked_blocks.extend(blocks);
        check(name, &scenario);
    }

    // `build_chunks` keeps an `estimate_below_grid` branch for a positive
    // remainder that rounds to zero grid cells, but every such remainder is
    // also off the grid and reports `estimate_not_grid_aligned` first. The
    // code stays in the closed list, and this pins that it is the only
    // generator code no input reaches.
    let defensive = GeneratorExplanationCode::HeuristicEstimateBelowGrid.as_str();
    for code in GeneratorExplanationCode::ALL {
        assert_eq!(
            seen.contains(code.as_str()),
            code.as_str() != defensive,
            "{code}"
        );
    }
}

#[test]
fn keeps_explanations_coded_across_every_golden_fixture() {
    let fixtures = golden_inputs();
    assert_eq!(fixtures.len(), 15);
    for fixture in &fixtures {
        let result = all(fixture);
        assert!(!result.candidates.is_empty());
        for candidate in &result.candidates {
            assert_eq!(check_coded_explanation(candidate), Ok(()));
            assert!(candidate.explanation.len() <= 50);
        }
    }
}

#[test]
fn detects_a_line_without_an_item_or_with_another_code() {
    let candidate = all(&input()).candidates.remove(0);
    assert_eq!(check_coded_explanation(&candidate), Ok(()));
    let mut stripped = candidate.clone();
    stripped.explanation_items.remove(0);
    assert!(check_coded_explanation(&stripped).is_err());
    let mut mislabelled = candidate.clone();
    for item in &mut mislabelled.explanation_items {
        if item.code.as_str() == "constraints_satisfied" {
            item.code = ExplanationCode::Generator(GeneratorExplanationCode::UnplacedMinutes);
            item.params = Params::none().number("deficitMin", 0.0);
        }
    }
    assert_ne!(mislabelled.explanation_items, candidate.explanation_items);
    assert!(check_coded_explanation(&mislabelled).is_err());
    let mut reworded = candidate;
    reworded.explanation[1] = reworded.explanation[1].replace("60", "61");
    assert!(check_coded_explanation(&reworded).is_err());
}

#[test]
fn codes_every_diversity_note_the_generator_emits() {
    let mut seen = BTreeSet::new();
    let replan_bound = generator_scenarios()
        .into_iter()
        .find(|(name, _)| *name == "replan bound")
        .unwrap()
        .1;
    let mut inputs = golden_inputs();
    inputs.extend([input(), replan_bound, multi_replan_input()]);
    for scenario in &inputs {
        let result = all(scenario);
        assert_eq!(check_coded_diversity_note(&result), Ok(()));
        let length = result
            .diversity_note
            .as_deref()
            .unwrap_or("")
            .encode_utf16()
            .count();
        assert!(length <= MAX_DIVERSITY_NOTE_LENGTH);
        seen.extend(note_codes(&result));
    }
    let published: BTreeSet<&str> = DiversityNoteCode::ALL
        .iter()
        .map(|code| code.as_str())
        .collect();
    assert_eq!(seen, published);
}

#[test]
fn reaches_each_of_the_three_note_codes_on_its_own_fixture() {
    // Three policies on one easy task give near-identical plans.
    let dropped = all(&input());
    assert_eq!(note_codes(&dropped), ["diversity_dropped"]);
    // A multi-task replan keeps three genuinely distinct policy plans.
    let distinct = all(&multi_replan_input());
    assert_eq!(
        note_codes(&distinct),
        ["diversity_distinct", "replan_bound_exceeded"]
    );
    assert!(
        distinct
            .diversity_note
            .as_deref()
            .unwrap()
            .starts_with("3 distinct plans from 3 policy candidates")
    );
    assert_eq!(check_coded_diversity_note(&distinct), Ok(()));
    // A single policy can produce a note that is only the bound sentence.
    let replan_bound = &generator_scenarios()[6].1;
    let bounded = generate(
        replan_bound,
        &GenerateOptions {
            policies: Some(vec![PolicyName::Balanced]),
            ..GenerateOptions::default()
        },
    )
    .unwrap();
    assert_eq!(note_codes(&bounded), ["replan_bound_exceeded"]);
    assert!(
        bounded
            .diversity_note
            .as_deref()
            .unwrap()
            .starts_with("Replan change bound exceeded:")
    );
    assert_eq!(check_coded_diversity_note(&bounded), Ok(()));
    // A wrong pairing is noticed.
    let mut unpaired = bounded;
    unpaired.diversity_note_items = None;
    assert!(check_coded_diversity_note(&unpaired).is_err());
    let mut reworded = distinct;
    reworded.diversity_note = reworded
        .diversity_note
        .map(|note| note.replace("3 distinct", "2 distinct"));
    assert!(check_coded_diversity_note(&reworded).is_err());
}

#[test]
fn caps_a_joined_note_at_500_characters_and_drops_text_with_its_item() {
    let base_note = "3 distinct plans from 3 policy candidates (pairwise distance >= 0.15).";
    let bound_line = |changed: f64| bound_text(&number_to_string(changed), "6", "2");
    let bound_item = |changed: f64| DiversityNoteItem {
        code: DiversityNoteCode::ReplanBoundExceeded,
        params: Params::none()
            .number("changedBlocks", changed)
            .number("bound", 6.0)
            .number("affectedExistingBlocks", 2.0),
    };
    let paired = |changed: f64| (bound_line(changed), Some(bound_item(changed)));
    let (note, items) = append_bound_diversity_lines(
        Some(base_note),
        &[],
        &[paired(31.0), paired(33.0), paired(35.0)],
    );
    let note = note.unwrap();
    assert!(note.encode_utf16().count() <= MAX_DIVERSITY_NOTE_LENGTH);
    // At least one of the three sentences had to be dropped to fit, and
    // every surviving sentence still has its item, in order.
    assert!(!items.is_empty() && items.len() < 3);
    let expected: Vec<String> = std::iter::once(base_note.to_owned())
        .chain(items.iter().map(diversity_text))
        .collect();
    assert_eq!(note, expected.join(" "));

    // A bound line without a coded item keeps its English text (legacy
    // fallback) …
    let (note, items) =
        append_bound_diversity_lines(Some("base note"), &[], &[(bound_line(31.0), None)]);
    assert_eq!(note.unwrap(), format!("base note {}", bound_line(31.0)));
    assert_eq!(items, Vec::new());
    // … and one unpaired kept line drops every item (FU-88), so the client
    // shows the full English note instead of a partial coded one.
    let (note, items) = append_bound_diversity_lines(
        Some("base note"),
        &[],
        &[(bound_line(31.0), None), paired(33.0)],
    );
    assert_eq!(
        note.unwrap(),
        format!("base note {} {}", bound_line(31.0), bound_line(33.0))
    );
    assert_eq!(items, Vec::new());
    // Nothing to say stays nothing.
    assert_eq!(
        append_bound_diversity_lines(None, &[], &[]),
        (None, Vec::new())
    );
    let (note, items) = append_bound_diversity_lines(None, &[], &[paired(31.0)]);
    assert_eq!(note.unwrap(), bound_line(31.0));
    assert_eq!(items.len(), 1);
}
