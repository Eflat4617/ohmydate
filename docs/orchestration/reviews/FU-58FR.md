# FU-58FR (ctx_40e735b6c560, sol gpt-6.1-sol medium) — APPROVE (implementer Fable 5.2 medium)

REVIEW VERDICT: APPROVE
Findings (most severe first):
  None.

Contract / license / security / migration impact: Reviewed the complete git diff torgal/ohmydate...7bf0505 at HEAD 7bf05056f48321ecc3da306d65d8ecc3e5a798b0, the original FU-58F packet, the FU-61-58 packet, the prior review, and WORKER-AND-REVIEW-CONTRACT section 4. All 12 changed paths are within services/api/test/** and the explicitly allowed services/api/vitest.config.ts; there are no production, dependency, API-contract/schema, domain/upstream boundary, authentication, sensitive-logging, timezone, error-model, or migration changes. Commits 91d3fa8 and 7bf0505 have Conventional Commit subjects and Task trailers.

Acceptance: FU-61 readyz is unchanged from 0251dc8, retains the exact 503/database=failed assertion, and verifies pending at virtual 2499 ms and completion at 2500 ms. Every setup unconditionally builds a fresh mkdtemp workspace and supplies both its root and build ID; the four original build-ID guard tests remain. The two-contender and three-contender tests exercise the actual workspace/build/stamp implementation: distinct paths and IDs, cross-invocation rejection, A teardown while B consumes, C rebuilding newer sources while B retains identical bytes, and B teardown leaving C intact (global-setup.test.ts:201-264). Their former shared-lock schedule has no shared output path to target.

Deleted-test mapping verified: (1) acquire/release ownership -> private-workspace creation/removal and lifecycle assertions; (2) mismatched-owner release -> failed-neighbor setup removes only itself plus sweep preserves live owners; (3) two stale reclaimers -> dead-owner cleanup plus distinct simultaneous workspaces; (4) paused publication -> atomic owner-PID mkdtemp naming plus two-/three-contender isolation. These are the four coordinator-approved removals; no other behavioral assertion was weakened, and no skips/only markers were added. Always-build and build-failure cleanup assertions remain, with additional stamp-failure and foreign-artifact negatives.

Shim/sweep: current build scripts only emit into the private dist; source/config/module links are inputs. Both PATH and npm_execpath select the run-only shim, unsupported install commands exit 64, package-manager state is excluded, fixtures and build-smoke are regular copies, and recursive cleanup does not follow their input symlinks. The sweep enumerates only its checkout-specific base and removes matching dead-owner paths; there is no stale takeover or restoration path. The 30-to-120-second budget is acceptable test infrastructure tolerance for the explicitly database-wide migration advisory lock, remains bounded, and does not alter timeout-behavior assertions. Two concurrent complete suites passed even under substantial additional machine load.

Missing tests: none required for this round; multi-worktree concurrency and cross-PID-namespace cleanup remain unverified follow-ups.

Verification actually executed: yes —
  DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm --filter @ohmydate/api test -> exit 0; 64 files passed, 440 passed, 9 skipped, 75.86 s.
  The identical environment and corepack pnpm --filter @ohmydate/api test command launched twice simultaneously through a Node Promise.all subprocess driver -> individual exits 0 and 0; each 64 files passed, 440 passed, 9 skipped; 206.42 s and 205.63 s.
  Supplemental driver exit 1: its extra aggregate checksum included services/api/node_modules/.vite/vitest/.../results.json, so ordinary Vitest results-cache writes failed that overbroad checksum. The subsequent recent-file metadata scan exited 0 and identified only that cache file among the checked checkout dist/package-state paths; neither actual suite failed. This supplemental checksum is not claimed as passing.
  DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci -> exit 0; typecheck/lint passed, root 137 files/1613 passed/29 skipped, web 32 files/240 passed, generated API schema diff clean, boundaries 390 files/0 violations, build-smoke healthz 200 and SIGTERM exit 0.
  git diff --check torgal/ohmydate...7bf0505 -> exit 0.
  git status --porcelain -> exit 0, empty.
  Read-only Node inspection of defaultWorkspaceBaseDir after CI -> exit 0, remainingBuildWorkspaces=[].

git status --porcelain after review: empty

Residual risks: The final scripts/ci/build-smoke.mjs step still rebuilds the checkout dist, so two full ci commands in one worktree can collide; this is the acknowledged out-of-scope follow-up. Symlinked inputs are writable at the filesystem level, so future build-script changes must retain their input-only use; the shim supports only the current run-script subset and fails loudly for unsupported commands. PID reuse can postpone cleanup and a shared temp directory across PID namespaces can invalidate liveness assumptions. The 120-second migration queue budget does not support unbounded concurrency. Existing skips are unchanged. No files were manually modified, created, deleted, or committed during review; only test/build-generated artifacts were produced. Rollback remains git revert 7bf0505 91d3fa8.
