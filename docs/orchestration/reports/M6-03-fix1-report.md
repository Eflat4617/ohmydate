# M6-03R-1 fix round — task_adb0874de6ab (ctx_4440ae74adf7)

- worktree: /home/torgal/orca/workspaces/oh_my_date/m6-03-notes-ui · branch torgal/m6-03-notes-ui (not pushed)
- merged torgal/ohmydate first (`git merge --no-edit torgal/ohmydate` → 734d2c2, clean; FU-69 scheduler + docs)
- then, per coordinator msg_3ca3de9a0184 (FU-76 merged first), merged torgal/ohmydate 0593bf6 again → e993cb7
  - conflicts in app.ts, PlanningWizardView.vue, e2e/global-setup.ts and e2e/helpers/state.ts were resolved keeping both
    sides; app.ts takes FU-76's `fakeLlmFor`
- commits:
  - 7f5ba49 fix(web): owner-fence every notes lookup; no silent rebase over content conflicts; promote 409 pages (M6-03R-1)
  - 24b8121 refactor(api): createBaseFakeLlm factory for the fake provider base (FU-76 composition)
  - e993cb7 Merge torgal/ohmydate (FU-76): e2e-grounded scenario is the base fake under ScriptedFakeLlm
- HEAD: 3f807ba = e993cb7 plus a docs-only merge of torgal/ohmydate 5395fb3 (ledger and eval JSON; nothing testable changed)

## FU-76 composition (coordinator msg_3ca3de9a0184)

- `app.ts` `fakeLlmFor` (exported for tests) builds the base with `createBaseFakeLlm({scenario, owners})`: the plain
  FakeLlm, or the owner-scoped e2e-grounded scenario over it. FU-76's `ScriptedFakeLlm` wraps that base for
  `LLM_FAKE_SCRIPTED_OWNERS`, so no mode shadows another.
- `LLM_FAKE_SCENARIO` and `LLM_FAKE_SCENARIO_OWNERS` are registered in `fakeKnobsOf` and enforced by the shared
  `assertFakeKnobsAllowed`: fake provider only, `NODE_ENV=production` rejected. This is checked at configFromEnv and at
  buildApp boot (programmatic configs).
  - The scenario's own provider/production checks were removed; `parseLlmFakeScenario` now only validates the name.
  - The guard's NODE_ENV comparison is now trimmed and case-insensitive (stricter; FU-76's tests still pass).
- New tests (`services/api/test/fake-llm-scenarios.test.ts`):
  - both knobs active for different owners: the scenario owner gets grounded v2 output, the scripted owner the slow
    scripted answer (≥ latency), any other owner the plain fake's `LlmUnavailable`;
  - production rejects both knobs together (env and programmatic);
  - `buildApp` refuses a production config carrying the scenario.
- e2e/global-setup.ts passes both: `LLM_FAKE_SCENARIO_OWNERS` = notes owner, `LLM_FAKE_SCRIPTED_OWNERS` = aiwait owner.

## Finding table

| Finding | Reproduced first (failing test) | Fix | Status |
|---|---|---|---|
| H1 paginated link targets mix owners | `m6-03r-findings.spec.ts` "projects/tasks: a held A page released after switching to B…": before the fix, A's lookup fetched B/page2 and A's key held B data (failed) | `ownerFenced` + `collectPages` in `composables/notes.ts`: ONE OwnerBinding per lookup (all pages), its AbortSignal on every page request (`listProjects`/`listTasks`/`getTask` now take `signal`), key owner must be the bound owner, check before each next page and before returning; a stale lookup throws `OwnerChangedError` (no cache write, `retryFenced` never retries it). Applied to every notes lookup (see audit). | fixed; A→B→A tests pass for project and task targets (no B data under A, no A data under B) |
| M1 link/unlink 412 silently rebases conflicting edits | "link 412 / unlink 412 after a remote body change opens the conflict dialog" (failed: v2 adopted, no dialog) | `NoteLinks` emits `stale` with the latest note and closes the picker; the editor's `adoptServerNote` advances the base silently only if title/body/sensitivity/llmAllowed are unchanged remotely (link/version-only). If remote content changed and there are unsaved edits, it opens the existing reload / keep-mine-as-copy dialog and keeps the old base (the next Save → 412 → dialog again, never If-Match of the other version). Also applied to save 412: a link-only remote change rebases and retries the save once (new If-Match → new Idempotency-Key); a content change still opens the dialog without retrying. | fixed; tests for link and unlink (content conflict → dialog; link-only → silent rebase), save 412 link-only rebase+retry, save 412 content negative |
| M2 promote 409 lookup reads only page 1 | "opens a promoted note that sits on the second page" with 50 newer notes (failed: existsMissing) | `findPromotedNote(taskId, binding)` follows `nextCursor` through `collectPages` (owner-fenced, up to 20 pages of 50) until the `task_description` note with `sourceTaskId` is found or pages run out | fixed; page-two test + "missing only after every page" negative |
| Review residual risk: FU-76 composition | — | `createBaseFakeLlm({scenario, owners, fallback?})` in `adapters/fake-llm-scenarios.ts` returns the plain FakeLlm or the owner-scoped scenario with an injectable fallback; `app.ts` fake branch is one call, so FU-76 can wrap this base (or pass its scripted layer as fallback) instead of replacing it | done; test composes a scripted fallback |

