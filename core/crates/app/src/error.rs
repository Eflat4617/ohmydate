use std::fmt;

use ohmydate_domain::DomainError;
use ohmydate_store::StoreError;

/// Why a use-case did not produce its result.
#[derive(Debug)]
pub enum AppError {
    /// A domain outcome the client can act on (404, 409, 412, 422).
    Domain(DomainError),
    /// A long-running request with the same `Idempotency-Key` is in flight
    /// (409 `idempotency_in_progress`, retry later).
    IdempotencyInProgress,
    /// The data file failed. Reported as 500 without details.
    Store(StoreError),
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Domain(error) => error.fmt(formatter),
            AppError::IdempotencyInProgress => {
                formatter.write_str("another request with this Idempotency-Key is still pending")
            }
            AppError::Store(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Domain(error) => Some(error),
            AppError::IdempotencyInProgress => None,
            AppError::Store(error) => Some(error),
        }
    }
}

impl From<DomainError> for AppError {
    fn from(error: DomainError) -> Self {
        AppError::Domain(error)
    }
}

impl From<StoreError> for AppError {
    fn from(error: StoreError) -> Self {
        AppError::Store(error)
    }
}
