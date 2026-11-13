# TASK PACKET: CAL-01 — "한달" month view + today's 약속/마감 on Today (GU-1 user feedback round 2)
Role: worker (Opus 5.5 xhigh — UI; MODEL_BINDINGS §8). Base: torgal/ohmydate HEAD. The user is using the app now (gu-1-live), so ship a working, good-looking screen.

USER REQUEST (verbatim, Korean): "오늘 일정은 딱 오늘만 보여주잖아, 근데 장기적으로 한달 일정도 보여줬으면 하거든? 왼쪽 카테고리에 오늘 말고도 한달 이라고 만들어서 캘린더 형식으로 이날 뭐있고 또 뭐있고 이런거 표시해줬으면 좋겠어." and, about the product as a whole: "이 프로그램은 당장 하루에 뭘 해야하는지도 중요하지만 정확히는 내가 오늘 어떤 할일이 있는가를 알려주는 프로그램이란말이지? 장기적인 일정도 확인할 수 있으면서 오늘은 뭘해야하고 … 맨날 일을 미루기만 하는 나한테 오늘 할일이 무엇인지 리마인드 해주는 역할이 강하단말이야."

Read first: `apps/web/DESIGN.md` (the visual system, re-made on 2026-11-13: "텐미닛 플래너" — white ruled paper, pen-black ink, highlighter fills for state, NO cards / shadows / pill badges, one filled button per screen), `apps/web/docs/ui-polish/README.md`, `apps/web/PRODUCT.md`, `apps/web/src/styles/tokens.css` + `primitives.css` + `shell.css` + `screens/03-today.css` + `screens/07-plan.css`, `apps/web/src/views/TodayView.vue`, `apps/web/src/components/DayTimetable.vue` + `src/domain/dayTimetable.ts`, `apps/web/src/components/WeekCalendar.vue` (how blocks / 약속 / 마감 are already told apart, the calendar tokens), `apps/web/src/views/PlanComparisonView.vue` (loads approved blocks + commitments + tasks for a range), `apps/web/src/components/NavRail.vue`, `BottomNav.vue`, `AppShell.vue` (shortcuts), `HelpDialog.vue`, `apps/web/src/domain/time.ts`, `apps/web/src/i18n/messages/ko.ts`, `apps/web/src/mocks/**`, `apps/web/scripts/ui-screenshots.mjs`, `e2e/tests/e2e-a11y-screens.spec.ts`.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets (never open `*api_key*.txt`, `deploy/secrets/**`), calling paid external APIs other than your own model.
3. Commit your work on your branch with Conventional Commits; include "Task: CAL-01" in the body.
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

ALLOWED PATHS: `apps/web/**` (NOT `apps/web/src/views/CommitmentsView.vue`, NOT `apps/web/src/api/schema.d.ts` — other workers own those), `e2e/tests/e2e-a11y-screens.spec.ts` (add the new screen; never weaken or delete an assertion), `e2e/README.md` (only if wording changes).
No API, contract or database change: everything this task needs is already served (`GET /schedule-blocks?from&to`, `GET /commitments?from&to` with `occurrences`, `GET /tasks` with `dueAt`). If you believe something is missing, `orca orchestration ask`.

