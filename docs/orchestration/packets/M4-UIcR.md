# REVIEW PACKET: M4-UIcRR — Independent review of M4-UIcR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/m4-ui-integration. Base: torgal/ohmydate. Head: 67f4ccd.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/M4-UIcR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...67f4ccd; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of M4-UIc (narrow fix after M4-UI BLOCKED) — also the merge candidate for the whole M4-UI integration. Branch torgal/m4-ui-integration: 5d5f4fa, merge c177baf (torgal/ohmydate incl. FU-52), 67f4ccd on top of 6936345. Merge candidate torgal/ohmydate...67f4ccd. Read: docs/orchestration/packets/M4-UIc.md; reviews M4-UIR-1.md, M4-UIR2.md (P1/P2). Worker report:
Implemented owner-bound Focus/Today operations: auth exposes ownerId+epoch with a per-epoch AbortController invalidated before the login cookie switch, async operations capture owner+epoch and bind journal/session writes to it, runFlush is deduped per owner/epoch with owner-only replay, and 403/404 replays move to a per-owner quarantine with a visible notice while later events continue. Added P1/P2, createSession/restoreSession-after-switch, quarantine, me-refresh-owner, and push-permission-offline tests; E2E-4 now shrinks to 10 minutes and asserts GET /schedule-blocks endAt changed, and reschedules assert startAt changed (the fixture tasks are PATCHed to min session 10/splittable because the default 15-minute min rejected the required 10-minute shrink); also merged torgal/ohmydate preserving FU-52 LLM consent/budget with the owner epoch and regenerated the web client. Verification passed: web test exit 0 (146 tests), web build exit 0 (258 modules), env-scoped pnpm run ci exit 0 (1496 passed/29 skipped, boundaries 345 files/0 violations, build-smoke /healthz 200), e2e exit 0 (11 passed, 3.3m); commits 5d5f4fa, merge c177baf, 67f4ccd, clean worktree, rollback is reset to 6936345.
Narrow focus: (1) rebuild your P1/P2 owner-switch probes on this head (pause in flight + login B + network failure; A's replay in flight + login B) plus createSession/restore after a switch — nothing of A lands in B, A's events preserved, B's queue not blocked; (2) 403/404 quarantine does not drop billable/real data silently (visible notice, owner-scoped); (3) owner epoch also covers the FU-52 auth-store changes (consent/settings) after the merge; (4) E2E-4: fixture tasks set to min session 10 — via public API only? shrink/reschedule changes asserted; run pnpm run e2e once.
Fresh round budget: round 1 of 2 for M4-UIc. HIGH only for cross-owner leakage, data loss, security, or E2E not testing the real flow.

