# REVIEW PACKET: FU-14R — Independent review of FU-14
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-14-vikunja-feed. Base: torgal/ohmydate. Head: 379a7f5.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-14.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...379a7f5; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
taskId=task_d4d87c6736db dispatchId=ctx_29e3d5487aba worktree=/home/torgal/orca/workspaces/oh_my_date/fu-14-vikunja-feed branch=torgal/fu-14-vikunja-feed commit=379a7f55fd3eda8dc519de5de2860fb5cbcdfcfe (base merge-base with torgal/ohmydate = 2964971).
WHAT CHANGED (10 files, all Under packages/provider-vikunja/**, +1016/-69): (1) ChangeCursor carries remoteSeconds (encoded r); listChangedSince now uses it for the updated >= query and #reconcileRemote returns max(updated)-1s from the scan, never journal entry times. (2) ChangeJournalStore gains hasSnapshot/appendSnapshotOnce; every owner operation calls #ensureSnapshot so a fresh epoch snapshots all mapped live/deleted tasks at current localVersion exactly once, even under concurrent null polls. (3) ExternalMapping gains contentFingerprint (title, marker-free description, done, dueAt, project, mapped dependency relation ids); update/complete/softDelete and #commitReconciled/#reconcileRemote treat a mismatch as changed even with an equal ETag, and store the fingerprint after every commit. (4) #commitReconciled adopts the first observed ETag/updatedAt without a bump when the baseline is unknown, applies normal-path planner status (done/todo) on reconciled completions, and journals completedOccurrenceAt = pendingCompletion.dueAtBefore ?? completion time; the normal complete path now also journals dueAtBefore ?? now. Semantics documented in adapter JSDoc.
REQUIREMENTS: FU-14 met (external edit after the scan delivered once; planner clock +60s no longer skips a later external edit). FU-15 met (rebuild + update(B) then null resync includes A latest v2; concurrent null polls head=2 not 4). FU-16 met (same-second lost-response update reconciled via fingerprint; live test wraps real fetch, applies PATCH then AbortError, confirms equal ETag, asserts v+1/title/feed). FU-17 met (create follow-up keeps v1 and adopts first ETag; lost-response recurring completion ends status todo from in_progress; completedOccurrenceAt equals the due occurrence, live and unit; concurrent null snapshot once).
TESTS (real runs): 
 RUN  v5.1.0 /home/torgal/orca/workspaces/oh_my_date/fu-14-vikunja-feed/packages/provider-vikunja


 Test Files  10 passed (10)
      Tests  54 passed | 1 skipped (55)
   Start at  04:01:16
   Duration  261ms (tests 35%, import 33%, transform 22%, worker 9%) -> exit 0, 10 files, 54 passed / 1 skipped. 
 RUN  v5.1.0 /home/torgal/orca/workspaces/oh_my_date/fu-14-vikunja-feed/packages/provider-vikunja


 Test Files  10 passed (10)
      Tests  76 passed | 9 skipped (85)
   Start at  04:01:16
   Duration  6.18s (tests 93%, import 4%, transform 2%, worker 1%) -> exit 0, 10 files, 76 passed / 9 skipped (strictConcurrency/idempotentCreate capability gates). Scope: 10 of 11 workspace projects
apps/web typecheck$ vue-tsc --noEmit -p tsconfig.json
packages/domain typecheck$ tsc --noEmit -p tsconfig.json
packages/llm typecheck$ tsc --noEmit -p tsconfig.json
packages/scheduler typecheck$ tsc --noEmit -p tsconfig.json
packages/llm typecheck: Done
packages/ui-policy typecheck$ tsc --noEmit -p tsconfig.json
packages/domain typecheck: Done
services/api typecheck$ tsc --noEmit -p tsconfig.json
packages/ui-policy typecheck: Done
packages/contracts typecheck$ tsc --noEmit -p tsconfig.json
packages/scheduler typecheck: Done
packages/testkit typecheck$ tsc --noEmit -p tsconfig.json
services/api typecheck: Done
packages/testkit typecheck: Done
packages/provider-native typecheck$ tsc --noEmit -p tsconfig.json
packages/provider-vikunja typecheck$ tsc --noEmit -p tsconfig.json
packages/contracts typecheck: Done
apps/web typecheck: Done
packages/provider-native typecheck: Done
packages/provider-vikunja typecheck: Done

 RUN  v5.1.0 /home/torgal/orca/workspaces/oh_my_date/fu-14-vikunja-feed


 Test Files  41 passed | 4 skipped (45)
      Tests  246 passed | 41 skipped (287)
   Start at  04:01:28
   Duration  3.86s (tests 51%, import 23%, transform 22%, worker 4%)


 RUN  v5.1.0 /home/torgal/orca/workspaces/oh_my_date/fu-14-vikunja-feed/apps/web


 Test Files  10 passed (10)
      Tests  45 passed (45)
   Start at  04:01:32
   Duration  5.13s (tests 48%, environment 40%, setup 6%, import 4%, transform 1%, worker 1%)

Wrote /home/torgal/orca/workspaces/oh_my_date/fu-14-vikunja-feed/apps/web/src/api/schema.d.ts
Boundary check passed: 137 file(s), 0 violations. -> exit 0; typecheck+lint clean; root 246 passed/41 skipped; web 45 passed; api-client diff clean; boundaries 137 files, 0 violations. Note: the first ci attempt failed at apps/web typecheck because workspace deps were not installed (vue-tsc not found); Scope: all 11 workspace projects
✓ Lockfile passes supply-chain policies (verified 25m ago)
Lockfile is up to date, resolution step is skipped
Done in 28ms using pnpm v12.18.0 installed them and the rerun passed; pnpm-lock.yaml unchanged.
NEW CONTRACTS FOR DEPENDENTS: durable MappingStore needs a contentFingerprint field/column; ChangeCursor gains the opaque r field (old cursors decode r=0 and safely over-scan); durable ChangeJournalStore must implement hasSnapshot/appendSnapshotOnce atomically per owner+epoch.
RISKS/UNVERIFIED: watermark uses max updated seen (safe under server-monotonic updated timestamps; an empty scan keeps the old watermark and causes extra scans, not misses); fingerprint covers the mapped 'blocked' relation kind only, other relation kinds rely on ETag; legacy mappings without a fingerprint are adopted without a bump on first reconcile; durable Postgres stores and API wiring are not implemented here; live same-second test loops up to 8 second boundaries (passed first attempt). Rollback: delete branch torgal/fu-14-vikunja-feed (no migrations/contracts/upstream changes).

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. Live Vikunja http://127.0.0.1:3456 synthetic only.
Verify FU-14..17 (`git show torgal/ohmydate:docs/orchestration/FOLLOW-UPS.md`) using the exact probes in `git show torgal/ohmydate:docs/orchestration/reviews/M1-05R-3.md` (external edit during poll, planner clock ahead, rebuild+update then null resync, same-second lost-response live). Convergence: APPROVE unless HIGH/CRITICAL.
