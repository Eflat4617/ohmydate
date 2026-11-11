# REVIEW PACKET: FU-38cR2R — Independent review of FU-38cR2
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-38c-redaction-scanner. Base: torgal/ohmydate. Head: 78ad667.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-38cR2.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...78ad667; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
ROUND 2 REVIEW of FU-38c (fix 78ad667 on top of 05dc09d). Previous: git show torgal/ohmydate:docs/orchestration/reviews/FU-38cR-1.md; ADR-019 incl. amendment (5)-(8). Worker report:
taskId=task_aa9c08f300bf dispatchId=ctx_6f94c3a16512 worktree=/home/torgal/orca/workspaces/oh_my_date/fu-38c-redaction-scanner branch=torgal/fu-38c-redaction-scanner commits=05dc09d+78ad667 (this round 78ad667a1f080974eb2b666d1fb0fdaa092c573b)
What I did: read FU-38cR-1 + ADR-019 amendments (5)-(8), added failing tests first (40 failures reproduced), then closed every actionable finding. Changed this round: packages/llm/src/privacy.ts (+218/-51) and packages/llm/test/privacy-gate.test.ts (+237/-51). index.ts, package.json, lockfile and fixtures unchanged.
Finding table (severity -> status -> fix -> pinning tests):
[HIGH] API-key body cap rejected 257..600-char bodies and ZWSP/ZWNJ/SHY/WJ/BOM-joined realistic keys -> FIXED. ADR-019 (5): a capped body that reaches L_max while the [A-Za-z0-9_-] run continues is accepted; union stage extends to run end via one precomputed Int32Array run-end (O(n)). Tests: sk-proj-164 joined to another key/120-char word by each stripped joiner, 3x93 github_pat ZWSP runs, single 257..600 bodies for sk-/ghp-/xoxb-/glpat-, plus gate corpus + FU-32 snapshot A/B.
[MEDIUM] MAX_SEPARATOR=32 / Bearer \s{1,32} lost long whitespace-run recall -> FIXED. ADR-019 (6): normalisation folds every whitespace-class run (space/tab/newline/U+3000/NBSP/other Zs) to one separator unit while keeping original coordinates. Tests: all five reviewer repros + deterministic runs 1..80 across 7 whitespace kinds for phone/RRN/Bearer.
[MEDIUM] Perf gate could not detect O(n^2) -> FIXED. ADR-019 (8): best-of-3 per size, ratio bound 3.0 per doubling. Added shapes: uniform super/sub, separator runs over old cap (space + U+3000), prefix-dense 'sk-', Bearer near-misses, glued ASCII phone chains. Heavy 2/4/8 MiB passes.
[MEDIUM] Adjacency right boundary accepted raw continuations -> FIXED. ADR-019 (7): a glued continuation counts only if it resolves itself (no further relaxation) and is a different kind. Pin: '301017393922089022553716133087249092', 'order 0101234567890123456789012', '3.14159265358979323846264338' stay unmasked. Same-kind glued numeric windows are deliberately not carved (FU-32 also left them unmasked; zero regression).
[MEDIUM] +82-2 / single-digit-area international phones leaked -> FIXED (not pinned). CC pattern now allows a 1-digit area group and up to 5 groups, with required separators after the area so trailing digit runs are not split. Verified '+82-2-1234-5678', '+82 2 1234 5678', '+82-2-123-4567', '+81 3-1234-5678', '+33 1 23 45 67 89'; existing shorter-end and precision negatives stay green.
[LOW] Oracle checked digits only -> FIXED: gate now asserts every core glyph of literal tokens (letters included) is found by the oracle and masked by the scanner.
[LOW] No input-size guard -> FIXED: exported MAX_REDACT_INPUT=1 MiB and assertRedactInputSize(text) from privacy.ts (no caller; index.ts unchanged by allowed paths), with boundary tests.
Gate update: same-kind key runs with stripped joiners at realistic (164/93) and over-cap (>256) lengths are in CASES, so they exercise both the independent oracle and the frozen FU-32 snapshot A/B; zero per-glyph regressions remains the assertion.
Tests (final code): `corepack pnpm --filter @ohmydate/llm test` -> exit 0, 8 files / 377 passed, 1 skipped (env-gated perf). `PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 corepack pnpm --filter @ohmydate/llm test` -> exit 0, 8 files / 378 passed, 427.35s. `DATABASE_URL=... VIKUNJA_URL=... corepack pnpm run ci` -> exit 0: typecheck+lint ok, root 91 files / 1112 passed + 28 pre-existing skipped, web 13 files / 69 passed, check:api-client clean, boundaries 239 files / 0 violations.
Risks/unverified: synthetic corpora cannot prove complete PII coverage; redaction remains best-effort per 05 §12. Heavy perf wall-clock is ~5-7 min (uniform 8 MiB super/sub runs dominate) under load. Whitespace folding only covers whitespace-class runs; long non-whitespace separator runs (dash/dot) remain L_max-bounded. MAX_REDACT_INPUT is not wired to a caller yet (intentional). No new contracts or exports from index.ts; rollback: revert 78ad667 (or delete the branch, which also drops 05dc09d).
Narrow focus (re-run your round-1 harness; do not redesign):
1) Re-run your 216k A/B vs FU-32 plus the round-1 HIGH/MEDIUM repros (key cap + stripped joiners + >256 bodies; separator runs 1..80; adjacency benign digit runs; +82-2 family). Report per-class token/glyph regressions (must be 0) and the benign-corpus over-mask rate vs base.
2) Whitespace folding: any new false negative/positive where folding merges tokens across lines (e.g. '010\n\n1234-5678' in a table, or two separate numbers on adjacent lines forming a fake RRN)? Precision negatives unchanged.
3) New CC pattern (1-digit area, up to 5 groups): new over-masking of benign content (dates '+1 2 2026', scores, versions, IPs)?
4) Perf: max per-doubling ratio best-of-3 on your adversarial shapes.
5) GB-1 readiness statement.
Round 2 of 2: HIGH only for disclosure regressions vs FU-32 or super-linear time; else APPROVE with follow-ups.

