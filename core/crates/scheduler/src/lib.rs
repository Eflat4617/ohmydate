//! The deterministic scheduler of the OhMyDate core.
//!
//! A port of `packages/scheduler` (TypeScript), which stays the oracle until
//! cut-over: for the same input and seed this crate must return the same
//! bytes. The port lands module by module (blueprint 15 §5); every module is
//! checked against packs written by
//! `packages/scheduler/scripts/export-oracle.mts`.
//!
//! Ported so far — the layers everything else stands on:
//!
//! * [`prng`]: the seeded mulberry32 generator;
//! * [`canonical`]: canonical JSON with JavaScript number formatting, SHA-256;
//! * [`time`]: instant parsing/printing and the ADR-017 local-date partition;
//! * [`input_hash`]: the `inputHash` of a `ScheduleInput`.
//!
//! Like the TypeScript package, this crate is pure: no I/O, no clock, no
//! global state. The time zone database is compiled in.

pub mod canonical;
pub mod input_hash;
pub mod prng;
pub mod time;
