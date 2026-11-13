//! Stable JSON text and hashes for request fingerprints and body `ETag`s.

use std::fmt::Write as _;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// JSON with object keys sorted, no insignificant whitespace. Two values that
/// differ only in key order have the same text.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let mut output = String::new();
    write_canonical(value, &mut output);
    output
}

fn write_canonical(value: &Value, output: &mut String) {
    match value {
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(item, output);
            }
            output.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            output.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&Value::String(key.clone()).to_string());
                output.push(':');
                write_canonical(&map[key], output);
            }
            output.push('}');
        }
        scalar => output.push_str(&scalar.to_string()),
    }
}

/// Lowercase hex SHA-256 of `text`.
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

/// Fingerprint of a mutating request (08 §1): method, path without the query
/// string, and the body. Headers — `If-Match` in particular — are excluded,
/// so a retry after a version conflict with a fresh `If-Match` but the same
/// key and body is still the same request.
#[must_use]
pub fn request_hash(method: &str, path: &str, body: Option<&Value>) -> String {
    let fingerprint = serde_json::json!({
        "method": method,
        "path": path,
        "body": body.cloned().unwrap_or(Value::Null),
    });
    sha256_hex(&canonical_json(&fingerprint))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn key_order_and_whitespace_do_not_change_the_text() {
        let left: Value =
            serde_json::from_str(r#"{ "b": [1, {"y": null, "x": "가"}], "a": true }"#).unwrap();
        let right = json!({"a": true, "b": [1, {"x": "가", "y": null}]});
        assert_eq!(
            canonical_json(&left),
            r#"{"a":true,"b":[1,{"x":"가","y":null}]}"#
        );
        assert_eq!(canonical_json(&left), canonical_json(&right));
    }

    #[test]
    fn array_order_and_values_do_change_the_text() {
        assert_ne!(
            canonical_json(&json!([1, 2])),
            canonical_json(&json!([2, 1]))
        );
        assert_ne!(
            canonical_json(&json!({"a": 1})),
            canonical_json(&json!({"a": "1"}))
        );
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn the_request_hash_covers_method_path_and_body_only() {
        let body = json!({"title": "x"});
        let base = request_hash("POST", "/api/v1/tasks", Some(&body));
        assert_eq!(base.len(), 64);
        assert_eq!(
            base,
            request_hash("POST", "/api/v1/tasks", Some(&json!({"title": "x"})))
        );
        assert_ne!(base, request_hash("PATCH", "/api/v1/tasks", Some(&body)));
        assert_ne!(base, request_hash("POST", "/api/v1/projects", Some(&body)));
        assert_ne!(
            base,
            request_hash("POST", "/api/v1/tasks", Some(&json!({"title": "y"})))
        );
        assert_ne!(base, request_hash("POST", "/api/v1/tasks", None));
    }
}
