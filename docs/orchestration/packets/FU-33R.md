# REVIEW PACKET: FU-33R — Independent review of FU-33
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-33-reconciler-end. Base: torgal/ohmydate. Head: cc49314.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-33.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...cc49314; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
task_709d77049187 (dispatch ctx_ea7e1aa25e64) on /home/torgal/orca/workspaces/oh_my_date/fu-33-reconciler-end branch torgal/fu-33-reconciler-end at commit cc49314: kept the lock client error/end listeners attached through end() with a closing flag, added connectionTimeoutMillis=queryTimeoutMs and delayed sweeping=true until the advisory lock is acquired, requested server keepalives via startup options (defaults 30/10/3, configurable), and re-pinned the T1 token input-symlink swap regression; changed only services/api/src/adapters/vikunja/reconciler.ts and services/api/test/vikunja/{reconciler-liveness,wiring,tcp-proxy}.ts (4 files, +307/-6). Requirement checklist: all four met (end-window backend-termination tests for the after-sweep and non-leader paths see no uncaught error, silent-proxy connect rejects within the timeout with no spurious abort log, SHOW tcp_keepalives_idle returns 30 on the lock session and 45 when configured, and the post-check input symlink swap still reads tk-inside); tests: DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 pnpm --filter @ohmydate/api test -> exit 0 (27 files, 160 passed/9 skipped) and same env pnpm run ci -> exit 0 (typecheck+lint clean, root 80 files 904 passed/27 skipped, web 13 files 68 passed, gen:api clean, boundaries 219 files/0 violations). Risks: the keepalive startup options affect only the lock session and the existing one-owner overlap is unchanged, no new contracts are needed by dependents, and rollback is git revert cc49314.

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. DB planner_test.
Re-run FU-28R-1 probes (end-window terminate, silent connect, server keepalive SHOW, T1 swap). Convergence: APPROVE unless HIGH/CRITICAL.
