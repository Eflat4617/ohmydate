# REVIEW PACKET: FU-38RR — Independent review of FU-38R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-38-redaction-lows. Base: torgal/ohmydate. Head: 04809ca.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-38R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...04809ca; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
Worker claims (FU-38, DeepSeek high, commit 04809ca; source docs/orchestration/reviews/FU-32R-1.md):
- LOW-1: all-super/sub check counts only Nd digits as real -> circled-marker cases mask whole.
- LOW-2: accepted super/sub match extended over its contiguous super/sub run (marker before RRN no longer leaks last digit).
- LOW-3: generic shorter-group retry with exact validation for Korean/082 phone patterns (glued phone + ⑳/㉑).
- Tests: LOW cases, negatives ('²⁰²⁶','H₂O','10⁻¹²³⁴') unmasked, mixed shapes pinned as knownLimitations ('⁰¹⁰-1234-5678','¹²³⁴⁵⁶-1234567'), outlined U+1CCF0 digits, super/sub perf case, super/sub fuzz transform, makePhone separator omission.
- llm tests 332 passed; ci exit 0 (1020 passed/27 skipped) on rerun after an unrelated DB 5s timeout.
Coordinator focus asks:
1) Regression A/B vs torgal/ohmydate with an independent fuzz (incl. the reviewer's 120k distribution): recall must not drop for any class; report precision changes (LOW-2 run extension may over-mask adjacent super/sub text such as footnote markers or exponents).
2) LOW-3 shorter-group retry: any catastrophic backtracking / super-linear behaviour on long digit runs (perf to 8MB as before)?
3) Are the knownLimitations acceptable before GB-1 real provider (these are the last privacy gates)? Recommend any that must be fixed.
4) Exports/index unchanged; no logging of matched text.

