# REVIEW PACKET: FU-71RR — Independent review of FU-71R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-71-block-lock. Base: torgal/ohmydate. Head: 8c845ff.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-71R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...8c845ff; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-71 (schedule block lock/unlock API + web toggle; E2E-5R locks through the UI; implementer Opus 5.5 xhigh). Reviewer: Fable 5.2 xhigh in place of Sol (weekly limit; MODEL_BINDINGS §12). You are the REVIEWER: read-only — do not edit/create/commit repository files (scratch only outside the worktree); finish with the REVIEW VERDICT format. Do not read *api_key* files or call the LLM gateway. Branch torgal/fu-71-block-lock commit 8c845ff. Merge candidate torgal/ohmydate...8c845ff (merge-base 88feb4f). Read docs/orchestration/packets/FU-71.md (git show torgal/ohmydate:...), docs/blueprint/08 §2.5.1 on the branch, ADR-023 (+FU-77 amendment) in docs/blueprint/13-ADR.md, and apps/web/src/session/ownerStorage.ts / runOwnerBound for the guardrail.
HOST LOAD RULE (overrides the MUST line for these two commands only): do NOT run the full `pnpm run ci` or the full `pnpm run e2e` — another reviewer and the coordinator's integration run share this 14 GB host, and the coordinator runs both full suites on the merge result before accepting. Run instead: `pnpm run typecheck`, `pnpm run lint`, `pnpm run check:api-client`, `pnpm run check:boundaries` plus the package/targeted commands in Focus. A single timeout under load: rerun that file alone before judging it.
Worker report (Orca rejected its worker_done after a restart — worker_identity_changed — so the coordinator relays it here verbatim):
What I did: added POST /schedule-blocks/{id}:lock and :unlock, plus a web lock toggle on Today and the plan page, and switched E2E-5R to lock through the UI; one commit 8c845ff on torgal/fu-71-block-lock (worktree /home/torgal/orca/workspaces/oh_my_date/fu-71-block-lock, base 88feb4f, task_6081c7d89b41 / ctx_b6027c385bf0). What I found: every command in the packet passed except the full pnpm run ci, which failed on load timeouts (load average 23-40 on 20 cores) in files this change does not touch; each passed when rerun alone, and the CI steps the failure skipped passed when run separately. What is left: nothing for FU-71; a reviewer may question the toggle label, which changes between the two names as the packet specifies (details below), and rollback is deleting the branch.

DIFF (29 files)
- contracts: ScheduleBlockIdParams and the two routes (If-Match = block version + Idempotency-Key; responses 200 / 400 / 401 / 403 / 404 / 409 / 412 / 422 / 428). openapi.json and the web schema.d.ts are regenerated, and the routes.test matrix has the new entries.
- api: PgPlanningStore.setBlockLock does everything in one transaction.
  - It locks the plan row, then the block row, the same order the approval transactions use.
  - A foreign block, an unknown block or a block of a deleted plan is 404. A version mismatch is 412.
  - Only a planned block of an active plan with startAt >= now can change; started, done, skipped, moved or superseded blocks are 409 illegal_transition.
  - Block times never change. A change bumps the block version and plan.version (= Today.version) but not plan.updated_at, because getActivePlan orders by it.
  - It writes an audit_event with ids only. Asking for the state the block already has returns 200 and changes nothing.
  - PlanService and the route handler call it, wrapped in runIdempotent.
- web:
  - BlockLockToggle: a native button named "블록 고정" / "고정 해제" with aria-pressed; read-only mode shows a 고정됨 badge.
  - useBlockLock: the optimistic state, request, toast and refresh all run inside one runOwnerBound task; 412 or 409 re-reads; one ActionStore key per toggle.
  - Today cards: toggle plus disabled shrink/reschedule on locked blocks. Plan page approved schedule: toggle, disabled while a candidate draft has unsaved edits (a re-read would reset the draft). Replan proposal view: read-only badge.
  - Copy is in the ko catalog; the MSW mock handles lock/unlock; two sweep cases were added.
- e2e: lockScheduleBlock (the DB UPDATE) is removed. E2E-5R locks through the plan page's approved schedule with the keyboard, asserts If-Match and a UUIDv7 key, and keeps all its original assertions.
- docs: 08 §2.5.1.

