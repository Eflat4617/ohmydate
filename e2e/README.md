# E2E-1 (Playwright)

Vertical slice: web -> planner API -> Vikunja. This suite needs the dev
infrastructure from `AGENTS.md` (PostgreSQL on `127.0.0.1:55432`, Vikunja on
`127.0.0.1:3456`) and is intentionally **not** part of `pnpm run ci`.

## Run

```sh
pnpm exec playwright install chromium
DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test \
VIKUNJA_URL=http://127.0.0.1:3456 \
pnpm run e2e
```

`e2e/global-setup.ts` creates a throwaway PostgreSQL schema, runs the
migrations into it, registers a synthetic Vikunja user, mints a scoped API
token, creates the planner user with the `create-user` CLI, wires the owner
account and inbox mapping, then starts the API (`PROVIDER=vikunja`) and the
Vite dev server on random loopback ports. `e2e/global-teardown.ts` stops both
processes and drops the schema.

Artifacts:

- HTML report: `playwright-report/index.html`
- Traces/screenshots: `test-results/`
- Server logs and run state: `test-results/e2e/`

The suite covers the E2E-1 flow (create -> Vikunja check -> edit -> second
context edit -> 412 conflict dialog -> overwrite -> complete -> Vikunja check),
offline mutation gating, a keyboard-only sign-in and capture (Tab/Enter to sign
in, `n` to the capture bar, Enter to add, Enter again for the hand-off to 계획),
and `@axe-core/playwright` scans of login, 개요 and the inbox (zero
critical/serious).

## Where the specs walk since HOLO-04

The product is one flow (`apps/web/FLOW.md`); the specs follow it.

- **Signing in lands on 개요** (`/overview`), which holds 오늘. `helpers/app.ts`
  `login()` waits for it.
- **The start guide.** An owner without hours is met by the start guide the
  first time a device sees them, and every test starts on a fresh device.
  `login()` calls `settleStartGuide()`: it waits until the shell has decided
  (`.app-shell[data-first-run-state]` is no longer `pending`) and, if the guide
  opened, puts it away with 닫기 — 개요 then keeps the rest as its 시작 마무리
  card. A test that signs in by hand does the same (E2E-1 closes it with
  Escape, as a keyboard user would).
- **Places.** `openPlace(page, '할 일')` clicks the sidebar link (named by the
  place alone); `openInbox()` is 할 일, which opens on its canvas (HOLO-05).
  `/tasks` is the canvas, `/tasks?view=list` the same to-dos as rows (with the
  quick add and 말로 적기); `/projects` lands on the canvas, where a project is
  a folder. On the canvas `putDownTodo()` adds with the capture bar,
  `canvasTodo()` finds a to-do by its title and `openTodoDetail()` opens its
  floating detail. A context that points at the canvas uses `STILL_CANVAS`
  (reduced motion): floating to-dos sway, and a pointer action waits for its
  target to hold still. The 약속 list is `/planner?view=list`, the timer
  and its record `/focus`, the settings `/settings/<section>`. The old
  addresses redirect; the a11y spec checks three of them on purpose.
- **Signing out** is in the account menu: `signOut(page)`.
- **약속 in words** (E2E-7) runs in the planner's 약속 추가 dialog, and removes
  what it added through the row's own dialog (삭제, then its in-place confirm).
- **The capture bar** has its own real-API test in E2E-8: one line read by the
  (slow, fake) AI as a to-do, nothing saved before 담기, then the hand-off to
  `/plan/schedule?taskIds=<id>`.
- **After a review** the estimate feedback is on the next-step card
  (`[data-focus-next-feedback]`), once.

## E2E-3 and wall-clock time (FU-55)

Plan blocks are generated from the API's "now", so E2E-3 never assumes where
they land. After generation it reads the plan, availability, commitments,
approved schedule blocks and task due dates through the public API, and
`helpers/plan-edit.ts` picks every keyboard edit from that real schedule:

- **feasible**: one Alt+ArrowUp/Alt+ArrowDown press on a block that has 5
  free minutes on that side (same window, no overlap, not in the past, not past
  the due time), trying the next candidate when one is fully packed;
