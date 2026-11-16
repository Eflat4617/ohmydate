//! The contract's header rules (08 §1): `If-Match`, `Idempotency-Key`,
//! `If-None-Match` and `ETag`. A port of `services/api/src/http/headers.ts`.

use ohmydate_domain::Version;

use crate::contract::IfMatchRule;
use crate::problem::Problem;

/// `W/"<version>"`.
#[must_use]
pub fn etag_for_version(version: Version) -> String {
    format!("W/\"{version}\"")
}

/// `W/"availability:<n>"`: the tag of the available hours, and what a plan
/// approval names in `If-Match` (08 §2.4a).
#[must_use]
pub fn etag_for_availability(version: Version) -> String {
    format!("W/\"availability:{version}\"")
}

/// `W/"<16 hex>"` over the canonical JSON of a list body.
#[must_use]
pub fn etag_for_body(body: &serde_json::Value) -> String {
    let hash = crate::canonical::sha256_hex(&crate::canonical::canonical_json(body));
    format!("W/\"{}\"", &hash[..16])
}

/// True when an `If-None-Match` header names `etag` (weak comparison) or `*`.
#[must_use]
pub fn if_none_match(header: Option<&str>, etag: &str) -> bool {
    let Some(header) = header else {
        return false;
    };
    let strong = etag.strip_prefix("W/").unwrap_or(etag);
    header
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == "*" || candidate == etag || candidate == strong)
}

/// The number of a version tag: digits without a leading zero, as the
/// contract's pattern says (`[1-9][0-9]*`).
///
/// A number too large for a version is still a well-formed tag — the
/// contract puts no limit on the digits — so it is not refused here (400).
/// It is read as the largest version, which no entity has, and the handler
/// answers what it answers for any tag that is not current: 412. (An entity
/// would need four billion changes to reach that version.)
fn positive_integer(text: &str) -> Option<u32> {
    let valid = !text.is_empty()
        && !text.starts_with('0')
        && text.bytes().all(|byte| byte.is_ascii_digit());
    valid.then(|| text.parse().unwrap_or(u32::MAX))
}

/// Checks an `If-None-Match` header the contract declares: when it is sent
/// it names at least one tag (`minLength: 1`). An empty one is 400, as in
/// the reference; one that names no current tag is simply not a match.
pub fn check_if_none_match(header: Option<&str>) -> Result<(), Problem> {
    match header {
        Some(value) if value.trim().is_empty() => Err(Problem::malformed(
            "If-None-Match must name an entity tag",
            Vec::new(),
        )),
        _ => Ok(()),
    }
}

/// Reads the required `If-Match` of an existing-resource mutation.
///
/// Missing or blank is 428; a value that is not the expected weak tag
/// (`W/"<n>"`, or `W/"availability:<n>"` for the availability-keyed
/// operations) is 400. Returns the number inside the tag.
pub fn require_if_match(header: Option<&str>, rule: IfMatchRule) -> Result<Option<u32>, Problem> {
    let (prefix, missing, malformed) = match rule {
        IfMatchRule::None => return Ok(None),
        IfMatchRule::Version => (
            "W/\"",
            "existing-resource mutations must send If-Match: W/\"<version>\"",
            "If-Match must be a weak positive version tag, e.g. W/\"1\"",
        ),
        IfMatchRule::Availability => (
            "W/\"availability:",
            "this mutation requires If-Match: W/\"availability:<n>\"",
            "If-Match must be a weak availability tag, e.g. W/\"availability:1\"",
        ),
    };
    let value = header.map(str::trim).unwrap_or("");
    if value.is_empty() {
        return Err(Problem::if_match_required(missing));
    }
    value
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix('"'))
        .and_then(positive_integer)
        .map(Some)
        .ok_or_else(|| Problem::malformed(malformed, Vec::new()))
}

