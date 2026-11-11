# REVIEW PACKET: M23-UIR2R — Independent review of M23-UIR2
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/m23-ui-integration. Base: torgal/ohmydate. Head: fcaa451.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/M23-UIR2.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...fcaa451; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
Finish with exactly one worker_done (orca orchestration send --type worker_done ... --outcome succeeded) whose body is the review in this format:
REVIEW VERDICT: APPROVE | REQUEST_CHANGES | BLOCKED
Findings (most severe first):
  [CRITICAL|HIGH|MEDIUM|LOW] <title>
    Evidence: <file>:<line> + reproduction or test output
    Required change | Suggestion
Contract / license / security / migration impact: <text or "none">
Missing tests: <list>
Verification actually executed: yes|no — exact commands + exit codes
git status --porcelain after review: <must be empty>
Residual risks: <list>
--- WORKER CLAIMS ---
ROUND 2 REVIEW of M23-UI (merge 0c36232 + fix fcaa451 on top of 377d821). Previous: git show torgal/ohmydate:docs/orchestration/reviews/M23-UIR-1.md. Merge candidate torgal/ohmydate...fcaa451. Worker report:
taskId task_6c7e08f8293e, dispatchId ctx_4c0c2ae36b53; worktree /home/torgal/orca/workspaces/oh_my_date/m23-ui-integration; branch torgal/m23-ui-integration; commits 0c36232 (merge torgal/ohmydate, no web changes) and fcaa451 (fixes/tests); changed paths vs torgal/ohmydate are apps/web/** (App.vue, api/errors.ts, components/WeekCalendar.vue, domain/time.ts, views/PlanningWizardView.vue, views/PlanComparisonView.vue, tests incl new test/regressions.spec.ts) and e2e/** (helpers/planner.ts, e2e-2/e2e-3 specs), all within allowed paths.
FINDING TABLE:
| Finding | Sev | Fix | Test |
| session switch leaks A draft into B/new | HIGH | RouterView :key by route session id (App.vue) so the wizard remounts; same-session versions keep key | regressions.spec: real-router A->B->/plan/new, asserts B title, empty new form, zero PATCH |
| constraint_violation dropped | MED | errors.ts now uses exhaustive Record<ProblemCode,true> from generated schema (drift = typecheck failure); violations/errors preserved | problem.spec real payload; plan-comparison real 422 via PlannerClient renders H1/detail and /editedBlocks/0 block highlight |
| DST gap moved backward | MED | zonedWallClockToInstant enumerates candidate offsets, min for overlap, pre-transition offset for gap | NY 2026-03-08 02:30 -> 07:30Z; 2026-11-01 01:30 -> 05:30Z |
| repeated-hour block collapsed | MED | WeekCalendar duration from end-start instants; labels/aria-labels append offset suffix (GMT-4→GMT-5) for blocks and commitments | week-calendar crossing 05:30Z-06:30Z: top 90px/height 60px, offsets asserted |
| offline delayed mutations | MED | wizard rechecks offline before each Retry-After attempt, leaves action unsettled (same key reused) and skips after dispose; plan preview rechecks offline, cancels debounce on offline/unmount | wizard delayed-retry offline then reconnect same key; plan preview cancelled on offline and on unmount |
| missing E2E coverage | MED | E2E-2 keyboard now step1->questions->draft edit->approval; E2E-3 now approves a valid edited block (editedBlocks) and verifies persistence | e2e suites below |
TESTS: pnpm --filter @ohmydate/web test -> exit 0 (20 files, 112 passed); pnpm --filter @ohmydate/web build -> exit 0 (234 modules); DATABASE_URL/VIKUNJA_URL pnpm run ci -> exit 0 after one unrelated flake retry (first run hit packages/llm privacy perf threshold 53<50; isolated llm suite and full ci rerun passed: 1376 passed/29 skipped + 112 web, schema drift ok, boundaries 301/0, smoke /healthz 200); same env pnpm run e2e -> exit 0 (8 passed, 1.3m; E2E-2 keyboard completion and E2E-3 valid edited approval both green).
RISKS/NOTES: E2E-3 proves the edited block persisted via the 201 PlanVersion body plus GET /plans/{id} currentVersionId/version (the API has no endpoint returning approved version blocks, so GET plan cannot literally list them); the CI privacy perf test is pre-existing timing-sensitive and outside allowed paths; no new contracts needed, no migrations/deps; rollback is deleting branch torgal/m23-ui-integration or reverting fcaa451 (no pushes/rebases of shared branches).
Coordinator notes: the missing approved-blocks read endpoint is tracked as FU-51 (not this task); the legacy llm perf flake as FU-50.
Narrow focus (medium effort): re-run your 5 round-1 reproductions (session switch A->B save; real 422 constraint_violation parse/render; NY gap 02:30; repeated-hour block geometry; offline during Retry-After and preview debounce) on this head, run pnpm run e2e once, and spot-check the RouterView :key does not remount on same-session version changes (no lost edits during 412 conflict flows).
Round 2 of 2: HIGH only for data corruption, security, or E2E not testing the real flow; else APPROVE with follow-ups.

