# REVIEW PACKET: GU-1-PKGRR — Independent review of GU-1-PKGR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/gu-1-pkg. Base: torgal/ohmydate. Head: f7dcf36.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/GU-1-PKGR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...f7dcf36; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of GU-1-PKG (local run package for the user try-out: isolated compose stack ohmydate-local + scripts/local setup/start/stop/status + tests; implementer DeepSeek 4.1 Flash high). Reviewer: Fable 5.2 xhigh in place of Sol (weekly limit; MODEL_BINDINGS §12). You are the REVIEWER: read-only — do not edit/create/commit repository files (scratch only outside the worktree); finish with the REVIEW VERDICT format. NEVER read, print or copy *api_key* files or anything under deploy/secrets/**; do not call the LLM gateway; do not run docker. Branch torgal/gu-1-pkg commit f7dcf36. Merge candidate torgal/ohmydate...f7dcf36. Read docs/orchestration/packets/GU-1-PKG.md (git show torgal/ohmydate:...), ADR-022 + GU-1/GD-3 notes in docs/blueprint/13-ADR.md, services/api/src/config.ts, services/api/src/adapters/vikunja/owner-accounts.ts, e2e/global-setup.ts.
HOST LOAD RULE (overrides the MUST line for this command only): do NOT run the full `pnpm run ci` — the host is shared and the coordinator runs it on the merge result (the worker reports it green on the first run). Run instead: `pnpm run typecheck`, `pnpm run lint`, `pnpm run check:boundaries` and the commands in Focus. NOTE: in parallel with your review the coordinator verifies the docker stack + real LLM from this same worktree under compose project `ohmydate-local-verify` (gitignored deploy/secrets/local/, .local/, dist/ may appear — they are not your findings; do NOT read deploy/secrets/** and do not stop those processes).
Worker report (treat as unverified claims):
taskId: task_b9751d693222
dispatchId: ctx_9f0fc1356b11
worktree: /home/torgal/orca/workspaces/oh_my_date/gu-1-pkg
branch: torgal/gu-1-pkg
commit: f7dcf364d93b5a23770fe1648e0d7ac425bf0728

WHAT I DID
- Added deploy/local/compose.yaml: project ohmydate-local, same pinned postgres:18 and vikunja/vikunja:2.8.0 digests as deploy/dev, all ports 127.0.0.1 (pg 55442, vikunja 3466 from local.env), pgdata volume + ~/.local/share/ohmydate-local/vikunja-files, db-init creating vikunja/planner, restart unless-stopped, dev-style postgres healthcheck. Passwords and VIKUNJA_SERVICE_SECRET come only from deploy/secrets/local/stack.env via env_file; no secret literals.
- Added deploy/local/local.env (non-secret ports, NODE_ENV=production, ADR-022 LLM defaults/model/effort/base URL, budget 0.2/5, LLM_API_KEY_FILE default deepseek_api_key.txt) and deploy/local/README.md (English operator order/notes, registration is 127.0.0.1-only).
- Added scripts/local: secrets.mjs (0700 dir, 0600 random files, idempotent, never prints values), setup.mjs (Korean hidden prompts or env, secrets, health wait with exact compose hint, migrations, Vikunja login/register + Inbox + e2e-parity token/365d, token file + meta, create-user via stdin, owner upsert, --rotate-token), start.mjs (stale-build detection/--rebuild, preflight with access-only key check, detached API + vite preview, PID/log rotation, Korean URL), stop.mjs (SIGTERM then bounded SIGKILL, PID cleanup, never docker), status.mjs (Korean stack/migrations/secrets/key-presence/token-expiry/API/web summary), plus vitest config/tests and dev-infra smoke.
- Added root scripts local:setup/start/stop/status/test:local; .gitignore .local/ (deploy/secrets/ already ignored).

CHANGED PATHS (vs torgal/ohmydate, 23 files)
.gitignore, package.json, deploy/local/{README.md,compose.yaml,local.env}, scripts/local/{args.test.mjs,common.mjs,permissions.test.mjs,preflight.test.mjs,prompt.mjs,secrets.mjs,secrets.test.mjs,setup-cli.test.mjs,setup.mjs,smoke.test.mjs,stack.mjs,start.mjs,status.mjs,stop.mjs,stop.test.mjs,token-file.test.ts,vikunja-token.mjs,vitest.config.mjs}

CHECKLIST
- compose project/ports/digests/volumes/db-init/env_file/publicurl/registration/restart/healthcheck: MET (PyYAML syntax parsed; docker itself not run per rules).
- local.env + README: MET.
- secrets init: MET, tests cover modes/no-overwrite/no-printed-value.
- setup prompts/env, health error hint, migrations, Vikunja user+Inbox+token parity/365d, token file format, create-user stdin, owner upsert, idempotent + rotate-only: MET (smoke verified no duplicates/unchanged token).
- start build detection/preflight/detached API+preview/PID/logs/health/Korean URL/--fake-llm: MET.
- stop/status: MET.
- tests: MET; token writer round-trips the real API parser; permission parity reads e2e/global-setup.ts; key check has access/stat spies and never reads.
- docker stack start/health and real deepseek call: NOT RUN (coordinator-only).

TESTS (real exit codes)
1) corepack pnpm run lint -> exit 0 -> clean (no output).
2) DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run test:local -> exit 0 -> 8 files, 24 passed, 1 skipped. The dev-infra smoke ran setup -> start(--fake-llm) -> POST /api/v1/auth/login via the web preview proxy (HTTP 204) -> status (all normal) -> stop -> no PID files -> second setup no-op (users=1/owners=1, token unchanged); temp schema dropped.
3) corepack pnpm run check:boundaries -> exit 0 -> 545 files, 0 violations.
4) Full CI after coordinator go: DATABASE_URL=... VIKUNJA_URL=... corepack pnpm run ci -> exit 0 -> typecheck all workspaces; root vitest 181 files/2166 passed/30 skipped; web 54 files/502 passed + sweep 6 files/156 passed; check:api-client clean; boundaries 0; build-smoke /healthz 200 and SIGTERM exit 0. No load timeout occurred, so no rerun was needed.

RISKS / UNVERIFIED
- Docker compose up, image pull, actual health of the isolated stack, and any real DeepSeek call are coordinator-only and unverified here. Compose is syntactically valid but was not evaluated by docker.
- First setup creates secrets then intentionally fails with the compose hint until the coordinator starts the stack; README documents the order.
- Local token expiry days come from a 0600 sidecar meta file written by setup; if that file is removed status reports expiry unknown (validity still checked via GET /user).
- Rollback: delete branch torgal/gu-1-pkg or revert commit f7dcf36; no migrated/shared DB or infra was modified.
Focus (narrow — this package holds the user's real data and secrets):
(1) Secret hygiene: no secret value is ever printed, logged, put in argv (visible in ps) or in an env var of a long-lived process when a file path would do; generated files 0600 / dir 0700 even under a permissive umask; idempotent (never overwrites); the LLM key file is only access()/stat()ed, never opened; the Vikunja token + user password never reach stdout/stderr/logs (check every error path, including child-process stderr passthrough from create-user / migrations / API logs in .local/logs).
(2) Compose: secrets only via env_file; every port 127.0.0.1; same image digests as deploy/dev; VIKUNJA_DATABASE_PASSWORD actually provided; init service idempotent; volumes named per project; anything that would break under `sudo docker compose` (HOME, relative env_file path).
(3) Setup correctness and idempotency: Vikunja register vs existing login; Inbox; token permissions exactly the e2e set; 365-day expiry; token file format accepted by the API parser; create-user via stdin; owner upsert; second run a no-op; --rotate-token replaces the token atomically (no window with a broken file); migrations target the LOCAL planner DB only (never the dev/test DBs); partial-failure recovery (setup interrupted after Vikunja register but before create-user).
(4) Start/stop/status: production boot config matches what services/api requires (PUSH_KEY_FILE, LLM_SESSION_SECRET_FILE, budgets, HOST=127.0.0.1, no fake knobs in production); session cookie works on http://127.0.0.1 through vite preview (Secure cookie / CSRF / Origin through the proxy); stale-build detection cannot serve an old build silently; stop only signals processes it started (PID reuse — verify the PID still belongs to our command before SIGKILL); detached children survive the terminal closing; logs rotate without unbounded growth.
(5) Tests: the dev-infra smoke uses a temporary schema and drops it, never touches planner/vikunja dev data beyond one synthetic user; no test reads real secrets; negatives exist (stack down, key missing); nothing weakened or skipped without reason (explain the 1 skipped test).
(6) Run with env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456: pnpm run test:local ; pnpm run lint ; pnpm run check:boundaries.
Round 1 of 2. HIGH for any secret exposure, a write to the wrong database, a non-127.0.0.1 bind, stop killing a foreign process, a broken production boot, non-idempotent setup that duplicates or locks out the user.

