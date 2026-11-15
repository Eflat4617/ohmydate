//! Configuration shared by the property tests.

use proptest::test_runner::{Config, RngSeed};

/// Runs per property: `SCHED_PROPERTY_RUNS`, 1,000 by default (blueprint 15
/// §7.1; the cut-over gate uses 10,000). The same variable sets the
/// reference's fast-check runs.
pub fn runs() -> u32 {
    std::env::var("SCHED_PROPERTY_RUNS")
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
        .filter(|runs| *runs > 0)
        .unwrap_or(1000)
}

/// The proptest configuration of every property here.
///
/// The seed is fixed, so a run is repeatable and a failure can be reported
/// by its seed; `SCHED_PROPERTY_SEED` explores another stream. Failures are
/// not written to the source tree.
pub fn config() -> Config {
    let cases = runs();
    Config {
        cases,
        // The reference's properties skip inputs without room (`fc.pre`);
        // allow the same share of skips fast-check allows.
        max_global_rejects: cases.saturating_mul(100),
        failure_persistence: None,
        rng_seed: RngSeed::Fixed(
            std::env::var("SCHED_PROPERTY_SEED")
                .ok()
                .and_then(|raw| raw.parse::<u64>().ok())
                .unwrap_or(20_261_116),
        ),
        ..Config::default()
    }
}

/// A fixed corpus: `cases` inputs drawn from `seed`, whatever the
/// environment says. For properties that are regression corpora rather than
/// theorems, as the reference runs them (`{ numRuns, seed }`).
pub fn corpus(seed: u64, cases: u32) -> Config {
    Config {
        cases,
        max_global_rejects: cases.saturating_mul(100),
        rng_seed: RngSeed::Fixed(seed),
        ..config()
    }
}
