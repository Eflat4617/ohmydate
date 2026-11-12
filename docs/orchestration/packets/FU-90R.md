# REVIEW PACKET: FU-90RR — Independent review of FU-90R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-90-local-stack-followups. Base: torgal/ohmydate. Head: e8b9ad9.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-90R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...e8b9ad9; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
Finish with exactly one worker_done (orca orchestration send --type worker_done ... --outcome succeeded) whose body is the review in this format:
REVIEW VERDICT: APPROVE | REQUEST_CHANGES | BLOCKED
Findings (most severe first):
  [CRITICAL|HIGH|MEDIUM|LOW] <title>
    Evidence: <file>:<line> + reproduction or test output
    Required change | Suggestion
Contract / license / security / migration impact: <text or "none">
Missing tests: <list>
Verification actually executed: yes|no — exact commands + exit codes
git status --porcelain after review: <must be empty>
Residual risks: <list>
--- WORKER CLAIMS ---
REVIEW of FU-90 (GU-1-PKGR2 follow-ups: local:stack argument parsing + LOWs; implementer DeepSeek 4.1 Flash high). Reviewer: Fable 5.2 xhigh in place of Sol (weekly limit; MODEL_BINDINGS §12). You are the REVIEWER: read-only — do not edit/create/commit repository files (scratch only outside the worktree); finish with the REVIEW VERDICT format. NEVER read deploy/secrets/** or *api_key*; no docker, no real sudo (use a fake sudo shim on a PATH that contains only the shim); no LLM gateway. Branch torgal/fu-90-local-stack-followups commit e8b9ad9. Merge candidate torgal/ohmydate...e8b9ad9. Read docs/orchestration/reviews/GU-1-PKGR2.md (your previous findings) and docs/orchestration/packets/FU-90.md (git show torgal/ohmydate:...).
SPEED RULE: no full ci/e2e (the coordinator runs them on the batched merge). Run `pnpm run typecheck`, `pnpm run lint`, `pnpm run check:boundaries` and the Focus commands. Keep it focused; this is a small follow-up.
NOTE: the user is already running the package from a separate checkout (gu-1-live, compose project ohmydate-local) — do not touch that stack or its ports 55442/3466/3100/5180; use free ports and temp dirs.
Worker report (treat as unverified claims):
taskId: task_874c67a41605
dispatchId: ctx_c617dd9c7f7b
worktree: /home/torgal/orca/workspaces/oh_my_date/fu-90-local-stack-followups
branch: torgal/fu-90-local-stack-followups
commit: e8b9ad9 (base 243a51f)

CHANGED (16 files, all inside ALLOWED PATHS):
deploy/local/local.env
scripts/local/{compose,setup,start,status,prompt}.mjs + time-zone.mjs
scripts/local/{args,compose,setup-cli,setup-rotation,smoke,start,status}.test.mjs
services/api/src/cli/create-user.ts
services/api/test/create-user-args.test.ts

DIFF SUMMARY:
- compose.mjs: --dry-run/--help are booleans (never consume a value); argv splits at the first -- and forwards the tail verbatim; down allow-lists --remove-orphans and -t/--timeout N and refuses every -v/--volumes spelling with a Korean message.
- status.mjs: the DB-locked-out warning only fires when postgres.env/legacy stack.env is gone while stack state exists; a wide-mode LLM key now counts as a failure naming the exact chmod 600 command.
- start.mjs: web build is pinned to VITE_MOCK=0, prints the effective LLM host/model next to NODE_ENV/LLM_PROVIDER, logs the target before preflight, and waits 1s after healthz 200 to re-check our child (foreign listener cannot yield 준비 완료).
- setup.mjs: validates --time-zone/--locale/env with the exact domain IANA set before secrets/Vikunja; warns when a previous token id is unknown and revokes a new token only when the token file write did not replace it; dropped the irrelevant post-success stack hint.
- create-user.ts: realpath entry-point guard so an import never runs main(); tests build a fake sudo shim PATH and a live HTTP listener.

CHECKLIST:
1 done: dry-run/pass-through tests incl up/down/logs/ps args before/after --dry-run, logs -- vikunja, up -- --build; fake sudo shim records nothing.
2 done: down allow-list + Korean refusal tests for -v, -vt, -v=true, --volumes, --volumes=true.
3 done: status helper + tests for missing token (quiet) vs missing postgres.env (warn).
4 done: VITE_MOCK=0 build, LLM host/model reporting, post-healthz settle; tests for each.
5 done: unknown previous-token warning + revoke only when the token file was not replaced; tests cover success, meta failure after replace, token-write failure, meta-only failure.
6 done: exact IANA set (Intl.supportedValuesOf + UTC/Etc/UTC) and locale validation before initSecrets; CLI tests prove no secrets dir side effect.
7 done: entry-point guard; import test asserts main() did not run.
8 done: smoke asserts real smoke + DB passwords absent; local.env names postgres.env/vikunja.env; wide key is a failure; start target precedes preflight; setup hint removed.

TESTS (env DATABASE_URL=...planner_test VIKUNJA_URL=...):
- corepack pnpm run lint -> exit 0
- corepack pnpm run typecheck -> exit 0
- corepack pnpm run test:local -> exit 0; 13 files passed, 69 passed, 1 skipped (by-design smoke placeholder)
- corepack pnpm --filter @ohmydate/api exec vitest run --globals test/create-user-args.test.ts -> exit 0; 1 file, 5 passed
- corepack pnpm run check:boundaries -> exit 0; 562 files, 0 violations
- SKIPPED full `pnpm run ci` and full `pnpm run e2e` per the coordinator speed-up message.

RISKS/UNVERIFIED:
- No docker/sudo run; compose changes are proven via dry-run plus a PATH containing only a fake sudo shim that recorded no invocation.
- The 1s settle is a heuristic; a foreign listener plus a child that survives >1s before EADDRINUSE could still slip through.
- Domain IANA set is mirrored in scripts/local/time-zone.mjs (scripts cannot import TS); a domain change must update it.
- No API contract/OpenAPI, dependency, migration or secret-file change. No secret was read or printed.

ROLLBACK: delete branch torgal/fu-90-local-stack-followups or revert e8b9ad9.
Focus (narrow): (1) re-run your GU-1-PKGR2 reproductions with the fake sudo shim: `<action> --dry-run <arg>` for up/down/logs/ps never invokes sudo; `--` pass-through forwards verbatim; every -v/--volumes spelling on down is refused; (2) each LOW really fixed (status warning only when postgres.env is gone; VITE_MOCK=0 at build even with ambient VITE_MOCK=1; effective LLM host/model printed; foreign listener not reported ready; rotation warning/revoke-only-if-not-replaced; time zone/locale validated before ANY side effect; create-user import never runs main()); (3) no new secret exposure on any new path, no weakened test. Run with env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456: pnpm run test:local ; pnpm --filter @ohmydate/api exec vitest run --globals test/create-user-args.test.ts.
Round 1 of 2. HIGH for any path that runs real docker in dry-run, removes volumes, exposes a secret, or writes to the wrong target.

