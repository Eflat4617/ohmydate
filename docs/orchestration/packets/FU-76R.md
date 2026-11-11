# REVIEW PACKET: FU-76RR — Independent review of FU-76R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-76-long-ai-calls. Base: torgal/ohmydate. Head: 3a3e107.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-76R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...3a3e107; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-76 + FU-54 (long AI calls: wizard wait UX, explicit cancel, reload resume, shutdown/orphan handling, abort spend settlement; implementer Opus 5.5 xhigh). Branch torgal/fu-76-long-ai-calls HEAD 3a3e107. Merge candidate torgal/ohmydate...3a3e107. Read docs/orchestration/packets/FU-76.md, the FU-54 row in FOLLOW-UPS, coordinator decisions in EXECUTION-LEDGER 04:33 (migration 0014 allowed; NO abort on client disconnect; cancel only explicit via POST :manual), full worker report docs/orchestration/reports/FU-76-report.md (git show torgal/ohmydate:...). Worker summary:
Did: FU-76 + FU-54 on branch torgal/fu-76-long-ai-calls (commits 3fabc49 llm, 5fb3138 api incl. migration 0014, e637856 web, 3a3e107 e2e+docs 08 §2.3.1). The web wizard now shows a calm wait (elapsed timer, milestone-only aria-live, focus kept) with 취소 / 직접 작성으로 계속 via POST :manual. A reload or lost connection resumes by GET polling or same-key create replay, and the client bound is 315 s, above the server's 270 s request and 300 s socket bounds. Server side: explicit :manual/:cancel or shutdown aborts the run, settles spend, and records agent_run 'cancelled'. Shutdown marks ai_interrupted, :resume retries it, and a startup sweep plus a lazy GET check catch orphans; a client disconnect never cancels. FU-54 (a)–(e) are all MET and itemised separately in the report. Found: every exact test passed: llm exit 0 (664 passed), api exit 0 (505 passed), web exit 0 (368), pnpm run ci exit 0 (root 2025 passed, boundaries 0 violations, build-smoke ok), pnpm run e2e exit 0 (27 passed incl. 2 new E2E-AI); the scheduler property flake did not reproduce. Left: the real gateway is unverified; the cancel registry is in-process (single-process deploy only); cancel during create replays the key and then goes manual, without aborting the ≤70 s detection call. Four existing migration chain tests were extended to unwind 0014 (no assertions relaxed), and e2e/global-setup gained one owner, a possible additive merge overlap with M6-03. Rollback: delete the branch; 0014 has a down script (cancelled -> failed). Full checklist, risks and test output are in the report.
Focus (medium, priority order):
1) Money: no double charge on reload/network loss (client disconnect never aborts; same-key replay; polling); explicit cancel/shutdown abort settles spend with actual usage and agent_run cost == ledger (FU-54); stale recovery committed separately from a budget-rejected reservation; PolicyLlm reservation bound and adapter share ONE message builder (outbound bytes <= reserved bound).
2) State machine: ai_cancelled / ai_interrupted transitions; :resume re-runs only on explicit user action; startup sweep + lazy GET check never mark a genuinely running call orphaned (threshold vs the 270 s request bound); single-process cancel registry documented.
3) Migration 0014: CHECK only, rollback/reapply with seeded rows (down maps cancelled -> failed); 4 migration chain tests extended, not weakened.
4) Scripted slow fake LLM (E2E knob): refused with a real provider and in production; cannot be enabled by request input. NOTE: M6-03 (another worker) adds a separate fake scenario LLM_FAKE_SCENARIO=e2e-grounded in config/app.ts — not a finding, but flag anything that would make the two knobs conflict.
5) Web: wait panel a11y (milestone-only aria-live, focus), cancel/manual paths keep inputs, client bound 315 s > server bounds, owner-change continuation drop (ADR-023 OwnerBinding).
Run: pnpm --filter @ohmydate/llm test ; pnpm --filter @ohmydate/api test once. Do not call the real gateway; do not read *api_key* files.
Round 1 of 2. HIGH for double charge, ledger/agent_run mismatch, stuck sessions, migration rollback failure, fake knob reachable in production.

