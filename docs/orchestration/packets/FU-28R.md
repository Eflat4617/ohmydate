# REVIEW PACKET: FU-28R — Independent review of FU-28
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-28-reconciler-live. Base: torgal/ohmydate. Head: 881384f.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-28.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...881384f; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
taskId task_9ee9cbfae8b7, dispatchId ctx_6828fa90b18e: FU-28 is committed on branch torgal/fu-28-reconciler-live (commit 881384f, worktree /home/torgal/orca/workspaces/oh_my_date/fu-28-reconciler-live) touching only allowed paths: reconciler.ts (keepAlive 10s, statement_timeout/query_timeout 5s, active SELECT 1 leadership probes between owners and after the last owner, exactly one lock-loss log, lastRunAt only when still leader), owner-accounts.ts (O_NOFOLLOW open, fstat dev/ino match and /proc/self/fd containment before reading the handle), config.ts (DEFAULT_RECONCILE_INTERVAL_MS=300000 for PROVIDER=vikunja with databaseUrl, 0 for memory/absent DB), plus reconciler.test.ts, wiring.test.ts, reconciler-liveness.test.ts and tcp-proxy.ts. Found: the exact API test command exits 0 (27 files, 156 passed/9 skipped) and the same-env pnpm run ci exits 0 (typecheck + lint clean, root 818 passed/27 skipped, web 68 passed, check:api-client diff clean, boundaries 219 files/0 violations), covering silent TCP-proxy blackhole plus pg_terminate_backend (sweep stops at the probe with one error log and lastRunAt unset), bounded unlock timeout, leadership loss on the last owner, and leaf-symlink/inode and intermediate-dir swap rejection. Left: no blockers or skipped required checks; rollback is reverting 881384f, residual risks are the pre-existing one-owner overlap window during a sweep and restart-required token rotation, and the only new internal contract is LeaderRun receiving LeaderLease {signal,isLeader} (all in-repo/test implementers updated).

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. DB planner_test.
Re-run FU-27R-1 probes (silent loss via blackhole proxy, two-leader, unlock hang, token leaf/dir swap). This flips the reconciler to default ON for PROVIDER=vikunja: judge readiness end-to-end with FU-23 CAS (run the M1-10R-1 race probe with defaults). Convergence: APPROVE unless HIGH/CRITICAL.
