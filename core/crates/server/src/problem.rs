//! `application/problem+json` responses (RFC 9457, 08 §1).

use ohmydate_app::AppError;
use ohmydate_domain::{DomainError, ProblemCode};
use serde_json::{Map, Value, json};

/// One entry of a problem's `errors` array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
    pub path: String,
    pub message: String,
}

/// An error response. `detail` and `errors[].message` name rules, ids and
/// resource kinds only — never titles, descriptions or other user text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub status: u16,
    pub code: ProblemCode,
    pub title: &'static str,
    pub detail: Option<String>,
    pub errors: Vec<FieldError>,
    /// Extra response headers, e.g. `Retry-After`.
    pub headers: Vec<(String, String)>,
}

impl Problem {
    fn new(status: u16, code: ProblemCode, title: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            code,
            title,
            detail: Some(detail.into()),
            errors: Vec::new(),
            headers: Vec::new(),
        }
    }

    /// 400: the request does not have the shape the contract requires.
    #[must_use]
    pub fn malformed(detail: impl Into<String>, errors: Vec<FieldError>) -> Self {
        Self {
            errors,
            ..Self::new(
                400,
                ProblemCode::ValidationFailed,
                "Malformed request",
                detail,
            )
        }
    }

    /// 401: the launch token is missing or wrong.
    #[must_use]
    pub fn unauthenticated() -> Self {
        Self::new(
            401,
            ProblemCode::Unauthenticated,
            "Unauthenticated",
            "this request does not carry the launch token of the running app",
        )
    }

    #[must_use]
    pub fn forbidden(detail: &'static str) -> Self {
        Self::new(403, ProblemCode::Forbidden, "Forbidden", detail)
    }

    #[must_use]
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(404, ProblemCode::NotFound, "Not found", detail)
    }

    /// 428: an existing-resource mutation came without `If-Match`. The code
    /// is `version_conflict`, as in the TypeScript core.
    #[must_use]
    pub fn if_match_required(detail: &'static str) -> Self {
        Self::new(
            428,
            ProblemCode::VersionConflict,
            "If-Match header required",
            detail,
        )
    }

    /// 500 without details; the cause goes to the log, not to the client.
    #[must_use]
    pub fn internal() -> Self {
        Self::new(
            500,
            ProblemCode::InternalError,
            "Internal error",
            "an unexpected error occurred",
        )
    }

    /// 501: the operation exists in the contract but this build of the core
    /// does not serve it yet. Disappears when the port reaches parity.
    #[must_use]
    pub fn not_implemented(operation_id: &str) -> Self {
        Self::new(
            501,
            ProblemCode::InternalError,
            "Not implemented",
            format!("operation {operation_id} is not available in this build of the core"),
        )
    }

    /// True for the results 08 §1 stores for idempotent replay: 409 and 422
    /// domain outcomes. `idempotency_in_progress` is transient and excluded.
    #[must_use]
    pub fn is_storable(&self) -> bool {
        matches!(self.status, 409 | 422) && self.code != ProblemCode::IdempotencyInProgress
    }

    /// The response body. `trace_id` ties it to the request log line.
    #[must_use]
    pub fn body(&self, trace_id: &str) -> Value {
        let mut body = Map::new();
        body.insert("type".into(), json!("about:blank"));
        body.insert("title".into(), json!(self.title));
        body.insert("status".into(), json!(self.status));
        if let Some(detail) = &self.detail {
            body.insert("detail".into(), json!(detail));
        }
        body.insert("code".into(), json!(self.code.as_str()));
        if !self.errors.is_empty() {
            let errors: Vec<Value> = self
                .errors
                .iter()
                .map(|error| json!({"path": error.path, "message": error.message}))
                .collect();
            body.insert("errors".into(), Value::Array(errors));
        }
        body.insert("traceId".into(), json!(trace_id));
        Value::Object(body)
    }
}

