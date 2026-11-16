# Recurrence oracle packs

Written by `tests-core/support/recurrence-oracle.ts` from the TypeScript
reference (`services/api/src/application/rrule.ts`). `tests/oracle.rs` replays
every record through the Rust port and compares the answers; nothing may
differ — not an instant, not how it is printed, not which rejection a bad
input gets.

| File | What | How it was made |
|---|---|---|
| `sample.jsonl` | runs with every `cargo test` | `corepack pnpm run core:rrule-oracle` (seed 20261116, count 240) |

A pack is plain ASCII: a header line, then one record per line.

```text
{ format: "ohmydate-recurrence-oracle", formatVersion: 1,
  oracle: { node, tzdata, seed, count } }
{ t: "parse",  rrule, rule: { freq, interval, count, untilMs, untilDate, byDay, byMonthDay } | error }
{ t: "expand", id, kind, commitment: { startAt, endAt, timeZone, rrule? }, from, to,
               occurrences: [[startAt, endAt]], gaps, overlaps | error }
{ t: "clip",   occurrence: [startAt, endAt], from, to, clipped: [startAt, endAt] | null }
```

`error` is the name of the rejection (`RuleError::kind`, `ExpandError::kind`);
the reference's messages repeat the user's text and are not compared.
`gaps` and `overlaps` count the occurrences that fell on a wall time a clock
change skipped, or on one that happened twice — the test uses them to make
sure a pack still holds such cases.

What the sample holds:

- **parse** — 165 rules written by hand (every rejection, in every
  order the checks can meet; the corners of `split('=', 2)`, `toUpperCase`
  and `Number.parseInt`; `UNTIL` values that `Temporal` constrains) and 480
  seeded rules with one to three random edits.
- **expand** — the twelve expansions of `services/api/test/rrule.test.ts`
  (`kind: "test"`); 41 corners written by hand (`hand`: window and
  interval checks, the two caps, the ten-year jump and its day of margin,
  month ends and leap days, a calendar day a zone skipped); for each of the
  39 clock changes of ten zones in 2026–2027, a series of each frequency
  whose wall time falls into it (`dst`, 156 cases); and 240 seeded series (`seeded`, `lookback`,
  `once`): weekly sets, intervals, counts, both forms of `UNTIL`, month ends
  and leap days, lengths from a millisecond to eight days, windows from an
  hour to 366 days.
- **clip** — 40 seeded intervals.

Zones: UTC, Seoul and Kathmandu (no clock change), São Paulo (stopped
changing in 2019), New York, Berlin, London (northern), Sydney, Auckland,
Santiago (southern), Lord Howe (a 30-minute change), Chatham (a :45 offset),
Havana and Santiago (changes at midnight), Casablanca (the change that runs
the other way around Ramadan).

Large packs are not committed. They are written into
`core/target/recurrence-oracle/` and read through
`OHMYDATE_RECURRENCE_ORACLE_DIR`:

```sh
corepack pnpm run core:rrule-diff                                   # 20,000 seeded series (seed 20261116), clock changes of 2020–2030
RRULE_ORACLE_SEED=7 RRULE_ORACLE_COUNT=50000 corepack pnpm run core:rrule-diff
```

The same seed and count give the same records on the same Node version.
`tests-core/recurrence.test.ts` (part of `core:parity`) writes the sample
again in memory and fails when the committed file is not what the reference
answers today — after a change to the generator, or when Node's tz database
moves. Then make the sample again and commit it; if `cargo test` now
reports a mismatch, the two cores really differ: find the smallest input and
fix the port, or report the reference.

Deliberate defects are how the cases were chosen: a change to the port that
no record notices means a record is missing. The `hand` cases
`a-skipped-day-after-the-jump` and `window-starts-where-an-occurrence-ends`
came from that.
