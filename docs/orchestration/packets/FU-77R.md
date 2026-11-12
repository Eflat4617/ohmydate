# REVIEW PACKET: FU-77RR — Independent review of FU-77R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-77-owner-guardrail. Base: torgal/ohmydate. Head: 98ba71c.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-77R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...98ba71c; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-77 (structural owner-isolation guardrail for apps/web; breakthrough worker Fable 5.2 xhigh). Branch torgal/fu-77-owner-guardrail HEAD 98ba71c (8 commits). Merge candidate torgal/ohmydate...98ba71c. Read docs/orchestration/packets/FU-77.md, full worker report docs/orchestration/reports/FU-77-report.md (git show torgal/ohmydate:...), ADR-023 amendment in docs/blueprint/13-ADR.md, and the prior reviews that motivated it (M6-02R-1, FU-76R-1, M6-03R-1, M6-03R2). Worker summary:
I added one owner-scoped storage module (the only code allowed to touch localStorage/sessionStorage/indexedDB, lint-enforced incl. .vue), the runOwnerBound primitive with a lint rule for its tasks, an owner-scoped query client and a production page seal, migrated all 8 storage call sites and the M6-02/M6-03 fences, amended ADR-023, and committed 8 commits on torgal/fu-77-owner-guardrail (HEAD 98ba71c, clean tree). The new owner-switch harness and sweep found and fixed real leaks in screens with no fence (availability, commitments, inbox edits incl. the undo-delete timer, plans, notification polling and push enabling) and later-await gaps behind existing checks (replan approve/reject/request, patterns, wizard save-then-approve); web lint 0, web test 0 (52 files / 591 tests, the 442 existing ones unmodified), web build 0, pnpm run ci 0, and the E2E owner-reset + notes + AI-wait specs 0 (5 passed). Left: Focus start/restore/pause and the wizard AI-wait state machine keep their existing binding checks on purpose (covered by the sweep), the full E2E suite was not run, and the full report with root cause, design, migrated call-site list and risks is at the report path.
Focus (medium, priority order):
1) Guardrail is real: the ESLint rule rejects direct localStorage/sessionStorage/indexedDB (incl. window./globalThis./self. aliases, destructuring, bracket access, .vue <script>) everywhere except ownerStorage.ts and the explicit device-level allowlist (each with a reason); the lint negative fixture fails, the module passes; web lint is part of pnpm run ci (verify it is actually wired in, not only a package script).
2) ownerStorage: keys namespaced by verified owner; writes no-op when the binding is stale; owner change/logout clears/quarantines per ADR-023; device-level allowlist minimal (clientId etc.) and documented. Migration of the 8 call sites keeps single-owner behaviour (no lost prefs/queues on the same owner).
3) runOwnerBound / owner-scoped query client / page seal: binding captured before the first await, AbortSignal passed, stale continuations dropped before cache/storage/UI/navigation/toast; pagination helper. Check that the "production page seal" cannot strand a legitimate single-owner session (false positives) and that hard reset (ADR-023) still works.
4) The newly fixed leaks (availability, commitments, inbox edits incl. undo-delete timer, plans, notification polling + push enabling, replan approve/reject/request, patterns, wizard save-then-approve): spot-check 3 against the owner-switch harness; the harness itself genuinely holds a response, switches owner, releases (not a mock that always passes).
5) Focus start/restore/pause and the wizard AI-wait machine keep their own checks — acceptable?
6) No existing test modified/weakened (worker says the 442 existing tests are unmodified).
Run: pnpm --filter @ohmydate/web lint ; pnpm --filter @ohmydate/web test ; the E2E owner-reset + notes + AI-wait specs (playwright filtered; DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456).
Round 1 of 2. HIGH for a bypassable rule, a remaining cross-owner write, a regression for single-owner users, or weakened tests.

