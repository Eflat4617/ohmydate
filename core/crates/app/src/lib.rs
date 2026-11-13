//! Use-cases of the OhMyDate core.
//!
//! The HTTP layer calls this crate; this crate calls the domain (rules) and
//! the store (SQL). It owns transactions: every use-case runs inside one
//! SQLite transaction handed out by [`App::read`] or
//! [`App::mutate_idempotent`], so a rule check and the write it guards cannot
//! be separated.
//!
//! Functions here are synchronous. The server runs them on the blocking
//! thread pool.

mod app;
mod cursor;
mod error;
pub mod projects;
pub mod tasks;
#[cfg(test)]
mod testing;

pub use app::{App, IDEMPOTENCY_TTL_MS, Idempotent, IdempotentRequest, OwnerDefaults, Unit};
pub use cursor::{DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, Page, PageQuery};
pub use error::AppError;
pub use ohmydate_store::idempotency::StoredResponse;
