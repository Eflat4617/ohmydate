# TASK PACKET: M4-UIc — owner-bound Focus/Today client operations (M4-UI BLOCKED narrow fix)
Role: worker-frontend. Base: EXISTING branch torgal/m4-ui-integration at 6936345 (worktree m4-ui-integration). Read FULLY: docs/orchestration/reviews/M4-UIR2.md (P1/P2 reproductions) and M4-UIR-1.md.

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

ALLOWED PATHS: apps/web/**, e2e/** (assertion additions only).
DESIGN (binding):
- Owner epoch: the auth store exposes { ownerId, epoch }; setOwner (login/logout/me-refresh with a different owner) increments epoch and aborts in-flight Focus/Today/restore/flush work for the previous epoch (AbortController per epoch).
- Every async client operation captures { ownerId, epoch } at START and binds all writes to that owner: journal.append(event, ownerId) explicitly; session-store writes take an ownerId and are dropped (or written to the captured owner namespace) when it differs from the current owner; results arriving for an old epoch never touch current-owner UI/state.
- runFlush: dedupe keyed by owner; aborts when the owner changes; replays only records whose ownerId == current owner.
- Replay 403/404 for a record = terminal for that record: move it to a per-owner quarantine with a visible notice (do not block the rest of the queue); other errors keep the existing retry semantics.
- Login order: setOwner(new owner) happens before any post-login network call that writes local state (or the old epoch is invalidated before the cookie switch).
REQUIRED tests: reviewer P1 (pause in flight + login as B + network failure -> event stays in A's namespace, nothing in B) and P2 (A's replay in flight + login as B -> A's response never written to B); createSession and restoreSession responses after a switch; 403/404 replay quarantine does not block later events; plus E2E-4: shrink to 10 min and assert the GET /schedule-blocks endAt changed, and reschedule asserts startAt changed. LOWs: re-check online after the push permission prompt; fix the git diff --check whitespace in mocks/daily.ts.
Run and paste: pnpm --filter @ohmydate/web test ; pnpm --filter @ohmydate/web build ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456) ; same env pnpm run e2e. worker_done with finding table.
Retry limit 2. Rollback: reset branch to 6936345.
