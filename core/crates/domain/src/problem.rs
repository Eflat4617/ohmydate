/// Stable `code` values of `application/problem+json` responses.
///
/// This is the closed list of `packages/contracts/src/problem.ts`
/// (`PROBLEM_CODES`). A test in the server crate compares it with the
/// committed `openapi.json`, so a code added on one side fails the build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProblemCode {
    ValidationFailed,
    VersionConflict,
    AvailabilityChanged,
    ConstraintViolation,
    IdempotencyMismatch,
    ProviderUnavailable,
    LlmUnavailable,
    BudgetExceeded,
    DependencyCycle,
    IllegalTransition,
    ApprovalInProgress,
    NotFound,
    Forbidden,
    RateLimited,
    Unauthenticated,
    IdempotencyInProgress,
    ActiveSessionExists,
    SessionStateConflict,
    ReplanSuppressed,
    ProposalStateConflict,
    InternalError,
}

impl ProblemCode {
    /// Every code, in contract order.
    pub const ALL: [ProblemCode; 21] = [
        ProblemCode::ValidationFailed,
        ProblemCode::VersionConflict,
        ProblemCode::AvailabilityChanged,
        ProblemCode::ConstraintViolation,
        ProblemCode::IdempotencyMismatch,
        ProblemCode::ProviderUnavailable,
        ProblemCode::LlmUnavailable,
        ProblemCode::BudgetExceeded,
        ProblemCode::DependencyCycle,
        ProblemCode::IllegalTransition,
        ProblemCode::ApprovalInProgress,
        ProblemCode::NotFound,
        ProblemCode::Forbidden,
        ProblemCode::RateLimited,
        ProblemCode::Unauthenticated,
        ProblemCode::IdempotencyInProgress,
        ProblemCode::ActiveSessionExists,
        ProblemCode::SessionStateConflict,
        ProblemCode::ReplanSuppressed,
        ProblemCode::ProposalStateConflict,
        ProblemCode::InternalError,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ProblemCode::ValidationFailed => "validation_failed",
            ProblemCode::VersionConflict => "version_conflict",
            ProblemCode::AvailabilityChanged => "availability_changed",
            ProblemCode::ConstraintViolation => "constraint_violation",
            ProblemCode::IdempotencyMismatch => "idempotency_mismatch",
            ProblemCode::ProviderUnavailable => "provider_unavailable",
            ProblemCode::LlmUnavailable => "llm_unavailable",
            ProblemCode::BudgetExceeded => "budget_exceeded",
            ProblemCode::DependencyCycle => "dependency_cycle",
            ProblemCode::IllegalTransition => "illegal_transition",
            ProblemCode::ApprovalInProgress => "approval_in_progress",
            ProblemCode::NotFound => "not_found",
            ProblemCode::Forbidden => "forbidden",
            ProblemCode::RateLimited => "rate_limited",
            ProblemCode::Unauthenticated => "unauthenticated",
            ProblemCode::IdempotencyInProgress => "idempotency_in_progress",
            ProblemCode::ActiveSessionExists => "active_session_exists",
            ProblemCode::SessionStateConflict => "session_state_conflict",
            ProblemCode::ReplanSuppressed => "replan_suppressed",
            ProblemCode::ProposalStateConflict => "proposal_state_conflict",
            ProblemCode::InternalError => "internal_error",
        }
    }

    /// Looks a code up by its wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_round_trips_through_its_wire_name() {
        for code in ProblemCode::ALL {
            assert_eq!(ProblemCode::parse(code.as_str()), Some(code));
        }
    }

    #[test]
    fn wire_names_are_unique() {
        let mut names: Vec<&str> = ProblemCode::ALL.iter().map(|code| code.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), ProblemCode::ALL.len());
    }

    #[test]
    fn unknown_names_are_rejected() {
        assert_eq!(ProblemCode::parse("teapot"), None);
        assert_eq!(ProblemCode::parse("Not_Found"), None);
    }
}
