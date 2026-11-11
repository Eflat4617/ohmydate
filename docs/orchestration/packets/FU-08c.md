# REVIEW PACKET: FU-08cR — Independent review of FU-08c
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/ohmydate. Base: torgal/ohmydate. Head: df3915f.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-08c.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...df3915f; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
FU-08c Sol POST-REVIEW of Opus-fallback-approved high-risk work, now merged on torgal/ohmydate (read-only review of the INTEGRATION BRANCH HEAD; there is no feature branch). Scope: (A) intake draft:approve exactly-once (ADR-020 incl. §6–11; services/api/src/application/intake/**, adapters/pg-intake-approval-*, provider-vikunja client ProviderRequestGuard/runWithAbortSignal, task-repository create/adoption); (B) shutdown settlement (services/api/src/main.ts, http/shutdown-context.ts; FU-42c design in docs/orchestration/packets/FU-42c.md). Prior reviews: docs/orchestration/reviews/M2-03dR.md, M2-03cR2.md, FU-42cR2.md.
Narrow focus (medium effort; probes, not a full audit):
1) (A) Re-run two live probes on HEAD: lock-connection loss mid-approval with a second approver (exactly 6 tasks, no rollback DELETE by the stale holder) and crash-after-first-create retry (6 tasks, planned==task). Check M3-04 merge did not change the intake completion TX semantics (FU-45 estimates + ensurePlannerTaskIdentity inside it): a vanished created step -> stored 409, never 500.
2) (B) One compiled-code probe with real SIGTERM: disconnected client mutation (needs_reconcile=true, idempotency released) — confirm still green after later merges (M2-03/M3-04 touched app.ts/routes.ts).
3) Report anything the Opus reviews missed that is HIGH (duplication, data loss, security). Known accepted follow-ups: FU-46, FU-47 — do not re-report them.
Verdict: APPROVE (post-review confirmed) or REQUEST_CHANGES with new HIGH findings only.

