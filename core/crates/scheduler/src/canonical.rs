//! Canonical JSON and SHA-256: a port of `packages/scheduler/src/hash.ts`.
//!
//! `inputHash` and the differential tests hash canonical JSON, so the text
//! must equal what JavaScript produces:
//!
//! * object keys sorted as JavaScript sorts strings — by UTF-16 code units,
//!   not by Unicode scalar values or UTF-8 bytes;
//! * numbers printed by the ECMAScript `Number::toString` algorithm
//!   (`1e+21`, `1e-7`, `5` for `5.0`). Every JSON number is a double in
//!   JavaScript, so integers above 2^53 lose precision here too;
//! * strings escaped as `JSON.stringify` escapes them.

use std::cmp::Ordering;
use std::fmt::Write as _;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// JavaScript's default string order.
#[must_use]
pub fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `Number.prototype.toString()` of a finite double. JSON cannot hold
/// non-finite numbers; like `JSON.stringify`, they are written as `null`.
#[must_use]
pub fn js_number(number: f64) -> String {
    if number.is_finite() {
        ryu_js::Buffer::new().format_finite(number).to_owned()
    } else {
        "null".to_owned()
    }
}

/// `JSON.stringify` of a string.
fn write_string(text: &str, output: &mut String) {
    output.push('"');
    for character in text.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control < '\u{20}' => {
                // Writing to a String cannot fail.
                let _ = write!(output, "\\u{:04x}", u32::from(control));
            }
            other => output.push(other),
        }
    }
    output.push('"');
}

fn write_value(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(flag) => output.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            output.push_str(&number.as_f64().map_or_else(|| "null".to_owned(), js_number));
        }
        Value::String(text) => write_string(text, output),
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(item, output);
            }
            output.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| compare_utf16(left, right));
            output.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_string(key, output);
                output.push(':');
                write_value(&map[key], output);
            }
            output.push('}');
        }
    }
}

/// Deterministic JSON text with recursively sorted object keys.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let mut output = String::new();
    write_value(value, &mut output);
    output
}

/// Lowercase hex SHA-256 of the UTF-8 encoding of `text`.
#[must_use]
pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        // Writing to a String cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        for (number, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (5.0, "5"),
            (-17.0, "-17"),
            (0.1, "0.1"),
            (12.5, "12.5"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.000_001, "0.000001"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (f64::MAX, "1.7976931348623157e+308"),
        ] {
            assert_eq!(js_number(number), text);
        }
        assert_eq!(js_number(f64::NAN), "null");
        assert_eq!(js_number(f64::INFINITY), "null");
    }

    #[test]
    fn keys_sort_by_utf16_code_units() {
        // U+FF5E (BMP, one unit 0xFF5E) sorts after U+1F600 (surrogates
        // 0xD83D 0xDE00) in UTF-16, but before it by scalar value.
        assert_eq!(compare_utf16("\u{ff5e}", "\u{1f600}"), Ordering::Greater);
        assert_eq!("\u{ff5e}".cmp("\u{1f600}"), Ordering::Less);
        let value = json!({"b": 1, "a": 2, "A": 3, "10": 4, "9": 5, "": 6});
        assert_eq!(
            canonical_json(&value),
            r#"{"":6,"10":4,"9":5,"A":3,"a":2,"b":1}"#
        );
    }

    #[test]
    fn strings_are_escaped_like_json_stringify() {
        assert_eq!(canonical_json(&json!("a\"b\\c/d")), r#""a\"b\\c/d""#);
        assert_eq!(
            canonical_json(&json!("\u{0}\u{1f}\u{8}\u{c}\n\r\t")),
            r#""\u0000\u001f\b\f\n\r\t""#
        );
        // DEL and the line separators are not escaped.
        assert_eq!(
            canonical_json(&json!("\u{7f}\u{2028}한")),
            "\"\u{7f}\u{2028}한\""
        );
    }

    #[test]
    fn structure_is_preserved_and_whitespace_free() {
        let value = json!([1, [2, {"y": null, "x": true}], {}]);
        assert_eq!(canonical_json(&value), r#"[1,[2,{"x":true,"y":null}],{}]"#);
        assert_ne!(
            canonical_json(&json!([1, 2])),
            canonical_json(&json!([2, 1]))
        );
    }

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(sha256_hex("abc"), sha256_hex("abd"));
    }
}
