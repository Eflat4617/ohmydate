# REVIEW PACKET: FU-58FRR — Independent review of FU-58FR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-61-58-test-infra. Base: torgal/ohmydate. Head: 7bf0505.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-58FR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...7bf0505; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
ROUND 2 REVIEW of FU-58F (breakthrough fix by Fable 5.2 medium, MODEL_BINDINGS §10) + FU-61. Branch torgal/fu-61-58-test-infra HEAD 7bf0505 (91d3fa8 timeout budget + 7bf0505 design) on 0251dc8. Merge candidate torgal/ohmydate...7bf0505. Previous: docs/orchestration/reviews/FU-61-58R-1.md (git show torgal/ohmydate:...). Coordinator decision A (ledger 23:28): DistLock + the tests that only exercised it may be deleted with the code; worker must map each deleted test to a replacement. Coordinator ran pnpm install --frozen-lockfile in this worktree after the worker's reported node_modules incident (no-op, clean). Worker report:
WHAT I DID: replaced the shared services/api/dist + DistLock with a per-invocation private build workspace; all exact tests are green on the committed tree. WHAT I FOUND: the lock was never the real defect, and two concurrent suites additionally time out on the DB migration advisory lock (fixed by a timeout budget, separate commit). WHAT IS LEFT: nothing in scope; residual risks listed below.

taskId task_df6ec8898494 | dispatch ctx_da15321082f0 | worktree /home/torgal/orca/workspaces/oh_my_date/fu-61-58-test-infra | branch torgal/fu-61-58-test-infra | commits 91d3fa8 (timeout budget), 7bf0505 (design) on base 0251dc8.

ROOT CAUSE: every vitest invocation rebuilt and consumed the single services/api/dist. Mutual exclusion then depended on a directory lock with stale-owner takeover (verify-then-rename is never atomic: FU-57R2, FU-61-58R-1), and even a perfect lock could not stop another invocation rebuilding between two consumers (the build-ID mismatch the reviewer hit).

DESIGN (no lock at all): globalSetup sweeps dead-owner workspaces, creates <tmpdir>/ohmydate-api-build-<hash(apiRoot)>/ws-<pid>-XXXXXX by mkdtemp (owner pid is in the atomically created name, never ownerless), mirrors build inputs as symlinks, runs the unmodified `build` script there into a private dist, stamps a random build id, provides {build id, workspace api root}, and returns a teardown that removes it (also removed when setup fails). Consumers spawn from the provided path and keep asserting the build id. The build-smoke test runs a byte copy of scripts/ci/build-smoke.mjs in its own workspace. No vitest code reads or writes services/api/dist any more. Inside a workspace `pnpm` is a run-only shim (test/support/pnpm-run-shim.mjs) and no package-manager files are mirrored. Workspaces live in the OS temp dir rather than under the worktree, because eslint, tsc, check-boundaries and git would otherwise scan them.

CHANGED PATHS (git diff --name-only 0251dc8...HEAD): services/api/test/{dist-artifact.test.ts, global-setup.test.ts, production-timeouts.test.ts, shutdown-settlement.test.ts, db/helpers.ts, support/dist-artifact.ts, support/global-setup.ts, support/test-context.ts, support/fake-repo.ts (new), support/pnpm-run-shim.mjs (new)}, services/api/vitest.config.ts. No production code, no dependencies. readyz-timeout.test.ts (FU-61) untouched.

FINDING TABLE:
- FU-57R2 MEDIUM (ownerless publication window) -> eliminated: no lock, no owner publication.
- FU-61-58R-1 HIGH (three contenders, two live leases) -> impossible by construction: no path shared by two invocations. Regression: global-setup.test.ts 'three contenders: teardown and a later rebuild never touch an artifact in use', run against the real workspace/build/stamp code.
- FU-61-58R-1 residual (foreign rebuild between consumers -> build-ID mismatch) -> eliminated; concurrent full suites pass.
- NEW: two concurrent api suites time out (30 s) in rollback/reapply DB tests because src/db/migrate.ts takes a database-wide advisory lock and both runs share planner_test. Fixed in commit 91d3fa8 by raising the load budget 30 s -> 120 s in vitest.config.ts, test/db/helpers.ts, test/support/test-context.ts. No assertion changed. Please review this explicitly: it is outside the dist finding chain and easy to revert on its own.

