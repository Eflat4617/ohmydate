# tests-core — black-box parity harness for the Rust core

Starts the real `ohmydate-core` binary on a temporary data directory and
checks it against the HTTP contract in `packages/contracts` — the same
contract the TypeScript API and the web client use. Design and the cut-over
numbers: `docs/blueprint/15-DESKTOP-RUST-CORE.md` §7.

```sh
corepack pnpm run core:parity    # builds the binary, typechecks, runs the suite
```

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

`lifecycle.test.ts` covers the process: ready file (0600, removed on exit),
single instance (exit 3), usage errors (exit 2), restart durability including
stored idempotent responses, and a fresh launch token per start.

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
