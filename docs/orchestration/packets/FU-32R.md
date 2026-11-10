# REVIEW PACKET: FU-32R — Independent review of FU-32
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-32-nd-digits. Base: torgal/ohmydate. Head: 072678f.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-32.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...072678f; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
FU-32 complete on branch torgal/fu-32-nd-digits (worktree /home/torgal/orca/workspaces/oh_my_date/fu-32-nd-digits), commit 072678f. Changed packages/llm/src/privacy.ts and packages/llm/test/privacy.test.ts: isOriginalDigitChar now tests /^\p{Nd}$/u (math-bold/double-struck/sans/sans-bold/monospace/segmented start digits mask); super/subscript-only phone/RRN tokens are masked when every digit is super/subscript while markers and mixed tokens stay; seeded fuzz gained a 50% styled-digit transform with per-char coverage; tests grew 195->246. Requirements: (1) Nd start met; (2) regressions met (36 styled cases 0 leaks, marker math-RRN preserved); (3) styled fuzz met, 0 leaks; (4) super/subscript decision met (masked when all super/sub, mixed documented+tested). Tests: pnpm --filter @ohmydate/llm test -> EXIT 0 (7 files, 305 passed); pnpm run ci -> EXIT 0 twice (61 passed/18 skipped files, 778 passed/123 skipped; web 13 files/68; boundaries 217 files, 0 violations). Note: one earlier CI run failed the 50ms perf assert at load average ~285 (73ms) and another failed web vitest worker startup under the same load; both reran clean at lower load. Risks: mixed super/subscript+real-digit numbers remain unmasked by design; perf asserts are load-sensitive; no new contracts/API changes; rollback is git revert 072678f.

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only.
Last gate before a real LLM provider (GB-1). Re-run FU-24R-3 styled-digit probes and your 120k fuzz incl. styled digits; re-run all perf shapes at 100KB/1MB (new super/subscript path must stay linear); check markers stay boundaries. Convergence: APPROVE unless HIGH/CRITICAL.
