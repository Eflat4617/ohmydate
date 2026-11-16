//! The differential check: replay what the TypeScript reference answered
//! (`tests/oracle/README.md`) and compare record by record. No mismatch is
//! allowed — not in an instant, not in how it is printed, not in which
//! rejection a bad input gets.

// Helpers of an integration test are test code too.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use ohmydate_recurrence::{Frequency, Rule, Series, Until, clip, expand};
use serde_json::{Value, json};

const FORMAT: &str = "ohmydate-recurrence-oracle";
const FORMAT_VERSION: u64 = 1;

/// What a pack held and where the port disagreed.
#[derive(Debug, Default)]
struct Totals {
    parsed: usize,
    parse_rejections: usize,
    expanded: usize,
    expand_rejections: usize,
    occurrences: usize,
    /// Occurrences on a wall time a clock change skipped.
    gaps: u64,
    /// Occurrences on a wall time that happened twice.
    overlaps: u64,
    clipped: usize,
    /// Rejections seen, by name.
    rejections: BTreeMap<String, usize>,
    mismatches: Vec<String>,
}

impl Totals {
    fn mismatch(&mut self, what: &str, expected: &Value, actual: &Value) {
        // Enough to find the record; a large pack must not print megabytes.
        if self.mismatches.len() < 20 {
            self.mismatches.push(format!(
                "{what}\n  reference: {expected}\n  port:      {actual}"
            ));
        } else {
            self.mismatches.push(String::new());
        }
    }

    fn summary(&self) -> String {
        let mut text = format!(
            "parse {} (rejected {}), expand {} (rejected {}), occurrences {}, \
             on a skipped wall time {}, on a repeated wall time {}, clip {}, mismatches {}",
            self.parsed,
            self.parse_rejections,
            self.expanded,
            self.expand_rejections,
            self.occurrences,
            self.gaps,
            self.overlaps,
            self.clipped,
            self.mismatches.len()
        );
        let kinds: Vec<String> = self
            .rejections
            .iter()
            .map(|(kind, count)| format!("{kind} {count}"))
            .collect();
        let _ = write!(text, "\n  rejections: {}", kinds.join(", "));
        text
    }
}

fn instant(text: &Value) -> i64 {
    let text = text.as_str().expect("an instant is a string");
    text.parse::<jiff::Timestamp>()
        .unwrap_or_else(|error| panic!("{text}: {error}"))
        .as_millisecond()
}

/// The port's answer for a `parse` record, in the record's own shape.
fn parse_answer(text: &str) -> Value {
    match Rule::parse(text) {
        Ok(rule) => {
            let (until_ms, until_date) = match rule.until {
                None => (Value::Null, Value::Null),
                Some(Until::Instant(ms)) => (json!(ms), Value::Null),
                Some(Until::Date(date)) => (
                    Value::Null,
                    json!(format!(
                        "{:04}-{:02}-{:02}",
                        date.year, date.month, date.day
                    )),
                ),
            };
            let freq = match rule.frequency {
                Frequency::Daily => "DAILY",
                Frequency::Weekly => "WEEKLY",
                Frequency::Monthly => "MONTHLY",
                Frequency::Yearly => "YEARLY",
            };
            json!({"rule": {
                "freq": freq,
                "interval": rule.interval,
                "count": rule.count,
                "untilMs": until_ms,
                "untilDate": until_date,
                "byDay": rule.by_day,
                "byMonthDay": rule.by_month_day,
            }})
        }
        Err(error) => json!({"error": error.kind()}),
    }
}

/// The port's answer for an `expand` record.
fn expand_answer(record: &Value) -> Value {
    let commitment = &record["commitment"];
    let series = Series {
        start_ms: instant(&commitment["startAt"]),
        end_ms: instant(&commitment["endAt"]),
        time_zone: commitment["timeZone"].as_str().expect("timeZone"),
        rule: commitment.get("rrule").and_then(Value::as_str),
    };
    match expand(&series, instant(&record["from"]), instant(&record["to"])) {
        Ok(occurrences) => {
            let printed: Vec<Value> = occurrences
                .iter()
                .map(|occurrence| json!([occurrence.start_at(), occurrence.end_at()]))
                .collect();
            json!({"occurrences": printed})
        }
        Err(error) => json!({"error": error.kind()}),
    }
}

