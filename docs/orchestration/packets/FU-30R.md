# REVIEW PACKET: FU-30R — Independent review of FU-30
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-30-api-prefix. Base: torgal/ohmydate. Head: 86a4629.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-30.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...86a4629; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
Implemented FU-30/FU-31: contract routes now mount under /api/v1 via Fastify register prefix with root /healthz and /readyz (DB plus Vikunja /api/v1/info), added services/api/src/main.ts using configFromEnv with SIGTERM shutdown and a start script, removed the Vite rewrite, and updated every API test to prefixed paths. E2E now spawns the real main entry with VITE_MOCK=0, cleans up partial state on setup failure, deletes run-state.json in teardown, asserts the 412 at network level, checks Vikunja project_id == inbox id, and disables edit/complete offline; e2e is typechecked via tsc -p e2e (root package.json typecheck edited per REQUIRED item 4, outside the literal allowed list). Verification: pnpm run ci exit 0 (813 passed/27 skipped plus web 68, boundaries 219/0), pnpm run e2e twice exit 0 (4/4 each), and bad-VIKUNJA_URL setup exited 1 with zero leaked schemas/state/processes; commit 86a4629 on torgal/fu-30-api-prefix, nothing left except the deployment note that the start script uses the tsx devDependency.

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. DB planner_test; live Vikunja synthetic only.
Coordinator accepts the root package.json typecheck edit (FU-30 item 4). Verify: every contract path served only under /api/v1 (unprefixed 404), /healthz /readyz behaviour (DB down, Vikunja down), main.ts configFromEnv + SIGTERM graceful shutdown (reconciler stops, pool closes), web client base /api/v1 end-to-end without the rewrite, e2e run x2, setup-failure cleanup, no assertion weakened in the prefixed test rewrite (diff the tests). Note start script uses tsx devDependency — flag deploy implication. Convergence: APPROVE unless HIGH/CRITICAL.
