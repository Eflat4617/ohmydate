# REVIEW PACKET: FU-27R — Independent review of FU-27
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-27-reconciler. Base: torgal/ohmydate. Head: ec42c69.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-27.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...ec42c69; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
FU-27 implemented and committed as ec42c69 on torgal/fu-27-reconciler (worktree /home/torgal/orca/workspaces/oh_my_date/fu-27-reconciler). Leader lock now attaches error/end listeners that log via ReconcilerLogger and abort the sweep through an AbortSignal checked between owners; buildApp takes databaseUrl from AppConfig and rejects interval>0 without it; token file refs read the realpath (TOCTOU closed) and env:VIKUNJA_TOKEN_FILE is rejected; migrate.test pins MIGRATION_FILES and drops the dead 0002 branch; the five missing review tests were added. Both required commands pass on the committed tree: api test exit 0 (25 files, 142 passed/11 skipped) and pnpm run ci exit 0 (root 75 files 783 passed/33 skipped, web 68 passed, boundaries 213 files 0 violations); an initial full-suite flake from cross-worker advisory-lock contention on shared planner_test was fixed with per-test lock keys, and api test then passed 3x and ci 2x. Nothing is left; risks: abort is between owners (an already-running owner HTTP sweep completes), only pg_terminate_backend was simulated, and repo docs were not edited because they are outside the allowed paths (in-code docs updated); new contracts are AppConfig.databaseUrl (nullable, required when interval>0) and optional BuildAppOptions.reconcileLockKey; rollback is git revert ec42c69.

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. DB planner_test.
Re-run the M1-10R-2 probes (lock-probe: terminate lock backend mid-sweep -> no crash, sweep aborted; lock-loss two-leader probe; token TOCTOU; env:VIKUNJA_TOKEN_FILE). Judge readiness to enable the reconciler by default once FU-23 lands. Convergence: APPROVE unless HIGH/CRITICAL.
