# FU-77 fix round 1 (FU-77R-1) — worker report

- taskId: task_cf7460c476a9 · dispatchId: ctx_7f4c3ff56804
- worktree: /home/torgal/orca/workspaces/oh_my_date/fu-77-owner-guardrail · branch: torgal/fu-77-owner-guardrail
- head: e2d9188 (previous reviewed head 98ba71c; torgal/ohmydate merged first at 318f6c6 — orchestration docs only)
- commits this round: 5e0fdde (H2), 640205c (H1), cc9a806 (ADR), d46d5c5 (lint), 8bc2158 (timeouts), c5588b9 (navigation rule, two-phase test script), e2d9188 (ADR)
- outcome: succeeded. git status clean. All changed paths are under apps/web/** or docs/blueprint/13-ADR.md. No pre-existing test file was modified (every test file in `git diff torgal/ohmydate...HEAD` is an addition of FU-77).

## Finding table

| Finding | Status | Fix | Reproduced first | Regression |
| --- | --- | --- | --- | --- |
| H1 owner.wait does not prevent stale continuation or helper side effects | fixed | `runOwnerBound` runs a generator; the runner checks the binding in the same synchronous turn in which it resumes the task. Helpers that wait and then write are generators delegated with `yield*`. Every API request carries the starting owner's abort signal. Navigations are bound to the owner who started them. | yes — old primitive: `A-private written while <B> is signed in`; AvailabilityView: `cache ["availability"]` + announcement `가용 시간을 저장했어요 (버전 2).` for B; helper: `Linked A-private-title` | test/owner-resume-order.spec.ts (reviewer's probe, each later wait, helper wait in both orders, AvailabilityView, WizardNotesPanel announce); sweep in all orders |
| H2 storage guardrail permits aliases of browser globals (TS and Vue) | fixed | `owner-isolation/no-raw-storage` rejects the storage names wherever they are used to reach a value (any member property, any destructuring incl. parameters, constant computed keys, the name as a string); bare globals stay with no-restricted-globals. Exemptions unchanged: ownerStorage.ts and tests. | yes — the three reviewer probes returned 0 errors in .ts and .vue; 13 of 14 TS fixture lines and 6 of 7 Vue lines were not reported | test/owner-lint.spec.ts + fixtures aliasedStorage.ts, AliasedStorageView.vue |
| Missing test: push permission / service-worker waits | added | sweep case `notifications: enable push (permission prompt, service worker, subscription)`; the bound-point sweep changes the owner at each of its five waits | — | shard specs |
| Missing test: resolve-then-switch-before-resume; owner change inside helper awaits | added | see H1 | — | owner-resume-order.spec.ts + sweep |

## H1 in detail
Why the first design was wrong: `await owner.wait(p)` checked when the wrapper promise resolved. The code after the await resumes one microtask later, unchecked. And `await owner.wait(helper())` fences only the end of an async helper, not what the helper does after its own awaits.

What changed:
1. `session/ownerBound.ts` — the task is a generator (`function* (owner) { const x = yield* owner.wait(p); … }`). Each yield hands control to the runner; when the yielded thing settles, the runner checks `isOwnerBindingCurrent` and calls `steps.next/throw` in that same synchronous turn. Nothing can run between the check and the task's next stretch of code. A stale task is abandoned where it waits: no later line, no catch, no finally, no onError/onSettled. `await` cannot be written in a generator, and an async function does not type-check as a task. `rethrowIfStale` is removed (a stale failure never reaches the task). A raw `yield p` is fenced the same way; yielding a generator instead of delegating throws.
2. Helpers converted to delegated generators: announce (WizardNotesPanel, NoteEditor, NoteLinks, PatternsView, ReplanProposalView), focusState / refreshAll / invalidateSchedules (ReplanProposalView), reportStale (NoteLinks), focusFirstInvalid / resolveSaveConflict / finishDelete and the whole save flow (NoteEditor), fetchLatest / refreshConflict (useTaskActions), refreshSteps (CommitmentsView), navigateSteps (NotesView), run / persistDraftSteps / refreshSessionSteps (wizard non-AI).
3. Handlers that acted after awaiting a bound function are tasks themselves: TaskList saveEdit / onComplete / onOverwrite / onReload, InboxView.addTask, NotificationsPanel.onDismiss, LlmSettingsView setConsent / saveBudget, LlmConsentDialog grant / manualMode, NotesView.onDeleted, wizard enterManual / sessionAction / saveDraft / approve / reloadDraft.
4. Transport (`api/client.ts`): the first openapi-fetch middleware runs in the caller's turn and attaches the starting owner's AbortSignal to every request. Found by the new sweep order: a request started just before the switch (deleteCommitment and every other method without a signal parameter) was still sent afterwards.
5. Navigation (`router.ts` bindNavigationsToOwner): the owner is noted when push/replace is called and re-checked in beforeResolve. Found by the new sweep order: a navigation A started (notes create/delete, plan generate, task promote, replan request) completed after B signed in. Owner ids are compared, not epochs, so the first navigation (before /me answered) and a same-user re-login still complete — tested.
6. Lint `owner-isolation/bound-task` (replaces bound-await): `notGenerator` (async task), `asyncHelper` (a task or helper generator calling an async function declared in the same file), `afterOutcome` (effects after `await runOwnerBound(…)` or chained `.then`), `notDelegated` (a generator helper called like a function). I did not add a commit()-style rule: with the runner there is no unfenced position inside a task to flag.
7. Harness (`test/support/ownerSwitch.ts`) and sweep:
   - request orders, for every request an action sends: switched then answered late (existing), switched then aborted (what a real fetch does), answered then switched in the next microtask (order b);
   - bound points, for every suspension point of the bound tasks an action runs, network or not (helper nextTick, cache refresh, permission prompt, service worker): switch while pending (order c), right after it settled and before the task resumes (order b, the reviewer's gap), right after the task finished and before its caller resumes;
   - the control run must not end in an error notice (it caught a sweep case of mine that was passing on an error path: the wizard-notes case used a goal id that did not exist);
   - harness self-tests: unfenced code leaks in each order, the same code as a bound task does not.
   The sweep is 39 cases (156 tests), split over six spec files; the web test script runs them as a second phase.

## H2 in detail
The rule no longer follows aliases; it rejects the names. Covered with fixtures in TS and Vue script setup: `const b = window; b.localStorage`, `const { sessionStorage: s } = globalThis`, destructuring from `window.window`, `window.window.localStorage`, `self.self.indexedDB`, `globalThis.self.sessionStorage`, `document.defaultView?.localStorage`, a `Window`-typed variable, `b['localStorage']`, `` b[`sessionStorage`] ``, `Reflect.get(window, 'indexedDB')`, a key kept in a variable, `parent.localStorage`, a destructured parameter. Allowances verified: ownerStorage.ts passes, test files pass, `Storage` / `IDBDatabase` types and unrelated keys are not flagged.
Limit, stated in the rule and the ADR: a key assembled at run time (`'local' + 'Storage'`, `new Function`) is beyond a static rule; the sweep checks the keys that actually get stored against the declared table.

## Commands (real exit codes, at head e2d9188 unless noted)
- `corepack pnpm --filter @ohmydate/web lint` -> 0
- `corepack pnpm --filter @ohmydate/web test` -> 0 — phase 1: 53 files, 499 tests; phase 2 (sweep): 6 files, 156 tests (run at c5588b9, same web sources; repeated inside ci at e2d9188)
- `corepack pnpm --filter @ohmydate/web build` -> 0 (existing >500 kB chunk advisory)
- `DATABASE_URL=… VIKUNJA_URL=… corepack pnpm run ci` -> 0 — root 170 files / 2103 passed / 29 skipped; web 53/499 + 6/156; api-client schema unchanged; boundaries 523 files / 0 violations; build-smoke /healthz 200, SIGTERM exit 0
- `DATABASE_URL=… VIKUNJA_URL=… corepack pnpm exec playwright test -c e2e/playwright.config.ts e2e-5-owner-reset e2e-6-notes e2e-ai-wait` -> 0 — 5 passed (1.8 m)
- `git diff --check torgal/ohmydate...HEAD` -> 0
- SKIPPED: the full E2E suite (not requested).

## Things the reviewer should know
- The primitive's API changed (async task -> generator task), so my own round-0 tests of it were rewritten for the new form (owner-guardrail.spec.ts runOwnerBound block, the bound-task lint fixture). The harness invariants are unchanged or stricter; nothing was relaxed. One intermediate state excused navigations started before the switch — I replaced that with the navigation rule and restored the strict check before finishing.
- Web tests under machine load: during this round the machine sat at load 30–50 from other jobs. In those runs pre-existing tests with 1 s waits timed out (m4-focus, m4-today, wizard, plan-comparison, m6-03 notes …), sweep or no sweep. `m6-03r-findings › unlink 412 after a link-only remote change rebases silently` is racy by construction (it asserts right after the conflict text appears, while the follow-up GET may still be in flight) and failed twice in full-suite runs under load; it passed 20/20 alone. To keep the sweep from adding to that, its six shards now run after the rest of the suite, and the sweep's own waits are 20 s. If the reviewer sees a timeout in a pre-existing spec, check `uptime` first.
- The transport abort applies to every PlannerClient request once session/ownerEpoch is loaded, including login/logout: a login in flight when another tab changes the owner now fails as aborted (the page is reloading at that moment anyway).
- An abandoned generator does not run its finally blocks. That is intended (no UI write for a stale owner); a busy flag on the stale screen stays set until the reload.
- Still on hand-placed checks, as accepted: Focus start/restore/pause, the wizard AI-wait state machine, Today handlers. Their checks run in the resumed turn (directly after the await), which is the property H1 asked for; the request-order sweep covers them.
- Not statically checkable: an async helper imported from another module and called from a task (the lint rule sees only same-file helpers). The helpers used today (publishNote, forgetNote, findPromotedNote, composable actions, auth.setLlmConsent) write before their first await or are fenced themselves; the bound-point sweep would show a leak from one.

## Rollback
Delete the branch (no migration, no API contract change, no dependency added).
