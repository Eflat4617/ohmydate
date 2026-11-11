# REVIEW PACKET: FU-52RR — Independent review of FU-52R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-52-deepseek-llm. Base: torgal/ohmydate. Head: 66f85e4.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-52R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...66f85e4; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-52 — product LLM adapter (ADR-022 + amendments 1–2): OpenCode Go DeepSeek (deepseek-v4.1-flash, reasoning medium), budget, consent, input guard, x-opencode-session header. Branch torgal/fu-52-deepseek-llm commits 47c6311, b217b53, 57487fc, 66f85e4. Merge candidate torgal/ohmydate...66f85e4. Read: docs/blueprint/13-ADR.md ADR-022 (+ amendments), docs/orchestration/packets/FU-52.md, ledger 14:44 scope amendment (settings/user repo/intake wiring), 05 §8/§9/§12, 09 §6–§7.
SECURITY: do NOT read, print or copy any secret file (*api_key*.txt, deploy/secrets/**). Do NOT call the real gateway; the coordinator already ran a live smoke with synthetic input (success: deepseek-v4.1-flash, 5.7 s, 201/221 tokens, $0.00016, schema-valid output; earlier 400 MissingSessionID without the header).
Focus (medium effort, priority order):
1) Secret handling: key read once from LLM_API_KEY_FILE, fail closed on missing/empty/group-or-world-readable file, never in logs/errors/problem details/agent_run/snapshots (try a synthetic key marker through every error path: 401, 429, 500, timeout, malformed JSON, MissingSessionID).
2) Session header: HMAC-derived, stable per intake session, different across sessions, no raw ids/key; sent only to opencode.ai; the session secret — is it stable across restarts (random per boot breaks caching but not correctness) and never logged?
3) Budget + consent: no outbound call without consent; budget computed from usage x configured prices; caps enforced before the call (estimated) and after (actual) per day/month per owner; budget_exceeded -> manual path; settings PATCH validation; other owner isolation.
4) Redaction + FU-49 input guard applied to EVERY outbound payload (system + untrusted blocks), structured output still schema-validated -> proposal only.
5) The shutdown-settlement test change: the ordering assertion indexOf('unsettled operations') < indexOf('DB_DESTROYED') was replaced by membership checks. FU-42c REQUIRES "DB destroyed only after the unsettled log/cleanup". Verify the worker's claim (pino async flush vs direct stdout write) and whether the ordering is still guaranteed and tested some other way (e.g. timestamps or a structured event order); if the ordering guarantee is no longer tested, that is a HIGH test-weakening finding unless an equivalent assertion exists.
6) Retries only 429/5xx, 30 s timeout, JSON-mode fallback without loops; CI uses FakeLlm only (no network).
Round 1 of 2.

