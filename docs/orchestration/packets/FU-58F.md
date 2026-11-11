# TASK PACKET: FU-58F — Breakthrough fix for the test dist-artifact lease (Fable 5.2 medium, MODEL_BINDINGS §10)
Why Fable: the same defect class (two concurrent leases on the shared services/api dist artifact) has survived two review rounds (FU-57R2, FU-61-58R-1). Root cause first, then the smallest robust design.
Worktree/branch: torgal/fu-61-58-test-infra (HEAD 0251dc8). Read: docs/orchestration/reviews/FU-57R2.md and FU-61-58R-1.md (three-contender schedule), packets/FU-61-58.md, services/api/test/support/{dist-artifact,global-setup}.ts and their tests.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets, calling paid external APIs other than your own model.
3. Commit your work on your branch with Conventional Commits; include "Task: <taskId>" in the body.
4. Run every command in "Exact tests" and paste the real exit codes and tail output. Never claim a test passed
   that you did not run. If you could not run something, say SKIPPED + reason.
5. Send heartbeat if Orca's preamble asks for it.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
   (if your Orca preamble gives a different exact worker_done form, the preamble wins)
REPORT (body)
- taskId, dispatchId, worktree path, branch, commit SHA(s)
- changed paths (git diff --name-only <base>...HEAD) and 3–8 line diff summary
- requirement checklist: each acceptance item -> met / not met
- tests: command -> exit code -> key output lines
- risks, unverified items, new contracts needed by dependents, rollback method

ALLOWED PATHS: services/api/test/** only (+ services/api/vitest config / package.json test scripts if the design needs it — no production code, no dependency additions).
GOAL: no vitest invocation can ever consume or mutate a dist artifact another invocation is building or using; parallel full-suite runs from several worktrees/processes stay green.
Strongly consider eliminating shared mutable state instead of fixing the lock: e.g. each globalSetup invocation builds into its own unique output dir (mkdtemp under the worktree), passes that path to tests via env/provide(), and removes it in teardown (and a sweep of dirs whose owning pid is dead). If you keep a lock, it must be a primitive with atomic conditional takeover (no verify-then-rename window) and you must prove it against the reviewer's three-contender schedule.
REQUIRED: keep FU-61 readyz changes untouched; keep always-build semantics (every invocation builds); deterministic regression for the reviewer's three-contender schedule (or a test proving the design makes it impossible: two concurrent setups get distinct artifacts, neither can see the other's); build-ID guard stays; cleanup on success/failure; no tests deleted or assertions weakened.
Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456): pnpm --filter @ohmydate/api test ; two pnpm --filter @ohmydate/api test runs concurrently -> both exit 0 ; pnpm run ci. Commit (Task trailer), clean git status, worker_done with root cause + design + finding table.
Round 2 of 2 for this finding chain. Rollback: revert commits.