/// Reads the required `Idempotency-Key` of a mutation: a UUID of any version.
pub fn require_idempotency_key(header: Option<&str>) -> Result<String, Problem> {
    let value = header.map(str::trim).unwrap_or("");
    if value.is_empty() {
        return Err(Problem::malformed(
            "Idempotency-Key header is required for this mutation",
            Vec::new(),
        ));
    }
    let is_uuid = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    if is_uuid {
        // Keys compare case-insensitively, like the UUIDs they are.
        Ok(value.to_ascii_lowercase())
    } else {
        Err(Problem::malformed(
            "Idempotency-Key must be a UUID",
            Vec::new(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn version_tags_are_parsed() {
        assert_eq!(
            require_if_match(Some("W/\"1\""), IfMatchRule::Version).unwrap(),
            Some(1)
        );
        assert_eq!(
            require_if_match(Some(" W/\"42\" "), IfMatchRule::Version).unwrap(),
            Some(42)
        );
        assert_eq!(
            require_if_match(Some("W/\"availability:7\""), IfMatchRule::Availability).unwrap(),
            Some(7)
        );
        assert_eq!(require_if_match(None, IfMatchRule::None).unwrap(), None);
    }

    #[test]
    fn a_tag_with_more_digits_than_a_version_has_is_well_formed_and_never_current() {
        // The contract's pattern allows any number of digits. Such a tag is
        // not malformed (400): it names a version nothing has (412).
        for tag in [
            "W/\"4294967295\"",
            "W/\"4294967296\"",
            "W/\"99999999999999999999\"",
            "W/\"340282366920938463463374607431768211456\"",
        ] {
            assert_eq!(
                require_if_match(Some(tag), IfMatchRule::Version).unwrap(),
                Some(u32::MAX),
                "{tag}"
            );
        }
        assert_eq!(
            require_if_match(
                Some("W/\"availability:4294967296\""),
                IfMatchRule::Availability
            )
            .unwrap(),
            Some(u32::MAX)
        );
        // Digits only: a long number does not excuse anything else.
        for malformed in ["W/\"99999999999999999999x\"", "W/\"099999999999999999999\""] {
            assert!(require_if_match(Some(malformed), IfMatchRule::Version).is_err());
        }
    }

    #[test]
    fn an_if_none_match_that_is_sent_names_a_tag() {
        assert!(check_if_none_match(None).is_ok());
        assert!(check_if_none_match(Some("W/\"3\"")).is_ok());
        assert!(check_if_none_match(Some("*")).is_ok());
        assert!(check_if_none_match(Some("anything-at-all")).is_ok());
        for empty in ["", " ", "\t"] {
            let problem = check_if_none_match(Some(empty)).unwrap_err();
            assert_eq!(
                (problem.status, problem.code.as_str()),
                (400, "validation_failed")
            );
        }
    }

    #[test]
    fn a_missing_if_match_is_428_and_a_malformed_one_is_400() {
        for missing in [None, Some(""), Some("   ")] {
            let problem = require_if_match(missing, IfMatchRule::Version).unwrap_err();
            assert_eq!(
                (problem.status, problem.code.as_str()),
                (428, "version_conflict")
            );
        }
        for malformed in [
            "1",
            "\"1\"",
            "W/\"0\"",
            "W/\"01\"",
            "W/\"-1\"",
            "W/\"1",
            "*",
            "W/\"availability:1\"",
            "W/\"1\", W/\"2\"",
        ] {
            let problem = require_if_match(Some(malformed), IfMatchRule::Version).unwrap_err();
            assert_eq!(
                (problem.status, problem.code.as_str()),
                (400, "validation_failed"),
                "{malformed}"
            );
        }
        let wrong_kind = require_if_match(Some("W/\"1\""), IfMatchRule::Availability).unwrap_err();
        assert_eq!(wrong_kind.status, 400);
    }

    #[test]
    fn idempotency_keys_are_uuids_of_any_version() {
        assert_eq!(
            require_idempotency_key(Some("0193A8F2-6C1E-4B41-9A2E-1F1D6A0B3C55")).unwrap(),
            "0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c55"
        );
        for bad in [
            None,
            Some(""),
            Some("key-1"),
            Some("0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c5"),
            Some("0193a8f26c1e4b419a2e1f1d6a0b3c55aaaa"),
        ] {
            let problem = require_idempotency_key(bad).unwrap_err();
            assert_eq!(
                (problem.status, problem.code.as_str()),
                (400, "validation_failed"),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn if_none_match_compares_weakly() {
        let etag = "W/\"3\"";
        assert!(if_none_match(Some("W/\"3\""), etag));
        assert!(if_none_match(Some("\"3\""), etag));
        assert!(if_none_match(Some("W/\"1\", W/\"3\""), etag));
        assert!(if_none_match(Some("*"), etag));
        assert!(!if_none_match(Some("W/\"4\""), etag));
        assert!(!if_none_match(None, etag));
    }

    #[test]
    fn body_etags_depend_on_content_not_key_order() {
        let first = etag_for_body(&json!({"items": [], "nextCursor": null}));
        assert_eq!(
            first,
            etag_for_body(&json!({"nextCursor": null, "items": []}))
        );
        assert_ne!(
            first,
            etag_for_body(&json!({"items": [1], "nextCursor": null}))
        );
        assert!(first.starts_with("W/\"") && first.len() == 20, "{first}");
        assert_eq!(etag_for_version(Version::INITIAL), "W/\"1\"");
    }
}
