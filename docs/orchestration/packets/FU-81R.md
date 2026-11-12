# REVIEW PACKET: FU-81RR — Independent review of FU-81R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-81-deleted-dependents. Base: torgal/ohmydate. Head: cd6b0db.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-81R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...cd6b0db; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-81 (dependents of a deleted Vikunja task keep a stale dependsOn; implementer Opus 5.5 xhigh). Reviewer: Fable 5.2 xhigh in place of Sol (weekly limit; MODEL_BINDINGS §12). You are the REVIEWER: read-only — do not edit/create/commit repository files (scratch only outside the worktree); finish with the REVIEW VERDICT format. Do not read *api_key* files or call the LLM gateway. Branch torgal/fu-81-deleted-dependents commit cd6b0db. Merge candidate torgal/ohmydate...cd6b0db. Read docs/orchestration/packets/FU-81.md, worker report docs/orchestration/reports/FU-81-report.md (git show torgal/ohmydate:...), ADR-016 + FU-73 amendment in docs/blueprint/13-ADR.md. Worker summary:
Commit cd6b0db on torgal/fu-81-deleted-dependents. A live reproduction on v2.8.0 confirmed that a delete drops the dependents' blocked relation without touching their updated/ETag, so the feed never delivered them and get() served dependsOn=[] under the old v1. The fix re-reads the dependents named by the relations in each mapping's content fingerprint (owner-scoped, at most 50 reads per call) and commits each once through #commitReconciled: eagerly after softDelete (best-effort), and in the poll for every owner task in /tasks/deleted. This keeps FU-73 watermarks, is idempotent across polls, retries after a failed read, and changes no store interface or schema. Tests: 12 new fake-client unit tests (8 fail on the old code) plus a live contract test. 'pnpm --filter @ohmydate/provider-vikunja test' exit 0 (145 passed, 9 skipped capability gates); 'pnpm run ci' exit 0 (2142 passed, 29 skipped). Left: an ADR-016 note and the FU-81 status in FOLLOW-UPS (outside my allowed paths); full report at --report-path.
Focus (narrow): (1) reproduce live (synthetic user) own delete and remote delete -> dependent surfaces once with the stale dependency removed and version bumped once; (2) owner scoping of the dependents re-read; the 50-read bound — what happens to dependents beyond it (deferred to the next poll, never lost?); idempotent across polls; retry after a failed read; (3) FU-73 watermark semantics intact (no phantom bumps for unrelated tasks; own softDelete eager path cannot double-bump); (4) tests fail on the base (spot-check); (5) run pnpm --filter @ohmydate/provider-vikunja test (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456).
Round 1 of 2. HIGH for lost dependency updates, cross-owner reads, phantom bumps, weakened tests.

