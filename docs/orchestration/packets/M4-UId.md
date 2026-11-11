# TASK PACKET: M4-UId — hard reset on owner change (ADR-023) + serialized quarantine retry (M4-UIc BLOCKED)
Role: worker-frontend. Base: EXISTING branch torgal/m4-ui-integration at 4feec04. Read FULLY: docs/blueprint/13-ADR.md ADR-023; docs/orchestration/reviews/M4-UIcR-1.md and M4-UIcR2.md (both HIGH reproductions).

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

ALLOWED PATHS: apps/web/**, e2e/** (additions only).
REQUIRED
1) ADR-023 §1–2: a single ownerChanged(prev, next, reason) handler used by login (different user), logout, storage event and /me mismatch: abort current-epoch work, keep the previous owner namespace, then hard reset (location.reload / navigate to home after login). Inject the reload function for tests. App renders session/journal/settings UI only after /me confirms the owner (loading state before). Tests: storage event A->B -> reload called, no settings mutation possible before reload; external logout; login as different user; /me mismatch at boot; a settings mutation attempted between event and reload is rejected (binding mismatch) and never sends A's version.
2) ADR-023 §3: replay and quarantine retry run under one per-owner serial lock (navigator.locks when available; fallback in-tab mutex + BroadcastChannel notice); retry removes ONLY the entries it successfully re-queued (read-modify-write inside the lock), never clearing the owner quarantine wholesale. Regression: reviewer's delayed-append concurrent retry/flush probe -> new-key survives in quarantine; journal and quarantine consistent.
3) Mounted Focus regression: a never-settling owner-A operation is aborted by the owner change and B (after reset) is unaffected.
Run and paste: pnpm --filter @ohmydate/web test ; pnpm --filter @ohmydate/web build ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456) ; same env pnpm run e2e. worker_done with finding table.
Retry limit 2. Rollback: reset branch to 4feec04.
