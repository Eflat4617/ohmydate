# REVIEW PACKET: FU-39RR — Independent review of FU-39R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-39-scheduler-history. Base: torgal/ohmydate. Head: cadeac4.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-39R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...cadeac4; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
Worker claims (FU-39, DeepSeek high, commit cadeac4; sources docs/orchestration/reviews/M3-02cR-1.md and 06 §7.1 "이력 전용 위반 면제" decided 2026-11-11):
- validate.ts: H1 only for overlaps involving an audited block; H6 cap/break only for days/runs containing an audited minute (history minutes still counted there).
- Input: NaN/Infinity/non-integer minutes rejected (invalid_estimate for task minutes, invalid_input for prefs), cap 100000 min.
- All-infeasible fallback ranks deficitMin, then violations, then retained seeds. GENERATOR_VERSION m3-02.4.
- Tests: C1, C2, C3, C3b, C4, C5 feasible + 3 negatives; 1e400 Infinity; fallback regression; widened advance-now property (caps/breakAfter vary, deps, commitments, <=6 tasks); heavy timeout scales with SCHED_HEAVY_RUNS; ORACLE_MAX_TRANSITIONS guards; golden count wording.
- The property test's independent H1 oracle (independentH1Violation) now takes history + candidate blocks to apply the exemption.
- scheduler 123 tests, SCHED_PERF_ASSERT=1 pass, ci 1055 pass.
THIS REVIEW IS ALSO FU-08 (first Sol post-review of the WHOLE scheduler, previously approved only by the Opus fallback: M3-01b ADR-017 time partitioning, M3-02 candidates/replan/history contract, M3-02c, FU-39). Focus:
1) The oracle change must not weaken H1 beyond the 06 §7.1 exemption: an audited block overlapping a commitment/locked/history must still be caught; verify by mutation (disable validator H1 for audited blocks -> property must fail).
2) H6 exemption edges: day containing history + audited where total > cap; run crossing history->audited across midnight/DST; history-only run adjacent to an audited block with < breakMin gap.
3) Independent re-derivation of 06 §3 H1–H8 + §7.1 on DST/odd-offset zones (Santiago midnight gap, Goose_Bay midnight fold, Lord_Howe 30-min DST, Kathmandu, Chatham) with your own oracle; 10k+ random cases; report any returned candidate violating a hard constraint.
4) Determinism (G12 byte-identical), seed handling, perf p95 < 500ms (50 tasks/14 days/3 policies) under SCHED_PERF_ASSERT=1.
5) Replan contract (06 §7): changedBlocks bound, locked/past/in-progress fixed, seed invalidation rules.
6) Input validation completeness vs contracts (any finite-but-absurd value causing pathological time/memory).

