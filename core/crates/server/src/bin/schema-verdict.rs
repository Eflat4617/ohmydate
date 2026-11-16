//! `schema-verdict`: the core's verdict on request samples, for the schema
//! comparison (blueprint 15 §11 R13; `corepack pnpm run core:schema-diff`).
//!
//! Reads one JSON object per line from standard input —
//! `{"id": 7, "operation": "createTask", "part": "body", "text": "{…}"}`,
//! where `text` is the sample as JSON text — and writes one line per sample
//! to standard output: `{"id": 7, "verdict": "valid"}`. Verdicts:
//! `valid`, `invalid`, `unreadable` (the text is not JSON the core reads),
//! `no-rule` (the core checks nothing for that part of that operation).
//!
//! A line it cannot use ends the run with exit code 2 and says only which
//! line: samples are never echoed.

use std::io::{BufRead as _, Write as _};
use std::process::ExitCode;

use ohmydate_server::contract::Contract;
use ohmydate_server::verdict;
use serde_json::{Value, json};

fn answer(line: &str) -> Option<Value> {
    let request: Value = serde_json::from_str(line).ok()?;
    let operation = Contract::embedded().operation(request.get("operation")?.as_str()?)?;
    let verdict = verdict::judge(
        operation,
        request.get("part")?.as_str()?,
        request.get("text")?.as_str()?,
    )?;
    Some(json!({"id": request.get("id")?, "verdict": verdict.as_str()}))
}

#[allow(clippy::print_stderr)]
fn main() -> ExitCode {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for (index, line) in stdin.lock().lines().enumerate() {
        let Ok(line) = line else {
            eprintln!("schema-verdict: line {} is not text", index + 1);
            return ExitCode::from(2);
        };
        if line.trim().is_empty() {
            continue;
        }
        let Some(answer) = answer(&line) else {
            eprintln!(
                "schema-verdict: line {} is not a sample (id, operation, part, text)",
                index + 1
            );
            return ExitCode::from(2);
        };
        if writeln!(stdout, "{answer}").is_err() {
            return ExitCode::from(1);
        }
    }
    ExitCode::SUCCESS
}
