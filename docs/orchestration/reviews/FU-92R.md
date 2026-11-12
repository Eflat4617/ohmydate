# FU-92R (ctx_2bca89665391, Fable 5.2 xhigh, focused — implementer Opus) — APPROVE

REVIEW VERDICT: APPROVE
Reviewed torgal/ohmydate...f2bbcb5 (27 files, +1646/-25) as a focused security / data-loss / migration review. No CRITICAL, HIGH or blocking MEDIUM finding.

Findings (most severe first):
  [LOW] Browser cookies still expire 14 days after login, so "14 days since last use" is not what the user gets
    Evidence: services/api/src/http/routes.ts:381-400 sets `sid`/`csrf` with Max-Age = TTL, and the only caller is the login handler (routes.ts:1098); nothing re-issues them. The store slides `expires_at`, but the browser drops both cookies 14 days after login even with daily use. This predates FU-92, but with restarts no longer logging the user out it becomes the real limit, and the new GU-1 sentence (docs/user/GU-1-사용안내.md:524) promises 14 days from last use.
    Suggestion: follow-up task to re-issue the cookies when the expiry slides, or reword GU-1 to "14 days after login". Not blocking.
  [LOW] Rollback must run the down migration before the 0015 files are removed
    Evidence: services/api/src/db/migrate.ts:165 (and :252) rejects an applied migration whose file is missing, and scripts/local/start.mjs:218-225 refuses to start on any migration mismatch. "Delete the branch" is a rollback only while 0015 has not reached a database.
    Suggestion: on rollback run `corepack pnpm --filter @ohmydate/api db:rollback` first, then revert the code. Rollout note: after the merge the live stack needs `corepack pnpm local:setup` once, because `local:start` refuses while 0015 is pending.
  [LOW] GU-1 lines 296 and 310 still tell the user to log in again after a restart
    Evidence: docs/user/GU-1-사용안내.md:296 and :310 (outside the worker's allowed edit, as the worker reported); the FU-92 known-issue row is at :554.
    Suggestion: coordinator corrects both lines and closes the row on merge.
  [LOW] Login returns 500 if the user row vanishes between the password check and the session insert
    Evidence: services/api/src/adapters/pg-session-store.ts:87 insert fails with FK 23503, which reaches the generic 500 handler; test/pg-session-store.test.ts "a session cannot be created for a user that does not exist" pins the raw DB error. The in-memory store issued a session that then read as 401.
    Suggestion: map 23503 to 401 `unauthenticated`. Irrelevant for the single-user phase.

Contract / license / security / migration impact:
  Contract: none (no route, cookie, status-code or openapi change). License: none (no new dependency).
  Security, confirmed by reading the code and by the tests I ran:
  - sid and CSRF token are each randomBytes(32) in base64url, i.e. 256 bits (services/api/src/application/session-tokens.ts:10-17); an unkeyed SHA-256 digest is acceptable for that entropy.
  - Only lowercase-hex SHA-256 digests are stored, enforced by two CHECK constraints; the PG test reads the whole row as text and finds neither raw value.
  - The raw sid is never sent to PostgreSQL (create, lookup, update and delete all use the digest), so it cannot appear in statement logs; nothing logs it (the sweep job logs the error name only). The raw CSRF token is returned once, to the login Set-Cookie.
  - CSRF check is equivalent to before: header == cookie (constant time) AND sha256(header) == stored digest (timingSafeEqual); missing/empty header never matches. Digest-as-token and cross-session tokens are rejected (403) in tests.
  - The user id comes only from the session row, so one owner's sid cannot act for another owner; malformed sids return 401 without a query.
  Correctness: sliding expiry is written at most once a minute with a guarded UPDATE (no resurrection after logout); expired rows read as null and are deleted; logout deletes; user delete cascades; the sweep is one bounded DELETE (500 rows), runs at boot and every 10 minutes, and is stopped in onClose (interval and the 1 s shutdown timer are unref'd).
  Composition: PgSessionStore only when provider=vikunja and DATABASE_URL is non-empty; memory provider keeps the in-memory store (test asserts no auth_session row). The login rate limiter and its E2E reset route are untouched.
  Migration: 0015 is additive (one table, FK to "user" ON DELETE CASCADE, two indexes); the down file drops only auth_session. The extended rollback-chain tests run in per-test schemas and only add the 0015 unwind step; the single changed assertion (test/db/agent-run-cancelled-schema.test.ts:98) was extended to include 0015, not weakened. No test was deleted or skipped.
  Scope: all changed paths are inside ALLOWED PATHS; the commit carries `Task: FU-92`.

Missing tests: none blocking. Not covered: an HTTP-level test that a database failure during the session lookup yields a problem+json 500 rather than 401; two concurrent touches of one session; the periodic sweep through the real app timer (the job is unit-tested with a fake scheduler, the boot sweep through the app).

Verification actually executed: yes — env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456
  1) corepack pnpm --filter @ohmydate/api exec vitest run --globals test/pg-session-store.test.ts test/session-store-contract.test.ts test/auth-session-persistence.test.ts test/session-sweep-job.test.ts test/db/auth-session-schema.test.ts test/db/migrate.test.ts -> exit 0 (6 files passed, 62 tests passed, 0 skipped, 33 s)
  2) corepack pnpm run typecheck -> exit 0
  3) corepack pnpm run lint -> exit 0
  Not run, per the focused-review instruction: the full API test suite, check:boundaries and e2e. The worker's figures for those (666 passed / 9 skipped, 0 violations, e2e-5 2/2) remain unverified claims for the coordinator's merge run.

git status --porcelain after review: empty (HEAD f2bbcb5, no files created or modified in the worktree)

Residual risks:
  - Sessions now outlive restarts, so a restart no longer revokes anything: the only revoke-all is `DELETE FROM auth_session` (documented in 09), and there is no password-change path that ends existing sessions.
  - A database outage turns authenticated requests into 500 (as the worker reported). Each authenticated request costs one extra indexed SELECT, plus one UPDATE per session per minute.
  - The sweep runs in every vikunja+database process without a leader lock; concurrent sweeps only delete the same expired rows.
  - The live database (port 55442) was not touched; 0015 has been exercised only on planner_test schemas.
