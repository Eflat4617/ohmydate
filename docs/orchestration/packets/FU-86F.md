# TASK PACKET: FU-86F — fix round 1/2 for FU-86 (review FU-86R: REQUEST_CHANGES, 1 Required MEDIUM)
Role: worker (Opus 5.5 xhigh — UI). Worktree/branch: torgal/fu-86-block-lock-ux (HEAD b6dc9bc) — continue on it, do NOT rebase.
Read first: docs/orchestration/reviews/FU-86R.md (`git show torgal/ohmydate:docs/orchestration/reviews/FU-86R.md` — reproduction with numbers), packets/FU-86.md (original scope; all rules still apply).


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

HOST LOAD RULE: the laptop is on battery; keep test runs targeted. Before the full `pnpm run ci` or full `pnpm run e2e`, send `orca orchestration ask` and wait for the go.

ALLOWED PATHS: apps/web/** , e2e/tests/e2e-5r-replan.spec.ts.
REQUIRED
1) [MEDIUM, Required] The "saving" reason note must not move the layout: reserve its line at all times (fixed min-height, visibility toggled) or overlay it on the calendar, so the pressed toggle and its neighbours stay at the same position before, during and after a lock request, on desktop and at 390 px. Keep the role=status announcement but announce only when the user could be affected (e.g. when the calendar is visible/editable or a drag is under way) — or justify keeping it. Verify in a real browser (dev server, VITE_MOCK=1, delayed lock answer): measure the bounding boxes of the calendar panel and both approved-row toggles before/during/after — report the numbers. Add a regression check: an E2E-5R (or Playwright component-level) bounding-box assertion that the approved rows do not move when a toggle is pressed.
2) [LOW, do it] Test the calendar's own non-editable state while a lock is out: .calendar-resize absent and pointerdown+pointermove changes nothing (independent of the page guard; the reviewer's mutation `:editable` without the lock condition must now fail a test).
3) [LOW, do it] After a lock/unlock failure WITHOUT a server answer (network error), re-read the plan so a revision applied server-side cannot later reset a newer draft silently; test (mock applies the lock then returns a network error -> plan re-read, calendar at the new revision).
Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456): pnpm --filter @ohmydate/web lint ; pnpm --filter @ohmydate/web test ; pnpm run e2e e2e-5r ; then (after the coordinator's go) pnpm run ci ; pnpm run e2e. Commit (Task trailer), clean git status, worker_done.
Retry limit: this is round 1 of 2. Rollback: revert the fix commit(s).
