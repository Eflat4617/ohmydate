# FU-56R (ctx_cbe083affda0, Fable 5.2 xhigh — Sol weekly limit; implementer DeepSeek) — APPROVE

REVIEW VERDICT: APPROVE
Reviewed: torgal/ohmydate...35ad177 (branch torgal/fu-56-crosstab-e2e), reviewer Fable 5.2 xhigh, round 1 of 2. No CRITICAL/HIGH found. Focus answers: (1) the new E2E-5 assertion is effective, (2) transient errors keep the owner and are bounded, no guardrail violation, (3) no existing assertion weakened.

Findings (most severe first):
  [MEDIUM] The 10 s bound on the focus/visibility path is not pinned by any committed test
    Evidence: apps/web/test/fu-56-revalidation.spec.ts:143 calls auth.loadCurrent({ timeoutMs: 25 }) on the store directly and :150 only asserts IDENTITY_REVALIDATION_TIMEOUT_MS > 0. Scratch mutations (in a copy outside the worktree) both survive: apps/web/src/components/AppShell.vue:44 changed to auth.loadCurrent() with no timeout -> fu-56-revalidation + m4-owner-hard-reset 11/11 pass; apps/web/src/stores/auth.ts:27 changed to 86_400_000 -> 3/3 pass. The implementation itself is correct (AppShell.vue:44 passes the constant; a scratch MSW test with an infinitely delayed /me through the real PlannerClient ended in revalidationState 'failed', owner kept, in well under 2 s with timeoutMs 60).
    Suggestion (non-blocking; fold into the merge or a follow-up row): add an AppShell-level fake-timer test — focus with a never-settling getMe, advance IDENTITY_REVALIDATION_TIMEOUT_MS, expect the request signal aborted, revalidationState 'failed', owner kept, and a second focus issuing a new getMe; replace the > 0 assertion with the intended 10_000.
  [LOW] New banner has no layout rule and no visual review
    Evidence: AppShell.vue:161-174 uses class identity-revalidation-banner, which no stylesheet defines; the sibling .offline-banner gets width/max-width/margin-inline in apps/web/src/styles/shell.css:42-46, so the two banners will differ in width. UI was written by the non-UI implementer.
    Suggestion: share the offline-banner rule (or one class) and give it a quick visual check.
  [LOW] Failed-revalidation notice only clears on the next focus/visibility or the manual retry
    Evidence: AppShell.vue:40-56 — no `online` listener re-runs the check, and while offline it stacks under OfflineBanner as a second role=status/aria-live=polite region; the retry button is removed on click (v-if), dropping keyboard focus to body.
    Suggestion: retry once on `online`, or suppress the notice while offline.store.online is false.
  [LOW] E2E diagnosability and one immediate absence check
    Evidence: e2e/tests/e2e-5-owner-reset.spec.ts:229 and :273 waitForResponse have no timeout, so a broken reset fails as a generic "Test timeout of 60000ms exceeded" (seen in the mutation run); :255 toHaveCount(0) for A's title is evaluated right after the heading appears, before B's list is known to have rendered.
    Suggestion: pass { timeout: 20_000 } to both waiters; wait for tab 1's GET /tasks response before asserting absence.
  [LOW] Duplicate signal-combining helper
    Evidence: apps/web/src/stores/auth.ts:51-62 combinedSignal repeats anySignal in apps/web/src/api/client.ts:139-147, and the owner signal is already merged by ownerAbortMiddleware (client.ts:157-162).
    Suggestion: pass only the timeout signal, or export and reuse anySignal.

Contract / license / security / migration impact: none. Changed paths (AppShell.vue, i18n/messages/ko.ts, stores/auth.ts, apps/web/test/fu-56-revalidation.spec.ts, e2e/README.md, e2e/tests/e2e-5-owner-reset.spec.ts) are all inside ALLOWED PATHS; no API/contract/schema/migration/dependency change; no storage access or logging added; no secrets in tests or README. Guardrail: new store code keeps auth.ts's existing captureOwnerBinding/isOwnerBindingCurrent fence checked in the same turn after the await (auth.ts:119, :132) — loadCurrent itself adopts/changes the owner, so it cannot be a runOwnerBound task — and web lint (owner-isolation rules active on src/**) exits 0. README lock-fallback note matches apps/web/src/session/ownerLock.ts (channel only announces, nothing listens). Commit is Conventional with a Task trailer.

Missing tests: (1) AppShell focus/visibility -> timeout wiring and the 10 s value (see MEDIUM); (2) optional: the timeout through the real transport (the committed test mocks getMe).

Verification actually executed: yes
  git diff --name-only torgal/ohmydate...35ad177 -> 6 files, all in allowed paths; test-weakening grep on *.spec.ts/*.test.ts diff -> no matches (spec diff is additions only, 385+/4-, the 4 deletions are source lines)
  corepack pnpm --filter @ohmydate/web lint -> exit 0
  corepack pnpm --filter @ohmydate/web test -> exit 0 (502 passed + 156 passed, first try)
  DATABASE_URL=...planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run e2e e2e-5-owner-reset -> exit 0 (2 passed)
  same env, corepack pnpm run e2e -> exit 0 (31 passed, 7.2 min)
  corepack pnpm run ci -> exit 1 three times, none attributable to this branch: run 1 (no env) passed typecheck, lint, root tests, web tests, check:api-client, check:boundaries and stopped at build-smoke "DATABASE_URL is not set"; runs 2 and 3 (with DATABASE_URL/VIKUNJA_URL) failed in root vitest on timeouts only in services/api, packages/scheduler, packages/llm (16 tests / 9 files, then 1 test: packages/scheduler/test/generate.property.test.ts timed out at 240 s) while other workers held the machine at load 25-36 on 20 cores. Those 9 files re-run alone -> exit 0 (309 passed); generate.property.test.ts alone -> exit 0 (138 s). Remaining steps run individually with env: check:api-client exit 0, check:boundaries exit 0, node scripts/ci/build-smoke.mjs --required exit 0 (/healthz 200, SIGTERM exit 0).
  fu-56-revalidation.spec.ts repeated 5x -> exit 0 each.
  Mutation checks in a scratch copy outside the worktree (deleted afterwards):
    storage listener ignores a switch to another owner (ownerEpoch.ts:193) -> E2E-5 exit 1: existing reload test still passes, the NEW test fails at :229 (no automatic GET /me in tab 1) — the new assertion covers what the old one did not;
    transient failure wipes the owner (auth.ts:135 branch disabled) -> all 3 new unit tests fail;
    timeout abort never fires (auth.ts:71) -> timeout test fails;
    AppShell without timeoutMs, and constant = 24 h -> survive (MEDIUM above).
  Tab 1 in the new test has no page.reload/goto after its initial login (only expect/evaluate/request/waitForResponse); the /me it asserts is tab 1's own page request (pageA.waitForResponse), plus sid replacement, owner pointer, B namespace empty, A title absent.

git status --porcelain after review: empty (HEAD 35ad177; no repository file modified, created or committed)

Residual risks:
  - pnpm run ci did not exit 0 as one command on this machine under concurrent-worker load; evidence says load timeouts in untouched packages, but G3 should re-run it when the host is quieter.
  - The no-reload reset is proven for the storage-event path under Playwright's focus emulation; the focus-revalidation path (me-mismatch) is covered only by unit tests.
  - A regression that drops the timeout from AppShell would not be caught by tests (MEDIUM).
  - New banner copy/layout has not had a visual or screen-reader pass.