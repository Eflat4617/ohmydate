# TASK PACKET: M4-UI — integrate Today/Focus/Review/Notifications UI (M4-03) with the real M4 API; E2E-4
Role: worker-frontend + e2e. Base: torgal/ohmydate HEAD (M4-02 merged). Steps: branch from torgal/ohmydate, then `git merge --no-edit torgal/m4-03-today-ui` (UNREVIEWED feature branch built on MSW; first review happens on this integration). Resolve conflicts keeping both.
Read: 07 §3.1 Today, §3.4 Focus, offline rules; 08 §2.5/§2.9/§2.10 + the new reads (GET /sessions/{id}, GET /sessions?state=active, GET /schedule-blocks); 11 E2E-4 ("Today -> session start/pause/complete -> feedback -> notification dedupe"); e2e harness (e2e/global-setup.ts, existing E2E-1/2/3); docs/orchestration/reviews/M4-02R2.md residual notes.

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

ALLOWED PATHS: apps/web/**, e2e/**.
REQUIRED
1) gen:api against current contracts; fix all type errors; replace device-local session lookup with GET /sessions/{id} and GET /sessions?state=active (resume across devices/deep links); Today and calendar show APPROVED blocks via GET /schedule-blocks; proposal approve uses availability If-Match (TodayProposal.availabilityVersion); errors.ts exhaustive map stays in sync.
2) Offline Focus journal replays against the REAL API exactly once (server clamps documented bounds); other mutations disabled offline.
3) MSW updated to the same contract so unit tests stay meaningful; all web tests green.
4) E2E-4 (real API, PROVIDER=vikunja, fake LLM): from an approved plan (reuse E2E-3 helpers via public APIs) -> Today shows blocks -> start session -> pause -> resume -> complete -> review (outcome + chips) -> estimation feedback shown -> notification for the next block appears once (no duplicate after a second job sweep or page reload; trigger the sweep via the leader job or a test-only hook already in the API — no DB writes) -> dismiss keeps it dismissed. Plus offline: go offline during a session, pause/resume locally, reconnect -> events uploaded once, server state consistent. axe zero critical/serious on Today and Focus; keyboard-only focus flow.
Run and paste: pnpm --filter @ohmydate/web test ; pnpm --filter @ohmydate/web build ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456) ; same env pnpm run e2e (E2E-1..4 green).
Retry limit 2. Rollback: delete branch.
