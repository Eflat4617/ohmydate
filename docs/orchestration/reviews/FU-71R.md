# FU-71R (ctx_f44cd1adc1f5, Fable 5.2 xhigh — Sol weekly limit; implementer Opus) — APPROVE

REVIEW VERDICT: APPROVE
(FU-71 at 8c845ff, merge candidate torgal/ohmydate...8c845ff, merge-base 88feb4f. Reviewer: Fable 5.2 xhigh. No CRITICAL/HIGH/MEDIUM; four LOW suggestions, none blocking.)

Findings (most severe first):
  [LOW] Plan page: an edit started while a lock request is still out is discarded without notice
    Evidence: apps/web/src/views/PlanComparisonView.vue:195 (lockDisabled only stops new presses while the draft is dirty), :206-210 (watch on plan.version calls resetDraft()), :328-332 (onBlocksUpdated has no lock-pending guard), apps/web/src/composables/useBlockLock.ts:80 (the task re-reads the plan when the request returns). Press the toggle with a clean draft, drag a candidate block before the response arrives: the re-read moves plan.version and the edit is reset. Found by reading the code; not reproduced in a test.
    Suggestion: keep a dirty draft on a version change that came from a lock, or block calendar edits while a lock is pending; add a test.
  [LOW] The toggle can stay visible for up to 30 s after a block started
    Evidence: apps/web/src/composables/useBlockLock.ts:22-24 (isBlockLockable compares with the shared layout clock), apps/web/src/layout/now.ts:11 (LAYOUT_TICK_MS = 30_000), TodayView.vue:647, PlanComparisonView.vue:640. The server answers 409 and the screen explains and re-reads (useBlockLock.ts:88-90), but the clock is not refreshed, so the same toggle can still be shown until the next tick.
    Suggestion: call refreshLayoutNow() in the 409 branch.
  [LOW] Toggle name switches with aria-pressed and does not say which block
    Evidence: apps/web/src/components/BlockLockToggle.vue:43,49. As the packet specified. Every row's button has the same name, so a screen-reader user tabbing through the list cannot tell the blocks apart.
    Suggestion: one constant name with aria-pressed, plus the task title and time through aria-label or aria-describedby.
  [LOW] Reported behaviour without a repository test
    Evidence: services/api/src/adapters/pg-planning-store.ts:690 (block of a deleted plan -> 404) and :696 (block of a non-active plan -> 409) have no case in services/api/test/block-lock.test.ts; no test runs :lock/:unlock concurrently with an approval; apps/web/src/composables/useBlockLock.ts:88-93 (the 409 branch and the generic failure branch) have no web test. My scratch probes for the API paths passed (see Verification).
    Suggestion: add these cases (list under Missing tests).

Focus results:
  (1) API: one transaction; lock order plan row -> block row, and every approval TX (pg-planning-store approve, pg-replan-store approve, pg-today-store approveProposal) takes availability -> [proposal] -> plan row -> block rows, so they serialise on the plan row and no cycle exists (work-session completion only touches its session row and the block). Owner scope is in all three queries; foreign / unknown / deleted plan are 404. 412 on version mismatch; 409 for non-planned, started, or non-active plan; startAt == now is still lockable, consistent with the approvals' start_at >= now. Replay returns the stored response; the request hash includes the concrete path, so a key reused on another block or on :unlock is 422. Times never change (only locked, version, updated_at are set). plan.version +1, plan.updated_at untouched: its only readers are getActivePlan's ordering (pg-planning-store.ts:644) and the export's updatedAt field. Audit holds planId, locked, version only.
  (2) Replan interplay: the approval TX re-reads blocks after taking the plan row and re-validates; a lock taken after the proposal gives 422 and the block stays; an unlock taken after it gives 422 and the block is not dropped; Today proposals and Today actions pinned to the old revision give 412. Confirmed by the branch tests and by my race probe in both orders.
  (3) Web: optimistic state, request, toast and refresh are all inside one runOwnerBound task with owner.signal; nothing follows the awaited runOwnerBound; refresh is the same vue-query refetch pattern PlanComparisonView already uses. Lint rule owner-isolation/bound-task covers src/composables. Two sweep cases added and passing. 412 and 409 re-read. Native button, aria-pressed, keyboard in E2E. Plan-page toggle is disabled while the draft is dirty.
  (4) E2E-5R: lockScheduleBlock is gone from e2e/helpers/db.ts and has no other reference; the spec's only removed lines are the import, the helper call and two comment lines; the lock goes through the plan page with Enter and asserts 200, If-Match W/"<block.version>" and a UUIDv7 key; assertions were only added.
  Paths: all 29 changed files are inside the packet's allowed paths; no file deleted; no removed expect/it/test line, no skip/only (the new API file uses the existing describe.skipIf(!hasDatabase) pattern and its 10 tests ran). Commit is Conventional Commits with "Task: task_6081c7d89b41".

