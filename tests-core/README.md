# tests-core — black-box parity harness for the Rust core

Starts the real `ohmydate-core` binary on a temporary data directory and
checks it against the HTTP contract in `packages/contracts` — the same
contract the TypeScript API and the web client use. Design and the cut-over
numbers: `docs/blueprint/15-DESKTOP-RUST-CORE.md` §7.

```sh
corepack pnpm run core:parity    # builds the test binary, typechecks, runs the suite
corepack pnpm run core:build     # only the test binary (cargo feature `test-clock`)
```

The suite runs the **test build** of the binary: the one with the cargo
feature `test-clock`, which adds `--clock-offset-ms`. A build without the
feature — the default, and what gets packaged — has no such option
(`cargo test` proves that side: `a_build_that_can_be_packaged_has_no_clock_offset`).

Not part of `pnpm run ci` yet (blueprint 15 §7.6 says when it joins).

## What is checked for every ported operation

`parity.test.ts` reads method, path, required headers, schemas and declared
status codes from the contract and runs, per entry of `support/routes.ts`:

| Check | Expectation |
|---|---|
| valid request | the entry's success status; body valid against the contract schema (ajv); `ETag` of the stated kind |
| no / wrong launch token | 401 `unauthenticated` |
| mutation with a foreign `Origin` | 403 `forbidden` |
| `If-Match` routes | missing 428, malformed 400, stale 412 `version_conflict` |
| `Idempotency-Key` routes | missing or not a UUID 400; same key replays status, body and `ETag`; same key with another body 422 `idempotency_mismatch` |
| reads with an `ETag` | `If-None-Match` current → 304, other → 200 |
| body / id / query outside the schema | 400 `validation_failed` with `errors[]`; unknown id 404 |

Every response must use a status the contract declares for that operation,
and every problem must match the `Problem` schema with a `traceId` equal to
`x-trace-id`. These are the cases `services/api/test/conformance.test.ts`
covers for the TypeScript API; cookie/CSRF cases map to the launch token and
the `Origin` check.

The `coverage` test probes all contract operations and fails when the core
serves one that has no entry (unported operations answer 501, dropped ones 404).

`projects.test.ts` holds what is specific to `updateProject` (FOLD-01): the
Inbox is never archived but can be renamed, an empty patch is a no-op, an
archived project is renamed only together with bringing it back, archiving
leaves the tasks alone. `services/api/test/project-update.test.ts` pins the
same answers for the TypeScript API.

`settings.test.ts` holds what is specific to `updateMySettings` (RC-10A):
time zone names are those of the tz database, compared as written; every
accepted patch is a new version; a consent answer becomes a record with its
time and provider; a budget patch fills the limit it does not name; amounts
are kept to the micro-dollar. `services/api/test/llm-settings.test.ts` and
`auth.test.ts` pin the reference's side.

`availability.test.ts` holds what is specific to the available hours
(RC-20): the availability version (`W/"availability:<n>"`, version 1 before
anything is set, 412 `availability_changed`, not stored for its key), the
answer of a PUT in the order of the request and a read in weekday and date
order, the contract's shapes and bounds, and the rules between values (a
window ends after it starts, an extra day has a window) — 422 here, a failed
CHECK and 500 in the reference. An operation whose `If-Match` is the
availability tag says so in `routes.ts` (`ifMatch: 'availability'`).

`commitments.test.ts` holds what is specific to appointments and to
`listCalendarDayEvents` (RC-20): every create, change and delete is one
availability version; a rule's occurrences inside the window, printed as the
reference prints them, also across a clock change; the caps (366 days, 2,000
occurrences on a page); the order of the answers of a patch (the patch
itself, then 404, then 412). `services/api/test/planning.test.ts` pins the
reference's side. An appointment imported from Google Calendar (409) cannot
be created over HTTP before RC-90; that rule is tested in the Rust crates.

`recurrence.test.ts` needs no core process: it writes the recurrence oracle
pack again from the TypeScript reference (`support/recurrence-oracle.ts`) and
fails when the committed sample
(`core/crates/recurrence/tests/oracle/sample.jsonl`) is not what the
reference answers today. `cargo test` replays that sample against the Rust
port; `corepack pnpm run core:rrule-oracle` writes it,
`corepack pnpm run core:rrule-diff` compares a large one.

`web.test.ts` covers the web app the core serves with `--web-dir` and the
boot hand-off (blueprint 15 §1.3), over a real socket: the document for the
root and for routes of the app, types and cache rules of files, HEAD,
404 for missing files, reserved and hostile paths (sent as written — `fetch`
would tidy `..` away, so the client's `raw()` uses `node:http`), the exact
launch cookie (never `Secure`), one answer for every wrong token, and that
the token never reaches the process log. The directory is the fixture of the
server crate (`core/crates/server/tests/fixtures/web`); the real web app is
not built in tests.

`ledger.test.ts` keeps the parity ledger `core/PARITY.md` honest (blueprint
15 §7.5): every TypeScript test file of the reference core has exactly one
line, every Rust or harness test a line points at exists, "not yet" lines
wait for a task that is still open, and the totals match the lines. Adding a
`*.test.ts` under `services/api/test`, `packages/*/test` or `e2e/tests`
without a ledger line fails this test. `corepack pnpm run core:ledger` runs
it alone (with `docs.test.ts`, no core process, under a second);
`LEDGER_WRITE_TOTALS=1` rewrites the totals block.

`schema.test.ts` is the schema verdict comparison (blueprint 15 §2.4, R13):
for every request schema of the contract it builds a valid instance and
thousands of one-change variants (`support/samples.ts`), asks Ajv — set up as
`packages/contracts` sets it up — and the core (the `schema-verdict` binary,
which calls what the dispatcher calls), and lists every sample the two judge
differently. A difference is fixed in the core or decided and listed in
`support/schema-differences.ts`; an unlisted difference fails the test, and
so does a listed one that is gone, a keyword / format / pattern the generator
does not know, or a zone name the reference accepts and the core does not.
The full report goes to `core/target/schema-diff/report.md`.
`corepack pnpm run core:schema-diff` runs it alone.

`lifecycle.test.ts` covers the process: ready file (0600, removed on exit),
single instance (exit 3), usage errors (exit 2), restart durability including
stored idempotent responses, a fresh launch token per start, and the movable
clock: with `--clock-offset-ms` every time the core writes (rows, updates,
the time inside ids) is the wall clock plus the offset, forward or back, and
an idempotency key expires when a day has passed on that clock.

## Adding a route (later slices)

1. Implement the handler in `core/crates/server/src/handlers/` and list it in `table()`.
2. Add one `RouteEntry` to `portedRoutes` in `support/routes.ts`:
   `operationId`, `successStatus`, `etag`, and — as needed — `prepare`
   (creates the resources one request needs), `query`, `body`, `otherBody`,
   `invalidQuery`.
3. Put behaviour that is specific to the route (domain rules, state machines)
   in its own `*.test.ts` here, next to the generic suite.

`OHMYDATE_CORE_BIN=/path/to/ohmydate-core` runs the suite against another build.

This directory is not a pnpm workspace package: it must not change the
lockfile. `vitest.config.ts` and `tsconfig.json` borrow `@ohmydate/contracts`,
`ajv` and `ajv-formats` from `packages/contracts`.
