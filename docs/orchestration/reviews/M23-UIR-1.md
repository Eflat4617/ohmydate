# M23-UIR-1 (ctx_ec5035444985, sol gpt-6.1-sol medium) — REQUEST_CHANGES

REVIEW VERDICT: REQUEST_CHANGES
Findings (most severe first):
  [HIGH] Switching wizard sessions can overwrite the destination session's draft
    Evidence: apps/web/src/views/PlanningWizardView.vue:148-153 initializes draft only when null; persistDraft at :437-457 sends that retained draft to the CURRENT session ID/version. The router reuses PlanningWizardView without a route key (apps/web/src/router.ts:25-26; apps/web/src/App.vue:13). An in-memory execution of the actual script with Vue reactivity switched session-A to session-B: "Initial draft: A-0", "After switching to B, displayed draft: A-0 ; B server draft: B-0", then saveDraft produced 'Actual PATCH: [{"id":"session-B","title":"A-0"}]'. Navigation through Plan/new or between session URLs can therefore replace B's correct draft and approve A's tasks under B.
    Required change: isolate local wizard state by session ID or remount on ID change; reset draft/form/error/answer/action state for a different session while preserving same-session conflict edits. Add a real RouterView session-switch regression test asserting B never receives A's steps.

  [MEDIUM] constraint_violation responses lose their violations and human details
    Evidence: apps/web/src/api/errors.ts:6-23 omits constraint_violation, so :58 rejects this valid Problem code. Executing apiErrorFromPayload(422, {title:"Constraint violation",status:422,code:"constraint_violation",detail:"Edited blocks overlap",violations:[{code:"H1",message:"Blocks overlap"}]}) returned {"code":"unknown","detail":"Request failed with status 422"} with no problem. Consequently PlanComparisonView.vue:315-318 cannot render the required approval violations.
    Required change: recognize the current contract's complete Problem code enum and retain violations. Test a real 422 problem payload through PlannerClient and the approval UI, rather than injecting an already constructed ApiError.

  [MEDIUM] DST gap conversion moves commitments backward instead of to the next valid time
    Evidence: apps/web/src/domain/time.ts:135-140 blindly applies the second offset. Direct execution of zonedWallClockToInstant("2026-03-08",150,"America/New_York") returned 2026-03-08T06:30:00.000Z, which localInputValue rendered as 2026-03-08T01:30. The user entered nonexistent 02:30; blueprint 08 §3 requires the next valid time. CommitmentsView.vue uses this conversion for persisted start/end values.
    Required change: implement the documented gap/overlap disambiguation using the established time utility semantics and test spring gaps as well as fall overlaps.

  [MEDIUM] Calendar collapses a block crossing the repeated DST hour to five minutes
    Evidence: apps/web/src/components/WeekCalendar.vue:151-162 subtracts local end minutes from local start minutes whenever both dates match. In America/New_York on 2026-11-01, 05:30Z -> 06:30Z is a real 60-minute block whose endpoints both render 01:30; the code computes duration=0 and height=5px. Both task blocks and commitment bands use positionFor. The existing week-calendar.spec.ts tests blocks before/after the transition, never a crossing block.
    Required change: represent repeated-hour intervals and their duration coherently, including unambiguous labels; add crossing-transition block/commitment tests.

  [MEDIUM] Delayed approval retries send mutations after offline mode starts
    Evidence: apps/web/src/views/PlanningWizardView.vue:489-509 retries inside one run() call; run() checks offline only once at :228. An in-memory execution of the actual script made the first approval return approval_in_progress and switched the offline store before Retry-After: "Approval attempts after going offline during Retry-After: [{\"offline\":false},{\"offline\":true}]". PlanComparisonView.vue:186-217 similarly lets a queued preview POST fire offline; executing its actual script after edit -> offline produced 'POST preview after going offline: [{"offline":true}]'.
    Required change: recheck online/mutation eligibility immediately before each delayed request and cancel/defer pending work on offline/unmount; preserve the action key for an intentional retry after reconnection. Cover offline transitions during Retry-After and preview debounce.

Contract / license / security / migration impact: Current 422 constraint_violation handling and documented DST/offline behavior are not met; cross-session wizard state can corrupt another intake draft. All 36 changed paths are within apps/web/** and e2e/**, satisfying M23-UI allowed paths; no dependency/license changes, migrations, domain I/O changes, upstream imports/copies, v-html, new localStorage token storage, or sensitive logging were found. If-Match plan/availability headers and discriminated answer payloads are wired correctly; approval_in_progress retries are bounded to six total attempts and reuse the same key. Existing tests were not deleted, skipped, or weakened by this diff.

Missing tests: session-A -> session-B/new-session draft isolation; actual 422 constraint_violation parsing/rendering; spring gap and crossing fall-back interval rendering; offline transition during delayed mutations; network-error approval retries through the UI retaining keys; approve /editedBlocks/<i> highlighting. E2E-2's keyboard test stops after the first step (e2e/tests/e2e-2-wizard.spec.ts:100-125), so full keyboard-only question -> draft edit -> approval completion is still unverified. E2E-3 resets the edited block before approving, so it does not verify successful persistence of a valid editedBlocks approval.

Verification actually executed: yes —
  corepack pnpm --filter @ohmydate/web gen:api -> exit 0; generated schema has no git diff.
  corepack pnpm --filter @ohmydate/web test -> exit 0; 19 files, 102 tests passed.
  corepack pnpm --filter @ohmydate/web build -> exit 0; Vite built 234 modules.
  DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci -> exit 0; typecheck/lint passed, 1245 root tests passed and 27 preexisting skips, 102 web tests passed, schema drift check passed, boundaries 297 files/0 violations, build smoke /healthz 200 and SIGTERM exit 0.
  DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run e2e -> exit 0; all 8 E2E-1/2/3 tests passed (1.3m), including the configured zero-critical/serious axe assertions.
  git diff --check torgal/ohmydate...377d821 -> exit 0.
  node --experimental-strip-types --input-type=module with inline read-only source-execution harnesses -> exit 0 for error/DST, session-switch/save, queued-preview/offline, and approval-retry/offline reproductions. One initial preview harness exited 1 because the harness injected a conflicting weekDates binding; the corrected harness exited 0.
  Inspected git diff torgal/ohmydate...377d821 and applied WORKER-AND-REVIEW-CONTRACT §4.
git status --porcelain after review: empty
Residual risks: E2E-3 independently seeds a valid approved draft through public intake PATCH/approve APIs and sets public availability preferences; it does not write DB tables or inject scheduler candidates. Independent dependencies/longer breakAfterMin are supported product settings, and the subsequent 3-candidate/edit/201/second-context-commitment/412/regenerate/201 flow hit the real API, so no fixture-bypass blocker was found. Full keyboard completion, valid edited-block approval persistence, and concurrency edge cases above remain unverified by the passing suite. No files were changed or committed; fixes and round-2 review remain.
