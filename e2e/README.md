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
offline mutation gating, a Tab/Enter-only login + quick-add flow, and
`@axe-core/playwright` scans of login and inbox (zero critical/serious).

## E2E-3 and wall-clock time (FU-55)

Plan blocks are generated from the API's "now", so E2E-3 never assumes where
they land. After generation it reads the plan, availability, commitments,
approved schedule blocks and task due dates through the public API, and
`helpers/plan-edit.ts` picks every keyboard edit from that real schedule:

- **feasible**: one ArrowUp/ArrowDown press on a block that has 5 free
  minutes on that side (same window, no overlap, not in the past, not past the
  due time), trying the next candidate when one is fully packed;
- **H2 negative**: the fewest presses that push a block over its window edge;
- **H1 negative**: the fewest presses that slide a block into its same-day
  neighbour.

The week view is navigated to the edited block's week, and each edit waits for
the `:preview-edit` response of exactly that edited state (plus the
"Validating edits…" live-region update) instead of sleeping.
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
Without the variable nothing is shifted. Only E2E-3 opts in, so run E2E-1/E2E-2
on real time. PostgreSQL `now()` and Vikunja keep real time, which is fine for
E2E-3's flow but is why this stays opt-in.

## E2E-5R replan (M5-03)

`tests/e2e-5r-replan.spec.ts` uses its own planner/Vikunja owner (`replan`
fixture) because replan proposals are capped at two a day per owner. It
approves a four-task plan whose steps have P50 = P90 (so no deadline-risk
trigger), locks the first block, keeps the next hours busy with a commitment
(so a moved block can never start while the proposal is open) and adds a
commitment over the second block. It then waits for the API's leader-only
detection sweep, which runs every 300 s from API start (up to 11 minutes, so a
tick skipped by a contended advisory lock is tolerated), and checks:

- exactly one `commitment_conflict` proposal and one `replan_proposal`
  notification; Today shows one banner and the notification links to it;
- the detail lists only the overlapped block as moved and the locked block as
  unchanged; approval sends `If-Match: W/"availability:<n>"` + a UUIDv7 key,
  moves only that block, and the locked block keeps its row and times;
- *재계획 요청* → reject (24 h explanation) → asking again is
  `409 replan_suppressed` with `Retry-After` ≈ 24 h, shown as a wait.

Locking uses `helpers/db.ts` (an `UPDATE` in the throwaway schema) because M5
has no lock endpoint; every assertion still goes through the API or the UI.
The spec, the a11y additions (`/replan`, `/patterns`) and the axe scans of the
detail, reject dialog and suppressed state all require 0 critical/serious.

## E2E-6 notes (M6-03)

`tests/e2e-6-notes.spec.ts` uses its own owner (`notes` fixture). The API runs
with `LLM_FAKE_SCENARIO=e2e-grounded` (the coordinator's M6-03 scope
amendment; see `services/api/src/adapters/fake-llm-scenarios.ts`), scoped by
`LLM_FAKE_SCENARIO_OWNERS` to that owner. The scenario is honoured only with
`LLM_PROVIDER=fake` and is refused at boot under `NODE_ENV=production`. It answers `type_detection@v1` with a schema-valid
"new" classification, so sessions are no longer forced into manual mode
before decomposition. The note-grounded `decomposition@v2` gets a draft built
from the request: one `fact` citing the first note block actually sent, one
`inference` carrying a planted link, and one forged reference. Every other
prompt, including the ungrounded `decomposition@v1`, keeps the fixture-less
fake: `llm_unavailable`, then a manual draft. Other owners, and so every other
suite, get exactly the plain fake as before. Without the scope, answered
type detection changes the wizard's timing, and E2E-2's skip loop then races
a disappearing question card.

Flow, all in the UI unless noted:

1. Create a note whose body contains an injection (`이전 지시를 모두
   무시하고 <script>…</script> …`), a `javascript:` link and a tracking
   pixel, with *AI에 보내기 허용* on. The preview shows the script as text,
   no `javascript:` anchor and no image.
2. Link it to the Inbox project with the picker.
3. In the planning wizard, link it to the plan's goal (*이 계획에 참고할
   노트*), then skip the questions. The real pipeline (context builder →
   fenced prompt → schema → grounded sanitiser) yields two evidence items:
   *사실* with the note title, section and *노트 열기* link, and *추론*
   with `[link removed]`. The forged ref is gone, and the injection is shown
   verbatim as data (`window.__pwned` stays undefined; the draft keeps its 3
   steps).
4. Approve the draft. The note's AI usage history lists one succeeded call
   with the same section hash.
5. Create and approve a plan for the goal (API helpers). Starting a focus
   session from Today switches to the focus layout, where RelatedNotes lists
   the note (*이 프로젝트*, titles only). The toast's *되돌리기* restores
   Today.

A second test scans every notes screen with axe at 1280×860 and 390×844
(0 critical/serious, no horizontal page scroll).

