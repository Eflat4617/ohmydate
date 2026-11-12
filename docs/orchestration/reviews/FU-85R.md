# FU-85R (ctx_3cc490a88b3b, Fable 5.2 xhigh — Sol weekly limit; implementer Opus) — APPROVE

REVIEW VERDICT: APPROVE
Reviewed: torgal/ohmydate...347d86f (merge-base d3ed838, branch torgal/fu-85-revalidation-hardening), reviewer Fable 5.2 xhigh, round 1 of 2. No CRITICAL/HIGH/MEDIUM. All 5 REQUIRED items of FU-85 are met and every HIGH trigger was checked and is clear: no owner wipe on a transient failure, no request loop, no guardrail violation, the new tests bite, no assertion weakened. Two LOW suggestions, both non-blocking.

Findings (most severe first):
  [LOW] The failure notice appears during the automatic re-check after reconnect, although the user never saw a failure
    Evidence: apps/web/src/components/AppShell.vue:82-92 — revalidationFailed stays true through 'pending' and revalidationNoticeShown = revalidationFailed && offline.online. A check that failed while offline is hidden; on `online` the store flips to online and the re-check starts, so the notice mounts as a new role=status/aria-live=polite region with the failure copy and a busy button, then unmounts when the check succeeds. Reproduced twice: (a) scratch unit probe (offline -> focus fails -> `online` with a held getMe): notice exists = true with text "로그인 상태를 다시 확인하지 못했어요. …", false after the answer; (b) real Chromium on the mock dev server with /me delayed 1.5 s, at 1440 and 390 px: notice visible with aria-busy=true while auth.revalidationState is 'pending', gone after, content shifts by the banner height. The committed test apps/web/test/fu-56-revalidation.spec.ts:269-285 does not look at the notice during that window. REQUIRED 3 itself is met (nothing is stacked under OfflineBanner; exactly one polite region at every step).
    Suggestion: do not reveal a notice that was never visible until the reconnect check settles (show it during 'pending' only if it was already on screen), and assert that in the offline test.
  [LOW] No test pins listener teardown on unmount
    Evidence: scratch mutation deleting AppShell.vue:193 (removeEventListener('online', onBackOnline)) -> fu-56-revalidation.spec.ts 9/9 pass, exit 0. The code is correct: AppShell.vue:191-195 removes keydown, focus, online and visibilitychange, and a scratch probe on the real code (unmount during a pending check, then focus + online + visibilitychange) sent 0 further getMe.
    Suggestion: one test — unmount, dispatch the three events, expect no getMe.

Focus answers:
  (1) Bound pinned: yes. Mutations in a copy outside the worktree, spec fu-56-revalidation.spec.ts (baseline 9/9, exit 0): AppShell without timeoutMs -> exit 1 (new test, "expected false to be true" at the abort check); constant 86_400_000 -> exit 1 (2 tests); 5_000 -> exit 1 (2 tests); also 10_001 and 9_999 -> exit 1 each, so the value is exact; timeout signal dropped from boundedSignal -> exit 1; transient failure wipes the owner (auth.ts:122 branch disabled) -> exit 1, 8 of 9 tests. The test asserts confirmed, user, ownerId and the protected body after the abort, then a second getMe with a different, un-aborted signal.
  (2) Join: AppShell.vue:46-56 returns the in-flight promise. No join -> exit 1 (getMe 6 instead of 2); in-flight slot never cleared -> exit 1; no confirmed guard -> exit 1 (the anonymous `online` test). Scratch probe: 5 rounds of visibilitychange + online + focus + retry click during one pending check -> still 1 request, none 80 ms after it failed. A 401 on the re-check signs the tab out and later online/focus send nothing. Real browser: exactly 1 GET /me per `online` and 1 per retry.
  (3) Owner safety: the diff adds no storage, query-cache, toast or router code; web lint (owner-isolation rules on src/**/*.ts and .vue script blocks, apps/web/eslint.config.js) exit 0. auth.ts changes only the signal combiner (:62); the binding fence at :106/:119 is untouched. Probes: a re-check answering with another owner calls the reload hook once with 'me-mismatch' (hard reset, not a silent adoption); an owner switch during a pending check aborts it, a late answer cannot adopt the old owner, and focus/online send nothing while unconfirmed. The focus handoff (:96-103) only calls focus() on <main>; when the shell unmounts the ref is null and it does nothing.
  (4) A11y: offline -> 0 notices, 1 polite region (unit test and browser). Retry button is the same element, aria-busy=true, not disabled, keeps focus; `disabled` while busy -> exit 1; no handoff -> exit 1 (focus on body); unconditional handoff -> exit 1. Browser: focus stays on the button while busy and lands on #main-content on success. Layout: one rule for .offline-banner and .identity-revalidation-banner (shell.css:43-48, var(--content-wide)); measured both banners at x=296 w=1096 at 1440 px and x=16 w=358 at 390 px, equal to <main>; one row at desktop, button under the text at 390 px. The worker's numbers are confirmed.
  (5) E2E-5: no assertion removed; the diff only adds lines to the three waiters and two awaits before the existing toHaveCount(0) (:271-273). The /tasks waiter is pageA-scoped and gated on sawAutomaticMe, set only by tab 1's first GET /me 200 after registration (:231-250), whose body is then asserted to be B and not A. That /me is sent after the app's own reload, so the /tasks behind it is B's session. .task-list (TaskList.vue:234) is rendered only after the inbox query has settled, including when the list is empty, so the absence check runs against B's rendered list.
  REQUIRED 5: anySignal (client.ts:144) is the same AbortSignal.any path as the removed combinedSignal; in the fallback the first aborted signal's reason still wins. Probe through the real PlannerClient with a hanging fetch: aborted in 63 ms at timeoutMs 60, reason TimeoutError, state 'failed', owner kept.

