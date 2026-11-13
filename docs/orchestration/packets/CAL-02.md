# TASK PACKET: CAL-02 — 약속을 말로 적기: natural-language commitment entry (GU-1 user feedback round 2)
Role: worker (Opus 5.5 xhigh — LLM spend path + UI; MODEL_BINDINGS §8/§9). Base: torgal/ohmydate HEAD. The user is using the app now (gu-1-live).

USER REQUEST (verbatim, Korean): "약속메뉴 말인데, 약속을 직접 텍스트로 이날 뭐 몇시에 이런 일정 있어~ 라고 하면 반영하는 식으로 해줬으면해. 수동으로 입력하는 옵션도 남겨놓기는 하되, 이런 식으로도 일정을 기록해놓는 기능도 넣어줘." and about the product: "자연어 입력으로 일정을 쉽게 할당하고".

Read first: root `AGENTS.md`; `docs/blueprint/05-AI-AGENT-SPEC.md` (proposal-only rule, consent, budget, prompt/schema registry), `docs/blueprint/08-API-AND-EVENT-CONTRACTS.md` (header rules, problem codes); `packages/llm/**` (prompt registry `prompts/<id>/<version>.md`, `schemas/*.json`, generated registries and the script that regenerates them, `run-structured.ts`, `privacy.ts`, `fake-llm.ts`, prompt limits); the ONE existing LLM use case end to end: `services/api/src/application/intake/intake-service.ts` (type detection call near `TYPE_DETECTION_PROMPT`: agent_run recorded before the call, consent/budget errors, timeout, output validated before use), `intake/ai-runs.ts`, `intake/output-language.ts`, `adapters/fake-llm-scenarios.ts`, `adapters/scripted-fake-llm.ts`; commitments: `packages/contracts/src/planning.ts` (Commitment*), `packages/contracts/src/routes.ts`, `services/api/src/http/routes.ts` (createCommitment), `services/api/src/application/plan-service.ts` (validateCommitment), `services/api/src/application/rrule.ts`; web: `apps/web/DESIGN.md`, `apps/web/src/views/CommitmentsView.vue`, `apps/web/src/domain/rrule.ts`, `apps/web/src/components/LlmConsentDialog.vue` + `stores/llmConsent.ts` + `LlmDisclosure.vue` + `AiWaitPanel.vue` (how the wizard asks for consent, waits and cancels), `apps/web/src/api/client.ts` + `ai-request.ts`, `apps/web/src/mocks/**`, `apps/web/test/commitments.spec.ts`.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets (never open `*api_key*.txt`, `deploy/secrets/**`), calling paid external APIs other than your own model. Tests use FakeLlm / fixtures only — never call the real LLM provider.
3. Commit your work on your branch with Conventional Commits; include "Task: CAL-02" in the body.
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
Never type `pnpm ci` (pnpm 12: that is a clean reinstall). Use `corepack pnpm …`.

