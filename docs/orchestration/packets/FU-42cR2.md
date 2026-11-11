# REVIEW PACKET: FU-42cR2R — Independent review of FU-42cR2
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-42-shutdown-drain. Base: torgal/ohmydate. Head: 5b9fdf2.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-42cR2.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...5b9fdf2; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
ROUND 2 REVIEW of FU-42c (fix 5b9fdf2 on top of 9889704). Previous: git show torgal/ohmydate:docs/orchestration/reviews/FU-42cR-1.md. Worker report:
taskId=task_fc23259b644a dispatchId=ctx_a933bd9cdb67 worktree=/home/torgal/orca/workspaces/oh_my_date/fu-42-shutdown-drain branch=torgal/fu-42-shutdown-drain base=1cfd2fc merge=870d75a previous=9889704 new commit=5b9fdf2f7f80fc091967cb6e0d17621df7423c44

WHAT I DID
- Reproduced each FU-42cR-1 item as a failing test first: before the fix, 6/8 new regressions failed and the sync-reply case produced an uncaught ERR_STREAM_WRITE_AFTER_END.
- MEDIUM: the onRoute wrapper now creates and registers a fresh operation (meta from routeOptions/request) whenever request.raw has no unsettled record before calling the handler; started handlers are never settled by socket close.
- LOWs: (a) chain Promise.resolve(result).then(settle, settle+rethrow); (b) one socket-close listener per socket via WeakMap<Socket, Set<op>>; (c) wait for pending responses with the remaining cleanup budget before closeAllConnections; (d) server.close() at step 1 and app.close()/onClose only after handlers settle, with the comment corrected; (e) shutdownCleanupBudgetMs rejects >2500ms (12s drain + 500ms margin < 15s) at boot; (f) new commit body uses real newlines and Task footer.
- Committed the 1,000-request mixed registry-to-0 property test (async/sync/sync-reply/stream/hijack/preHandler/401/echo/404/bad-JSON) plus the connected-control 503 delivery regression.

FINDING TABLE
| Finding | Status | Evidence |
| MEDIUM pre-handler disconnect settles op, handler runs untracked | FIXED | onRoute re-creates op; real-socket preHandler 200ms + disconnect test proves close waits for handler; abort-ignoring variant exits 1 with unsettled log |
| LOW a Reply-thenable rejection crashes | FIXED | Promise.resolve chain; sync handler returning reply + write-after-end test leaves server alive, registry 0 |
| LOW b MaxListenersExceededWarning | FIXED | single listener per socket WeakMap; 15 pipelined GETs, zero warnings |
| LOW c cleanup-window responses cut off | FIXED | waitForResponses in remaining cleanup budget; 300ms handler with 100ms drain delivers 200; connected control receives 503 provider_unavailable |
| LOW d onClose before handlers finish | FIXED | app.server.close at step 1, app.close after settle; onClose timestamp >= handler finish |
| LOW e cleanup budget can reach deadline | FIXED | boot rejection + unit test; compiled boot with 3000 exits 1 naming SHUTDOWN_CLEANUP_BUDGET_MS |
| LOW f literal newlines in commit body | FIXED | git cat-file shows real multi-line body, Task footer; 9889704 left unrewritten to avoid history rewrite |

CHANGED PATHS (HEAD~1..HEAD): services/api/src/http/shutdown-context.ts, services/api/src/main.ts, services/api/test/shutdown-mutation-recovery.test.ts, services/api/test/shutdown-settlement-regressions.test.ts (new), services/api/test/shutdown-settlement.test.ts.

TESTS (real exit codes)
- DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm --filter @ohmydate/api test -> exit 0; 40 files passed, 226 passed / 9 skipped, 41.58s.
- DATABASE_URL=... VIKUNJA_URL=... corepack pnpm run ci -> exit 0; typecheck/lint clean, root 101 files / 1122 passed / 27 skipped, web 13 files / 69 passed, API client clean, boundaries 253 files / 0 violations, build smoke /healthz 200 {status:ok} and SIGTERM exit 0.
- New shutdown-settlement-regressions.test.ts alone -> exit 0; 8/8 passed (was 6 failed + 1 uncaught write-after-end before the fix).
- git diff --check -> clean; eslint on changed files -> clean.

RISKS / UNVERIFIED
- HTTP tracking remains HTTP/1 only.
- A handler or response that overruns the cleanup budget is still force-closed (by design; records released only if the handler promise settles).
- onClose hooks are now guaranteed to run after handler settlement; future hooks may rely on that ordering.
- The earlier 9889704 body still contains literal backslash-n sequences in history; it was not rewritten because that requires history rewriting.
- ROLLBACK: git reset --hard 9889704 (preserves the reviewed round-2 commits) or reset to 1cfd2fc; no migration or schema change.
Narrow focus (re-run, do not re-explore everything):
1) Re-run the round-1 MEDIUM repro (async preHandler + disconnect before handler start) and the R2 compiled disconnected-mutation probe with actual SIGTERM + PG after exit.
2) Verify each LOW fix (a)-(e) with one probe each; specifically: app.close()/onClose now runs after settlement — does reconciler.stop() still run on every exit path (including the exit-1 unsettled path and hard deadline)?
3) Confirm no regression in pipelining / trickle / 11s handler / pool disposal (run the existing production-timeouts + shutdown suites).
Round 2 of 2: HIGH only for data inconsistency, crashes, security; otherwise APPROVE with follow-ups.

