# TASK PACKET: FU-90F — fix round 1/2 for FU-90 (review FU-90R: REQUEST_CHANGES, 2 Required MEDIUM)
Role: worker (DeepSeek 4.1 Flash high). Worktree/branch: torgal/fu-90-local-stack-followups (HEAD e8b9ad9) — continue on it, do NOT rebase.
Read first: docs/orchestration/reviews/FU-90R.md (`git show torgal/ohmydate:docs/orchestration/reviews/FU-90R.md` — reproductions), packets/FU-90.md (original scope; all its rules still apply: never read deploy/secrets/** or *api_key*, never run docker/real sudo, fake sudo shim on a PATH containing only the shim, temp dirs, free ports; the user's live app uses 55442/3466/3100/5180 — never touch those ports).


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

SPEED RULE: no full ci/e2e; run lint, typecheck, test:local, check:boundaries and the create-user test.

ALLOWED PATHS: scripts/local/** , deploy/local/** , services/api/src/cli/create-user.ts , services/api/test/create-user-args.test.ts.
REQUIRED (each with a test that fails on e8b9ad9)
1) [MEDIUM] Foreign listener on the API/web port must be deterministic: before spawning a service that has no live pid record of ours, refuse when something already accepts TCP connections on its port (Korean message naming the port and the `ss -ltnp` hint); re-check both children are alive (and still ours) right before printing "준비 완료". Test: a real foreign HTTP listener on the API port -> start exits non-zero, nothing spawned, no pid file; and a child that outlives the settle then exits -> no "준비 완료".
2) [MEDIUM] `--dry-run=<value>` / `--help=<value>` (any token starting with `--dry-run=` or `--help=` before `--`) are refused with a Korean message, never reach sudo (fake-shim test for up/down/logs/ps).
3) [LOW, do it] meta fingerprint: store a short sha256 fingerprint of the token next to tokenId in the meta file; when it does not match the token file, treat the previous id as unknown, rewrite the meta and print the existing warning; tests for the re-run and next-rotation paths after a meta-write failure. If writeJsonAtomic throws after its rename, treat the file as replaced.
4) [LOW, do it] README: `down -v` is refused (exit 1), not ignored; bare `--time-zone`/`--locale` without a value -> error; the interactively typed zone is validated BEFORE Vikunja registration; parity test scripts/local/time-zone.mjs vs the domain's IANA set; strip `--follow` like `-f` for logs.
Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456): pnpm run lint ; pnpm run typecheck ; pnpm run test:local ; pnpm --filter @ohmydate/api exec vitest run --globals test/create-user-args.test.ts ; pnpm run check:boundaries. Commit (Task trailer), clean git status, worker_done.
Retry limit: this is round 1 of 2. Rollback: revert the fix commit(s).