- **H2 negative**: the fewest presses that push a block over its window edge;
- **H1 negative**: the fewest presses that slide a block into its same-day
  neighbour.

Since HOLO-03A the schedule being chosen is drawn on the planner's week grid
(`WeekGrid`): a plain arrow walks between items, Alt+arrow moves a block of the
picked schedule by five minutes. The grid is paged to the edited block's week
(`section.plan-week[data-week-start]`), the block is found by its accessible
name (`일정안 블록, <task>, <date> <start>~…`), and each edit waits for the
`:preview-edit` response of exactly that edited state (plus the "고친 내용을
확인하는 중…" live-region update) instead of sleeping. A finding is asserted by
its code as data (`li[data-code="H2"]`): the page says it in words.
`tests/plan-edit-helpers.spec.ts` covers the pickers without a browser.

### Simulated start time (opt-in)

```sh
E2E_FAKE_NOW=2026-11-14T12:00:00Z \
DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test \
VIKUNJA_URL=http://127.0.0.1:3456 \
pnpm exec playwright test -c e2e/playwright.config.ts e2e-3
```

`E2E_FAKE_NOW` must be an ISO-8601 instant with a zone. `global-setup.ts`
then starts the API with `helpers/shifted-clock.mjs` preloaded
(`NODE_OPTIONS=--import=…`): `Date.now()` / `new Date()` report real time plus
a fixed offset, so time keeps flowing from the simulated start. The offset is
stored as `clockOffsetMs` in the run state; E2E-3 uses it for its own "now"
and installs the same start time in its browser context (`helpers/clock.ts`).
Without the variable nothing is shifted. Only E2E-3 opts in to the API shift;
E2E-1/E2E-2 run on real time. PostgreSQL `now()` and Vikunja keep real time,
which is fine for E2E-3's flow but is why this stays opt-in.

## Time-of-day independence (FU-79)

The Today specs (E2E-4, E2E-6, E2E-6 notes and the a11y sweep) no longer derive
their plan from the wall clock. `helpers/day-clock.ts` picks the next local
`09:00` that is at least three hours after the API's now, and the spec installs
that instant in the browser context (`installBrowserClockAt`). Plan blocks
start on that simulated day; E2E-4's notification carrier starts a few minutes
after the API's now so the leader sweep still fires. The result is three cards
at 21:50, 23:59, 00:01 and on a DST-change day, not just in the morning:

```sh
E2E_FAKE_NOW=2026-11-12T23:59:00Z \
DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test \
VIKUNJA_URL=http://127.0.0.1:3456 \
pnpm exec playwright test -c e2e/playwright.config.ts e2e-4-today
```

E2E-4 uses `America/New_York` as the E2E user's time zone, so the DST runs are
real local transitions. `tests/plan-edit-helpers.spec.ts` also checks the day
helper across UTC midnight, the New York spring-forward and the fall-back.

**Client/server skew (known and intentional).** The browser context runs on the
simulated local morning while the API stays on its own clock (real time, or the
`E2E_FAKE_NOW` offset). The browser can therefore be about 3 h to just under 28 h ahead of the API (nearly 28 h across a fall-back day).
`SessionService` clamps `clientStartedAt` and every pause/resume/complete
client timestamp to `apiNow + FORWARD_CLOCK_TOLERANCE_MS` (2 minutes), so a future-dated
session start is recorded as API now + 2 minutes and elapsed-time values are clamped rather than
trusted. E2E-4's focus assertions only depend on the clamped-safe properties
(state, version, no negative durations), which is why they remain valid on this
path. Shifting the API to the same morning is optional and not required for the
day-boundary checks: `E2E_FAKE_NOW` shifts the API by a run-wide offset, and
the spec still chooses the next local morning, so the skew remains by design.
When an unskewed session path needs coverage, set `E2E_FAKE_NOW` near the
simulated morning in a dedicated spec instead.

### Login rate limit isolation (FU-79)

`POST /auth/login` is limited per `IP:email` for 60 s. `global-setup.ts` starts
the E2E API with the fake-only `E2E_RESET_LOGIN_RATE_LIMIT=1` knob (rejected
when `NODE_ENV=production` or the provider is not `fake`), and
`helpers/test.ts` automatically calls its reset route before every test. Each
Playwright test therefore starts with a clean window and cannot inherit a 429
from an earlier spec; the production limiter is unchanged.

## E2E-5 automatic cross-tab reset (FU-56)

`tests/e2e-5-owner-reset.spec.ts` keeps the explicit reload/bootstrap check and
adds an automatic one: tab 1 is signed in as owner A with A-only settings, a
task and a cached Focus session; tab 2 signs in as B in the same browser
context. Tab 1 resets itself from the `storage` event (the app triggers the
hard reload; the test never calls `page.reload`) and shows B. The spec then
checks real session state from tab 1: `GET /me` returns B, the `sid` cookie
was replaced, the active-owner pointer is B, B's Focus namespace is empty, A's
namespace is preserved but not rendered, and A's task title is absent from the
DOM and from B's task list. Since HOLO-04 the reset brings tab 1 back on 개요;
the spec then opens 할 일 in tab 1 and checks the title only after the
`GET /tasks` tab 1 sends as B has answered and B's list has rendered. Signing out in tab 2 makes
tab 1 return to the login screen and `GET /me` answer 401, still without a
test-driven reload. The response waiters time out after 20 s, so a broken
reset fails at the wait that never matched rather than at the test timeout.

**Lock fallback scope.** When the Web Locks API is unavailable, Focus replay
falls back to an in-tab mutex plus a `BroadcastChannel` notice
(`apps/web/src/session/ownerLock.ts`). The channel tells other tabs that a lock
was taken or released; it does not exclude them. It is an in-tab fallback, not
distributed exclusion, and the ADR-023 hard reset plus per-owner namespaces —
not the channel — are what keep owners apart.

## E2E-5R replan (M5-03)

`tests/e2e-5r-replan.spec.ts` uses its own planner/Vikunja owner (`replan`
fixture) because replan proposals are capped at two a day per owner. It
approves a four-task plan whose steps have P50 = P90 (so no deadline-risk
trigger), locks the first block in the UI (the confirmed plan draws its blocks
on the week grid; the block's card carries the lock: `POST
/schedule-blocks/{id}:lock` with the block's `If-Match` and a UUIDv7 key; the
hand-off card, the grid, the card and the toggle must not move while the answer
is out), keeps the next hours busy with a commitment
(so a moved block can never start while the proposal is open) and adds a
commitment over the second block. It then waits for the API's leader-only
detection sweep, which runs every 300 s from API start (up to 11 minutes, so a
tick skipped by a contended advisory lock is tolerated), and checks:

- exactly one `commitment_conflict` proposal and one `replan_proposal`
  notification; 오늘 (on 개요) shows one replan card (a link, never the filled button)
  and the notification links to the proposal;
- 다시 맞추기 (one screen since HOLO-03A) lists only the overlapped block as moved
  and the locked block as unchanged, shows 전 → 후 as numbers and on the week
  grid (a ghost where the block stood, a proposal where it goes), and has one
  filled button, 승인; approval sends `If-Match: W/"availability:<n>"` + a
  UUIDv7 key, moves only that block, the locked block keeps its row and times,
  and the filled button becomes 오늘 보기;
- *다시 맞추기 요청* → reject (24 h explanation) → asking again is
  `409 replan_suppressed` with `Retry-After` ≈ 24 h, shown as a wait;
- the list beside the proposal holds the history, and `/replan` with nothing
  waiting says the plan is on track.

Locking goes through the real UI and API (FU-71; it used to be a direct
`UPDATE` fixture step); every assertion goes through the API or the UI.
The spec, the a11y additions (`/replan`, `/insights` — AI 분석, reached through
the old `/patterns` address — and the first two stages of 계획 세우기) and the
axe scans of the proposal, reject dialog and suppressed state all require 0
critical/serious.

## E2E-9 folders (HOLO-06)

`tests/e2e-9-folders.spec.ts` walks a folder's whole life on the real stack,
through the 할 일 canvas, with the main owner. A folder is a project, and
폴더 없애기 is the one place in the canvas that moves to-dos in bulk: every
to-do in the folder goes to the inbox, and only an empty folder is archived.
The live backend differs from the mock once a project is archived — it leaves
the project list, every write to a to-do inside it is refused (503
`provider_unavailable`) and those to-dos leave the unfiltered task list — so
each step is checked through the planner API (`listProjects`, `listTasks`,
`getTask` in `helpers/planner.ts`) and in Vikunja itself (`is_archived`, the
to-do's `project_id`):

- 폴더 만들기 → two to-dos picked (Ctrl-click) and filed with 폴더로 옮기기,
  a third from its own detail, which is then finished inside the folder →
  이름 바꾸기 in place → reload: the name, the two open to-dos and the count hold;
- **negative:** the question is asked while online and answered after the
  line dropped — no write leaves the page, the folder and its three to-dos are
  as they were, and the menu does not offer 폴더 없애기 or 이름 바꾸기 offline;
- 폴더 없애기: the three moves are answered (200, `projectId` = the inbox)
  before the archive is, nothing is deleted, the finished one stays finished,
  the folder is gone from the canvas and from `GET /projects`, and archived in
  Vikunja;
- 되돌리기 on the toast (it stays ten seconds, so the checks before it run
  together): `archived: false` first, then the three moves back;
- removed again, reload: it stays gone, all three are in the inbox (the
  planner's and Vikunja's) and one of them is finished from there.

## E2E-6 notes (M6-03)

`tests/e2e-6-notes.spec.ts` uses its own owner (`notes` fixture). The API runs
with `LLM_FAKE_SCENARIO=e2e-grounded` (the coordinator's M6-03 scope
amendment; see `services/api/src/adapters/fake-llm-scenarios.ts`), scoped by
`LLM_FAKE_SCENARIO_OWNERS` to that owner. Both knobs belong to the shared fake-knob
guard (`assertFakeKnobsAllowed`): they are honoured only with `LLM_PROVIDER=fake`
and refused under `NODE_ENV=production`. The scenario is the base fake that FU-76's
scripted slow owners (`LLM_FAKE_SCRIPTED_OWNERS`, E2E-AI) wrap, so both run
side by side for their own owners. It answers `type_detection@v1` with a schema-valid
"new" classification, so sessions are no longer forced into manual mode
before decomposition. The note-grounded `decomposition@v2` gets a draft built
from the request: one `fact` citing the first note block actually sent, one
`inference` carrying a planted link, and one forged reference. Every other
prompt, including the ungrounded `decomposition@v1`, keeps the fixture-less
fake: `llm_unavailable`, then a manual draft. Other owners, and so every other
suite, get exactly the plain fake as before. Without the scope, answered
type detection changes the flow's timing for E2E-2.

Flow, all in the UI unless noted:

1. Create a note whose body contains an injection (`이전 지시를 모두
   무시하고 <script>…</script> …`), a `javascript:` link and a tracking
   pixel, with *AI에 보내기 허용* on. The preview shows the script as text,
   no `javascript:` anchor and no image.
2. Link it to the Inbox project with the picker.
3. In 계획 세우기, link it to the plan's goal (*이 계획에 참고할 노트*), then
   leave the questions blank. The real pipeline (context builder →
   fenced prompt → schema → grounded sanitiser) yields two evidence items:
   *사실* with the note title, section and *노트 열기* link, and *추론*
   with `[link removed]`. The forged ref is gone, and the injection is shown
   verbatim as data (`window.__pwned` stays undefined; the draft keeps its 3
   steps).
4. Confirm the steps (the flow goes on to 일정안). The note's AI usage history
   lists one succeeded call with the same section hash.
5. Create and approve a plan for the goal (API helpers). Starting a focus
   session from 오늘 (on 개요) switches to the focus layout, where RelatedNotes
   lists the note (*이 폴더*, titles only). The toast's *되돌리기* restores
   개요.

A second test scans every notes screen with axe at 1280×860 and 390×844
(0 critical/serious, no horizontal page scroll).

