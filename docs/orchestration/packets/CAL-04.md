# TASK PACKET: CAL-04 — Google Calendar sync, web side: 캘린더 연동 화면 + imported items on 약속 / 한달 (GU-1 user feedback round 2)
Role: worker (Opus 5.5 xhigh — UI; MODEL_BINDINGS §8). Base: the branch named in your Orca preamble / worktree (it already contains CAL-01 month view, CAL-02 "말로 적기" and the CAL-03 server contract for Google Calendar).

USER REQUEST (verbatim, Korean): "일정은 안드로이드 폰이랑 연동되게 구글일정공유? 그런거로 연동해줬으면 하고, 연동 시 구체적인 시간 구간이 정해져있는 일정이면 약속 메뉴에 그대로 일정 있다고 비워놓는 식으로." The user is not a Google Cloud expert ("구글일정공유? 그런거로"): the screen must explain itself in plain Korean.

Read first: `apps/web/DESIGN.md` (ruled paper, highlighter for state, no cards / shadows / pills, one filled button per screen), `apps/web/PRODUCT.md`; the server contract — `packages/contracts/src/**` (the Google integration schemas and routes, `calendar-day-events`, the `google` commitment source and the read-only rule), `apps/web/src/api/schema.d.ts`, `docs/blueprint/13-ADR.md` ADR-024 and the 08 section for these routes, `docs/user/` Google setup guide (if present on your base); web — `apps/web/src/views/LlmSettingsView.vue` + `LayoutSettingsView.vue` (settings screens in the current system), `AvailabilityView.vue` (If-Match / 412 / owner-bound save flow), `CommitmentsView.vue` (after CAL-02), the month view from CAL-01 (`views/MonthView.vue` or as named, its domain function and tests), `TodayView.vue`, `NavRail.vue`, `BottomNav.vue`, `router.ts`, `api/client.ts`, `mocks/**`, `i18n/messages/ko.ts`, `scripts/ui-screenshots.mjs`, `e2e/tests/e2e-a11y-screens.spec.ts`.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets (never open `*api_key*.txt`, `deploy/secrets/**`), calling paid external APIs other than your own model. Never call Google: the web tests and the mock mode fake the integration routes.
3. Commit your work on your branch with Conventional Commits; include "Task: CAL-04" in the body.
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

ALLOWED PATHS: `apps/web/**` (do not hand-edit `apps/web/src/api/schema.d.ts`; if it is stale against the contracts, regenerate it with the repo script and say so), `e2e/tests/e2e-a11y-screens.spec.ts` (add the new screen; never weaken an assertion), `docs/user/**` (only to make the in-app wording and the guide agree). The server is done: if a route or field you need is missing or behaves differently from the contract, `orca orchestration ask` — do not change `packages/**` or `services/**`.

REQUIRED
1) [HIGH] New screen "캘린더 연동" at `/settings/calendar` (route name `calendar-settings`), in the rail's 설정 group (and wherever the phone nav lists settings). It is driven by `GET /integrations/google` and has one state per `status`:
   - `not_configured`: say in two or three plain sentences what connecting does (the phone's Google Calendar shows OhMyDate's blocks and reminds before each one; Google events with a time come in as 약속 and that time is kept free) and what is needed first: a one-time setup on the laptop, with the numbered steps in short form and the exact file path and restart commands from the user guide. No button that cannot work.
   - `disconnected`: what will be read from Google (the calendars the user picks: titles and times of events, nothing else stored) and what will be sent (titles and times of blocks and of 약속 entered here, into a separate calendar named "OhMyDate"; the user's own calendars are never changed), then "구글 계정 연결" → `POST …:connect` → the browser goes to `authorizationUrl` (top-level navigation; owner-bound, offline-aware).
   - `connected`: last sync time and result in words; "지금 동기화" (`POST …:sync`, shows the counts it returns in one sentence); 가져올 캘린더 — a checklist of `calendars` (name, "기본" for primary, read-only ones marked), saved with the settings; 폰으로 보내기 — switches for 블록 보내기, 직접 넣은 약속 보내기, 아침에 "오늘 할 일" 알림, and the reminder lead (없음 / 정각 / 5 / 10 / 15 / 30 / 60분 전); a note when `importAvailable` or `exportAvailable` is false (the permission was not granted on Google's screen: say which and offer to reconnect); "연결 끊기" with a confirm dialog that says what happens (imported 약속 are removed from here; the "OhMyDate" calendar on Google is removed too unless the user unticks it). Saving follows the existing If-Match / Idempotency-Key / 412 conflict / owner-bound pattern.
   - `needs_reauth`: one clear line that Google sign-in expired and syncing has stopped, with "다시 연결". Nothing else is lost.
   - Returning from Google: `/settings/calendar?google=connected | denied | error` shows the matching message once and cleans the query from the URL.
   - `lastError` codes are shown as plain sentences (catalog entries per code, a fallback for unknown ones).
   - One filled button per state (connect / save / reconnect). Loading, load error with retry, offline (read-only), and the phone width all work.
2) [HIGH] 약속 screen: rows whose `source` is `google` say so in words ("구글 캘린더") and have no 수정 / 삭제 (they are edited in Google); a short line above the list says where they come from and links to 캘린더 연동. When the integration is `needs_reauth`, one line on this screen says imported 약속 may be out of date. Manual rows and "말로 적기" behave exactly as before.
3) [MEDIUM] 한달 screen: all-day events from `GET /calendar-day-events` for the visible range are shown at the top of their day cells as plain day labels (they do not look like blocks or 약속, and never count as taken time), included in the day detail and in the cell's accessible name; a multi-day event appears on each of its days. 약속 that came from Google are told apart in the day detail in words. If the day-events request fails the month still renders (the labels are simply absent, with one quiet line).
4) [LOW] Today: imported 약속 need no special treatment beyond what CAL-01 built; verify that a `google` 약속 for today shows there, and fix it only if it does not.
5) Mock mode (`VITE_MOCK=1`, clock pinned 2026-11-14): MSW handlers for every integration route with a small in-memory state machine (not_configured → disconnected → connected → needs_reauth selectable for the sweep, e.g. by a query flag or localStorage switch the screenshot script sets through the owner-scoped storage module), a few imported 약속 and day events in November 2026 (a public holiday label, a timed dentist visit), so the sweep shows each state.
6) Tests (vitest + @vue/test-utils), each with a negative case: each status renders the right content and the right single primary action; connect navigates to the URL the server returned and only that; settings save sends exactly the chosen calendars and options with If-Match and handles 412; sync shows counts and errors; disconnect confirm with and without `removeExported`; the `?google=` messages; google rows are read-only on 약속; month day labels (multi-day, failure of the request); catalog/i18n tests; owner-switch guardrail stays green. Add `/settings/calendar` to `e2e/tests/e2e-a11y-screens.spec.ts` and each state to `apps/web/scripts/ui-screenshots.mjs`.
7) Look at it in the mock dev server at 1440, 1024 and 390 px, light and dark, every state; fix what looks wrong (this is a settings page in a paper planner, not a SaaS integrations card grid); describe what you saw in the report.

Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456):
corepack pnpm --filter @ohmydate/web lint ; corepack pnpm --filter @ohmydate/web test ; corepack pnpm run typecheck ; corepack pnpm run lint ; corepack pnpm run check:api-client ; corepack pnpm run check:boundaries ; corepack pnpm run e2e e2e/tests/e2e-a11y-screens.spec.ts (if the stack is not up say SKIPPED + reason — never start docker).
Commit (Task trailer), clean git status, worker_done.
Retry limit 2. Rollback: delete branch.