CHECKLIST: all met.
- API: lock/unlock, If-Match + Idempotency-Key, owner scope 404, only future blocks of an active plan (409 otherwise), idempotent replay, audit, times unchanged, an unlocked block is movable by the next replan.
- Web: toggle on Today and the plan page, read-only on the replan view, keyboard, accessible names, aria-pressed, guardrail optimism, 412 refresh, ko catalog.
- E2E-5R uses the real UI.
- Tests: API (10 new), web (9 new plus 2 sweep cases).

TESTS (env per packet)
- pnpm --filter @ohmydate/api test: exit 0, 81 files, 560 passed / 9 skipped (existing skips).
- pnpm --filter @ohmydate/web lint: exit 0.
- pnpm --filter @ohmydate/web test: exit 0, 54 files / 508 tests plus sweep 6 files / 164 tests.
- pnpm run ci, first run: exit 1, a type error in my new test file; fixed and amended.
- pnpm run ci, second run: killed by the host for low memory after typecheck and lint passed.
- pnpm run ci, final run (after your "rerun now"): exit 1. Typecheck and lint passed. The root vitest run had 9 timeouts in 7 files this change does not touch, 2130 passed / 29 skipped.
- Each of those 7 files rerun alone: all exit 0 (explanation 8/8, history-exemption 9/9, http-timeouts 4/4, shutdown-drain 2/2, shutdown-settlement-regressions 8/8, production-timeouts 5/5, generate.property 4/4).
- CI steps the failure skipped, run separately:
  - web test: 1 timeout in m6-03-notes-links (unchanged file); alone it is exit 0, 17/17. Sweep shards: exit 0, 164/164.
  - check:api-client exit 0; check:boundaries exit 0 (528 files, 0 violations); build-smoke --required exit 0 (/healthz 200, SIGTERM exit 0).
- pnpm run e2e: exit 0, 30 passed (6.7m), including E2E-5R (2.4m).

RISKS
- Toggle label: as the packet specifies, the name switches between "블록 고정" and "고정 해제" while aria-pressed also changes. WAI-ARIA guidance says a toggle's label should stay constant; switching is a one-line change.
- A lock invalidates work pinned to the previous plan revision: Today accept/shrink/reschedule and pending Today proposals get 412 and must re-read; plan preview-edit gets 412.
- Pending replan proposals approved after a lock or unlock return 422 constraint_violation and leave the block untouched; both directions are tested.
Focus (narrow):
(1) API correctness: one transaction, lock order plan row -> block row matches the approval transactions (no deadlock against approve/replan/Today accept); owner scope 404 (foreign / unknown / deleted plan); 412 on version mismatch; only planned future blocks of the active plan (409 otherwise — check the boundary startAt == now and a block that started between read and write); idempotent replay returns the same response; times never change; plan.version bumped but plan.updated_at untouched — confirm nothing else relies on updated_at changing; audit has ids only.
(2) Replan interplay: a locked block is kept by the next replan and an unlocked block is movable; a pending replan/Today proposal approved after a lock/unlock is rejected (422 constraint_violation / 412) and leaves the block untouched — no silent overwrite of a locked block.
(3) Web: every lock/unlock request + optimistic state runs inside runOwnerBound / owner-scoped transport (FU-77 guardrail; web lint exit 0); 412/409 re-read; owner switch mid-request cannot apply A's toggle to B (sweep case); keyboard + aria-pressed; plan-page toggle disabled while a candidate draft has unsaved edits. Label switching ("블록 고정"/"고정 해제" with aria-pressed) is as the packet specified — treat as LOW at most.
(4) E2E-5R: the DB UPDATE helper is really gone and the lock goes through the UI with If-Match + UUIDv7 Idempotency-Key; no original assertion weakened (diff of e2e-5r spec).
(5) Run with env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456: pnpm --filter @ohmydate/api test ; pnpm --filter @ohmydate/web lint ; pnpm --filter @ohmydate/web test ; pnpm run e2e e2e-5r (targeted spec only).
Round 1 of 2. HIGH for cross-owner effects, a locked block moved/overwritten, deadlock-prone lock order, guardrail violations, weakened tests.