REQUIRED
1) [HIGH] New screen "한달" at `/month` (route name `month`).
   - Nav: in the rail's first group directly under "오늘", label "한달", shortcut key `m` (next to `t`), listed in the help dialog. On phones put it in the bottom nav's "더보기" sheet near the top (keep the bottom bar's own items as they are unless one clearly fits better — say what you chose).
   - A month page of a paper planner: columns 월 화 수 목 금 토 일 (Monday first, as in the availability grid), one row per week that touches the month (5 or 6), days of the neighbouring months shown but quiet. The month is in the URL (`/month?m=2026-11`) so reload and back/forward keep it; default = the current month in the owner's zone (the availability time zone, as other views resolve it). Controls: previous month, next month, "이번 달". Title is the month itself ("2026년 11월").
   - Each day cell shows the date and what is on that day, in time order:
     a. approved schedule blocks (task title; start time),
     b. 약속 — every occurrence of every commitment in range (title; start time). `commitment.source` may be a value other than `manual` in the future (a Google import arrives in a later task): treat every source the same here,
     c. 마감 — tasks whose `dueAt` falls on that day and that are not done.
     Use the SAME visual vocabulary the week calendar and Today already use for these three kinds (tokens in `tokens.css`; DESIGN.md says which highlighter means what). One legend, once. A finished block reads as done (mint), today is unmistakable (the current mark), past days are quieter.
   - A cell fits a few lines; the rest collapses to "+N개" and the full list is in the day detail.
   - Day detail: selecting a day (click, Enter/Space) shows that day's full list with times, titles and where each item leads (task detail for blocks and deadlines; `/commitments` for 약속; "오늘 보기" → `/today` when the day is today). At ≥1280px it is the page's one context column beside the grid; below that it sits under the grid. Today is selected at first.
   - 390px: no horizontal page scroll. Cells cannot hold text there: show the date and compact marks for what the day holds (kind is readable from the mark, not from colour alone — the selected day's list below carries the words).
   - Keyboard and a11y: the grid is one tab stop with roving focus; arrows move by day/week, Home/End go to the week's ends, PageUp/PageDown change month, Enter/Space select. Each cell has an accessible name like "11월 14일 토요일, 블록 2개, 약속 1개, 마감 1개" (and "오늘"). axe: no serious/critical findings. Visible focus. Reduced motion respected (the system only animates state; do not add decorative motion).
   - States: loading (skeleton in the shape of the grid), load error with retry (keep last data on screen when a background re-read fails), a month with nothing planned (the grid still shows; one plain line that says so and points to "일정 만들기" / "약속"), offline (read-only is fine: the screen only reads).
   - Data: read all pages of the three lists for the visible grid range (≤ 42 days). Owner isolation rules of the web app apply (FU-77 guardrail: owner-bound continuations, the owner-scoped storage module; `pnpm --filter @ohmydate/web lint` enforces them).
   - Copy: Korean, in the typed catalog `ko.ts`, in the product's plain voice (see PRODUCT.md / existing strings). No `v-html`. Styles in `src/styles/screens/` as a new numbered file imported from `screens.css`; colours and fonts only through tokens; no card, no shadow, no pill; at most one filled button on the screen (this screen may have none).
2) [MEDIUM] Today also says what else is on today. Under the existing block list of `/today`, and only when there is something to show: today's 약속 (time range + title) and tasks due today that are not done ("오늘 마감"). Draw today's 약속 on the day timetable too, as time that is taken but not planned work (a mark that is visibly different from the highlighter runs of blocks, with a legend entry). Do not change the block list, the figures row or the layout policy; keep the existing Today tests green without editing them.
3) Mock mode (`VITE_MOCK=1`, clock pinned to 2026-11-14): make sure November 2026 has a believable month — blocks on several days, at least one repeating 약속, a few deadlines — so the screenshot sweep shows a full page. Extend the existing mock seed rather than adding a second data path.
4) Tests (vitest + @vue/test-utils, as in `apps/web/test`), each with at least one negative case:
   - pure month-grid function: weeks of a month (Monday first, 5- and 6-row months, zone edges such as a block at 23:30–00:30 and a commitment occurrence near midnight in `Asia/Seoul` and in a zone with DST), placement of blocks / occurrences / deadlines, sort order, overflow count;
   - the view: renders items on the right days, month navigation updates the URL and the range that is queried, day selection + detail, keyboard movement, loading / error+retry / empty month, accessible names;
   - Today: 약속 and 오늘 마감 sections appear only when there is data; timetable draws the 약속 mark;
   - i18n catalog tests stay green.
   Add `/month` to `e2e/tests/e2e-a11y-screens.spec.ts` and to `apps/web/scripts/ui-screenshots.mjs` (light + dark, the widths it already sweeps).
5) Look at it. Run the mock dev server and check `/month` and `/today` at 1440, 1280, 1024 and 390 px in light and dark. Fix what looks wrong before you report: clipped text, misaligned rules, a cramped or sparse page, anything that reads as a generic dashboard rather than a page of this planner. In the report, describe what you saw (no screenshots committed).

Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456):
corepack pnpm --filter @ohmydate/web lint ; corepack pnpm --filter @ohmydate/web test ; corepack pnpm run typecheck ; corepack pnpm run lint ; corepack pnpm run check:boundaries ; corepack pnpm run e2e e2e/tests/e2e-a11y-screens.spec.ts (if the e2e runner needs the stack and it is not up, say SKIPPED + reason — never start docker).
Commit (Task trailer), clean git status, worker_done.
Retry limit 2. Rollback: delete branch.