impl From<DomainError> for Problem {
    /// The mapping of `domainErrorToProblem` (`services/api/src/http/problem.ts`).
    fn from(error: DomainError) -> Self {
        let detail = error.to_string();
        match error {
            DomainError::NotFound { .. } => Self::not_found(detail),
            DomainError::VersionConflict { .. } => Self::new(
                412,
                ProblemCode::VersionConflict,
                "Version precondition failed",
                detail,
            ),
            DomainError::AvailabilityChanged { .. } => Self::new(
                412,
                ProblemCode::AvailabilityChanged,
                "Availability changed",
                detail,
            ),
            DomainError::ValidationFailed(issues) => Self {
                errors: issues
                    .into_iter()
                    .map(|issue| FieldError {
                        path: issue.path,
                        message: issue.message,
                    })
                    .collect(),
                ..Self::new(
                    422,
                    ProblemCode::ValidationFailed,
                    "Domain validation failed",
                    detail,
                )
            },
            DomainError::DependencyCycle(_) => Self::new(
                422,
                ProblemCode::DependencyCycle,
                "Dependency cycle detected",
                detail,
            ),
            DomainError::IdempotencyMismatch => Self::new(
                422,
                ProblemCode::IdempotencyMismatch,
                "Idempotency key reuse",
                "the same Idempotency-Key was used with a different request",
            ),
            DomainError::IllegalTransition(_) => Self::new(
                409,
                ProblemCode::IllegalTransition,
                "State conflict",
                detail,
            ),
        }
    }
}

impl From<&AppError> for Problem {
    fn from(error: &AppError) -> Self {
        match error {
            AppError::Domain(error) => error.clone().into(),
            AppError::IdempotencyInProgress => Self {
                headers: vec![("Retry-After".to_owned(), "1".to_owned())],
                ..Self::new(
                    409,
                    ProblemCode::IdempotencyInProgress,
                    "Idempotency key in progress",
                    "another request with this Idempotency-Key is still pending",
                )
            },
            AppError::Store(_) => Self::internal(),
        }
    }
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{Id, ValidationIssue, Version};
    use ohmydate_store::StoreError;

    use super::*;

    fn id() -> Id {
        Id::parse("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55").unwrap()
    }

    #[test]
    fn domain_errors_map_to_the_statuses_of_the_typescript_core() {
        let cases: Vec<(DomainError, u16, &str)> = vec![
            (DomainError::not_found("task", &id()), 404, "not_found"),
            (
                DomainError::VersionConflict {
                    expected: Version::INITIAL,
                    actual: None,
                },
                412,
                "version_conflict",
            ),
            (
                DomainError::AvailabilityChanged {
                    expected: Version::INITIAL,
                    actual: Version::INITIAL.next(),
                },
                412,
                "availability_changed",
            ),
            (DomainError::invalid("title", "x"), 422, "validation_failed"),
            (
                DomainError::DependencyCycle(vec![id(), id()]),
                422,
                "dependency_cycle",
            ),
            (
                DomainError::IdempotencyMismatch,
                422,
                "idempotency_mismatch",
            ),
            (
                DomainError::IllegalTransition("no".into()),
                409,
                "illegal_transition",
            ),
        ];
        for (error, status, code) in cases {
            let problem = Problem::from(error);
            assert_eq!((problem.status, problem.code.as_str()), (status, code));
        }
    }

    #[test]
    fn only_409_and_422_domain_results_are_storable() {
        assert!(Problem::from(DomainError::invalid("title", "x")).is_storable());
        assert!(Problem::from(DomainError::IllegalTransition("no".into())).is_storable());
        assert!(!Problem::from(DomainError::not_found("task", &id())).is_storable());
        // A stale availability tag can be retried with the same key.
        let stale = DomainError::AvailabilityChanged {
            expected: Version::INITIAL,
            actual: Version::INITIAL.next(),
        };
        assert!(!Problem::from(stale).is_storable());
        assert!(!Problem::from(&AppError::IdempotencyInProgress).is_storable());
        assert!(!Problem::internal().is_storable());
        assert!(!Problem::malformed("x", Vec::new()).is_storable());
    }

    #[test]
    fn the_body_has_the_contract_fields_and_the_trace_id() {
        let problem = Problem::from(DomainError::ValidationFailed(vec![ValidationIssue::new(
            "title",
            "title must not be empty",
        )]));
        assert_eq!(
            problem.body("req-1"),
            json!({
                "type": "about:blank",
                "title": "Domain validation failed",
                "status": 422,
                "detail": "validation failed: title",
                "code": "validation_failed",
                "errors": [{"path": "title", "message": "title must not be empty"}],
                "traceId": "req-1",
            })
        );
        assert!(
            Problem::unauthenticated()
                .body("req-2")
                .get("errors")
                .is_none()
        );
    }

    #[test]
    fn storage_failures_are_reported_without_details() {
        let error = AppError::Store(StoreError::Corrupt {
            table: "task",
            column: "status",
        });
        let problem = Problem::from(&error);
        assert_eq!(problem.status, 500);
        assert_eq!(
            problem.detail.as_deref(),
            Some("an unexpected error occurred")
        );
        let in_progress = Problem::from(&AppError::IdempotencyInProgress);
        assert_eq!(
            in_progress.headers,
            vec![("Retry-After".to_owned(), "1".to_owned())]
        );
    }
}
