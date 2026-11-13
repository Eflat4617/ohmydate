use std::fmt;

use crate::{Id, ProblemCode, Version};

/// One field-level finding of a failed validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub path: String,
    pub message: String,
}

impl ValidationIssue {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { path: path.into(), message: message.into() }
    }
}

/// A domain failure. Each variant maps to exactly one HTTP status and problem
/// code in the server crate; the mapping mirrors `domainErrorToProblem` in
/// `services/api/src/http/problem.ts`.
///
/// Messages name resource kinds and ids only. They never contain titles,
/// descriptions or other user text, so they are safe to return and to log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainError {
    /// The entity does not exist (or is soft-deleted). 404 `not_found`.
    NotFound { resource: &'static str, id: Option<Id> },
    /// `If-Match` named a version that is not current. 412 `version_conflict`.
    VersionConflict { expected: Version, actual: Option<Version> },
    /// The request is well-formed but breaks a domain rule. 422
    /// `validation_failed`.
    ValidationFailed(Vec<ValidationIssue>),
    /// A dependency edge would close a cycle. 422 `dependency_cycle`.
    DependencyCycle(Vec<Id>),
    /// The same `Idempotency-Key` was reused with a different request. 422
    /// `idempotency_mismatch`.
    IdempotencyMismatch,
    /// The entity is in a state that does not allow the action. 409
    /// `illegal_transition`.
    IllegalTransition(String),
}

impl DomainError {
    #[must_use]
    pub fn not_found(resource: &'static str, id: &Id) -> Self {
        DomainError::NotFound { resource, id: Some(id.clone()) }
    }

    #[must_use]
    pub fn invalid(path: &str, message: &str) -> Self {
        DomainError::ValidationFailed(vec![ValidationIssue::new(path, message)])
    }

    #[must_use]
    pub fn code(&self) -> ProblemCode {
        match self {
            DomainError::NotFound { .. } => ProblemCode::NotFound,
            DomainError::VersionConflict { .. } => ProblemCode::VersionConflict,
            DomainError::ValidationFailed(_) => ProblemCode::ValidationFailed,
            DomainError::DependencyCycle(_) => ProblemCode::DependencyCycle,
            DomainError::IdempotencyMismatch => ProblemCode::IdempotencyMismatch,
            DomainError::IllegalTransition(_) => ProblemCode::IllegalTransition,
        }
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DomainError::NotFound { resource, id: Some(id) } => {
                write!(formatter, "{resource} not found: {id}")
            }
            DomainError::NotFound { resource, id: None } => write!(formatter, "{resource} not found"),
            DomainError::VersionConflict { expected, actual: Some(actual) } => {
                write!(formatter, "expected version {expected} but found {actual}")
            }
            DomainError::VersionConflict { expected, actual: None } => {
                write!(formatter, "expected version {expected}")
            }
            DomainError::ValidationFailed(issues) => {
                let paths: Vec<&str> = issues.iter().map(|issue| issue.path.as_str()).collect();
                write!(formatter, "validation failed: {}", paths.join(", "))
            }
            DomainError::DependencyCycle(cycle) => {
                let ids: Vec<&str> = cycle.iter().map(Id::as_str).collect();
                write!(formatter, "dependency cycle detected: {}", ids.join(" -> "))
            }
            DomainError::IdempotencyMismatch => {
                formatter.write_str("idempotency key reused with a different request body")
            }
            DomainError::IllegalTransition(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for DomainError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(last: char) -> Id {
        Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c5{last}")).unwrap()
    }

    #[test]
    fn messages_match_the_typescript_core() {
        assert_eq!(
            DomainError::not_found("task", &id('5')).to_string(),
            "task not found: 0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55"
        );
        assert_eq!(
            DomainError::VersionConflict {
                expected: Version::INITIAL,
                actual: Version::new(3)
            }
            .to_string(),
            "expected version 1 but found 3"
        );
        assert_eq!(
            DomainError::DependencyCycle(vec![id('5'), id('6'), id('5')]).to_string(),
            "dependency cycle detected: 0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55 -> \
             0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56 -> 0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55"
        );
        assert_eq!(
            DomainError::invalid("title", "title must not be empty").to_string(),
            "validation failed: title"
        );
    }

    #[test]
    fn each_error_has_its_own_problem_code() {
        assert_eq!(DomainError::not_found("task", &id('5')).code(), ProblemCode::NotFound);
        assert_eq!(DomainError::IdempotencyMismatch.code(), ProblemCode::IdempotencyMismatch);
        assert_eq!(DomainError::DependencyCycle(vec![]).code(), ProblemCode::DependencyCycle);
        assert_ne!(
            DomainError::invalid("title", "x").code(),
            DomainError::IllegalTransition("x".into()).code()
        );
    }
}
