# REVIEW PACKET: FU-35R — Independent review of FU-35
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-35-api-main. Base: torgal/ohmydate. Head: 8e8b6f8.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-35.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...8e8b6f8; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
taskId=task_234d9fd79a15 dispatchId=ctx_2a29b30f7a29 worktree=/home/torgal/orca/workspaces/oh_my_date/fu-35-api-main branch=torgal/fu-35-api-main commit=8e8b6f8bc123ea3f6fe5bfbc63e990a5a0ac7640 (base merge-base cac3d17). Changed: main.ts refactor (createDatabasePool with connectionTimeoutMillis=5s, attachPoolErrorHandler logging idle pg errors without crash, exported shutdown controller with first-signal close, repeated-signal ignore, 15s deadline exit 1, close/destroy failures exit 1, entrypoint guard so tests can import main), app.ts readyz DB race with 2.5s deadline -> database=failed, package.json build/build:api/build:workspace-deps/dev(tsx)/start(node dist/main.js) scripts, new tsconfig.build.json (dist, src root) plus compilation of the three TS workspace deps into dist/node_modules so plain node can run, and two new test files. Requirement checklist: (1) pool error handling/connectionTimeoutMillis MET; (2) readyz 2.5s bound with never-answering TCP proxy test MET; (3) repeated signals ignored + 15s deadline exit 1 tests MET; (4) no-tsx production build/start and node dist/main.js /healthz -> 200 MET. Tests actually run: DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 pnpm --filter @ohmydate/api test -> exit 0 (30 files, 170 passed, 9 skipped); same env pnpm run ci -> exit 0 (root 83 files 923 passed/27 skipped, web 69 passed, api-client clean, boundaries 223 files/0 violations); pnpm --filter @ohmydate/api run build -> exit 0; DATABASE_URL=.../planner PROVIDER=vikunja node dist/main.js -> GET /healthz 200 {status:ok}, SIGTERM exit 0; targeted vitest main.test.ts+readyz-timeout.test.ts -> exit 0 (7 passed, readyz elapsed 2644ms). Risks/unverified: build script is tsc-based with inline post-build package.json synthesis for workspace TS deps (no new dependency, lockfile untouched); manual prod check used the dev planner DB after running migrations, and SIGTERM behavior is covered by controller unit tests rather than a spawned dist process; no new contracts needed. Rollback: git revert 8e8b6f8 (or reset branch to cac3d17) and rerun pnpm run ci.

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. DB planner_test (a scratch schema) only.
Re-run FU-30R-1 probes (idle backend kill, never-answering DB readyz, double SIGTERM, prod start without tsx incl. a SPAWNED node dist/main.js SIGTERM test). Judge the build approach (inline package.json synthesis for workspace TS deps into dist/node_modules) for robustness vs a bundler; flag Docker image implications. Convergence: APPROVE unless HIGH/CRITICAL.
