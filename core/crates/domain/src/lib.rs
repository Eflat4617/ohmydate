//! Pure domain types and rules of the OhMyDate core.
//!
//! This crate mirrors `packages/domain` of the TypeScript core: it has no I/O
//! and no dependencies (not even `serde`). Wire formats live in the server
//! crate, storage in the store crate. Time and randomness are injected through
//! the [`Clock`] and [`RandomSource`] ports.

mod availability;
mod dag;
mod entities;
mod error;
mod id;
mod instant;
mod ports;
mod problem;
mod text;
mod validation;
mod version;

pub use availability::{
    Availability, AvailabilityException, AvailabilityKind, AvailabilityPrefs, AvailabilityPut,
    AvailabilityRule, CalendarDate, ExceptionKind, LocalTime, MAX_AVAILABILITY_EXCEPTIONS,
    MAX_AVAILABILITY_RULES, MAX_PREFERENCE_MINUTES, RiskLevel, validate_availability_put,
};
pub use dag::{DependencyEdge, assert_acyclic};
pub use entities::{
    LlmBudget, LlmConsent, LlmSettings, MicroUsd, Owner, Project, ProjectKind, SessionWindow, Task,
    TaskCreate, TaskPatch, TaskPriority, TaskStatus,
};
pub use error::{DomainError, ValidationIssue};
pub use id::{Id, UuidV7Generator};
pub use instant::Instant;
pub use ports::{Clock, IdGenerator, RandomSource};
pub use problem::ProblemCode;
pub use text::{is_blank_js, utf16_len};
pub use validation::{
    MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, NormalizedTaskCreate, NormalizedTaskPatch,
    ensure_no_nul, validate_project_title, validate_task_create, validate_task_patch,
};
pub use version::Version;
