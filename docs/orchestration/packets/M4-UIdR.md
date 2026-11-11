# REVIEW PACKET: M4-UIdRR — Independent review of M4-UIdR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/m4-ui-integration. Base: torgal/ohmydate. Head: 2a2d734.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/M4-UIdR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...2a2d734; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of M4-UId (ADR-023 hard reset on owner change; M4-UIc BLOCKED). Branch torgal/m4-ui-integration commit 2a2d734 on top of 4feec04. Merge candidate torgal/ohmydate...2a2d734 (whole M4-UI). Read: docs/blueprint/13-ADR.md ADR-023; docs/orchestration/packets/M4-UId.md; reviews M4-UIcR-1.md, M4-UIcR2.md. Worker report:
taskId task_2679a18dc81c, dispatchId ctx_6ab12496bfd6, worktree /home/torgal/orca/workspaces/oh_my_date/m4-ui-integration, branch torgal/m4-ui-integration, commit 2a2d734.

Changed paths: 12 files under apps/web/** only (source 10, tests 2). Diff summary: new ownerChanged(prev,next,reason) centralizes login/logout/storage//me-mismatch, aborts the epoch, preserves prior namespaces and reloads via injectable injectOwnerReload; auth now gates UI on /me confirmation and rejects settings writes unless the binding/user/owner match; new ownerLock serializes replay+retry per owner through navigator.locks or an in-tab mutex with BroadcastChannel notice; retry re-queues under the lock and removes only the keys it successfully queued via removeQuarantinedEntries; Focus/Today retry buttons are disabled while retrying; 7 new regressions cover storage A->B, external logout, login as B, boot /me mismatch, pre-/me loading gate, concurrent delayed-append retry/flush, and a mounted never-settling A Focus operation.

Requirement checklist: ADR-023 §1 single handler + abort + preserve namespaces + injectable reload = met; §2 /me-confirmed UI loading gate = met; required owner-change tests including settings rejection with no updateMySettings call = met; §3 per-owner serial lock (Web Locks, fallback mutex + BroadcastChannel notice) = met; retry selective read-modify-write removal, never wholesale clear = met; reviewer delayed-append probe keeps new-key in quarantine and journal/quarantine consistent = met; mounted Focus A abort + B unaffected = met.

Tests (all run on final commit): pnpm --filter @ohmydate/web test -> exit 0, 27 files / 164 passed; pnpm --filter @ohmydate/web build -> exit 0, 259 modules; DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 pnpm run ci -> exit 0, typecheck+lint+generated client+boundaries 347 files/0 violations, root 124 files 1496 passed/29 skipped, web 27/164, build-smoke /healthz 200 and SIGTERM 0; same env pnpm run e2e -> exit 0, 11 passed (3.3m).

Risks/unverified: production reload and default history target are not exercised under jsdom because tests inject a no-op/spy reload; the BroadcastChannel fallback only gives an in-tab mutex plus a notice, not a distributed Web Lock; /me mismatch schedules the reload but confirms the verified owner so tests can continue after a mocked reload; no fetch timeout was added. Rollback: git reset --hard 4feec04 on this branch.
Narrow focus (medium effort): (1) re-run both M4-UIcR2 HIGH probes (concurrent delayed-append retry vs flush; cross-tab A->B storage event with auth.user/consent/budget/settings version) on this head; (2) since jsdom injects the reload, verify the REAL hard reset with Playwright in this worktree using a scratch spec outside the repo or an ad-hoc run: two contexts/tabs of the same browser profile, tab 2 logs in as another owner, tab 1 must reload and show only owner B data (no A consent/budget/session) — report the result; (3) every owner-change path goes through ownerChanged (grep for other setOwner/user writes); (4) BroadcastChannel fallback acceptable as documented.
Fresh round budget for M4-UId: round 1 of 2. HIGH only for cross-owner leakage, data loss, security; else APPROVE with follow-ups.

