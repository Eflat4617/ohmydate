# REVIEW PACKET: FU-38dRR — Independent review of FU-38dR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-38c-redaction-scanner. Base: torgal/ohmydate. Head: e7feb7e.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-38dR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...e7feb7e; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-38d (FU-38c BLOCKED narrow fix) — GB-1 privacy gate, FIRST Sol review of the redesigned scanner. Branch torgal/fu-38c-redaction-scanner commit e7feb7e (merge candidate torgal/ohmydate...e7feb7e). Read: ADR-019 incl. amendments (5)-(11); docs/orchestration/packets/FU-38d.md; reviews FU-38cR-1.md and FU-38cR2.md.
Worker claims: CC_PHONE restored byte-identical to FU-32; separate 1-digit-area pattern (minDigits 8); out-of-scope shapes pinned via a named KNOWN_OUT_OF_SCOPE list; +cc regression corpus with separators/stripped joiners; seeded 2,600-case A/B (single/mixdigit/same2/same3/pairs/perms) zero regressions vs FU-32 snapshot; llm 425 pass; heavy perf 317s.
Narrow focus (medium effort):
1) Build your own A/B (fresh generator, not repo code) vs torgal/ohmydate (FU-32) at >= 50k cases across: single tokens all styles, +cc with separators/glued/stripped joiners (the FU-38cR2 HIGH list), same-kind 2/3, cross-kind pairs/perms. Report per-class token/glyph regressions (must be 0 outside the KNOWN_OUT_OF_SCOPE list) — this is the merge gate.
2) Confirm CC_PHONE_SOURCE equals the FU-32 snapshot text and the KNOWN_OUT_OF_SCOPE list matches ADR-019 (10)-(11) only (no extra silent exclusions).
3) Precision: short '+' numerics ('+1 2 2026', '+44 1 234'), versions/IPs/dates unchanged vs FU-32.
4) Linear time sanity at 1/2/4/8 MiB on 3-4 adversarial shapes (best-of-3).
5) One-paragraph GB-1 readiness statement.
HIGH only for disclosure regressions vs FU-32 or super-linear time.

