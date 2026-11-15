//! The deterministic scheduler of the OhMyDate core.
//!
//! A port of `packages/scheduler` (TypeScript), which stays the oracle until
//! cut-over: for the same input and seed this crate must return the same
//! bytes. The port lands module by module (blueprint 15 §5); every module is
//! checked against packs written by
//! `packages/scheduler/scripts/export-oracle.mts`.
//!
//! Ported so far:
//!
//! * [`prng`]: the seeded mulberry32 generator;
//! * [`canonical`]: canonical JSON with JavaScript number formatting, SHA-256;
//! * [`js`]: the `Math.*` functions that differ from `f64`'s;
//! * [`time`]: instants, time zones, the ADR-017 local-date partition, local
//!   clocks and the 5-minute grid;
//! * [`types`]: the input types and their JSON form;
//! * [`slots`]: available time of a horizon;
//! * [`sessions`], [`requirements`]: H6-legal session lengths and the minutes
//!   a task needs;
//! * [`input_hash`]: the `inputHash` of a `ScheduleInput`;
//! * [`codes`]: the closed explanation, violation and input-issue codes;
//! * [`validate`]: the hard-constraint validator and the input validator;
//! * [`explain`]: the capacity report made before generation;
//! * [`policies`], [`generate`]: the three published policies and the plan
//!   generator, with replanning and the FU-69 repair passes;
//! * [`replay`]: every ported layer on one input, in the oracle's JSON shape
//!   (used by the differential test and the `sched-diff` binary).
//!
//! Like the TypeScript package, this crate is pure: no I/O, no clock, no
//! global state. The time zone database is compiled in.
//!
//! # Determinism rules
//!
//! JavaScript sorts are stable, `Map` and `Set` iterate in insertion order
//! and strings compare by UTF-16 code units. So this crate sorts with
//! `sort_by` only, never iterates a hash container (`clippy.toml` forbids
//! both `sort_unstable*` and `HashMap`/`HashSet`), and orders text with
//! [`canonical::compare_utf16`], not `str::cmp`.

#[macro_use]
mod macros;

pub mod canonical;
pub mod codes;
pub mod explain;
pub mod generate;
pub mod input_hash;
pub mod js;
pub mod policies;
pub mod prng;
pub mod replay;
pub mod requirements;
pub mod sessions;
pub mod slots;
pub mod time;
pub mod types;
pub mod validate;
