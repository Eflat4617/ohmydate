# FU-77 worker report — structural owner-isolation guardrail for apps/web

- taskId: task_b5e2619c0ad8 · dispatchId: ctx_761dd5eb09cc
- worktree: /home/torgal/orca/workspaces/oh_my_date/fu-77-owner-guardrail
- branch: torgal/fu-77-owner-guardrail (base c34b1e1)
- commits: c9958ad, df2125c, b73ce76, af00f7c, 7e9fb4b, 8daf490, a956eaa, 98ba71c (HEAD)
- outcome: succeeded. git status clean. No existing test file was modified, deleted or skipped (all 7 test files in the diff are new).

## Root cause
Three things, none of them specific to a screen:
1. "Who is signed in" is ambient mutable state. Code that reads it after an `await` reads someone else.
2. Storage keys were strings any file could assemble, so nothing stopped an unscoped key or a key built from the ambient owner.
3. A line after an `await` was only as safe as a hand-placed check at that exact spot. A missing check is invisible until review.
Each of the four findings was one of these, fixed where it was found.

## Design (what now makes the wrong thing hard)
1. `src/session/ownerStorage.ts` — the only module that touches localStorage / sessionStorage / indexedDB. Everything persisted is declared in one table: owner slots (key is always `<prefix>:<ownerId>`), a device allowlist with a reason per key (active-owner pointer; the remove-only legacy AI-wait key), and the device database. A write takes the OwnerBinding captured where the action began; the namespace comes from the binding; a stale binding writes nothing. Only slots declared `keep-for-owner` (focus sessions, quarantine, clientId) accept a late write, and it lands in that owner's own namespace. Slots declared clear-on-owner-change (AI wait) are emptied by ownerEpoch itself on every owner change.
2. `src/session/ownerBound.ts` — `runOwnerBound(async (owner) => …, { onError, onSettled, binding })`. Binding captured synchronously before the first await; `owner.wait(p)` rejects with OwnerChangedError the moment the owner changes (also when `p` never settles or ignores the signal); `owner.rethrowIfStale(cause)` for catches; `owner.signal`; `owner.pages(…)` / `collectPages` for paginated lookups; a stale result or failure is dropped and neither handler runs. `ownerFenced` (query form) moved here; `composables/notes.ts` re-exports it unchanged.
3. Page seal (opt-in, installed by main.ts) — once a hard reset is decided the page cannot write the new owner's storage namespace with any binding, the query cache is dropped and takes no more data, no toast appears, the router does not move. Unfenced code then has nowhere to write. Never engages for a single owner.
4. `src/session/ownerQuery.ts` — the app's QueryClient cancels and drops everything on any owner change and never retries OwnerChangedError.
5. ESLint (`apps/web/eslint.config.js`, `apps/web/eslint/owner-isolation.js`) — storage globals fail lint anywhere in src except ownerStorage.ts (bare, window/globalThis/self, brackets, destructuring; .vue script blocks included through a small processor, no new dependency). Rule `owner-isolation/bound-await`: inside a runOwnerBound task (or a helper taking an OwnerScope) a bare await, an unguarded catch and a finally are errors.
6. Tests — `test/support/ownerSwitch.ts` (hold A's response, switch to B, release; late delivery is forced even if the request was aborted; requests sent after the switch are never answered) and `test/owner-switch-sweep.spec.ts`, which also switches the owner at every network await an action leads to. A manifest test requires every source file that talks to the API or persists on the device to have a case or an exemption with a reason.

## Migrated call sites
Storage (all 8, stored keys and values byte-identical): session/owner.ts, session/quarantine.ts, session/clientId.ts, session/journal.ts, stores/session.ts, composables/useAiWait.ts, layout/localSignals.ts, layout/prefs.ts.
Ad-hoc fences moved to runOwnerBound: FocusView.submitReview (M6-02R-1 H1); NoteEditor confirmDelete/finishDelete, reloadFromConflict, copyFromConflict (M6-03R2); NoteLinks add/remove; WizardNotesPanel link/unlink; TaskDetailView.promote; PatternsView toggle/reset; ReplanProposalView approve/reject/refresh/recompute.
Screens that had no fence at all, now bound: AvailabilityView save/reload; CommitmentsView save/remove; useTaskActions (all task mutations) + TaskList delayed delete (timer bound to the click); PlanNewView.generate; PlanComparisonView preview/approve/regenerate; useNotifications poll/dismiss; NotificationsPanel.enablePush; ReplanRequestButton.submit; PlanningWizardView run()/refreshSession()/approve() (non-AI steps).
Left on their existing binding checks, on purpose: Focus start/restore/pause (a late answer is kept in the starting owner's namespace, not dropped — pinned by m4-owner-bound.spec.ts), NoteEditor.saveNote (retry recursion), TodayView handlers, and the wizard AI-wait state machine (checks tied to the poll token and `disposed`). All are covered by the sweep.

## What the sweep found (real defects, fixed)
- AvailabilityView: A's late save wrote A's availability into the cache and announced "saved (version 2)" for B.
- Notifications: a poll answered late listed and toasted A's notifications for B; enablePush could register the browser under B's account after a long permission prompt.
- TaskList: the 6 s undo timer would send A's delete with B's session.
- Later-await gaps behind existing checks: ReplanProposalView announced approval/rejection, ReplanRequestButton navigated to the new proposal, PatternsView announced the change — all after the owner changed during the follow-up read.
- Wizard approve: a switch between saving the draft and approving it sent the approval under the next owner.
- A harness blind spot found by a mutation check (removing one fence was not detected) and fixed: held responses are now detached from the aborted request, and the baseline is taken before the switch.

## Requirement checklist
1. Owner-scoped persistence module, sole storage accessor, owner-namespaced keys, device allowlist with reasons, binding-taking writes that no-op when stale, clear/preserve on owner change, ESLint enforcement, all call sites migrated — met.
2. Owner-bound async primitive with AbortSignal, drop on staleness, paginated helper; existing fences migrated where it reduces code — met (exceptions listed above).
3. Reusable harness at apps/web/test/support/ownerSwitch.ts + generic sweep over notes, wizard/AI wait, layout signals, focus review, replan, today, availability/commitments, inbox edits (plus plans, patterns, task promotion, notifications, AI settings) — met.
4. Lint self-test: fixtures fail, the module passes — met (test/owner-lint.spec.ts).
5. ADR-023 amendment — met.
6. No behaviour change for a single owner; existing tests green and unweakened — met (442 pre-existing web tests pass unmodified).

## Tests (real exit codes)
- `corepack pnpm --filter @ohmydate/web lint` -> 0 (script added; `eslint .` with the apps/web config)
- `corepack pnpm --filter @ohmydate/web test` -> 0 — 52 files, 591 tests passed (baseline before the task: 49 files, 442 tests)
- `corepack pnpm --filter @ohmydate/web build` -> 0 — built; existing >500 kB chunk advisory
- `DATABASE_URL=… VIKUNJA_URL=… corepack pnpm run ci` -> 0 — typecheck, lint, root 170 files / 2103 passed / 29 skipped, web 52 / 591, api-client schema unchanged, boundaries 514 files / 0 violations, build-smoke /healthz 200 + SIGTERM exit 0
- `DATABASE_URL=… VIKUNJA_URL=… corepack pnpm exec playwright test -c e2e/playwright.config.ts e2e-5-owner-reset e2e-6-notes e2e-ai-wait` -> 0 — 5 passed (52.9 s)
- SKIPPED: the full E2E suite (only the three requested specs were run).

## Risks and things a reviewer should know
- Multi-owner behaviour did change, deliberately: stale continuations now stop at their next await (e.g. ActionStore.settle is no longer called for a stale owner — instance-local); every toast is cleared on an owner change; useNotifications resets and restarts for the next owner; the production query client drops its cache on an owner change.
- The page seal runs only in production (main.ts). It is covered by owner-guardrail.spec.ts and exercised by E2E-5, not by the older unit tests, which switch owners on one page on purpose. If a `beforeunload` prompt cancels the hard reload, the page stays sealed until the user reloads (fail closed; before, it stayed on the loading screen).
- journal.append now resolves the record's owner before awaiting the database open (it used to read it after). Same result unless setOwner is called during the open.
- ESLint 10 uses the config nearest to each file, so apps/web/eslint.config.js re-exports the repository config. Its `ignores` patterns therefore resolve relative to apps/web for those files (`docs/**` now also covers apps/web/docs). .vue script blocks get only the owner-isolation rules; the general rules stay off for them, as before.
- The harness accepts a "loading / could not load" notice after a switch as the screen's own reaction (Korean text pattern `불러오(는 중|지 못했)`); anything else that appears counts as a leak.
- Web test wall time grew from about 11 s to about 29 s (the sweep is 118 tests).
- Not individually swept (exempt with reasons in the manifest): read-only screens and lookups (EvidenceList, NoteAiUsage, ReplanBanner, relatedNotes, useLatestReplanPlan, useTodaySnapshot, ProjectDetailView, ProjectListView) and storage plumbing (owner.ts, quarantine.ts, journal.ts).
- Out of scope: the server does not verify the intended owner of a request.

## Contracts for dependents
- To persist anything: add a slot to the table in ownerStorage.ts and write with `slot.write(binding, …)`.
- Anything that acts after an API answer, a timer or a dialog: `runOwnerBound`; pass `{ binding }` captured at the click for work that starts later; check `outcome.status` before acting after it.
- A new source file that talks to the API or persists on the device must add a case to owner-switch-sweep.spec.ts (or an exemption with a reason), or the manifest test fails.
- Tests that need the production cache behaviour use `createOwnerQueryClient()`.

## Rollback
Delete the branch (no migration, no contract or API change, no dependency added).
