# REVIEW PACKET: FU-01R — Independent review of FU-01
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-01-boundaries. Base: torgal/ohmydate. Head: 1de2357.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-01.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...1de2357; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
Implemented FU-01..FU-03 in /home/torgal/orca/workspaces/oh_my_date/fu-01-boundaries on branch torgal/fu-01-boundaries at commit 1de2357: file: URL specifiers now normalize via fileURLToPath and classify through path.relative(repoRoot, abs) (outside repo -> external), the fixture exclusion is scoped to scripts/__fixtures__/boundaries only, and tests/fixtures now cover file: service/upstream targets, packages/x/__fixtures__/foo.mjs upstream, apps/web .d.ts service+upstream imports, inline type re-export, and effective pnpm config (autoInstallPeers=false, strictPeerDependencies=true, engineStrict=true, saveExact=true via execFileSync pnpm). Acceptance checklist all met: FU-01 file: URL normalization+forbidden fixtures (met), FU-02 scoped exclusion+packages/x regression (met), FU-03 d.ts/inline-reexport/pnpm config tests (met); changed paths are scripts/check-boundaries.mjs, scripts/check-boundaries.test.mjs, and six scripts/__fixtures__/boundaries/** files (8 files, +62/-5), with diff summary: added FIXTURE_EXCLUSION/isExcludedPath path-scoped skip, added file: branch in classifySpecifier, added 5 forbidden fixtures + 2 absolute-template file-URL fixtures, updated expected violation arrays and added pnpm-config test. Tests: pnpm run ci -> exit 0 (22 test files, 74 tests passed; Boundary check passed: 50 file(s), 0 violations); pnpm exec vitest run scripts/check-boundaries.test.mjs --reporter=verbose -> exit 0 (4/4 tests). Risks: file: URL with non-local host or malformed URL is treated as external (conservative) and computed imports remain unsupported; no new contracts for dependents; rollback is deleting branch torgal/fu-01-boundaries or reverting commit 1de2357.

EXTRA: small tooling follow-up. Verify the three follow-ups from `git show torgal/ohmydate:docs/orchestration/reviews/M1-01R-3.md` are closed using your own /tmp-copy probes. Convergence rule: APPROVE unless HIGH/CRITICAL.
