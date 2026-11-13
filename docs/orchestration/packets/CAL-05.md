# TASK PACKET: CAL-05 — 할 일을 말로 적기: natural-language task entry in the inbox (GU-1 user feedback round 2, follow-up answer)
Role: worker (Opus 5.5 xhigh — LLM spend path + UI; MODEL_BINDINGS §8/§9). Base: torgal/ohmydate HEAD, which already contains CAL-02 (약속을 말로 적기: prompt `commitment_parse`, `POST /commitments:parse`, the drafts UI on `/commitments`). This task is the same idea for tasks; reuse what CAL-02 built instead of making a second copy.

USER REQUEST (verbatim, Korean): asked "작업(할 일)도 말로 적어 넣는 기능이 필요할까요?", the user answered "할일도 말로 적어놓는 기능이 있으면 좋겠어". Product role in their words: "자연어 입력으로 일정을 쉽게 할당하고, 맨날 일을 미루기만 하는 나한테 오늘 할일이 무엇인지 리마인드 해주는 역할".

Read first: root `AGENTS.md`; everything CAL-02 added — `packages/llm/prompts/commitment_parse/`, its schema, the service + route + tests in `services/api`, the contract in `packages/contracts`, on the web the 말로 적기 section of `apps/web/src/views/CommitmentsView.vue` with its components, client wrapper, mock handler and tests, the E2E spec; then tasks — `packages/contracts/src/task.ts` (TaskCreate: title, dueAt, priority …), `services/api/src/application/task-service.ts` + the task routes, `apps/web/src/views/InboxView.vue`, `components/QuickAddForm.vue`, `components/TaskItem.vue`, `views/TaskDetailView.vue` (how a due date/time is entered and shown today), `apps/web/DESIGN.md`.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets (never open `*api_key*.txt`, `deploy/secrets/**`), calling paid external APIs other than your own model. Tests use FakeLlm / fixtures only — never call the real LLM provider.
3. Commit your work on your branch with Conventional Commits; include "Task: CAL-05" in the body.
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

SPEED RULE: do NOT run the full `pnpm run ci` or the full `pnpm run e2e`; run the commands under "Exact tests". The coordinator runs the full suites on the batched merge.
MEMORY RULE: this laptop has 15 GB and other workers are running. Run ONE test command at a time, never two suites in parallel, and prefer the files you touched over whole-package runs until the final pass.
Never type `pnpm ci` (pnpm 12: that is a clean reinstall). Use `corepack pnpm …`.

