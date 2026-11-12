# REVIEW PACKET: FU-85RR — Independent review of FU-85R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-85-revalidation-hardening. Base: torgal/ohmydate. Head: 347d86f.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-85R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...347d86f; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-85 (identity revalidation hardening after FU-56: 10 s bound pinned by an AppShell fake-timer test, banner layout, offline/online behaviour, focus handling, E2E-5 waits, duplicate signal helper; implementer Opus 5.5 xhigh). Reviewer: Fable 5.2 xhigh in place of Sol (weekly limit; MODEL_BINDINGS §12). You are the REVIEWER: read-only — do not edit/create/commit repository files (scratch only outside the worktree); finish with the REVIEW VERDICT format. Do not read *api_key* files or call the LLM gateway. Branch torgal/fu-85-revalidation-hardening commit 347d86f. Merge candidate torgal/ohmydate...347d86f (merge-base d3ed838). Read docs/orchestration/packets/FU-85.md and docs/orchestration/reviews/FU-56R.md (git show torgal/ohmydate:...), ADR-023 (+FU-77 amendment) in docs/blueprint/13-ADR.md.
HOST LOAD RULE (overrides the MUST line for these two commands only): do NOT run the full `pnpm run ci` or the full `pnpm run e2e` — the host is shared and the coordinator runs both full suites on the merge result before accepting (the worker reports both green on the first run). Run instead: `pnpm run typecheck`, `pnpm run lint`, `pnpm run check:api-client`, `pnpm run check:boundaries` plus the package/targeted commands in Focus. A single timeout under load: rerun that file alone before judging it.
Worker report (treat as unverified claims):
FU-85 done on worktree /home/torgal/orca/workspaces/oh_my_date/fu-85-revalidation-hardening, branch torgal/fu-85-revalidation-hardening, commit 347d86f (base d3ed838). All 5 REQUIRED items are met; every exact test exited 0, the full suites on the first run. Nothing is left except two residual risks below (no failure).

CHANGED (git diff --name-only d3ed838...HEAD; 8 files, +364/-36, all inside ALLOWED PATHS): apps/web/src/api/client.ts, apps/web/src/api/index.ts, apps/web/src/components/AppShell.vue, apps/web/src/stores/auth.ts, apps/web/src/styles/shell.css, apps/web/test/fu-56-revalidation.spec.ts, e2e/README.md, e2e/tests/e2e-5-owner-reset.spec.ts.
DIFF SUMMARY:
- AppShell.revalidateIdentity returns the in-flight check promise, so a focus, visibility or online trigger during a check joins it instead of starting another (no loop). A new window 'online' listener re-runs the bounded check once.
- The failed notice (revalidationNoticeShown) appears on 'failed', stays mounted while a check is 'pending' (the button shows busy and is not disabled, so it keeps keyboard focus) and closes on 'idle'. It is hidden while offline.store.online is false.
- A pre-flush watcher moves focus to <main id=main-content> (preventScroll) when the notice closes with focus inside it; focus elsewhere is not touched.
- The notice uses UiBanner's inline variant. shell.css: one rule '.offline-banner, .identity-revalidation-banner' (100% width, max-width var(--content-wide), margin-inline auto).
- auth.ts: the duplicate combinedSignal is removed; it uses anySignal, now exported from client.ts and re-exported from api/index.ts. Behaviour is identical: the same AbortSignal.any path, first reason wins.
- E2E-5: both /me waitForResponse calls have { timeout: 20_000 }. A new waiter matches tab 1's first GET /tasks 200 after its automatic /me; the test awaits it and B's .task-list before the existing toHaveCount(0) for A's title. No assertion was removed. README wording updated.
- No new copy, no v-html, no storage or owner-bound task code.

CHECKLIST:
1. MEDIUM, met. New AppShell fake-timer test (setTimeout/clearTimeout faked after mount):
   - a never-settling getMe is still pending and not aborted at 9_999 ms;
   - a focus while it is in flight starts no second getMe;
   - at +1 ms the signal is aborted with reason TimeoutError, revalidationState is 'failed', confirmed is true, user, ownerId and body are kept, and the notice shows;
   - the next focus sends a new getMe with a fresh signal (resolves, state 'idle').
   The FU-56 '> 0' is now toBe(10_000), also asserted in the new test.
   Scratch mutations (all reverted; git status clean):
   - AppShell loadCurrent() without timeoutMs: new test fails (expected false to be true, the abort check);
   - constant 86_400_000: 2 tests fail (the abort check and 'expected 86400000 to be 10000');
   - constant 5_000: 2 tests fail.
