# TASK PACKET: FU-66d — make the perf-gate self-test actually catch a generate()-based calibration (narrow, after FU-66R2 BLOCKED)
Role: worker (Opus 5.5 xhigh; DeepSeek missed this twice). Worktree fu-66-scheduler-test-speed, branch torgal/fu-66-scheduler-test-speed, HEAD 2308637. New round budget (2).
Read FULLY: docs/orchestration/reviews/FU-66R-1.md and FU-66R2.md (git show torgal/ohmydate:...). The FU-41 speedup (c12ff8f) and the independent hash calibration are accepted; do not change them or the 500 ms budget / best-of-5.

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

ALLOWED PATHS: packages/scheduler/test/performance.test.ts (and a new helper under packages/scheduler/test/ if needed).
REQUIRED (follow the reviewer's recipe):
1) Inject at the generate BINDING: vi.mock('../src/index.js', async (importOriginal) => { const a = await importOriginal(); return { ...a, generate: vi.fn(a.generate) }; }) (or equivalent), so every generate() call — including one a mistaken calibration would make — goes through the mock.
2) The gate and self-test A read the calibration from ONE shared constant (e.g. PRODUCTION_GATE.calibration) so changing the gate's calibration argument also changes what A tests.
3) Spy: around the production calibration, mockClear then expect(generate).not.toHaveBeenCalled() — a real assertion that fails if the calibration calls generate().
4) Self-test A: mockImplementation adds a +100% CPU burn to every generate() call; measure with PRODUCTION_GATE.calibration; assert the MEDIAN (not p95) per-sample ratio >= 1.6.
5) Mutation proof (scratch copy or in-memory transform, NOT committed): reviewer mutations M1 (runCalibrationWorkload body -> generate(buildLargeInput(), 3 policies, seed 50)) and M2 (gate calibration -> 3-policy generate(input)) must both make the suite FAIL; paste the outputs. Control (no mutation) passes.
6) Correct the commit-message/comment claims to what the code actually proves.
Exact tests: pnpm --filter @ohmydate/scheduler test ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456). Commit (Task trailer), clean git status, worker_done with the mutation outputs.
