# TASK PACKET: FU-52c — spend reservation upper bound + reservation recovery (FU-52 BLOCKED narrow fix)
Role: worker-backend. Base: EXISTING branch torgal/fu-52-deepseek-llm at 92095a7 (worktree fu-52-deepseek-llm). Read FULLY: docs/orchestration/reviews/FU-52R-1.md and FU-52R2.md; ledger 15:38 design.
SECURITY (binding): never read/print/copy secret files; no real gateway calls (fake HTTP server only).

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

ALLOWED PATHS: packages/llm/** , services/api/src/app.ts (ledger wiring only), services/api/src/application/intake/intake-service.ts (usage persistence only), services/api/test/**, services/api/migrations/0011_* (unmerged; may edit).
REQUIRED
1) HIGH input bound: reservation input tokens = an UPPER BOUND of the full outbound request: UTF-8 byte length of the serialized messages (system + user + untrusted blocks + JSON-mode fallback instruction) + fixed per-message overhead (document, e.g. 16 tokens/message + 64) — byte count is a safe upper bound for BPE tokenizers (one token covers >=1 byte). Reserve with that, round UP to the next micro-dollar. Regression: reviewer's concurrent schema-sized Korean input case (20 concurrent calls vs $0.035 cap; simulated 8200/2000 usage) -> dispatched calls' worst-case spend <= cap; plus ASCII, emoji/astral, mixed.
2) MEDIUM stale reservations: a leader-only (or on-demand at reservation time) recovery settles reservations older than (request timeout x (retries+1) + margin) at their reserved amount (state=settled, reason=recovered) — never release potentially billable work; settlement DB failures retried with bounded backoff and, if still failing, left reserved for recovery (policy does not mark settled before the DB write succeeds). Tests: crash-before-dispatch (row reserved, recovered), abort mid-call, transient settlement failure.
3) MEDIUM usage aggregation: every terminal LlmError from runStructured carries the accumulated usage of all charged attempts; intake persists it to agent_run. Tests: repair rejection, transport failure, timeout after a charged first attempt.
Run and paste: pnpm --filter @ohmydate/llm test ; pnpm --filter @ohmydate/api test ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456). worker_done with finding table.
Retry limit 2. Rollback: reset branch to 92095a7.
