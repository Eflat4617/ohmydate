# TASK PACKET: FU-41 fix round 1/2 (FU-41R REQUEST_CHANGES)
Role: worker-scheduler. Base: EXISTING branch torgal/fu-41-replan-bound at e35c459 (worktree fu-41-replan-bound).
Read FULLY: `git show torgal/ohmydate:docs/orchestration/reviews/FU-41R-1.md`; the NEW 06 §7 "영향 범위 계약" (`git show torgal/ohmydate:docs/blueprint/06-SCHEDULER-SPEC.md`); original packet docs/orchestration/packets/FU-41.md.

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

ALLOWED PATHS: packages/scheduler/** only.
REQUIRED
- Implement the contract exactly: affected = tasks hit by the trigger + BOTH endpoints of every added/removed/changed dependency edge + all successors; everything else frozen; if an affected task cannot be fully placed because of frozen blocks, add its predecessors to the affected set stage by stage (up to dependency depth) and retry; only then return an explained infeasible candidate; bound = per-block symmetric difference <= 2*affectedExistingBlocks+2, flagged when expansion exceeds it.
- Tests: the reviewer's deterministic Berlin counterexample (T1 dependsOn T0 added -> feasible, deficit 0) and the Seoul three-task case (fast-check seed 2035140076); the existing replan.property.test.ts dependency-change property must pass UNCHANGED; an unconditional infeasible-preservation negative; randomized forced multi-session replans; committed p90/remainingMin huge-value rejection matrix. Update packages/scheduler/src/types.ts docs to the contract wording.
Run and paste: pnpm --filter @ohmydate/scheduler test ; SCHED_PERF_ASSERT=1 pnpm --filter @ohmydate/scheduler test ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456).
Retry limit: this is round 1 of 2. Rollback: reset branch to e35c459.
