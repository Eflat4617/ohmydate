# FU-73R (ctx_65172dba464e, Fable 5.2 xhigh — Sol weekly limit; implementer Opus) — APPROVE

REVIEW VERDICT: APPROVE
(Reviewed by Claude Fable 5.2 in place of Sol. FU-73, torgal/ohmydate...f61105c, merge base cfbc26d. No CRITICAL/HIGH/required-MEDIUM. All findings are non-blocking suggestions.)

Findings (most severe first):
  [LOW] complete() keeps the watermark, but no committed test pins it
    Evidence: packages/provider-vikunja/src/task-repository.ts:935-936. In a scratch copy, changing that line back to `latestUpdatedAt` leaves all 100 unit tests green. The line is load-bearing: "create with dependsOn -> complete at v1 before the listener touch -> touch lands 1 s later" gives feed [1,2] at head and [1,2,3] with the mutation.
    Suggestion: add that scenario to test/unit/task-repository.self-touch.test.ts (AGENTS.md: unit test per new behaviour).
  [LOW] The 10 s grace bound is not pinned
    Evidence: task-repository.ts:134. SELF_TOUCH_GRACE_MS = 60_000 keeps all unit tests green; the only "past the window" negative uses +120 s (self-touch test :674-689). Measured at head: an ETag-only remote edit at +3 s, +9 s and +10.5 s after create-with-deps is absorbed ([1]); at +12 s it bumps ([1,2]).
    Suggestion: add a boundary pair (just inside = absorbed, which documents accepted risk (a); just past the watermark = bump) so the window cannot widen unnoticed.
  [LOW] Lost relation-write response with no earlier write time still gives one phantom bump and a 412 (worker risk (b), reproduced)
    Evidence: task-repository.ts:772-776 passes selfTouchWatermark(relationWriteTimes, undefined), which is undefined when the failing relation write is the first one. Scratch probe: update({dependsOn:[dep]}) with the POST applied but answered 503 -> get() reconciles to v2 -> touch lands in a later second -> feed [1,2,3], and a write at v2 throws VersionConflictError. Not a regression (base behaves the same); needs a transport failure on the relation write plus a reconcile read that beats the touch.
    Suggestion: optional follow-up: use the pre-check GET's Date header (provider clock) as the lower-bound write time on the unknown-outcome path.
  [LOW] ADR-016 section 1(b) no longer matches the behaviour exactly
    Evidence: docs/blueprint/13-ADR.md:90 says a differing ETag means VersionConflict. Now an ETag move with unchanged mapped content inside the watermark is adopted, and vikunja_mapping.external_updated_at can sit up to ~11 s ahead of the provider `updated` (mapping-store.ts:28-34). docs/ was outside the worker's allowed paths.
    Suggestion (coordinator): add an ADR addendum for the exception and the new column meaning.
  [LOW] Nit: new code uses Date.parse where the domain helper exists
    Evidence: task-repository.ts:140,157,194; packages/domain/src/time.ts:8 exports instantToEpochMs. One pre-existing Date.parse in the file sets the precedent; lint passes.
    Suggestion: switch to instantToEpochMs when the file is next touched.

