# REVIEW PACKET: FU-24R — Independent review of FU-24
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-24-redaction. Base: torgal/ohmydate. Head: dcea051.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-24.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...dcea051; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
taskId=task_510316841606 dispatchId=ctx_4b8da05794f3
worktree=/home/torgal/orca/workspaces/oh_my_date/fu-24-redaction branch=torgal/fu-24-redaction commit=dcea051 (base 7be66d0)
changed: packages/llm/src/privacy.ts, packages/llm/src/budget.ts, packages/llm/test/privacy.test.ts, packages/llm/test/budget.test.ts (4 files, +607/-33)
diff summary: (1) rejected matches retry at start+1 instead of lastIndex=end, with a class-(a) regression table; (2) the +cc phone pattern gets a trailing-digit-lookahead second pass so a rejected greedy group count shortens (class-(b) table); (3) \b and the word/plus lookbehind are removed from regexes and re-evaluated against original chars (ZWSP-joined phones/keys, ①/² before +/sk-) plus a non-ASCII no-match fast path; (4) knownLimitations now lists >320-char runs/URL query and >63-char labels with asserting tests; (5) budget allow-list exempts only usd===undefined and validates allowUnpricedModels as string[].
REQUIREMENT CHECKLIST: (1) met incl. deterministic 20,009-case fuzz (17 seeds, fullwidth, 20 default-ignorables, astral/㈜/U+FDFA/combining/CJK/circled/superscript neighbours), 0 leaks; (2) met; (3) met; (4) met; (5) met; perf met.
TESTS (real exits): corepack pnpm install --frozen-lockfile -> 0 (restored vue-tsc; no lockfile change). corepack pnpm --filter @ohmydate/llm test -> 0, 7 files/211 passed. corepack pnpm --filter @ohmydate/llm typecheck -> 0. corepack pnpm run ci -> 0, 0, 0 (three consecutive final runs): root 53 passed|13 skipped files, 658 passed|88 skipped tests, web 11 files/60 passed, check:api-client OK, boundaries 193 files/0 violations. Perf probes: 100KB astral 1.8ms; dotted 0.9ms; 100KB emails 9.4ms; 10K phones 8.1ms; ZWSP-joined 18.6ms.
RISKS: intermediate CI attempts before the final tree flaked once each on the pre-existing 50ms '100KB astral emoji' perf assert (56.8/67/61ms under host load ~6-10); the final fast path cuts that case to ~1.8ms and the last 3/3 full CI runs were green at load 7.7-9.9. shorterEnd may over-mask an extra adjacent digit run (privacy-safe). Unverified: no real provider exists, so costUsd reporting is still untested against a real port. Contracts for dependents: record() on an allow-listed model with NaN/negative cost now exhausts; constructor throws TypeError for a non-array/non-string allowUnpricedModels. Rollback: revert dcea051.

REVIEWER: Claude Opus 5.5 xhigh FALLBACK. Add "reviewer=opus-fallback" after VERDICT. Read-only; /tmp probes only.
This gates enabling a real LLM provider. Re-run every input class from `git show torgal/ohmydate:docs/orchestration/reviews/M2-01cR-1.md` (a)/(b)/LOW lists, your own 20k fuzz with a different seed, perf probes, and full pnpm run ci x2. Report recall honestly (leaks per class). Convergence: APPROVE unless HIGH/CRITICAL.
