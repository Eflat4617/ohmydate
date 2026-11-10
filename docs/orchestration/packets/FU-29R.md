# REVIEW PACKET: FU-29R — Independent review of FU-29
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-29-inbox-column. Base: torgal/ohmydate. Head: 9749b16.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-29.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...9749b16; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
FU-29 done: commit 9749b16 on torgal/fu-29-inbox-column at /home/torgal/orca/workspaces/oh_my_date/fu-29-inbox-column. Added migration 0004 (is_inbox boolean NOT NULL DEFAULT false, project-only CHECK, partial UNIQUE(owner_id) WHERE is_inbox, newest-live fingerprint backfill then NULL project fingerprints, down restores the interim marker), moved MappingStore to inbox/getInboxMapping/markInbox atomically in InMemory and PG, removed content_fingerprint reuse, re-read the partial-unique winner on cross-instance races, bumped project version when kind changes, and made GET /user swallow only provider_auth so transient 5xx surfaces as 503. Added the trash/rename/restore single-inbox scenario, softDelete vs deleted-scan race, #kindFor mutation killer, InboxView page>1, inbox-lookup title fix, and pinned 0004 assertions; provider test exit 0 (108 passed/9 skipped), api test exit 0 (150 passed/9 skipped), full ci exit 0 (821 passed/27 skipped, web 69, boundaries 217 files 0 violations). Risks: SQL cannot derive the Vikunja default so backfill picks the newest live marker, the losing cross-instance create race can leave an unmapped Vikunja Inbox project, and clearing the previous marker does not bump that old project version; rollback is delete branch (0004 down preserves identity via content_fingerprint).

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. DB planner_test; live Vikunja synthetic only.
Re-run FU-23R-2 probe T (trash default -> replacement -> rename -> no third Inbox) live via buildApp PROVIDER=vikunja; 0004 up/down with existing data incl. multiple fingerprint markers per owner; cross-instance first-create race (two API processes); transient GET /user 5xx no stray Inbox. Judge the residual "losing race leaves an unmapped Vikunja Inbox project". Convergence: APPROVE unless HIGH/CRITICAL.
