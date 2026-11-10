# REVIEW PACKET: FU-18R — Independent review of FU-18
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-18-inbox-kind. Base: torgal/ohmydate. Head: 82fb9ee.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-18.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...82fb9ee; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
FU-18 done on branch torgal/fu-18-inbox-kind (commits 75b31d4, 82fb9ee): Project.kind='inbox'|'normal' is now in contracts/OpenAPI/web schema, domain (kind + optional getInbox + softDelete Version capability), migration 0002 (kind check, partial unique, per-user inbox backfill via uuidv7(), task.project_id NOT NULL), InMemory/testkit inbox suite, API user creation (UserService + PgInboxRepository used by CLI and test seed), createTask->inbox, TaskService.remove using the returned version, and web inbox-by-kind/FU-19 fixes (busy-disabled dialog actions, If-Match-keyed rotation, focusin trap, conflictOpen counter, real-path overwrite test, MSW kind). Found: all exact tests pass (contracts generate exit 0, web gen:api exit 0, DATABASE_URL=... pnpm run ci exit 0 with 60 files/330 tests root + 12 files/65 web, check:api-client clean, boundaries 175 files/0 violations; api test 20 files/89 tests), and the only compatibility compromises are that domain Project.kind/getInbox are optional and inbox deletion is enforced as archive rejection because the forbidden Vikunja adapter still lacks ADR-018 and ProjectRepository has no delete operation. Left: the Vikunja adapter (separate task) must set kind and implement getInbox, M1-10's migration-0003 merge should keep the derived migrate.test convention, and no real browser/axe run was done (MSW only).

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only. DB planner_test only.
Focus: ADR-018 conformance (`git show torgal/ohmydate:docs/blueprint/13-ADR.md`), migration 0002 up/down + backfill correctness on a DB with existing users/tasks (orphans assigned), partial unique under concurrency (concurrent getInbox -> one inbox), contract change (kind required in responses, ProjectCreate cannot create inbox), web inbox-by-kind with explicit error state, FU-19/FU-20 items, tests not weakened (worker edited migrate.test.ts per coordinator convention). Note worker made domain Project.kind/getInbox OPTIONAL for Vikunja adapter compatibility — judge whether acceptable as interim.
