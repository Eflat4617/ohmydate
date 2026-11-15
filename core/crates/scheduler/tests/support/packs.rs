//! Oracle packs written by `packages/scheduler/scripts/export-oracle.mts`.
//!
//! The committed packs live in `tests/oracle/` (and `tests/oracle/regressions/`).
//! Large packs are not committed: the exporter writes them to a directory
//! named by `OHMYDATE_ORACLE_DIR` (by convention `core/target/oracle`), and
//! every `*.json` there is read as well.
//!
//! A pack holds one case per line, so a large pack is read one case at a
//! time instead of being loaded whole.

use std::fs::File;
use std::io::{BufRead, BufReader, Lines};
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const FORMAT: &str = "ohmydate-scheduler-oracle";
pub const FORMAT_VERSION: u64 = 2;

const CASES_LINE: &str = " \"cases\": [";

pub fn check_header(header: &Value) -> Result<(), String> {
    if header["format"] != FORMAT {
        return Err(format!("not an oracle pack: format {}", header["format"]));
    }
    if header["formatVersion"] != FORMAT_VERSION {
        return Err(format!(
            "unsupported formatVersion {} (this test reads {FORMAT_VERSION}; regenerate the pack \
             with `corepack pnpm run core:oracle`)",
            header["formatVersion"]
        ));
    }
    Ok(())
}

/// One pack file: its header (everything but the cases) and where it is.
pub struct Pack {
    pub name: String,
    pub header: Value,
    path: PathBuf,
}

impl Pack {
    /// Reads the header of a pack and checks format and version.
    pub fn open(path: &Path) -> Result<Self, String> {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let file = File::open(path).map_err(|error| format!("{name}: {error}"))?;
        let mut head = String::new();
        let mut found_cases = false;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|error| format!("{name}: {error}"))?;
            if line == CASES_LINE {
                found_cases = true;
                break;
            }
            head.push_str(&line);
            head.push('\n');
        }
        if !found_cases {
            return Err(format!(
                "{name}: no `\"cases\": [` line; not written by the exporter"
            ));
        }
        let head = head.trim_end().trim_end_matches(',');
        let header: Value = serde_json::from_str(&format!("{head}\n}}"))
            .map_err(|error| format!("{name}: header is not JSON: {error}"))?;
        check_header(&header).map_err(|reason| format!("{name}: {reason}"))?;
        Ok(Self {
            name,
            header,
            path: path.to_owned(),
        })
    }

    /// The cases of the pack, parsed one line at a time.
    pub fn cases(&self) -> Cases {
        let file = File::open(&self.path)
            .unwrap_or_else(|error| panic!("cannot reopen {}: {error}", self.name));
        let mut lines = BufReader::new(file).lines();
        for line in lines.by_ref() {
            if line.unwrap_or_else(|error| panic!("{}: {error}", self.name)) == CASES_LINE {
                break;
            }
        }
        Cases {
            name: self.name.clone(),
            lines,
        }
    }

    /// A primitive list of the header, for example `"partitions"`.
    pub fn primitives(&self, kind: &str) -> &Vec<Value> {
        self.header["primitives"][kind]
            .as_array()
            .unwrap_or_else(|| panic!("{}: no primitives.{kind}", self.name))
    }
}

pub struct Cases {
    name: String,
    lines: Lines<BufReader<File>>,
}

impl Iterator for Cases {
    type Item = Value;

    fn next(&mut self) -> Option<Value> {
        let line = self
            .lines
            .next()?
            .unwrap_or_else(|error| panic!("{}: {error}", self.name));
        let text = line.trim_end_matches(',');
        if !text.starts_with('{') {
            // ` ]` closes the list.
            return None;
        }
        Some(
            serde_json::from_str(text)
                .unwrap_or_else(|error| panic!("{}: a case is not JSON: {error}", self.name)),
        )
    }
}

fn json_files(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    files
}

/// Directory of the committed packs.
pub fn committed_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/oracle")
}

