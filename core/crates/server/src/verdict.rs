//! What the core's request validation says about one value, with no request
//! around it.
//!
//! This is the core's side of the schema comparison (blueprint 15 §11 R13):
//! `tests-core/schema.test.ts` builds sample values for every request schema
//! of the contract, asks the reference validator (Ajv, as
//! `packages/contracts` sets it up) and — through the `schema-verdict`
//! binary — this module, and lists every sample the two judge differently.
//!
//! Nothing here is a second implementation: each function calls what the
//! dispatcher calls for that part of a request.

use serde_json::Value;

use crate::contract::{IfMatchRule, Operation};
use crate::headers;

/// The answer for one sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The request would go on to its handler.
    Valid,
    /// The request would be answered 400 `validation_failed`.
    Invalid,
    /// The text is not JSON the core can read (400 before any schema).
    Unreadable,
    /// The core checks nothing here: the operation has no rule for this part.
    NoRule,
}

impl Verdict {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Valid => "valid",
            Verdict::Invalid => "invalid",
            Verdict::Unreadable => "unreadable",
            Verdict::NoRule => "no-rule",
        }
    }
}

fn of_errors(found: Option<bool>) -> Verdict {
    match found {
        Some(true) => Verdict::Valid,
        Some(false) => Verdict::Invalid,
        None => Verdict::NoRule,
    }
}

/// Judges `text` as one part of a request to `operation`.
///
/// `part` is `body`, `query` or `params` — `text` is then the JSON of the
/// body, of the parsed query object, or of the object of path parameters —
/// or `header:if-match` / `header:idempotency-key` / `header:if-none-match`,
/// where `text` is a JSON string holding the header value. `None` for a part
/// this function does not know.
#[must_use]
pub fn judge(operation: &Operation, part: &str, text: &str) -> Option<Verdict> {
    let Ok(instance) = serde_json::from_str::<Value>(text) else {
        return Some(Verdict::Unreadable);
    };
    let verdict = match part {
        "body" => of_errors(operation.body_accepts(&instance)),
        "query" => of_errors(operation.query_accepts(&instance)),
        "params" => of_errors(operation.params_accept(&instance)),
        "header:if-match" => match (operation.if_match, instance.as_str()) {
            (IfMatchRule::None, _) => Verdict::NoRule,
            (rule, Some(value)) if headers::require_if_match(Some(value), rule).is_ok() => {
                Verdict::Valid
            }
            _ => Verdict::Invalid,
        },
        "header:idempotency-key" => match (operation.idempotency_key, instance.as_str()) {
            (false, _) => Verdict::NoRule,
            (true, Some(value)) if headers::require_idempotency_key(Some(value)).is_ok() => {
                Verdict::Valid
            }
            _ => Verdict::Invalid,
        },
        "header:if-none-match" => match (operation.if_none_match, instance.as_str()) {
            (false, _) => Verdict::NoRule,
            (true, Some(value)) if headers::check_if_none_match(Some(value)).is_ok() => {
                Verdict::Valid
            }
            _ => Verdict::Invalid,
        },
        _ => return None,
    };
    Some(verdict)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::Contract;

    fn judge_for(id: &str, part: &str, text: &str) -> Option<Verdict> {
        judge(Contract::embedded().operation(id).unwrap(), part, text)
    }

    #[test]
    fn each_part_is_judged_by_the_rule_the_dispatcher_uses() {
        assert_eq!(
            judge_for("createTask", "body", r#"{"title":"Read"}"#),
            Some(Verdict::Valid)
        );
        assert_eq!(
            judge_for("createTask", "body", r#"{"title":7}"#),
            Some(Verdict::Invalid)
        );
        assert_eq!(
            judge_for("listTasks", "query", r#"{"limit":10,"status":"done"}"#),
            Some(Verdict::Valid)
        );
        assert_eq!(
            judge_for("listTasks", "query", r#"{"limit":"10"}"#),
            Some(Verdict::Invalid),
            "the text of a number is not a number: the dispatcher converts before it judges"
        );
        assert_eq!(
            judge_for(
                "getTask",
                "params",
                r#"{"id":"0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55"}"#
            ),
            Some(Verdict::Valid)
        );
        assert_eq!(
            judge_for("getTask", "params", r#"{"id":"nope"}"#),
            Some(Verdict::Invalid)
        );
        assert_eq!(
            judge_for("updateTask", "header:if-match", r#""W/\"3\"""#),
            Some(Verdict::Valid)
        );
        assert_eq!(
            judge_for("updateTask", "header:if-match", r#""3""#),
            Some(Verdict::Invalid)
        );
        assert_eq!(
            judge_for(
                "createTask",
                "header:idempotency-key",
                r#""0193A8F2-6C1E-4B41-9A2E-1F1D6A0B3C55""#
            ),
            Some(Verdict::Valid)
        );
        assert_eq!(
            judge_for("createTask", "header:idempotency-key", r#""not-a-uuid""#),
            Some(Verdict::Invalid)
        );
    }

    #[test]
    fn a_part_without_a_rule_and_text_that_is_not_json_are_told_apart() {
        // getTask has no body, no query and no If-Match in the contract.
        for part in ["body", "query", "header:if-match", "header:idempotency-key"] {
            assert_eq!(
                judge_for("getTask", part, r#""anything""#),
                Some(Verdict::NoRule),
                "{part}"
            );
        }
        assert_eq!(
            judge_for("createTask", "header:if-none-match", r#""W/\"1\"""#),
            Some(Verdict::NoRule)
        );
        assert_eq!(
            judge_for("getMe", "header:if-none-match", r#""""#),
            Some(Verdict::Invalid)
        );
        assert_eq!(
            judge_for("getMe", "header:if-none-match", r#""W/\"1\"""#),
            Some(Verdict::Valid)
        );
        for text in ["", "{", "{\"title\":", r#""\ud800""#, "1e400", "NaN"] {
            assert_eq!(
                judge_for("createTask", "body", text),
                Some(Verdict::Unreadable),
                "{text}"
            );
        }
        // A header value that is not a string cannot be a header.
        assert_eq!(
            judge_for("updateTask", "header:if-match", "3"),
            Some(Verdict::Invalid)
        );
        assert_eq!(judge_for("createTask", "cookie", "{}"), None);
        assert_eq!(Verdict::NoRule.as_str(), "no-rule");
    }
}
