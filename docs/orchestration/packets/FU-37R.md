# REVIEW PACKET: FU-37RR — Independent review of FU-37R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-37-api-pool. Base: torgal/ohmydate. Head: 35b8637.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-37R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...35b8637; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
Worker claims (FU-37, DeepSeek high, commit 35b8637, base c75f4ba; source review docs/orchestration/reviews/FU-35R-1.md):
- main.ts: pool.on('connect') attaches a per-client 'error' listener surviving checkout (logs code/message only); keepAlive:true; statement_timeout/query_timeout via PG_STATEMENT_TIMEOUT_MS / PG_QUERY_TIMEOUT_MS (default 10s).
- app.ts: Fastify requestTimeout/connectionTimeout via HTTP_REQUEST_TIMEOUT_MS / HTTP_CONNECTION_TIMEOUT_MS (default 10s).
- Entry guards in main.ts and src/db/migrate.ts compare realpath(argv[1]) (+ '.js') with this module (extensionless + symlinked launches).
- Tests: node net drop-proxy parks in-flight /readyz, destroys both sockets without FATAL -> 503 database=failed, process alive, recovers to 200; checked-out-client listener test (mutation-sensitive); entry-guard tests; slow-client shutdown test; DB test timeout 30s (vitest.config.ts); build smoke added to `pnpm run ci` (rm -rf dist, build, node dist/main.js PROVIDER=vikunja fake VIKUNJA_URL, /healthz 200, SIGTERM exit 0).
- ci EXIT 0: 957 passed/27 skipped, web 69, boundaries 0.
- Risks stated: build smoke SKIPS (exit 0) without DATABASE_URL; idle-backend errors may be warned twice; 10s defaults.
Coordinator focus asks:
1) Reproduce FU-35R finding 1 (checked-out socket drop without FATAL, frozen path then close) against this head: process must survive; also query_timeout race leaving client pinned.
2) Does statement_timeout default 10s break any legitimate long operation (migrations run via migrate.ts, reconciler sweeps, advisory lock session held by reconciler leader — must NOT be killed by statement/idle timeouts)? Check the reconciler's dedicated lock connection and migration runner.
3) requestTimeout vs slow uploads/long-poll — any route that legitimately exceeds 10s? graceful shutdown interplay.
4) Build smoke silently skipping without DATABASE_URL: acceptable or should fail loudly in ci? Recommend.
5) Entry guard: no double-execution when imported by tests; Windows-irrelevant.
6) Secrets: logs exclude connection strings / SQL text / params.