/// Every pack to compare against: the committed sample, the committed
/// regression packs, and the packs of `OHMYDATE_ORACLE_DIR` when it is set.
pub fn packs() -> Vec<Pack> {
    let committed = committed_directory();
    let mut files = json_files(&committed);
    assert!(
        !files.is_empty(),
        "no oracle packs in {}",
        committed.display()
    );
    files.extend(json_files(&committed.join("regressions")));
    if let Some(directory) = std::env::var_os("OHMYDATE_ORACLE_DIR") {
        // Relative paths are taken from the workspace root (`core/`), where
        // `cargo test` is started, not from the crate directory it runs in.
        let directory = PathBuf::from(directory);
        let directory = if directory.is_absolute() {
            directory
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(directory)
        };
        let extra = json_files(&directory);
        assert!(
            !extra.is_empty(),
            "OHMYDATE_ORACLE_DIR is set but {} holds no pack",
            directory.display()
        );
        files.extend(extra);
    }
    files
        .iter()
        .map(|path| Pack::open(path).unwrap_or_else(|reason| panic!("{reason}")))
        .collect()
}

/// Collects mismatches of one comparison layer and fails with all of them.
pub struct Tally {
    layer: &'static str,
    compared: usize,
    mismatches: usize,
    shown: Vec<String>,
}

impl Tally {
    const SHOWN: usize = 12;

    pub fn new(layer: &'static str) -> Self {
        Self {
            layer,
            compared: 0,
            mismatches: 0,
            shown: Vec::new(),
        }
    }

    /// Counts one comparison; `difference` describes it when it failed.
    pub fn check(&mut self, difference: Option<String>) {
        self.compared += 1;
        if let Some(text) = difference {
            self.mismatches += 1;
            if self.shown.len() < Self::SHOWN {
                self.shown.push(text);
            }
        }
    }

    pub fn compared(&self) -> usize {
        self.compared
    }

    /// Prints the layer's numbers and fails if anything differed or fewer
    /// than `at_least` comparisons were made (an empty pack must not pass).
    pub fn finish(self, at_least: usize) {
        println!(
            "oracle layer {}: {} compared, {} mismatch(es)",
            self.layer, self.compared, self.mismatches
        );
        assert!(
            self.mismatches == 0,
            "{}: {} mismatch(es) in {} comparison(s); first {}:\n{}",
            self.layer,
            self.mismatches,
            self.compared,
            self.shown.len(),
            self.shown.join("\n")
        );
        assert!(
            self.compared >= at_least,
            "{}: only {} comparison(s), expected at least {at_least}",
            self.layer,
            self.compared
        );
    }
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 160 {
        format!("{}…", text.chars().take(160).collect::<String>())
    } else {
        text
    }
}

/// The first place two JSON values differ, as `pointer: actual != expected`.
/// Numbers are equal when they are the same double.
pub fn first_difference(actual: &Value, expected: &Value) -> Option<String> {
    difference_at(actual, expected, &mut String::new())
}

fn difference_at(actual: &Value, expected: &Value, pointer: &mut String) -> Option<String> {
    let differ = |pointer: &str| {
        Some(format!(
            "{} : {} != {}",
            if pointer.is_empty() { "/" } else { pointer },
            short(actual),
            short(expected)
        ))
    };
    match (actual, expected) {
        (Value::Number(left), Value::Number(right)) => {
            let same = match (left.as_f64(), right.as_f64()) {
                (Some(left), Some(right)) => left.to_bits() == right.to_bits(),
                _ => false,
            };
            if same { None } else { differ(pointer) }
        }
        (Value::Array(left), Value::Array(right)) => {
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                let length = pointer.len();
                pointer.push_str(&format!("/{index}"));
                let found = difference_at(left, right, pointer);
                pointer.truncate(length);
                if found.is_some() {
                    return found;
                }
            }
            if left.len() == right.len() {
                None
            } else {
                Some(format!(
                    "{pointer} : {} item(s) != {} item(s); first extra: {}",
                    left.len(),
                    right.len(),
                    short(
                        left.get(right.len())
                            .or_else(|| right.get(left.len()))
                            .unwrap_or(&Value::Null)
                    )
                ))
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            for (key, left_value) in left {
                let Some(right_value) = right.get(key) else {
                    return Some(format!("{pointer}/{key} : present != absent"));
                };
                let length = pointer.len();
                pointer.push('/');
                pointer.push_str(key);
                let found = difference_at(left_value, right_value, pointer);
                pointer.truncate(length);
                if found.is_some() {
                    return found;
                }
            }
            right
                .keys()
                .find(|key| !left.contains_key(*key))
                .map(|key| format!("{pointer}/{key} : absent != present"))
        }
        _ if actual == expected => None,
        _ => differ(pointer),
    }
}