Contract / license / security / migration impact: none. 8 changed files, all inside ALLOWED PATHS (apps/web/**, e2e/tests/e2e-5-owner-reset.spec.ts, e2e/README.md). No API, schema, migration or dependency change; anySignal is newly exported inside the web api module only. No new copy, no v-html, no storage access, no logging. Commit is Conventional with a Task trailer. Rollback: revert 347d86f.

Missing tests: (1) listener teardown on unmount (LOW above); (2) notice state while the reconnect check is pending (LOW above). Neither blocks.

Verification actually executed: yes
  git diff --name-only torgal/ohmydate...347d86f -> 8 files, all allowed
  test-weakening grep on the *.spec.ts diff -> 2 hits, both harmless: the removed toBeGreaterThan(0) is replaced by toBe(10_000) as the packet requires; ".skip-link" is a CSS class
  corepack pnpm run typecheck -> exit 0 (includes tsc -p e2e)
  corepack pnpm run lint -> exit 0
  corepack pnpm run check:api-client -> exit 0
  corepack pnpm run check:boundaries -> exit 0 (527 files, 0 violations)
  corepack pnpm --filter @ohmydate/web lint -> exit 0
  corepack pnpm --filter @ohmydate/web test -> exit 0 (54 files / 508 passed, then 6 files / 156 passed; first run)
  DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run e2e e2e-5-owner-reset -> exit 0 (2 passed, 13.3 s; first run)
  NOT run, per the HOST LOAD RULE: full `pnpm run ci`, full `pnpm run e2e`.
  Scratch copy outside the worktree (deleted afterwards): 17 mutations on fu-56-revalidation.spec.ts — 16 exit 1, 1 survives (teardown, LOW above); 7 probe tests, exit 0.
  Mock dev server (VITE_MOCK=1, port 5199, stopped afterwards) + Playwright Chromium at 1440 and 390 px: layout, offline, reconnect and keyboard retry as reported above. Screenshots are in the session scratchpad only.
  Not re-run: the worker's E2E mutation (storage listener ignoring an owner switch failing at the 20 s waits); it needs an edited copy of the whole stack.

git status --porcelain after review: empty (HEAD 347d86f; no repository file modified, created or committed)

Residual risks:
  - Full ci and full e2e on the merge result are still the coordinator's to run.
  - An `online` that arrives while an older check is still in flight joins it; if that older request then fails, nothing re-checks until the next focus, visibility change or the retry button. This is the packet's required no-loop behaviour.
  - A second failed retry is not re-announced, because the notice text does not change (worker's own note; confirmed).
  - The three 20 s waiters are created before the action they wait on; under heavy host load a slow login could trip them earlier than the 60 s test timeout would have.
  - Tests unmount the shell only on their last line, so a failing assertion leaves a mounted shell with window listeners for the tests that follow in the file.