Contract / license / security / migration impact: Additive contract only: POST /schedule-blocks/{id}:lock and :unlock plus ScheduleBlockIdParams; regenerating openapi.json and the web schema.d.ts gives no diff. No new dependency, no migration (schedule_block.locked existed). Security: session cookie + CSRF from the generic pre-handler, owner_id in every query, UUID path validation, no new logging, audit without user text. Behaviour change for clients: a lock or unlock moves Plan.version / Today.version (documented in 08 §2.5.1) while Plan.updatedAt stays.

Missing tests:
  - API: block of a soft-deleted plan -> 404; block of a non-active plan -> 409.
  - API: :lock / :unlock racing a replan approval (both orders), and two concurrent locks on one plan.
  - Web: useBlockLock 409 illegal_transition branch (message + re-read); a network failure followed by a retry reusing the same Idempotency-Key; toggle disabled offline; the plan-page draft case in the first finding.

Verification actually executed: yes — from the worktree root at 8c845ff, DB commands with DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456
  - git diff torgal/ohmydate...8c845ff (read in full except the generated openapi.json / schema.d.ts)
  - corepack pnpm run typecheck -> exit 0
  - corepack pnpm run lint -> exit 0
  - corepack pnpm run check:api-client -> exit 0
  - corepack pnpm run check:boundaries -> exit 0 (528 files, 0 violations)
  - corepack pnpm --filter @ohmydate/api test -> exit 0 (81 files; 560 passed, 9 skipped)
  - services/api: corepack pnpm exec vitest run --globals test/block-lock.test.ts --reporter verbose -> exit 0 (10/10 passed, none skipped)
  - corepack pnpm --filter @ohmydate/web lint -> exit 0
  - corepack pnpm --filter @ohmydate/web test -> exit 0 (54 files / 508 tests, then sweep 6 files / 164 tests)
  - corepack pnpm exec vitest run packages/contracts -> exit 0 (16 files / 97 tests); packages/contracts pnpm run generate -> exit 0, no diff
  - corepack pnpm run e2e e2e-5r -> exit 0 (1 passed, 5.3 m)
  - Reviewer scratch probes, files outside the worktree, run with services/api vitest --dir <scratch>: race probe -> exit 0 (4/4). 12 staggered rounds of lock vs replan approval gave 200/422 x4 and 412/201 x8; 12 rounds of unlock vs approval gave 200/422 x4 and 200/201 x8; no 5xx or deadlock, the task always kept exactly 60 minutes, a block whose lock returned 200 was never moved. Two blocks of one plan locked at once: both 200, plan.version +2, updated_at unchanged. Same block twice at once: 200 + 412, one audit row. Paths probe -> exit 0 (3/3): deleted plan 404, non-active plan 409, no cookie 401, malformed id 400.
  - NOT run, per the HOST LOAD RULE: full pnpm run ci and full pnpm run e2e. The worker's report of load timeouts in the full ci run is therefore unverified by me.

git status --porcelain after review: empty (HEAD 8c845ff; only ignored generated directories: node_modules, services/api/dist, playwright-report, test-results)

Residual risks:
  - The full ci and full e2e suites on the merge result are the coordinator's run; I have no evidence for them.
  - The started-block check uses a clock value read before the transaction (services/api/src/application/plan-service.ts:493). A request that waits on the plan row while the block's start passes can still change the lock; the window is the lock wait, and the approval transactions read their clock the same way.
  - A replan proposal made before a lock or unlock stays pending and shows its old diff; approving it answers 422 and the user has to ask for a new one (documented in 08 §2.5.1).
  - The plan page's approved schedule lists the week's blocks of every plan (GET /schedule-blocks is not filtered by plan; existing behaviour), so a toggle there can change another plan's block. The server handles each block by its own plan.
  - My race probe covers two interleavings over 12 rounds each on a loaded host; it is evidence, not proof, and is not in the repository.
  - Not checked by me: a visual review of the toggle in a browser, and an axe scan of the plan page and Today with the toggle present.
