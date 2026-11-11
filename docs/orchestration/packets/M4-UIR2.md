# REVIEW PACKET: M4-UIR2R — Independent review of M4-UIR2
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/m4-ui-integration. Base: torgal/ohmydate. Head: 6936345.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/M4-UIR2.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...6936345; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
Finish with exactly one worker_done (orca orchestration send --type worker_done ... --outcome succeeded) whose body is the review in this format:
REVIEW VERDICT: APPROVE | REQUEST_CHANGES | BLOCKED
Findings (most severe first):
  [CRITICAL|HIGH|MEDIUM|LOW] <title>
    Evidence: <file>:<line> + reproduction or test output
    Required change | Suggestion
Contract / license / security / migration impact: <text or "none">
Missing tests: <list>
Verification actually executed: yes|no — exact commands + exit codes
git status --porcelain after review: <must be empty>
Residual risks: <list>
--- WORKER CLAIMS ---
ROUND 2 REVIEW of M4-UI (fix 6936345 on top of e7e5987). Previous: git show torgal/ohmydate:docs/orchestration/reviews/M4-UIR-1.md. New devDependency fake-indexeddb 6.2.8 (license Apache-2.0 verified by coordinator; worker said MIT) + pnpm-lock delta: approved as test-only scope. Worker report:
Fixed all six M4-UIR-1 findings in commit 6936345 on branch torgal/m4-ui-integration: Today is now strictly GET /today with schedule-blocks only enriching matching IDs, Focus transitions/restoration/replay are serialized with durable journal append plus optimistic counters, session cache/client-id/journal are owner-namespaced with logout clearing and 404/403 treated as unavailable, session-start actions retain the full SessionCreate payload across retries, timers derive from startedAt+focusedSec+pausedSec, and push opt-in is disabled and guarded offline. | Finding | Resolution / regression | |---|---| | H1 unrelated-plan cards | current-plan-only cards; MSW two-plan test and real E2E two-approved-plan test shrink+reschedule every shown card | | H2 stranded rapid offline events | one in-flight transition per session, controls disabled; delayed-append double click/Space test and later-complete replay test | | H3 cross-owner session/journal leakage | owner-scoped localStorage/IndexedDB, auth switch clears memory, current-owner replay, account-switch and IndexedDB reopen tests | | H4 changing retry body | immutable full SessionCreate payload reused; lost-response same key/body test | | M timer reset on restore | server-clock cursor derivation; active-600s, paused and resumed reload tests | | M push offline | offline guard before permission/subscribe; supported-browser offline negative test | Verification: web test exit 0 (25 files/139 tests), web build exit 0 (250 modules), root ci exit 0 (121 files/1424 pass, 29 skipped; web 139; typecheck/lint/api-client/boundaries 336 files/build-smoke green), and e2e exit 0 (11 passed, 3.3m). Risks left: two-plan E2E needs enough remaining UTC day for two 45-minute plans (it passed), fake-indexeddb 6.2.8 (MIT dev-only) was added for real IndexedDB reopen coverage, and offline document reload is still impossible without a service worker so pending-indexedDB persistence is covered by the reopen test rather than an offline page reload.
Narrow focus (medium effort): re-run your round-1 component probes (two-plan Today cards; concurrent pause with delayed IndexedDB; logout/login owner switch with cached session + queued events; lost-response start retry same key/body; restored timer after 600 s; offline push opt-in) on this head; confirm the new two-approved-plan E2E really exercises shrink/reschedule on every shown card; run pnpm run e2e once.
Round 2 of 2: HIGH only for data corruption, cross-owner leakage, security, or E2E not testing the real flow; else APPROVE with follow-ups.