fn clip_answer(record: &Value) -> Value {
    let clipped = clip(
        instant(&record["occurrence"][0]),
        instant(&record["occurrence"][1]),
        instant(&record["from"]),
        instant(&record["to"]),
    );
    json!({"clipped": clipped.map(|part| json!([part.start_at(), part.end_at()]))})
}

/// The part of a record that is the reference's answer.
fn expected(record: &Value, keys: &[&str]) -> Value {
    let mut answer = serde_json::Map::new();
    for key in keys {
        if let Some(value) = record.get(*key) {
            answer.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(answer)
}

fn check_record(record: &Value, totals: &mut Totals) {
    let reject = |totals: &mut Totals, answer: &Value| {
        if let Some(kind) = answer.get("error").and_then(Value::as_str) {
            *totals.rejections.entry(kind.to_owned()).or_default() += 1;
            true
        } else {
            false
        }
    };
    match record["t"].as_str() {
        Some("parse") => {
            let text = record["rrule"].as_str().expect("rrule");
            let reference = expected(record, &["rule", "error"]);
            let port = parse_answer(text);
            totals.parsed += 1;
            if reject(totals, &reference) {
                totals.parse_rejections += 1;
            }
            if port != reference {
                totals.mismatch(&format!("parse {text:?}"), &reference, &port);
            }
        }
        Some("expand") => {
            let reference = expected(record, &["occurrences", "error"]);
            let port = expand_answer(record);
            totals.expanded += 1;
            if reject(totals, &reference) {
                totals.expand_rejections += 1;
            }
            totals.occurrences += reference["occurrences"].as_array().map_or(0, Vec::len);
            totals.gaps += record["gaps"].as_u64().unwrap_or(0);
            totals.overlaps += record["overlaps"].as_u64().unwrap_or(0);
            if port != reference {
                let what = format!(
                    "expand {} {} [{} .. {})",
                    record["id"], record["commitment"], record["from"], record["to"]
                );
                totals.mismatch(&what, &reference, &port);
            }
        }
        Some("clip") => {
            let reference = expected(record, &["clipped"]);
            let port = clip_answer(record);
            totals.clipped += 1;
            if port != reference {
                totals.mismatch(&format!("clip {record}"), &reference, &port);
            }
        }
        other => panic!("unknown record type {other:?}: regenerate the pack"),
    }
}

/// Replays a pack: a header line, then one record per line.
fn check_lines(lines: impl Iterator<Item = String>) -> Result<Totals, String> {
    let mut totals = Totals::default();
    let mut lines = lines.filter(|line| !line.trim().is_empty());
    let header: Value = lines
        .next()
        .and_then(|line| serde_json::from_str(&line).ok())
        .ok_or("the pack has no header line")?;
    if header["format"] != FORMAT || header["formatVersion"] != FORMAT_VERSION {
        return Err(format!(
            "this is not a {FORMAT} pack of version {FORMAT_VERSION}: make it again with \
             `corepack pnpm run core:rrule-oracle`"
        ));
    }
    for line in lines {
        let record: Value =
            serde_json::from_str(&line).map_err(|error| format!("unreadable record: {error}"))?;
        check_record(&record, &mut totals);
    }
    Ok(totals)
}

fn check_pack(path: &Path) -> Totals {
    let file = File::open(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let lines = BufReader::new(file)
        .lines()
        .map(|line| line.expect("a line of text"));
    check_lines(lines).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn sample_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/oracle/sample.jsonl")
}

fn sample_lines() -> Vec<String> {
    std::fs::read_to_string(sample_path())
        .expect("the committed sample")
        .lines()
        .map(str::to_owned)
        .collect()
}

fn assert_no_mismatch(name: &str, totals: &Totals) {
    println!("{name}: {}", totals.summary());
    assert!(
        totals.mismatches.is_empty(),
        "{name}: {} mismatches with the reference\n{}",
        totals.mismatches.len(),
        totals.mismatches.join("\n")
    );
}

#[test]
fn the_committed_sample_matches_the_reference() {
    let totals = check_pack(&sample_path());
    assert_no_mismatch("sample", &totals);
    // A pack that lost its cases must not pass as "no mismatch".
    assert!(totals.parsed >= 600, "{}", totals.summary());
    assert!(totals.parse_rejections >= 400, "{}", totals.summary());
    assert!(totals.expanded >= 400, "{}", totals.summary());
    assert!(totals.occurrences >= 4_000, "{}", totals.summary());
    assert!(totals.gaps >= 50, "{}", totals.summary());
    assert!(totals.overlaps >= 50, "{}", totals.summary());
    assert!(totals.clipped >= 40, "{}", totals.summary());
    // Every rejection the reference has shows up at least once.
    for kind in [
        "malformed_part",
        "unsupported_part",
        "duplicate_part",
        "unsupported_freq",
        "interval",
        "count_and_until",
        "count",
        "until_date",
        "until_instant",
        "until_value",
        "byday_needs_weekly",
        "byday_value",
        "bymonthday_needs_monthly",
        "bymonthday_value",
        "wkst",
        "invalid_range",
        "range_too_long",
        "invalid_interval",
        "too_many_occurrences",
        "safety_bound",
    ] {
        assert!(
            totals.rejections.contains_key(kind),
            "the sample has no {kind} case: {}",
            totals.summary()
        );
    }
}

/// Large packs are not committed. `corepack pnpm run core:rrule-diff` writes
/// one into `core/target/recurrence-oracle/` and points this test at it.
#[test]
fn packs_of_the_oracle_directory_match_the_reference() {
    let Some(directory) = std::env::var_os("OHMYDATE_RECURRENCE_ORACLE_DIR") else {
        return;
    };
    // A relative path is taken from the workspace (`core/`), where the
    // command is run; cargo runs the test itself in the crate's directory.
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(directory);
    let mut packs: Vec<PathBuf> = std::fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect();
    packs.sort();
    assert!(!packs.is_empty(), "no pack in the oracle directory");
    for pack in packs {
        let totals = check_pack(&pack);
        assert_no_mismatch(&pack.display().to_string(), &totals);
        assert!(totals.expanded > 0 && totals.parsed > 0, "an empty pack");
    }
}

// The comparison itself, on records with a known answer.

fn pack_of(records: &[Value]) -> Vec<String> {
    let header = json!({"format": FORMAT, "formatVersion": FORMAT_VERSION});
    std::iter::once(&header)
        .chain(records)
        .map(Value::to_string)
        .collect()
}

#[test]
fn a_different_instant_form_or_rejection_is_a_mismatch() {
    let series = json!({
        "startAt": "2026-11-11T09:00:00.000Z",
        "endAt": "2026-11-11T10:00:00.000Z",
        "timeZone": "UTC",
        "rrule": "FREQ=DAILY;COUNT=2",
    });
    let record = |answer: Value| {
        let mut record = json!({
            "t": "expand", "id": "case", "kind": "hand", "commitment": series,
            "from": "2026-11-11T00:00:00.000Z", "to": "2026-11-20T00:00:00.000Z",
        });
        for (key, value) in answer.as_object().unwrap() {
            record[key] = value.clone();
        }
        record
    };
    let right = json!({"occurrences": [
        ["2026-11-11T09:00:00Z", "2026-11-11T10:00:00Z"],
        ["2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z"],
    ]});
    let good = check_lines(pack_of(&[record(right)]).into_iter()).unwrap();
    assert!(good.mismatches.is_empty(), "{:?}", good.mismatches);
    assert_eq!((good.expanded, good.occurrences), (1, 2));

    for wrong in [
        // One second off.
        json!({"occurrences": [
            ["2026-11-11T09:00:00Z", "2026-11-11T10:00:00Z"],
            ["2026-11-12T09:00:01Z", "2026-11-12T10:00:00Z"],
        ]}),
        // The same instants, printed with a fraction.
        json!({"occurrences": [
            ["2026-11-11T09:00:00.000Z", "2026-11-11T10:00:00.000Z"],
            ["2026-11-12T09:00:00.000Z", "2026-11-12T10:00:00.000Z"],
        ]}),
        // One occurrence fewer, one more, another order.
        json!({"occurrences": [["2026-11-11T09:00:00Z", "2026-11-11T10:00:00Z"]]}),
        json!({"occurrences": [
            ["2026-11-11T09:00:00Z", "2026-11-11T10:00:00Z"],
            ["2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z"],
            ["2026-11-13T09:00:00Z", "2026-11-13T10:00:00Z"],
        ]}),
        json!({"occurrences": [
            ["2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z"],
            ["2026-11-11T09:00:00Z", "2026-11-11T10:00:00Z"],
        ]}),
        // A rejection where the port answers.
        json!({"error": "too_many_occurrences"}),
    ] {
        let totals = check_lines(pack_of(&[record(wrong.clone())]).into_iter()).unwrap();
        assert_eq!(totals.mismatches.len(), 1, "{wrong}");
    }
}

#[test]
fn a_different_parse_or_clip_answer_is_a_mismatch() {
    let rule = |count: i64| {
        json!({"freq": "DAILY", "interval": 1, "count": count, "untilMs": null,
               "untilDate": null, "byDay": [], "byMonthDay": []})
    };
    let cases = [
        (
            json!({"t": "parse", "rrule": "FREQ=DAILY;COUNT=3", "rule": rule(3)}),
            0,
        ),
        (
            json!({"t": "parse", "rrule": "FREQ=DAILY;COUNT=3", "rule": rule(4)}),
            1,
        ),
        (
            json!({"t": "parse", "rrule": "FREQ=DAILY;COUNT=3", "error": "count"}),
            1,
        ),
        (
            json!({"t": "parse", "rrule": "FREQ=DAILY;COUNT=0", "error": "count"}),
            0,
        ),
        // The right verdict with the wrong reason is still a mismatch.
        (
            json!({"t": "parse", "rrule": "FREQ=DAILY;COUNT=0", "error": "interval"}),
            1,
        ),
        (
            json!({"t": "parse", "rrule": "FREQ=DAILY;COUNT=0", "rule": rule(0)}),
            1,
        ),
        (
            json!({"t": "clip", "occurrence": ["2026-11-11T09:00:00.000Z", "2026-11-11T10:00:00.000Z"],
                   "from": "2026-11-11T09:30:00.000Z", "to": "2026-11-11T12:00:00.000Z",
                   "clipped": ["2026-11-11T09:30:00.000Z", "2026-11-11T10:00:00.000Z"]}),
            0,
        ),
        (
            json!({"t": "clip", "occurrence": ["2026-11-11T09:00:00.000Z", "2026-11-11T10:00:00.000Z"],
                   "from": "2026-11-11T09:30:00.000Z", "to": "2026-11-11T12:00:00.000Z",
                   "clipped": null}),
            1,
        ),
    ];
    for (record, mismatches) in cases {
        let totals = check_lines(pack_of(std::slice::from_ref(&record)).into_iter()).unwrap();
        assert_eq!(totals.mismatches.len(), mismatches, "{record}");
    }
}

#[test]
fn a_pack_of_another_format_is_refused_not_skipped() {
    let other_version = json!({"format": FORMAT, "formatVersion": FORMAT_VERSION + 1});
    let error = check_lines(std::iter::once(other_version.to_string())).unwrap_err();
    assert!(error.contains("core:rrule-oracle"), "{error}");
    let other_format = json!({"format": "ohmydate-scheduler-oracle", "formatVersion": 1});
    assert!(check_lines(std::iter::once(other_format.to_string())).is_err());
    assert!(check_lines(std::iter::empty()).is_err());
    let broken = [
        json!({"format": FORMAT, "formatVersion": 1}).to_string(),
        "{".into(),
    ];
    assert!(check_lines(broken.into_iter()).is_err());
}

#[test]
fn the_sample_says_where_it_comes_from() {
    let lines = sample_lines();
    let header: Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(header["format"], FORMAT);
    assert!(
        header["oracle"]["tzdata"]
            .as_str()
            .is_some_and(|tz| !tz.is_empty())
    );
    assert!(header["oracle"]["seed"].as_u64().is_some());
    // ASCII only: some rules hold characters that tools take for line breaks.
    assert!(lines.iter().all(|line| line.is_ascii()));
}
