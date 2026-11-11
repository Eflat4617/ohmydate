# REVIEW PACKET: FU-38dR2R — Independent review of FU-38dR2
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-38c-redaction-scanner. Base: torgal/ohmydate. Head: 8f2db58.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-38dR2.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...8f2db58; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
ROUND 2 REVIEW of FU-38d (fix 8f2db58 on top of e7feb7e) — GB-1 privacy gate. Previous: git show torgal/ohmydate:docs/orchestration/reviews/FU-38dR-1.md. Merge candidate torgal/ohmydate...8f2db58. Worker report:
FU-38dR-1 report
taskId=task_6558e722dfb7 dispatchId=ctx_48c695dda0c2
worktree=/home/torgal/orca/workspaces/oh_my_date/fu-38c-redaction-scanner branch=torgal/fu-38c-redaction-scanner
base=e7feb7e commit=8f2db58e7a9bb269beda311943d38b3b3a7ba32f (single commit)
changed paths: packages/llm/src/privacy.ts, packages/llm/test/privacy-gate.test.ts (both inside ALLOWED PATHS)

Reproductions (before -> after, all now equal FU-32):
- "x\n\n010-1234-5678": head span [4,16) output "x\n\n0[REDACTED_PHONE]" -> now span [3,16) output "x\n\n[REDACTED_PHONE]".
- "intro" + 30 spaces + "010-1234-5678" + 5x" following prose ": head span [64,78) left the phone visible -> now span [35,48) masks the phone.

Finding table:
[HIGH] Compact ASCII whitespace-fold map converted original offsets twice -> FIXED. recordSpan gets an original offset from sourceAt, and compact charStart/charEnd indexed compactSource again. Compact maps are pure ASCII, so a char index already equals its original code-unit offset; the shared charStart/charEnd helpers now return it unchanged (and +1 for the end) for both ascii and compact maps, while the generic chars map still resolves via map.chars. The compact path is retained because the generic per-char map path was ~203 ms for 1 MiB ASCII prose vs FU-32 ~17 ms (>3x); current compact lazy path is ~1.8x.
[MEDIUM] A/B exemptions were broader than ADR-019 (10)-(11) -> FIXED. A/B now exempts only the explicitly named same-kind glued numeric pairs and triples (ADR-019 (10)). The glued ghp_ pair was removed from the no-regression exemption (FU-32 parity passes the baseline comparison). Oracle must-mask exceptions are a separate set (ADR cases + ghp_ pair). The generated-corpus blanket prefix/suffix predicate no longer skips glued permutations; only same2/same3 glued numeric windows remain exempt.

Added tests:
- Exact original spans + per-non-whitespace-glyph coverage for phone (+cc too), RRN, email, sk/tk/pk, ghp_, github_pat_, glpat-, AKIA, xoxb-, AIza and Bearer after LF/CRLF paragraphs, spaced tabs, 40 spaces, and long mixed whitespace, always with trailing prose.
- Exact spans for folded whitespace inside phone/RRN groups and between multiple tokens (phone+RRN, email+phone, key+phone).
- Seeded 2,400-case whitespace-context A/B vs FU-32 (folded whitespace before/inside/after, ASCII paragraph breaks plus U+3000/NBSP/U+2003), zero per-glyph regressions.

Tests (command -> exit -> key output):
- corepack pnpm --filter @ohmydate/llm test -> exit 0 -> 8 files passed, 436 passed / 2 skipped (438), 3.16 s.
- PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 corepack pnpm --filter @ohmydate/llm test -> exit 0 -> 8 files, 438 passed, 376.16 s.
- DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci -> exit 0 -> typecheck+lint ok; root 91 files / 1171 passed / 29 skipped (1200); web 13 files / 69 passed; check:api-client clean; boundaries 239 files / 0 violations.

Risks/unverified: synthetic corpora cannot prove complete PII recall; the glued realistic ghp_ pair remains unmasked by both FU-32 and head (A/B parity, oracle-only exception); non-whitespace separator runs >32 remain out of scope per ADR-019 (11); MAX_REDACT_INPUT still has no caller; heavy wall-clock is ~6.3 min under the 20 min timeout. No new contracts/exports. Rollback: git reset --hard e7feb7e.
Narrow focus (medium effort):
1) Re-run your round-1 whitespace-context A/B (seed 0x128acf21, 60k) AND the first 62k A/B vs FU-32: per-class token/glyph regressions must be 0 outside the named ADR-019 (10)-(11) list. Re-run both direct reproductions.
2) Confirm the exemption sets: A/B exemptions = only ADR-019 (10) named same-kind glued numeric windows (+ (11) separator runs); oracle-only exceptions separate; no blanket predicate.
3) Quick perf sanity (1 MiB ASCII prose with paragraphs vs FU-32; one adversarial shape 1/2/4/8 MiB).
4) GB-1 readiness statement (scanner only; scope/consent notice is a separate user decision).
Round 2 of 2: HIGH only for disclosure regressions vs FU-32 or super-linear time; else APPROVE with follow-ups.

