//! Recurring appointments of the OhMyDate core.
//!
//! A port of `services/api/src/application/rrule.ts`, the bounded `RRULE`
//! adapter of the TypeScript core (the reference): parse a rule, and expand
//! an appointment into the occurrences that overlap a window, on the
//! appointment's own wall clock and across clock changes.
//!
//! The same input must give the same occurrences as the reference — the same
//! instants, printed the same way, and the same rejection where it rejects.
//! `tests/oracle.rs` compares the two on a pack the reference wrote
//! (`tests/oracle/README.md`); no mismatch is allowed. That is why the code
//! follows the reference's control flow instead of a calendar library's
//! recurrence support, and why no recurrence crate is used.
//!
//! The crate is pure: no I/O, no clock, no global state. It depends on
//! `jiff` for the tz database (bundled into the binary) and on nothing of
//! this workspace. Instants are epoch milliseconds.
//!
//! Where the port refuses instead of answering like the reference — both
//! outside anything the app stores — is spelled out on
//! [`ExpandError::UnknownTimeZone`] and [`ExpandError::OutOfRange`].

mod civil;
mod expand;
mod rule;
mod zone;

pub use civil::Date;
pub use expand::{ExpandError, MAX_LOOKBACK_MS, MAX_RANGE_MS, Occurrence, Series, clip, expand};
pub use rule::{Frequency, MAX_OCCURRENCES, Rule, RuleError, Until};
pub use zone::knows_time_zone;
