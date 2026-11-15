# Oracle packs

Written by `packages/scheduler/scripts/export-oracle.mts` from the TypeScript
scheduler (the reference). `tests/oracle.rs` replays every case and compares
layer by layer; nothing may differ.

| File | What | How it was made |
|---|---|---|
| `sample.json` | 15 golden fixtures + 12 seeded cases; runs with every `cargo test` | `corepack pnpm run core:oracle` (seed 20261113, count 12) |

`tests/oracle/regressions/*.json` is read too when it exists: one-case packs
of mismatches that were found and fixed.

Large packs are not committed. They are generated into `core/target/oracle/`
and read through `OHMYDATE_ORACLE_DIR`:

```sh
corepack pnpm run core:diff                                  # 2,000 cases, seed 20261113
ORACLE_COUNT=10000 corepack pnpm run core:diff               # the cut-over gate (15 §7.7)
ORACLE_SEED=7 ORACLE_COUNT=2000 corepack pnpm run core:diff  # another stream
```

Seeds used for the stage gates so far (2,000 cases each): `20261113`.

The same seed and count give the same pack on the same Node version. After a
change to the exporter or to the reference, regenerate `sample.json` and
commit it with the change; bump `formatVersion` on both sides when the shape
of a pack changes.
