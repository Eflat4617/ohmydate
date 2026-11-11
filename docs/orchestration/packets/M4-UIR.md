# REVIEW PACKET: M4-UIRR — Independent review of M4-UIR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/m4-ui-integration. Base: torgal/ohmydate. Head: e7e5987.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/M4-UIR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...e7e5987; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of M4-UI (Today/Focus/Review/Notifications UI = M4-03, first review, integrated with the real M4 API; E2E-4). Branch torgal/m4-ui-integration: merge 89c3383 (torgal/m4-03-today-ui) + e7e5987. Merge candidate torgal/ohmydate...e7e5987 (apps/web/**, e2e/**). Read: docs/orchestration/packets/M4-UI.md, M4-03.md; 07 §3.1/§3.4 + offline rules; 08 §2.5/§2.9; 11 E2E-4. Worker report:
M4-03 is merged into torgal/m4-ui-integration (merge 89c3383, integration commit e7e5987) and the UI now reads real M4 data: gen:api is current, Today uses GET /schedule-blocks for approved cards, Focus restores via GET /sessions/{id} and Today resumes via GET /sessions?state=active, today-proposal approval sends availability If-Match, MSW gained the same session/schedule reads, and a read-only Approved schedule section was added to plan comparison. E2E-4 (new e2e/tests/e2e-4-today.spec.ts, second synthetic owner for isolation) proves approved plan -> Today -> keyboard start/pause/resume/complete -> review/estimation feedback -> one session-reminder notification across a second sweep/reload -> dismiss persists, plus offline pause/resume replay exactly once (server version 3), with zero critical/serious axe issues on Today/Focus; final commands were web test exit 0 (23 files/131 tests), web build exit 0, pnpm run ci exit 0 (121 files/1424 pass, 29 skipped; web 131; typecheck/lint/api-client/boundaries/build-smoke green), and pnpm run e2e exit 0 (10 passed, 3.3m). Risks: notification E2E waits ~65s for the real leader sweep because no API test hook exists, two earlier CI attempts flaked only on unrelated timing tests under load average 16 before the final green run, Today shows up to 3 approved blocks from any active plan so actions on older plans can 422 (isolated in E2E), and no new contracts are needed; rollback is reverting e7e5987/89c3383 or deleting the branch.
Focus (medium effort):
1) Worker-stated UX risk: Today shows up to 3 approved blocks from ANY active plan, so actions on blocks of older plans can 422. Is this a correctness bug vs 07 §3.1 (Today = today's blocks of the user's current schedule)? Recommend the fix (e.g. only blocks of each plan's current version / dedupe by task) — HIGH if a normal user flow produces errors.
2) Offline Focus journal: exactly-once replay against the real API across reload and tab close (IndexedDB), pre-minted keys reused, ordering with clock clamping; other mutations disabled offline; no secrets/notes stored in IndexedDB beyond what is needed (review note never stored offline unless documented).
3) E2E-4 integrity: no DB writes or private hooks; the 65 s wait relies on the real leader sweep — acceptable? Dedupe asserted after a second sweep + reload.
4) Security/UI rules: no v-html, problem+json rendered as text, push opt-in only after permission, keys never in localStorage.
5) Run pnpm run e2e once yourself.
Round 1 of 2. HIGH for data corruption, security, a normal-flow error, or E2E not testing the real flow.