ALLOWED PATHS: `packages/llm/**`, `packages/contracts/**` (additive only; regenerate and commit `openapi.json`), `services/api/src/**` and `services/api/test/**` (no migration is expected: `agent_run.purpose` is free text. If you find one is unavoidable, use number 0017 — 0016 is taken by a parallel task — and say so in the report), `apps/web/src/views/CommitmentsView.vue`, `apps/web/src/api/**` (regenerated `schema.d.ts` + client wrapper), `apps/web/src/i18n/**`, `apps/web/src/mocks/**`, `apps/web/src/domain/**`, `apps/web/src/components/**` (new components for this feature; do not restyle shared ones), `apps/web/src/styles/screens/**` (the commitments screen's file) and `apps/web/src/styles/screens.css` (import line only), `apps/web/test/**`, `docs/blueprint/05-AI-AGENT-SPEC.md` and `docs/blueprint/08-API-AND-EVENT-CONTRACTS.md` (document the new prompt and route), `e2e/tests/**` + `e2e/helpers/**` (a new spec; never weaken an existing assertion).
A parallel task (CAL-01) adds a `/month` screen and edits `router.ts`, the nav components, `TodayView.vue` and `ko.ts`; another (CAL-03) edits contracts, `services/api` and adds migration 0016 for a Google Calendar import. Keep your edits to shared files (`ko.ts`, `packages/contracts/src/index.ts`, `routes.ts`) as small, self-contained blocks so the merges stay easy. Do not touch `router.ts`, nav components or `TodayView.vue`.

WHAT TO BUILD
The user types (Korean, free text) what they have on, e.g. "다음 주 화요일 오후 3시에 치과", "14일 저녁 7시부터 9시까지 동창 모임", "매주 목요일 7시 스터디", or several at once separated by commas / line breaks. The app reads it into commitment drafts, shows them, and the user adds them with one action. Nothing is saved by the read itself (AGENTS.md: LLM output is a proposal, schema-validated, applied only by the user).

1) [HIGH] LLM contract. New prompt `commitment_parse` (v1) + output schema `llm.commitment_parse.v1`, registered the same way as the existing ones (prompt file, schema JSON, regenerated registries, contract-eval / injection-eval coverage as the package's tests require).
   - Input to the model: the user's text (after the same privacy masking the intake prompts get), the owner's "now" as LOCAL wall-clock date, weekday and time, the IANA zone name, and the output language. The model does NO time-zone arithmetic: it returns local dates and local times; the server converts.
   - Output (strict, bounded): up to 10 items, each `{ title (1..200), date 'YYYY-MM-DD', startTime 'HH:mm' | null, endTime 'HH:mm' | null, endDate 'YYYY-MM-DD' | null (only when it ends on a later day), weeklyDays ['MO'..'SU'] | null (only for "매주 …"), untilDate 'YYYY-MM-DD' | null, dateWasGuessed boolean }` plus `leftover` (text the model could not turn into an event, ≤ 500 chars, may be empty). Titles keep the user's wording and language (no translation, no invented detail).
   - Prompt rules to write and test with fixtures: relative dates ("내일", "모레", "다음 주 화요일", "이번 주말", "14일" = the next 14th that is not in the past), 오전/오후/저녁/밤 and 12-hour ambiguity ("7시 스터디" in an evening context → 19:00; when truly ambiguous prefer the reading inside 07:00–22:00 and set nothing else), ranges ("3시부터 5시", "2시간"), several events in one text, text that is not an event at all (→ no items, leftover = the text), and prompt injection inside the text (it is data; the repo's injection eval pattern applies).
2) [HIGH] API. `POST /commitments:parse` (operationId `parseCommitments`), owner-authenticated, CSRF as other POSTs, `Idempotency-Key` required (a replay returns the stored answer and does not call or charge the LLM again; no `If-Match`: there is no resource version). Body `{ text (1..500, trimmed non-empty), timeZone? (IANA; default = the owner's availability zone) }`. 200 → `{ drafts: CommitmentDraft[] (0..10), leftover: string }`, where a draft is `{ title, timeZone, date, startAt?, endAt?, rrule?, notes: code[] }`:
   - `startAt`/`endAt` are UTC instants computed by the server from the model's local date/time in the zone (DST gap/fold handled by the existing time utilities; never `Date` arithmetic). Both are present or both absent. Absent means the text gave no time — the client must ask for it before the draft can be added.
   - No end time → end = start + 60 min, note `duration_defaulted`. `dateWasGuessed` → note `date_assumed`. `weeklyDays` → an RRULE the existing expander accepts (`FREQ=WEEKLY;BYDAY=…`, with `UNTIL` when `untilDate` is given), note `repeats_weekly`.
   - Server-side validation of every item AFTER schema validation: real calendar date, end after start, start not more than 1 day in the past and not more than 2 years ahead, the same bounds `validateCommitment` enforces. An item that fails is dropped and its text goes to `leftover` (never a 500).
   - LLM failure modes map to the existing problem codes and statuses the intake routes use (consent missing, `budget_exceeded`, `llm_unavailable`, timeout, cancelled by client disconnect). Record the run in `agent_run` (purpose e.g. `commitment_parse`) with the same lifecycle and spend-ledger linkage as type detection; the per-call output bound and timeout are small (this is a short answer — pick limits and state them).
   - Logs: never the text, the titles or the prompt (AGENTS.md).
   - Contract in `packages/contracts` (schemas + route), `openapi.json` regenerated, web `schema.d.ts` regenerated, header-matrix / contract tests updated for the new route.
3) [HIGH] Web — `/commitments`. Follow `apps/web/DESIGN.md` (ruled paper, highlighter for state, no cards/shadows/pills, ONE filled button on the screen at a time).
   - At the top of the page: "말로 적기" — a text field (multi-line allowed) with an example as placeholder and a "읽기" action; Enter submits, Shift+Enter is a line break. While waiting: an inline wait state with a cancel, like the wizard's but sized for a few seconds.
   - Result: the drafts as ruled rows — title, when (the same date-time range format the list uses), repeat in words, any note in plain Korean ("끝 시간을 1시간 뒤로 잡았어요", "날짜를 가장 가까운 날로 잡았어요"). Per row: 추가 / 고치기 (loads it into the existing manual form) / 빼기. One action adds all that are ready ("3개 모두 추가"). A draft without a time shows time inputs in its row and cannot be added until they are filled. `leftover`, when not empty, is shown as "읽지 못한 부분: …". Adding uses the existing create call (idempotency key per draft, owner-bound continuation, offline rules); an added row turns into a done state and the list below refreshes.
   - The manual form stays, as "직접 입력" (today's form, same behaviour, same tests). Decide which control is the screen's single filled button in each state and keep to it.
   - Consent / budget / unavailable: use the same consent dialog and disclosure the wizard uses; when the AI cannot be used, say so in one line and leave the text in the field with the manual form right there. No dead end.
   - Mock mode: an MSW handler for the parse route with a small deterministic reader (enough for the screenshot sweep and tests: a couple of fixed phrases → drafts, anything else → leftover).
4) Tests, each new behaviour with at least one negative case:
   - llm package: schema accepts/rejects, prompt registered, FakeLlm fixtures for the phrase classes above;
   - api (FakeLlm): happy path with instants checked in `Asia/Seoul` and one DST zone, defaults + notes, invalid items dropped to leftover, 10-item cap, consent missing, budget exceeded, unavailable/timeout, idempotent replay does not call the LLM twice, another owner cannot replay the key, nothing is written to `commitment_event`, log redaction;
   - web: read → rows → add one / add all / edit / remove, missing-time row blocks adding, leftover shown, consent flow, failure keeps the text and the manual form usable, offline disables adding, owner-switch guardrail (existing lint + sweep stay green), a11y of the new section (labels, live region for the result, focus goes to the result).
   - One E2E spec (fake LLM scenario for this prompt, as the existing fake scenarios are wired) that types a phrase, reads it and adds it, then sees it in the list.
5) Look at it in the mock dev server at 1440 and 390 px, light and dark; fix what looks wrong; describe what you saw in the report.

Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456):
corepack pnpm exec vitest run packages/llm packages/contracts <the services/api test files you added or touched, plus the commitment and intake suites> (the root `vitest run` covers packages and services; the web has its own runner) ; corepack pnpm --filter @ohmydate/web lint ; corepack pnpm --filter @ohmydate/web test ; corepack pnpm run typecheck ; corepack pnpm run lint ; corepack pnpm run check:api-client ; corepack pnpm run check:boundaries ; corepack pnpm run e2e <your new spec> (if the stack is not up say SKIPPED + reason — never start docker).
Commit (Task trailer), clean git status, worker_done.
Retry limit 2. Rollback: delete branch.