## Async-path audit (every async path added in M6-03, and how it is fenced)

Reads (TanStack queries; all keys start with the owner; all queryFns run in
`ownerFenced(keyOwner(queryKey), …)` with `retry: retryFenced()`):

1. Notes list, search and paging (`NotesView` `useInfiniteQuery`, key `['notes', owner, 'list', q]`): each page is one
   fenced request with `binding.signal`. A page started under another owner is refused, and an answer arriving after an
   owner change is dropped. Tested: notes-list page fetch refused under B, A's cache keeps only A.
2. Link targets (`useLinkTargets` projects and tasks, keys `['notes', owner, 'targets', kind]`): one binding for the whole
   multi-page lookup, `collectPages` with checks before and after each page, and signal on every page. Tested: A→B→A for
   both kinds.
3. Linked notes (`useLinkedNotes`: project tab, task detail, wizard panel): fenced, signal. Tested: delayed A answer
   released under B is not cached under A or shown under B.
4. Editor doc (`NoteEditor` `docQuery`, key `['notes', owner, 'doc', id]`): fenced, signal. The editor additionally resets
   base, fields and dialogs on owner change.
5. AI usage history (`NoteAiUsage` `useInfiniteQuery`, key `['notes', owner, 'usage', id]`): each page fenced, signal.
6. Wizard note picker candidates (`WizardNotesPanel`, key `['notes', owner, 'list', q, 'wizard']`): fenced, signal.
7. Wizard evidence note titles (`EvidenceList` `useQueries`, doc keys): fenced, signal.
8. RelatedNotes (`useRelatedNotes`):
   - `getTask` (key `['task', owner, id]`): fenced, signal.
   - Open note (doc key): fenced, signal.
   - Per-target linked documents (`useQueries`): fenced, signal.
   - The intake session (shared key `['intake', id]`, pre-existing wizard key) is observe-only (`enabled: false`); the
     panel makes no request of its own.
9. Task detail `getTask` (key `['task', owner, id]`): fenced, signal.

Writes and continuations (one `captureOwnerBinding()` before the first await; `binding.signal` on the request; an
`isOwnerBindingCurrent(binding)` check after every await, before any state, cache, toast or navigation):

10. Editor create (POST `/documents`): checked after create and after `publishNote`, before announce and before `emit('created')` (navigation).
11. Editor save (PATCH, If-Match + Idem): checked after the PATCH and after `publishNote`.
    - 412 → `resolveSaveConflict`: fenced `getDocument`, then a link-only rebase or the dialog.
    - The retry runs only if the binding is still current.
12. Conflict: keep mine as a copy (POST): checked after create and after `publishNote`, before navigation.
    Conflict: reload: binding captured, checked after `publishNote`, before announce.
13. Delete (DELETE, If-Match + Idem): checked after the request.
    - 404: treated as already deleted.
    - 412: fenced `getDocument` re-check before adopting.
    - `forgetNote` and navigation happen only after the check.
14. Link/unlink in the editor (`NoteLinks`, POST/DELETE links, If-Match note version + Idem): checked after the request.
    On 412, `reportStale` does a fenced `getDocument` and emits only while current. The editor decision (M1) is
    synchronous.
