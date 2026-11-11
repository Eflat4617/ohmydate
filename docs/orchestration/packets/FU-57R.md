# REVIEW PACKET: FU-57RR — Independent review of FU-57R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-57-dist-once. Base: torgal/ohmydate. Head: 0aa9193.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-57R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...0aa9193; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-57 (build services/api/dist once for tests). Branch torgal/fu-57-dist-once commit 0aa9193. Packet: docs/orchestration/packets/FU-57.md. Worker report:
Built services/api/dist once via a new vitest globalSetup (cross-process lease + mtime build stamp) and replaced both suites' per-file pnpm build calls with lease-and-consume; build-smoke is unmodified and still rebuilds in place under the same lease, refreshing the stamp (commit 0aa9193 on torgal/fu-57-dist-once). Proof: pnpm run ci green 3/3 (root 124 files/1497 passed+29 skipped each; web 27/166; build-smoke SIGTERM 0), and the two affected files in parallel green 5/5 (13 passed each, ~55s); no assertions or timeouts changed. Nothing is left on the task; only note the two heavy files now serialize on the lease so build-smoke cannot race live dist consumers.
Narrow focus (medium effort): (1) no assertion/timeout changes in the two suites (diff check); (2) lease/stamp correctness: stale dist after source edits is rebuilt (mtime stamp covers all workspace packages the build compiles, incl. the 4-5 workspace deps), concurrent vitest workers never read a half-written dist, a crashed holder does not deadlock (lease expiry), works when tests run from root and from services/api; (3) build-smoke behaviour unchanged; (4) run pnpm run ci once and the two files in parallel once.
Round 1 of 2. HIGH only for test weakening or CI that can pass on a stale/broken build; else APPROVE.