2. LOW, met. Visual check in the Vite dev server (VITE_MOCK=1, Playwright Chromium, screenshots in the scratchpad only, not committed):
   - desktop 1440: both banners at x=296, width 1096, the same as <main>; the notice is one row, text then '다시 확인' on the right;
   - 390 px: both at x=16, width 358; the button wraps under the text in the text column;
   - the busy state shows a spinner in the button, which stays in place.
3. LOW, met. New tests:
   - offline: the notice is hidden and exactly 1 polite status region is left in .app-main;
   - 'online' sends exactly 1 getMe; 3 more online events plus a focus while it is in flight send 0 more (negative); none after it settles;
   - if the check after 'online' still fails, the notice shows once OfflineBanner is gone;
   - 'online' while anonymous sends no getMe (negative);
   - retry: the button stays the same element, is focused and aria-busy while pending, and keeps focus after a second failure; on success, focus is on #main-content, not body;
   - focus on the skip link is not moved when the notice closes (negative).
   Mutations, each failing tests: old v-if (3 fail), no offline suppression (2), no online listener (2), no in-flight join (2: 6 getMe instead of 2), no focus handoff (1: activeElement body), unconditional handoff (1).
   In the real browser: setOffline(false) re-ran /me and cleared the notice.
4. LOW, met. E2E-5 changes as in the diff summary. Mutation (ownerEpoch storage listener ignores an owner switch, reverted): fails in 21.5 s with 'page.waitForResponse: Timeout 20000ms exceeded' at :232/:243 instead of the generic 60 s test timeout.
5. LOW, met (see diff summary). Tests green.

TESTS (env DATABASE_URL=...planner_test VIKUNJA_URL=http://127.0.0.1:3456 for e2e and ci):
- corepack pnpm --filter @ohmydate/web lint -> exit 0
- corepack pnpm --filter @ohmydate/web typecheck -> exit 0
- tsc -p e2e -> exit 0
- corepack pnpm --filter @ohmydate/web test -> exit 0 (54 files / 508 passed, then sweep 6 files / 156 passed)
- corepack pnpm run e2e e2e-5-owner-reset -> exit 0 (2 passed, 11.9 s)
- after the coordinator's go: corepack pnpm run ci -> exit 0, first run. Root vitest 173 files, 2142 passed / 29 skipped (pre-existing, none in apps/web). Web 508 + 156. check:api-client clean. Boundaries 527 files, 0 violations. build-smoke /healthz 200, SIGTERM exit 0.
- corepack pnpm run e2e -> exit 0 (31 passed, 6.6 min, 0 failed or flaky)

RISKS / UNVERIFIED:
- Visual check method: the failed state was set through the auth store, because MSW answers /me inside a service worker. The real-failure path is covered by the unit tests and the online re-check by the browser run.
- No feedback on a repeated failure: if a retry fails again the notice text doesn't change, so it is not announced again (the busy state ends and focus stays on the button).
- The focus handoff runs after nextTick. It is not owner data, and it does nothing if the owner changed (main is unmounted).
- An extra GET /me is sent on every offline->online transition while signed in, by design.
NEW CONTRACTS: none (anySignal is newly exported from the web api module; no API, schema or migration change).
ROLLBACK: delete the branch (or revert 347d86f).
Focus (narrow):
(1) The new AppShell fake-timer test really pins the 10 s bound: re-run the worker's scratch mutations yourself in a copy outside the worktree (AppShell without timeoutMs; constant 24 h; constant 5 s) — each must fail; the timeout abort keeps the confirmed owner (no wipe) and the next focus issues a fresh request.
(2) In-flight join: focus/visibility/online during a pending check never starts a second request and never loops; 'online' while anonymous sends nothing; no leaked listeners on unmount (check removeEventListener for 'online', focus, visibilitychange).
(3) Owner safety: nothing new writes owner data or bypasses the FU-77 guardrail (web lint exit 0); the focus handoff after nextTick cannot act on a different owner's DOM; revalidation still cannot adopt a different owner silently.
(4) A11y: exactly one polite live region while offline; retry button keeps focus while busy (aria-busy, not disabled); focus moves to #main-content only when it was inside the closing notice; banner layout rule shared with .offline-banner using design tokens.
(5) E2E-5: no assertion removed or weakened; the new GET /tasks waiter really belongs to tab 1 after its automatic /me (not a stale earlier response).
(6) Run with env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456: pnpm --filter @ohmydate/web lint ; pnpm --filter @ohmydate/web test ; pnpm run e2e e2e-5-owner-reset.
Round 1 of 2. HIGH for an owner wipe on transient failure, a request loop, a guardrail violation, a test that does not bite, weakened assertions.

