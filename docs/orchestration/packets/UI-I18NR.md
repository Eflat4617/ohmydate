# REVIEW PACKET: UI-I18NRR — Independent review of UI-I18NR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/ui-i18n-ko. Base: torgal/ohmydate. Head: e46f0af.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/UI-I18NR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...e46f0af; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of UI-I18N (Korean UI, typed i18n catalog, Intl formatting; implementer Opus 5.5 xhigh). Branch torgal/ui-i18n-ko commit e46f0af. Merge candidate torgal/ohmydate...e46f0af. Read: docs/orchestration/packets/UI-I18N.md; worker report docs/orchestration/reports/UI-I18N-report.md (git show torgal/ohmydate:...); Korean screenshots apps/web/docs/ui-polish/after-ko/. Worker summary:
Did: added a bundled, typed ko i18n layer (apps/web/src/i18n: t/tp with typed keys+params, plural API, Messages contract, I18nT, html lang=ko) and moved all UI copy, aria text, toasts, notifications and all 19+unknown problem codes to natural 해요체 Korean, with Intl date/time/range/duration/USD formatters replacing every raw-minute display and a shared consent/AI-settings disclosure (OpenCode Go DeepSeek, data sent, best-effort masking, revoke anytime); commit e46f0af on torgal/ui-i18n-ko. Found/verified: web test exit 0 (240 passed, +47 new incl. formatter DST/edge, catalog completeness + English-copy scanner, FU-60 request-based wait), web build exit 0, pnpm run ci exit 0 (1521 passed/29 skipped + web 240, boundaries 0), pnpm run e2e exit 0 (23 passed; first run caught one English prompt assertion in E2E-2, fixed and re-run), MSW sweep after-ko 130 visits 0 critical/serious 0 overflow. Left: server free text without codes (scheduler explanations, violation messages) is still shown as original marked lang=en and would need server-side codes for full Korean; full report with checklist, risks and rollback is at the report path.
Coordinator note: server free text (scheduler explanations, violation messages) staying English is tracked as FU-62 — not a finding here.
Focus (medium effort): (1) many existing test assertions changed from English to Korean names — verify each changed assertion keeps the SAME coverage (no assertion removed or loosened, e.g. regex widened to match anything); (2) typed catalog: missing key fails typecheck/test; English-copy scanner meaningful; (3) formatters: duration (0, negative, >1 day, signed), DST day, ranges, USD 2–4 decimals; tz handling via the user tz; (4) consent/AI settings disclosure content accurate (OpenCode Go DeepSeek, data sent, best-effort masking limits, revoke); (5) a11y: lang=ko, accessible names still unique/meaningful, axe sweep 0; (6) run web tests + full e2e once.
Round 1 of 2. HIGH for weakened tests, behaviour regressions, a11y critical/serious, misleading consent text.

