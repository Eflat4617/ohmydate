# REVIEW PACKET: FU-42RR — Independent review of FU-42R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-42-shutdown-drain. Base: torgal/ohmydate. Head: 05bf7f7.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-42R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...05bf7f7; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
Worker report (FU-42, DeepSeek high, commit 05bf7f7; source docs/orchestration/reviews/FU-37R2.md):
task_b7274aa19b24, dispatch ctx_bb9ba02d81fa, worktree /home/torgal/orca/workspaces/oh_my_date/fu-42-shutdown-drain, branch torgal/fu-42-shutdown-drain, commit 05bf7f797a63a6c4e2a7799157277b902473c083: implemented per-socket shutdown decisions (preserve sockets with a complete pending response until it settles, drop idle/incomplete-only sockets immediately, close preserved sockets after the response finishes), propagated a per-app AbortSignal through the request context via AsyncLocalStorage into Vikunja client requests so drain expiry aborts in-flight fetches and stops retries with ProviderUnavailableError, logged each forced closure once with route+reqId+method and no bodies, and added committed regressions for the real-socket complete-GET-plus-incomplete-pipelined-POST shutdown, provider retry cancellation, Kysely transaction timeout/rollback on a fresh backend, and 20 callback-checkout pool counters. Acceptance checklist all met (per-socket pinning bounded by drain, 200 delivered and exit 0 well before hard deadline, FU-37 production-timeout tests still green, provider retry loop stops with no further attempts, provider_unavailable mapping covered by the domain error, forced-closure log present without payload); tests: corepack pnpm --filter @ohmydate/provider-vikunja test -> exit 0 (13 files, 83 passed/1 skipped), corepack pnpm --filter @ohmydate/api test with DATABASE_URL/VIKUNJA_URL -> exit 0 (37 files, 208 passed/9 skipped), corepack pnpm run ci with DATABASE_URL/VIKUNJA_URL -> exit 0 (root 98 files 1103 passed/27 skipped, web 69 passed, boundaries 249 files/0 violations, build-smoke /healthz 200 and SIGTERM exit 0). Risks: the 12s drain still cannot cover the ~30s provider retry budget or multiple sequential calls, so drain expiry intentionally cancels them as provider_unavailable; HTTP tracking remains HTTP/1 only; rollback is deleting branch torgal/fu-42-shutdown-drain or reverting commit 05bf7f7.
Coordinator notes: packages/provider-vikunja/src/index.ts is outside the literal ALLOWED PATHS (client.ts only) — judge whether the export change is minimal/necessary (scope amendment acceptable if it only exports the signal option type).
Focus asks:
1) Re-run the FU-37R2 pipelining repro against literal compiled code (complete GET + incomplete pipelined POST on one socket, SIGTERM) -> 200 delivered, exit 0; plus keep-alive idle sockets and multiple complete pipelined requests.
2) AbortSignal via AsyncLocalStorage: context leaks across requests? Signal used outside a request (reconciler sweeps, startup) — must not abort or crash; mutations aborted mid-flight leave consistent state (idempotency record released, ADR-016 marker recovery possible)?
3) Abort mapping: aborted fetch -> ProviderUnavailableError -> 503 provider_unavailable; no 500; forced-closure log contains no bodies/headers/tokens.
4) FU-37 regressions (timeouts, trickle, 11s handler, pool disposal) still green.
Round 1 of 2.