15. Wizard goal link/unlink (`WizardNotesPanel`): checked after the request and after `publishNote`; the 412 refetch is
    followed by a re-check before setting the error.
16. Promote (`TaskDetailView`, POST `:promote-description`, If-Match task version + Idem): checked after the request and
    after `publishNote`, before toast and navigation.
    - 409: `findPromotedNote(taskId, binding)`, multi-page and fenced, re-checked before toast and navigation.
    - 412: `taskQuery.refetch()` (fenced), then re-checked.
17. `publishNote` / `forgetNote`: called only after a binding check, with the owner key read at that moment; the
    invalidations they trigger refetch through the fenced queryFns above.

Not changed (pre-existing, not added in M6-03): `ProjectDetailView`'s `['projects']` and `['tasks', 'project', id]`
queries (M1-era keys shared with other views). The owner change hard reload still covers them; it is listed here for
completeness.

## Tests (real exit codes; DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456)

Final results, on merged HEAD e993cb7:

- `pnpm --filter @ohmydate/web test` → exit 0 — Test Files 49 passed (49), Tests 439 passed (439)
- `pnpm --filter @ohmydate/web build` → exit 0 — index 653.42 kB (gzip 191.80), NotesView 146.76 kB
- `pnpm run ci` → exit 0 — root 170 files, 2100 passed | 29 skipped; web 439/439; Boundary check 503 files, 0
  violations; build-smoke `/healthz` 200

Earlier runs on the pre-FU-76 head 24b8121:

- `pnpm --filter @ohmydate/web test` → exit 0 — Test Files 46 passed (46), Tests 417 passed (417); 15 new in m6-03r-findings.spec.ts
- `pnpm --filter @ohmydate/web build` → exit 0 — index 638.09 kB (gzip 186.95), NotesView 146.76 kB
- `pnpm run ci`:
  - Run 1 → exit 1: `fu41.test.ts:849` 180 s timeout (FU-66) and `services/api/test/db/migrate.test.ts:394` 120 s timeout,
    with load average 28.
  - Run 2 → exit 1: only `fu41` (FU-66). Root tests 163 files passed / 1 failed, 2047 passed / 1 failed / 29 skipped;
    typecheck and lint passed inside ci.
  - Re-run alone: `fu41.test.ts` → exit 0, 9 passed (144 s); `migrate.test.ts` → exit 0, 13 passed (9.9 s). No changes
    under `packages/` or `services/api/src/db`.
  - CI's later stages run directly: `check:api-client` exit 0; `check:boundaries` exit 0 (488 files, 0 violations);
    `build-smoke --required` exit 0 (`/healthz` 200).
- `pnpm run e2e` on e993cb7 → exit 1: 25 passed, 2 failed, 2 did not run (6.3 m). Passed: E2E-6 notes ×2, E2E-AI ×2
  (FU-76, scripted owner beside the e2e-grounded owner), E2E-2 ×3, E2E-6 layout, E2E-5R, a11y screens.
  - E2E-5 owner reset failed on `login`'s 429 back-off (61 s wait > 60 s test timeout). Re-run alone → passed (2.6 s).
  - E2E-4 Today ("keeps one notification") failed `toHaveCount(3)`, received 2, at 21:47 UTC. The spec runs in a UTC
    browser and puts a large goal's blocks back to back from now, so after about 21:00 UTC the third block falls past
    midnight UTC. Re-run alone at 21:48 UTC → same failure. On the base torgal/ohmydate (5395fb3) at 21:49 UTC → the
    identical failure. It's time-of-day, not this branch: no changes to E2E-4 or its helpers. The earlier run of this
    suite at about 05:00 UTC passed 27/27.
- The 2 that did not run are the E2E-4 serial siblings after the failure.
- services/api: `fake-llm-scenarios.test.ts` + `scripted-fake-llm.test.ts` + `config.test.ts` → 31 passed; tsc clean; eslint clean.

## Risks

- `OwnerChangedError` results stay as error state under the old owner's key and refetch on next use. No data is kept.
- The save 412 auto-retry happens at most once, and only for link/version-only remote changes.
- The promote search is capped at 20 pages × 50 notes, about 1,000 notes on one task.
- Rollback: revert e993cb7 (merge), 24b8121 and 7f5ba49, or delete the branch.
