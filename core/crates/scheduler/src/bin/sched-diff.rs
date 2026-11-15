//! `sched-diff`: the Rust scheduler as a filter, for comparing it with the
//! TypeScript reference outside `cargo test`.
//!
//! Reads one JSON document from standard input:
//!
//! ```json
//! { "input": { … ScheduleInput … }, "options": null, "plans": [[{ "taskId": "…", "start": "…", "end": "…" }]] }
//! ```
//!
//! and writes what the scheduler computes for it (`replay::replay`:
//! `inputIssues`, `slots`, `deficit`, `result`, `resultHash`, `validation`
//! and the verdicts on `plans`) to standard output. `packages/scheduler/scripts/shrink-oracle.mts` drives it
//! to minimise an input on which the two implementations differ.
//!
//! Exit codes: 0 written, 2 the document could not be read. Messages name a
//! place in the document and never repeat a value from it.

use std::io::{Read, Write};
use std::process::ExitCode;

use ohmydate_scheduler::replay::replay;
use serde_json::Value;

fn run(text: &str) -> Result<Value, String> {
    let document: Value = serde_json::from_str(text)
        .map_err(|error| format!("standard input is not JSON ({:?})", error.classify()))?;
    let plans = match document.get("plans") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(plans)) => plans.clone(),
        Some(_) => return Err("/plans is not an array".to_owned()),
    };
    replay(
        document.get("input").unwrap_or(&Value::Null),
        document.get("options").unwrap_or(&Value::Null),
        &plans,
    )
    .map_err(|error| error.to_string())
}

fn main() -> ExitCode {
    let mut text = String::new();
    if std::io::stdin().read_to_string(&mut text).is_err() {
        let _ = writeln!(std::io::stderr(), "sched-diff: cannot read standard input");
        return ExitCode::from(2);
    }
    match run(&text) {
        Ok(output) => {
            let mut stdout = std::io::stdout().lock();
            if writeln!(stdout, "{output}").is_err() {
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Err(reason) => {
            let _ = writeln!(std::io::stderr(), "sched-diff: {reason}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_is_replayed_and_a_bad_one_is_refused_without_echoing_it() {
        let output = run(
            r#"{"input": {"now": "2026-11-13T00:00:00Z", "timeZone": "UTC",
                "horizon": {"start": "2026-11-13T00:00:00Z", "end": "2026-11-14T00:00:00Z"},
                "tasks": [], "availability": [{"weekday": 5, "startLocal": "09:00", "endLocal": "10:00", "kind": "work"}],
                "exceptions": [], "commitments": [], "lockedBlocks": [],
                "prefs": {"maxDailyFocusMin": 240, "breakAfterMin": 60, "breakMin": 15, "riskLevel": "p50",
                          "dayStartLocal": "08:00", "dayEndLocal": "18:00"},
                "seed": 1},
               "plans": [[]]}"#,
        )
        .unwrap();
        assert_eq!(output["inputIssues"], serde_json::json!([]));
        assert_eq!(
            output["slots"],
            serde_json::json!([{"start": "2026-11-13T09:00:00Z", "end": "2026-11-13T10:00:00Z"}])
        );
        assert_eq!(output["plans"], serde_json::json!([{"violations": []}]));

        let reason = run(r#"{"input": {"now": "secret note"}}"#).unwrap_err();
        assert_eq!(reason, "/horizon is missing");
        assert!(!reason.contains("secret"));
        let reason = run("{ secret note").unwrap_err();
        assert!(!reason.contains("secret"), "{reason}");
        assert!(
            run(r#"{"input": {}, "plans": 3}"#)
                .unwrap_err()
                .contains("/plans")
        );
    }
}
