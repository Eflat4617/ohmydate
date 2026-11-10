# REVIEW PACKET: FU-09R — Independent review of FU-09
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-09-web. Base: torgal/ohmydate. Head: 2580131.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-09.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...2580131; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
What: implemented FU-09..11 under apps/web only (ConflictDialog focus trap + Escape=Keep editing + global-shortcut suppression + inert editor + current-draft overwrite; UUIDv7 Idempotency-Keys rotated whenever If-Match changes; MSW follows 08 §1 storing only 2xx/409/422 and emits unauthenticated/idempotency_in_progress; Inbox scoped by projectId; reload failures toasted; dead IdempotencyKeyStore removed), after merging torgal/ohmydate into torgal/fu-09-web, commit 2580131fb0a36dfd4565672849b3aefa8573c70a. Found: web vitest 11 files/60 tests pass, web build exit 0, and pnpm run ci exit 0 (typecheck, lint, root+web tests, check:api-client, boundaries 104 files/0 violations); all 17 changed paths are apps/web/**. Left: nothing blocking; residual risk is MSW-only verification (no real API/axe browser run), and rollback is deleting branch torgal/fu-09-web.

REVIEWER: Claude Opus 5.5 xhigh FALLBACK (Sol usage-limited). Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only.
Verify FU-09..11 from `git show torgal/ohmydate:docs/orchestration/FOLLOW-UPS.md` and M1-07R-2 probes (shortcut while dialog open, overwrite with newer draft, If-Match change -> new key, MSW storage rule 08 §1). Convergence rule: APPROVE unless HIGH/CRITICAL.
