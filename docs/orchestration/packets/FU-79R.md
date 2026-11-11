# REVIEW PACKET: FU-79RR — Independent review of FU-79R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-79-e2e-time. Base: torgal/ohmydate. Head: 974ea66.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-79R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...974ea66; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-79 (E2E time-of-day independence + login limiter isolation; implementer DeepSeek). Branch torgal/fu-79-e2e-time commit 974ea66. Merge candidate torgal/ohmydate...974ea66 (base has since gained M6-03; expect overlap in e2e/global-setup.ts / helpers/state.ts). Read docs/orchestration/packets/FU-79.md. Worker summary:
taskId task_1128045c1330, dispatchId ctx_019f5e16f815, worktree /home/torgal/orca/workspaces/oh_my_date/fu-79-e2e-time, branch torgal/fu-79-e2e-time, commit 974ea66658e72622244f86c7fab08d90165625b3. Changed e2e/** plus a small fake-only API knob: day-clock.ts installs a simulated local morning (next 09:00 +3h) for E2E-4/6/a11y, planner.ts places plan blocks on that day while E2E-4's notification carrier stays apiNow+<=8min, and an auto fixture calls a new E2E_RESET_LOGIN_RATE_LIMIT-guarded reset route before every test (production/non-fake boot rejects it; limiter untouched). Requirements: (1) met — E2E-4 ran green with E2E_FAKE_NOW=2026-11-12T21:50Z, 2026-11-12T23:59Z, 2026-11-13T00:01Z and 2026-03-08T04:30Z (NY DST spring-forward), each 3/3 passed exit 0; (2) met — per-test reset fixture, E2E-5 green; (3) audit — E2E-6 and a11y fixed the same way, E2E-3 already used E2E_FAKE_NOW, E2E-5R/E2E-1/E2E-2 are not today-card dependent (relative-to-now or due-date only) and were left as-is. Tests: pnpm run e2e twice -> exit 0 / 28 passed in 6.2m both times; targeted forced E2E-4 runs -> exit 0 / 3 passed each; pnpm run ci with DATABASE_URL+VIKUNJA_URL -> exit 0 (typecheck, lint, 1664+376 tests, api-client, boundaries 489/0, build-smoke /healthz 200); an earlier ci attempt without DATABASE_URL exited 1 only at build-smoke (env missing), hence the rerun. Risks: fake-only reset route is not in OpenAPI (internal E2E path), E2E user tz for E2E-4 is now America/New_York, and E2E-5R still uses wall-clock relative scheduling (continuous availability, not day-card dependent); rollback = delete branch torgal/fu-79-e2e-time.
Focus (medium, priority order):
1) SECURITY of the new fake-only login-rate-limit reset route (E2E_RESET_LOGIN_RATE_LIMIT): refused at config AND buildApp when NODE_ENV=production or a non-fake provider (prefer the shared assertFakeKnobsAllowed guard now on torgal/ohmydate — flag if it duplicates/diverges), not reachable when the env var is unset (404, not 403), cannot reset other limiters, no auth bypass; production limiter behaviour unchanged; tests for each negative.
2) Determinism: E2E-4/E2E-6/a11y use the simulated day clock; re-run E2E-4 with E2E_FAKE_NOW at 21:50Z, 23:59Z, 00:01Z and the DST day -> 3/3 each; the 3-card assertion unchanged (not loosened).
3) Changed assertions in existing E2E specs keep their coverage (list any changed expect()).
4) Audit claim: E2E-5R/E2E-1/E2E-2 not day-boundary dependent — spot-check one.
Run: pnpm run e2e once (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456) and the forced-time E2E-4 runs. 
Round 1 of 2. HIGH for any reachable limiter reset/auth bypass in production or weakened assertions.