ALLOWED PATHS: `packages/llm/**`, `packages/contracts/**` (additive; regenerate and commit `openapi.json`), `services/api/src/**` and `services/api/test/**` (no migration expected; if unavoidable use number 0017 and say so), `apps/web/src/views/InboxView.vue`, `apps/web/src/components/QuickAddForm.vue`, the 말로 적기 components CAL-02 added (to make them shared — keep the 약속 screen's behaviour and tests exactly as they are), `apps/web/src/api/**` (regenerated `schema.d.ts` + client wrapper), `apps/web/src/i18n/**`, `apps/web/src/mocks/**`, `apps/web/src/domain/**`, `apps/web/src/styles/screens/**` (the inbox/tasks file), `apps/web/test/**`, `docs/blueprint/05-AI-AGENT-SPEC.md` and `08-API-AND-EVENT-CONTRACTS.md`, `e2e/tests/**` + `e2e/helpers/**` (a new spec; never weaken an existing assertion).
A parallel task (CAL-04) builds the Google Calendar settings screen and edits `CommitmentsView.vue`, the month view, `router.ts`, nav components, `ko.ts` and `mocks/**`. Do NOT touch `CommitmentsView.vue`, `MonthView.vue`, `router.ts` or the nav components; keep `ko.ts` and mock edits as small self-contained blocks.

WHAT TO BUILD
In the inbox the user types what they have to do, in Korean free text — "금요일까지 보고서 초안", "다음 주 수요일 발표 자료 만들기, 내일까지 교수님께 메일", "장보기" — and the app reads it into task drafts (title + 마감 when one was said), shows them, and adds them when the user confirms. The existing one-line quick add (type a title, Enter, it is added at once) stays exactly as it is and stays the fastest path.

1) [HIGH] LLM contract: prompt `task_parse` (v1) + schema `llm.task_parse.v1`, registered and evaluated the way `commitment_parse` is. Same input (masked text, local "now" with weekday, zone, output language), same rule that the model returns LOCAL dates/times and the server converts. Output: up to 10 items `{ title (1..200, the user's own wording without the deadline phrase), dueDate 'YYYY-MM-DD' | null, dueTime 'HH:mm' | null, dateWasGuessed boolean }` + `leftover`. Rules to write and test with fixtures: "…까지" / "…전에" / "내일" / "이번 주 금요일" are deadlines; a text with no date is a task without a deadline (NOT leftover); several tasks in one text; an appointment-like phrase ("3시에 치과") is still returned as a task with that due time (this box makes tasks; the 약속 screen has its own box) — say so in the prompt; text that is not a to-do at all → leftover; prompt injection is data.
2) [HIGH] API: `POST /tasks:parse` (operationId `parseTasks`), same header rules, idempotent replay, agent_run + spend-ledger lifecycle, failure mapping, limits and logging rules as `POST /commitments:parse` — share the implementation (one small "parse with the LLM into drafts" use case with two prompts) rather than duplicating it. Body `{ text (1..500), timeZone? }`. 200 → `{ drafts: TaskDraft[] (0..10), leftover }`, a draft = `{ title, dueAt? (UTC instant), notes: code[] }`. Date without a time → the end of that local day, in the same convention the task detail screen uses for a date-only deadline today (find it; if there is none, 23:59 local — state which), note `due_time_defaulted`; `dateWasGuessed` → `date_assumed`. Validation after schema validation: real date, not more than 1 day in the past, not more than 2 years ahead; a failing item keeps its title and loses its deadline with note `due_dropped` (a to-do should not vanish because its date was odd). Nothing is written by the read.
3) [HIGH] Web — inbox. Follow `apps/web/DESIGN.md` (one filled button on the screen at a time).
   - Next to the quick add: a way to read free text ("말로 적기") — decide whether it is a second action on the same field or its own field under it, and keep "type a title, Enter" untouched. A hint line with one example ("금요일까지 보고서 초안, 내일 교수님께 메일").
   - Result rows: title (editable in place), 마감 in the app's date-time format or "마감 없음" (changeable with the same input the task detail uses), notes in plain Korean, 추가 / 빼기 per row and "N개 모두 추가". Added rows show as done and the inbox list refreshes; new tasks go to the inbox like quick-added ones (same create call, idempotency key per draft, owner-bound, offline rules).
   - Consent / budget / unavailable / cancel / leftover: the same behaviour and wording family as on the 약속 screen. When the AI cannot be used the text stays and the quick add still works.
   - The `n` shortcut and "새 작업" button keep focusing the quick add.
   - Mock mode: an MSW handler with a small deterministic reader, like CAL-02's.
4) Tests, each new behaviour with a negative case: llm (schema, prompt registry, fixtures); api with FakeLlm (instants in `Asia/Seoul` and one DST zone, no-date task, date-only default, invalid date keeps the task, 10-item cap, consent / budget / unavailable, idempotent replay without a second LLM call, other owner cannot replay, nothing written to tasks, log redaction; the commitments parse tests stay green after the shared refactor); web (read → rows → add one / add all / edit / remove, leftover, failure keeps the text, offline, quick add unchanged, `n` focus, a11y of the new region, owner guardrail); one E2E spec with the fake scenario: type, read, add, see the task in the inbox with its 마감.
5) Look at it in the mock dev server at 1440 and 390 px, light and dark; fix what looks wrong; describe what you saw.

Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456), one at a time:
corepack pnpm exec vitest run packages/llm packages/contracts <the services/api test files you added or touched, plus the commitments-parse, tasks and intake suites> ; corepack pnpm --filter @ohmydate/web lint ; corepack pnpm --filter @ohmydate/web test ; corepack pnpm run typecheck ; corepack pnpm run lint ; corepack pnpm run check:api-client ; corepack pnpm run check:boundaries ; corepack pnpm run e2e <your new spec and CAL-02's spec> (if the stack is not up say SKIPPED + reason — never start docker).
Commit (Task trailer), clean git status, worker_done.
Retry limit 2. Rollback: delete branch.