Focus answers:
  1) Watermark: correct. observeRemote (task-repository.ts:180-207) absorbs only when the fingerprint is defined and unchanged AND remote updated < watermark; contentChanged is computed independently and always bumps (also in the #remoteChanged pre-check, so 412 is kept). The fingerprint (:92-112) covers every provider-backed Task field that #toTask maps: title, marker-stripped description, done, dueAt, projectId, blocked relation ids. A genuine content edit inside the window therefore cannot be absorbed, and nothing mapped can be lost permanently; only ETag-only edits (unmapped fields such as priority, verified live to move the ETag) are absorbed inside the window. Probes at head: remote title edit inside the window before the own touch landed -> [1,2], own touch then absorbed, stale write 412, write at v2 ok; remote relation add inside the window -> one bump; ETag-only edit on the dependency task 1 s after linking still bumps (its watermark is untouched). The watermark was not lowered by a later plain update or complete.
  2) Concurrency: the watermark is written in the same single-row put as the fingerprint/version (create: provisional value with the insert, final value with the fingerprint CAS; update: one CAS put). Failure paths raise it through #markNeedsReconcile (CAS, skips when a newer writer won). Conflict suites pass; 412 is still raised for content changes and for ETag-only changes at/after the watermark.
  3) Provider clock only: inputs are relation `created`, the Date header, and observed `updated`; #clock.now() is not used, and the comparison is provider `updated` vs a provider-derived instant, so planner skew cannot widen the window. A missing provider time only narrows it.
  4) Tests: no test removed, skipped or loosened (the grep of the test diff for removed expect/it/test/.skip/.only is empty; the existing create-with-dependencies [1] assertion in contract.test.ts is untouched, the diff there is additions only). New unit file on base sources: 11 failed / 3 passed, as claimed. New live test on base sources: 3/3 failed with "expected [1, 2] to deeply equal [1]". Mutation spot-check on a scratch copy: 9 of 12 mutants killed (create provisional, create final, adopt, update, both needsReconcile sites, commitReconciled, grace=0, unbounded ownTouch); survivors are complete() and grace=60 s (findings above) plus one equivalent mutant.
  Root cause verified live: relation POST returns `created` and a Date header; the base task's updated/ETag moved after the relation DELETE response had returned (old value at +9 ms, new at +17 ms); the other task was never touched; a plain PATCH causes no later touch; the ETag is purely the `updated` second.

Contract / license / security / migration impact: none. packages/contracts and OpenAPI unchanged (check:api-client clean), no new dependency, no migration, nothing new is logged. Semantic change only: external_updated_at is now a non-decreasing accounted-for watermark. Rollback by reverting f61105c is safe (old code reads the column only for the no-ETag comparison and the snapshot `at`). Changed paths are all inside packages/provider-vikunja/** (5 files). Commit is Conventional with the Task trailer.

Missing tests:
  - complete() before the own relation touch lands (see finding 1).
  - Grace boundary pair (see finding 2).
  - Client-level test for createRelation/deleteRelation return values: `created` preferred over Date, Date fallback, zero/garbage -> undefined. Making createRelation ignore either source alone leaves the unit suite green (the fake reports identical times for both).

Verification actually executed: yes
  - DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm --filter @ohmydate/provider-vikunja test -> exit 0 (14 files, 132 passed, 9 skipped)
  - same env, in packages/provider-vikunja: corepack pnpm exec vitest run --globals test/contract.test.ts, 6 times while corepack pnpm --filter @ohmydate/api test ran as load for the whole loop -> 6/6 exit 0 (31 passed, 9 skipped each); API suite exit 0 (79 files, 542 passed, 9 skipped)
  - same env: corepack pnpm run ci -> exit 0 (typecheck, lint, test 171 files / 2121 passed / 29 skipped, web 49 files / 442 passed, check:api-client no diff, check:boundaries 0 violations, build-smoke /healthz 200 and SIGTERM exit 0)
  - Scratch copies outside the worktree: new unit file on cfbc26d sources -> exit 1 (11 failed, 3 passed); live FU-73 test on cfbc26d sources x3 -> exit 1 each; 8 reviewer probe scenarios and the mutation runs on head sources; a live probe against Vikunja with a synthetic user, cleaned up afterwards.

git status --porcelain after review: empty (HEAD f61105c, no files modified, nothing committed)

Residual risks:
  - (a) An ETag-only Vikunja edit within about 10-11 s (provider time) of the adapter's own relation write is absorbed; no mapped content is involved.
  - (b) Listener lag over 10 s, or the lost-response case in finding 3, can still give one phantom bump.
  - Same-version mapping writes (create's second put, settle, needsReconcile) are not CAS-protected against each other, so a stale concurrent poll can overwrite a raised watermark with an older one; the store does not enforce "never decreases". This is the existing FU-22 create race; effect is at most one phantom bump.
  - In create()'s adopt branch (a concurrent poll committed first) only the provisional watermark is kept, so it does not cover a relation write more than 10 s after the create read.
  - deleteRelation relies on the Date header alone; a reverse proxy that rewrites Date with a skewed clock would shift the window for delete-only updates. Not applicable to the local-only deployment.
  - Pre-existing, not from this change: a relation written by another Vikunja client can still produce a content bump followed by a second ETag-only bump when its async touch lands a second later.
  - FU-81 (dependents not touched on task delete) is tracked separately.
