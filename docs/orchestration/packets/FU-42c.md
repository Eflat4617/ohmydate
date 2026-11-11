# TASK PACKET: FU-42c — shutdown settlement tracked by handler work, not sockets (FU-42 BLOCKED redesign)
Role: worker-backend. Base: EXISTING branch torgal/fu-42-shutdown-drain at 1cfd2fc (worktree fu-42-shutdown-drain). First `git merge --no-edit torgal/ohmydate`.
Read FULLY: docs/orchestration/reviews/FU-42R-1.md and FU-42R2.md (all repros, especially the disconnected-client mutation and the socket-aborted-unsettled residuals).

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

DESIGN (binding):
- In-flight tracking = the handler's own async work: an onRequest hook creates an operation record whose completion is the settlement of the ROUTE HANDLER PROMISE (wrap via preHandler/onRoute handler wrapper or an AsyncLocalStorage scope whose promise is awaited), independent of socket/response events. A client disconnect does NOT settle it; a finished handler always settles it (also for aborted sockets, streams, hijacks) — no leaked records.
- Shutdown sequence: (1) server stops accepting; idle/incomplete-only sockets closed; sockets with a pending valid response preserved (keep FU-42 round-1 behaviour). (2) wait for ALL operations up to drain budget (12s). (3) fire the abort signal for remaining operations (the timer must not be cleared just because app.close() resolved), wait up to cleanup budget (2s). (4) If operations are still unsettled: log error {count, routes(template only)} and exit 1 (explicit failure, never report success). (5) Only after (2)–(4): close remaining sockets, then db.destroy(), then exit. Hard deadline 15s stays absolute.
REQUIRED tests (real sockets, compiled-code spawn where the reviewer did):
1) Disconnected-client mutation: real authenticated PATCH, real PG stores (isolated planner_test schema), synthetic provider applies PATCH then stalls GET; client disconnects; SIGTERM; after ACTUAL process exit query PG: needs_reconcile=true, idempotency row released; exit 0 only if settled within budgets.
2) Never-settling handler that ignores abort -> exit 1 with the unsettled log, db destroyed only after the cleanup budget expires (before hard deadline).
3) Socket-aborted completed handler, aborted stream, hijack: operation records released after handler completion (registry size back to 0).
4) Listeners/operations installed BEFORE requests (create the shutdown controller at boot as production does).
5) All FU-37/FU-42 regressions stay green.
ALLOWED PATHS: services/api/src/main.ts, services/api/src/app.ts (shutdown/request context only), services/api/src/http/shutdown-context.ts, services/api/test/**.
Run and paste: pnpm --filter @ohmydate/api test ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456). worker_done with finding table.
Retry limit 2. Rollback: reset branch to 1cfd2fc.