DELETED TESTS (coordinator-approved option A). Correction to my question: the 'dist lock' block had 4 tests, not 5. Each with its replacement:
1. 'acquires and releases a lock it owns' -> 'mirrors build inputs read-only and keeps every written path private' (create/remove lifecycle of the owned resource).
2. 'release with a mismatched owner token is a no-op' (never destroy another holder's state) -> 'a setup that fails next to a healthy one removes only its own workspace' and 'sweep removes only workspaces whose owner process is gone'.
3. 'two waiters reclaiming one crashed holder yield exactly one lease' -> 'sweep removes only workspaces whose owner process is gone' (crash recovery without takeover) and 'two concurrent setups get distinct artifacts and neither can see the other'.
4. 'paused owner publication cannot hand a second waiter a second lease' -> 'three contenders: ...' and 'two concurrent setups ...'.
Kept 1:1: the four build-ID guard tests; always-build ('builds on every invocation, each in a new workspace, even when a stamped artifact already exists'); failure cleanup ('removes the workspace and provides nothing when the build fails'). Negative required by condition 3: a consumer given another invocation's artifact is rejected with /mismatch/ in both concurrency tests. 14 new tests in total, plus two added assertions in the build-smoke test.

CHECKLIST: FU-61 untouched met | always-build met | three-contender regression met | build-ID guard stays met | cleanup on success/failure met | no assertions weakened met | no tests deleted: 4 deleted with approval.

TESTS (DATABASE_URL/VIKUNJA_URL as given, on HEAD 7bf0505):
- pnpm --filter @ohmydate/api test -> exit 0; 64 files, 440 passed, 9 skipped.
- same command twice concurrently -> exit 0 and exit 0; each 64 files, 440 passed, 9 skipped (~130 s). Before the timeout commit this pair failed 3 of 3 attempts on DB timeouts only, never on dist.
- pnpm run ci -> exit 0; root 137 files, 1613 passed, 29 skipped; web 32 files, 240 passed; boundaries 390 files 0 violations; build-smoke healthz 200 and SIGTERM exit 0.
- git status clean; no workspaces left in the temp base dir.

INCIDENT (repaired, please be aware): my first prototype ran the real `pnpm run build` in a symlink mirror; pnpm 12 auto-ran an install through the links and re-pointed this worktree's node_modules (412 symlinks, bin wrappers, .pnpm-workspace-state-v1.json, storeDir in .modules.yaml) at my scratch dir. I restored all of them by hand; no tracked file changed and the full ci above passed afterwards. If you want certainty, a `pnpm install --frozen-lockfile` in this worktree rebuilds it. It also left a stray store at /tmp/.pnpm-store, which I did not delete. This hazard is why the final design uses the run-only shim.

RISKS / UNVERIFIED: (1) scripts/ci/build-smoke.mjs still rebuilds the real services/api/dist, so two `pnpm run ci` in the SAME worktree can still collide in that final step; fixing it needs a change outside allowed paths. (2) The shim re-implements `pnpm run` (sh -c, node_modules/.bin on PATH); a build script needing other pnpm subcommands fails loudly with exit 64. (3) The sweep trusts pid liveness; pid reuse only delays cleanup, but a process in another pid namespace sharing /tmp could have a live workspace swept. (4) The 120 s budget covers a few concurrent runs, not unbounded; the real fix is a per-schema migration lock or per-run database (production/infra). (5) Concurrency verified with two runs in one worktree, not across several worktrees. No new contracts for dependents. Rollback: git revert 7bf0505 91d3fa8.
Narrow focus (medium): (1) re-run your three-contender schedule idea against the new design — can two invocations ever share/see a build artifact? (2) verify the deleted-test -> replacement mapping (4 tests) keeps each guarantee; no other assertion removed/weakened; (3) commit 91d3fa8 (30 s -> 120 s DB test budget): acceptable as a dev-only budget, or masks a real hang? (4) shim/sweep safety: the workspace build can never write into the real worktree (node_modules, dist, lockfile) — check the pnpm-run shim and the mirrored inputs; sweep only removes dead-owner workspaces under its own base dir. (5) run pnpm --filter @ohmydate/api test twice concurrently once.
Round 2 of 2: HIGH only for a remaining shared-artifact path, weakened assertions, or writes into the real worktree; else APPROVE with follow-ups (build-smoke.mjs rebuilding real dist is a known follow-up).

