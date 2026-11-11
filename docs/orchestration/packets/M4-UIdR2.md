# REVIEW PACKET: M4-UIdR2R — Independent review of M4-UIdR2
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/m4-ui-integration. Base: torgal/ohmydate. Head: 5384216.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/M4-UIdR2.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...5384216; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
ROUND 2 REVIEW of M4-UId (fix 5384216 on top of 2a2d734). Previous: git show torgal/ohmydate:docs/orchestration/reviews/M4-UIdR-1.md. Merge candidate torgal/ohmydate...5384216 (whole M4-UI). Scope amendment approved: services/api/src/http/routes.ts + auth.test.ts for /me cache headers. Worker report:
taskId task_418137e378d8, dispatchId ctx_3a38ce541132, worktree /home/torgal/orca/workspaces/oh_my_date/m4-ui-integration, branch torgal/m4-ui-integration, commit 5384216.

Finding table: (1) Client identity cache = FIXED; getMe now always sends cache no-store, and apps/web/test/api-client.spec.ts asserts the request cache option. (2) Server defense = FIXED; GET /me sets Cache-Control private, no-store and Vary: Cookie, and its ETag is W/"<userId>:<version>"; auth.test.ts proves same-user 304 and cross-owner 200/no-304 with the new headers. (3) Real two-tab browser regression = FIXED; e2e-5 uses normal caching, same-version A/B owners, seeds A consent 9/90 and an A active session, logs B in tab 2, verifies the fresh cookie is B, forces a real document reload (sentinel gone), and checks owner marker/session namespace plus absence of A budget text; tab 2 Sign out then resets tab 1 to /login. I also added a Sign out control and focus/visibility identity revalidation so cross-tab logout is reachable, with a unit test for the focus path.

Changed paths (9): apps/web/src/api/client.ts, components/AppShell.vue, components/NavRail.vue, stores/auth.ts, test/api-client.spec.ts, test/m4-owner-hard-reset.spec.ts, e2e/tests/e2e-5-owner-reset.spec.ts, services/api/src/http/routes.ts, services/api/test/auth.test.ts. Diff summary: no-store on /me; user-scoped /me ETag plus no-store/Vary on 200 and 304; focus/visibility /me revalidation that keeps the UI on transient errors but clears it on 401; random-transient guard; Sign out in NavRail; cross-tab logout regression.

Tests (final commit): pnpm --filter @ohmydate/web test -> exit 0, 27 files/166 passed; pnpm --filter @ohmydate/api test -> exit 0, 56 files/376 passed/9 skipped; pnpm --filter @ohmydate/web build -> exit 0, 259 modules; DATABASE_URL=... planner_test VIKUNJA_URL=http://127.0.0.1:3456 pnpm run ci -> exit 0 (root 124 files/1497 passed/29 skipped, web 27/166, boundaries 347/0, build-smoke /healthz 200 and SIGTERM 0); same env pnpm run e2e -> exit 1 with 11 passed/1 failed. The only failure is pre-existing E2E-3 'a small keyboard edit should remain feasible': its last plan block is 10:30-11:00 and ArrowUp to 10:25 overlaps the 09:00-10:30 block, so the preview correctly returns H1; the 700ms fixed wait makes it a timing-dependent false positive. I reproduced the same E2E-3 failure after reverting my five production files to base 2a2d734, so it is not caused by this task; E2E-5 passed in every full run.

Risks/unverified: e2e runs with LLM_PROVIDER=fake, so the consent/budget cards are not rendered; E2E-5 instead proves B's /me has no llm values, B's session namespace is empty, A's namespace is preserved, and the settings page contains no A budget values. External logout is driven through the new Sign out control (real app logout in tab 2), with focus revalidation as an additional cookie-only-logout defense. Rollback: git reset --hard 2a2d734 for this repair or revert 5384216.
Coordinator note: the E2E-3 failure ('a small keyboard edit should remain feasible') is confirmed PRE-EXISTING on torgal/ohmydate at UTC 09:50 (wall-clock dependent block positions) and is tracked separately as FU-55 — do not count it against this task.
Narrow focus (medium effort): re-run your real-Chromium two-tab probe with NORMAL caching (no route tricks): tab 2 logs in as B -> tab 1 really reloads and shows only B; tab 2 Sign out -> tab 1 resets to /login. Check /me headers (Cache-Control private, no-store; Vary: Cookie; ETag W/"<userId>:<version>"; cross-owner conditional request never 304). Judge the added Sign out control and focus/visibility revalidation (scope creep acceptable? any regression on transient errors). Run e2e-5 + api auth tests.
Round 2 of 2: HIGH only for cross-owner leakage, data loss, security; else APPROVE with follow-ups.

