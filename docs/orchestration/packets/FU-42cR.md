# REVIEW PACKET: FU-42cRR — Independent review of FU-42cR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-42-shutdown-drain. Base: torgal/ohmydate. Head: 9889704.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-42cR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...9889704; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-42c (redesign after FU-42 BLOCKED). Branch torgal/fu-42-shutdown-drain: merge 870d75a + fix 9889704. Review the WHOLE FU-42 diff vs torgal/ohmydate (merge candidate). Read: docs/orchestration/packets/FU-42c.md (binding design), reviews FU-42R-1.md and FU-42R2.md — re-run every repro. Worker report:
taskId=task_346a9c5a32a7 dispatchId=ctx_bba02163ba2e worktree=/home/torgal/orca/workspaces/oh_my_date/fu-42-shutdown-drain branch=torgal/fu-42-shutdown-drain base=1cfd2fc merge=870d75a commit=9889704c9f7f27ce736024ed14bae685184717e0

WHAT I DID
- In-flight tracking now follows the route-handler promise, not socket/response events. onRequest creates an operation record; an onRoute wrapper marks handlerStarted and settles when the handler promise resolves/rejects. onResponse/onError settle only handlers that never started; a socket-close fallback covers incomplete bodies but is removed on settlement. A client disconnect no longer settles an operation.
- Shutdown sequence: stop accepting + drop idle/incomplete-only sockets (preserve complete pending responses); wait all operations up to 12s drain, allowing pending responses to flush within that budget; abort the app signal unconditionally (independent of app.close()); wait 2s cleanup with DB alive; close remaining sockets; then throw if any operation is still unsettled so the controller destroys the DB and exits 1.
- Added real regressions: compiled dist/main spawn with synthetic Vikunja provider + isolated planner_test schema + actual SIGTERM after client disconnect, querying PG after actual process exit; compiled never-settling fixture proving exit 1, unsettled log {count,routes}, DB destroyed after cleanup and before deadline; in-process aborted-handler/stream/hijack registry-release tests; controller created before listen.

CHANGED PATHS (9889704): services/api/src/http/shutdown-context.ts (+169/-...), services/api/src/main.ts, services/api/test/shutdown-drain.test.ts, services/api/test/shutdown-settlement.test.ts (new), services/api/test/support/never-settling-app.mjs (new).

REQUIREMENT CHECKLIST
1) Disconnected-client mutation, compiled spawn, actual SIGTERM, PG after exit: MET (test asserts needs_reconcile=true, idempotency rows 0, exit 0).
2) Never-settling handler ignores abort -> exit 1 with unsettled {count:1,routes:[{route:'/never'}]}, DB_DESTROYED after drain+cleanup, before 5s deadline: MET.
3) Socket-aborted completed handler / aborted stream / never-ended hijack release records to 0: MET.
4) Shutdown listeners created at boot before requests: MET (in-process close-before-listen plus production main/fixture).
5) FU-37/FU-42 regressions stay green: MET (full api suite + full CI).
Binding shutdown order (accept -> drain -> abort -> cleanup -> sockets -> db.destroy/exit): MET.

TESTS (real exit codes)
- DATABASE_URL=... VIKUNJA_URL=... corepack pnpm --filter @ohmydate/api test -> exit 0; 39 files passed, 216 passed / 9 skipped, 51.14s.
- DATABASE_URL=... VIKUNJA_URL=... corepack pnpm run ci -> exit 0; typecheck/lint OK, root 100 files / 1112 passed / 27 skipped, web 13 files / 69 passed, API client clean, boundaries 252 files / 0 violations, build smoke /healthz 200 and SIGTERM exit 0.
- New shutdown-settlement.test.ts alone -> exit 0; 6/6 passed, 18.56s (mutation ~12s at production budgets; never-settling exit 1 after ~0.9s).
- git diff --check -> clean.

RISKS / UNVERIFIED
- HTTP tracking remains HTTP/1 only.
- Forced socket closure can terminate client transport before a domain 503 is delivered (unchanged residual).
- Background reconciler work is not request-scoped and can still affect shutdown duration.
- Requires no new schema/OpenAPI/dependency; cancellation contract unchanged.
- ROLLBACK: git reset --hard 1cfd2fc (or revert 9889704; merge commit 870d75a brings only docs).
Focus asks:
1) Your FU-42R2 disconnected-client mutation probe on compiled code with actual SIGTERM, PG queried after exit: needs_reconcile=true, idempotency released.
2) Handler-promise tracking via onRoute wrapper: covers every route (including ones registered by plugins, 404 handler, errors before the handler, async/sync/stream handlers)? Any path leaking a record forever or double-settling? Registry size returns to 0 under 1,000 mixed requests incl. client aborts.
3) Exit policy: unsettled -> exit 1 after cleanup, DB destroyed last, hard deadline absolute; no success reported while work is outstanding.
4) FU-37/FU-42 behaviours: pipelining, keep-alive, trickle, 11s handler drain, pool disposal, query-secret log redaction.
Round 1 of 2 for FU-42c. HIGH only for data inconsistency, crashes, security.

