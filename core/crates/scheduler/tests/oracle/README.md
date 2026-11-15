# Oracle packs

Written by `packages/scheduler/scripts/export-oracle.mts` from the TypeScript
scheduler (the reference). `tests/oracle.rs` replays every case and compares
layer by layer; nothing may differ.

| File | What | How it was made |
|---|---|---|
| `sample.json` | 15 golden fixtures + 6 path cases + 12 seeded cases; runs with every `cargo test` | `corepack pnpm run core:oracle` (seed 20261113, count 12) |

`tests/oracle/regressions/*.json` is read too when it exists: one-case packs
of mismatches that were found and fixed. They are made by the shrinker, which
takes a mismatching case of a large pack and removes everything the mismatch
does not need:

```sh
corepack pnpm run core:shrink -- --pack core/target/oracle/diff.json --case gen-000123 \
  --name short-slug --note "what was wrong"
corepack pnpm run core:shrink -- --self-test
```

Large packs are not committed. They are generated into `core/target/oracle/`
and read through `OHMYDATE_ORACLE_DIR`:

```sh
corepack pnpm run core:diff                                  # 2,000 seeded cases (seed 20261113) + the reference tests' inputs
ORACLE_COUNT=10000 corepack pnpm run core:diff               # the cut-over gate (15 §7.7)
ORACLE_SEED=7 ORACLE_COUNT=2000 corepack pnpm run core:diff  # another stream
```

`core:diff` first runs the reference test suite once (`core:harvest`) and
records every input its tests give to `generate` — about 1,980 inputs from
14 test files, the scenarios the reference was fixed against (the first 200
of each test; property tests make thousands). They become `reference-test`
cases next to the seeded ones.

Path cases (`pathCases()` in the exporter) are hand-written inputs, each one
decisive for a single generator path — a path whose removal no other case
notices. They are small and part of every pack, this sample included. When a
deliberate defect in the generator passes `core:diff` and the tests, find an
input for which that code decides the plan and add it there.

Seeds used for the stage gates so far (2,000 seeded cases each): `20261113`.

The same seed and count give the same pack on the same Node version. After a
change to the exporter or to the reference, regenerate `sample.json` and
commit it with the change; bump `formatVersion` on both sides when the shape
of a pack changes.
