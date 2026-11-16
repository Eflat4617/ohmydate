# TASK PACKET: HOLO-06 — folders proven on the real stack, and one word for each thing (다시 맞추기, 폴더)
Role: worker (Fable 5.2 xhigh; MODEL_BINDINGS §13). Base: torgal/ohmydate HEAD (HOLO-01..05 and FOLD-01 are merged and deployed). No other worker is running. Small task: keep it small.

WHY: HOLO-05 made 할 일 a canvas with folders (a folder is a project; removing one = move everything in it to the inbox, then archive; undo = un-archive first, then move back — `apps/web/src/composables/useFolderActions.ts`). Its unit tests run against mocks, but the live backend (Vikunja behind the TypeScript API) behaves differently from the mock once a project is archived: it drops the project from the list, refuses every write to a to-do inside it (reported as 503) and hides those to-dos from the unfiltered list. Nothing on the real stack proves the folder life cycle yet, and this is the one place in the new screens that moves the user's data in bulk. Second, two things have two names on screen.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths". Anything else: `orca orchestration ask` and end your turn.
2. Never: sudo, global installs, docker, git push, git rebase of shared branches, starting sub-workers, reading/writing outside your worktree, printing or storing secrets, calling paid external APIs other than your own model. No new dependencies. No API, contract or database change.
3. Tests follow the design; no skipped, deleted or weakened tests; the tests that guard data safety, owner isolation, idempotency/conflict handling and offline rules stay as they are.
4. Commit IN SLICES (A, then B, then C) with Conventional Commits, "Task: HOLO-06" in the body, green at each.
5. Run every command in "Exact tests", paste real exit codes.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
REPORT: commits; what the real stack did at each step of the folder life cycle (and any defect found and how it was fixed); the renames (what changed, what was left and why); tests with exit codes.

MEMORY RULE: 15 GB laptop. ONE test command at a time; the web test script already caps vitest at 4 workers; stop your dev server by PID after checking its working directory (never `pkill -f`). No full `pnpm run ci`, no full `pnpm run e2e`. Never type `pnpm ci`.
BUDGET NOTE: the weekly model allowance is finite. Slice A matters most; commit it before starting B.

ALLOWED PATHS: `apps/web/**`, `e2e/**`, `docs/user/**`.

WHAT TO DO
A) [HIGH] One real-stack E2E for the folder life cycle (a new spec file, or a test in `e2e-1.spec.ts` if it fits better), driven through the canvas as a person would and checked through the API (`helpers`): make a folder → file two open to-dos into it and have one finished to-do in it → rename it → reload: name, contents and count hold → 폴더 없애기 → every to-do that was in it (open AND finished) is in the inbox, none is deleted, the folder is gone from the canvas and is archived on the server → 되돌리기 on the toast: the folder is back with the same to-dos → remove it again, reload: it stays gone and the to-dos stay in the inbox, still editable (complete one). Add the negative the real stack allows: with the page offline (or the remove button's precondition unmet) nothing is moved and nothing is archived. If the real stack shows a defect in `useFolderActions` or the canvas (for example a to-do left inside an archived folder, a stale version after rename, a list that still shows an archived folder's to-dos), fix it in the web with a unit test that fails before the fix, and say what it was. Do not change the server.
B) [MEDIUM] One word for stage ⑥: the user reads 재계획 in the screen title, breadcrumb, buttons, notifications, toasts and the guides, while `FLOW.md` and 개요's card say 다시 맞추기. Use 다시 맞추기 everywhere the user reads it (noun: "다시 맞추기", the proposal: "다시 맞춘 일정안" or what reads naturally in each sentence — you are the writer; keep sentences short and calm). The catalog (`ko.ts`) is the source; the unit tests, E2E specs and `docs/user/**` that quote the old word follow. Addresses (`/replan`), component names, test ids and data attributes stay. The HOLO-05 worker counted about 28 catalog strings and about 50 test quotes in 10 files.
C) [LOW] 폴더 is the word (PRODUCT.md): the task page, note links and the focus filter still say 프로젝트. Change what the user reads; leave code names. If a place needs more than a string change, leave it and say so.

Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456), one at a time:
corepack pnpm --filter @ohmydate/web lint ; corepack pnpm --filter @ohmydate/web test ; corepack pnpm run typecheck ; corepack pnpm run lint ; corepack pnpm run check:boundaries ; corepack pnpm run e2e <your folder spec> e2e/tests/e2e-1.spec.ts e2e/tests/e2e-5r-replan.spec.ts e2e/tests/e2e-a11y-screens.spec.ts (and any other spec you touched; if the stack is not up say SKIPPED + reason — never start docker).
Clean git status, worker_done. Retry limit 2. Rollback: delete branch.
