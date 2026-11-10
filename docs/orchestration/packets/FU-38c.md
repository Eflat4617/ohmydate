# TASK PACKET: FU-38c — redaction scanner redesign (ADR-019), GB-1 gate
Role: worker-backend (privacy). Base: torgal/ohmydate HEAD (FU-32 state; FU-38 branch NOT merged and must NOT be merged or cherry-picked wholesale).
Read FULLY first: docs/blueprint/13-ADR.md ADR-019; docs/orchestration/reviews/FU-32R-1.md, FU-38R-1.md, FU-38R2.md (all repros); docs/blueprint/05-AI-AGENT-SPEC.md §12; packages/llm/src/privacy.ts and its tests. You MAY read torgal/fu-38-redaction-lows for ideas (git show torgal/fu-38-redaction-lows:packages/llm/src/privacy.ts) but every reused idea must pass the gate below.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets, calling paid external APIs other than your own model.
3. Commit your work on your branch with Conventional Commits; include "Task: <taskId>" in the body.
4. Run every command in "Exact tests" and paste the real exit codes and tail output. Never claim a test passed
   that you did not run. If you could not run something, say SKIPPED + reason.
5. Send heartbeat if Orca's preamble asks for it.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
   (if your Orca preamble gives a different exact worker_done form, the preamble wins)
REPORT (body)
- taskId, dispatchId, worktree path, branch, commit SHA(s)
- changed paths (git diff --name-only <base>...HEAD) and 3–8 line diff summary
- requirement checklist: each acceptance item -> met / not met
- tests: command -> exit code -> key output lines
- risks, unverified items, new contracts needed by dependents, rollback method

ALLOWED PATHS: packages/llm/src/privacy.ts (and new packages/llm/src/privacy/** modules if you split it), packages/llm/test/** only. Public exports (packages/llm/src/index.ts) unchanged.
REQUIRED
1) Scanner per ADR-019: every pattern explores every candidate start (after an accepted match continue at the next candidate start, never at match end); per-pattern max match length L_max documented; final mask = union of accepted spans mapped back to original coordinates; deterministic kind label priority on overlaps; span extensions (super/sub runs) only in the union stage.
2) Keep FU-32 behaviour as the floor: every existing privacy test stays green (no weakened/removed assertions).
3) Repros as tests (all must fully mask every core glyph): FU-38R-1 HIGH ('⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷' with glued/ZWSP/ZWNJ/U+00AD/space), FU-38R2 HIGH-1 ('⁰¹⁰¹²³⁴⁵⁶⁷⁸​900101-1234567' + ZWNJ/U+00AD/glued), FU-38R2 HIGH-2 ('⁴³⁶⁰¹⁰⁸⁷⁵³⁷⁵⁸​019-1463-3169', '₁₂₄₀₅₂₅₇₄₄₇₃₃­031-7225-9762'), the FU-32R/FU-38 LOW examples (circled markers, glued phone + ⑳/㉑).
4) GATE test suite in repo (seeded, deterministic, bounded runtime; heavy sizes behind PRIVACY_HEAVY=1): an INDEPENDENT reference oracle (simple per-start brute-force matcher over the normalized text, written separately from the scanner) + per-core-glyph coverage assertions over: single tokens of every kind/style (Nd, fullwidth, super, sub, per-digit mixtures); same-kind 2- and 3-token runs; CROSS-KIND adjacency in both orders (RRN<->phone, phone<->email, phone<->API key, 3-token permutations); separators glued/space/ZWSP/ZWNJ/U+00AD. The scanner must mask at least what the oracle finds for every supported shape. Also an A/B vs the FU-32 implementation snapshot (copy it into test/fixtures as a frozen reference module) asserting zero per-glyph recall regressions.
5) Precision negatives stay unmasked: 'E=mc²', 'x₁…x₁₀', footnotes after words ('결과¹²³'), years '²⁰²⁶', 'H₂O', '10⁻¹²³⁴'; pin attached-suffix tradeoffs.
6) Mixed super/sub + Nd tokens ('¹²³⁴⁵⁶-1234567', '⁰¹⁰-1234-5678', '¹⁹00101¹²³⁴⁵⁶𝟕'): mask fully if the gate stays green; otherwise knownLimitations with explicit tests and say so.
7) Perf: linear to 8 MiB for the adversarial shapes listed in FU-38R2 (overlapping super runs, alternating super/ASCII, long ZWSP chains, many retries) — assert scaling ratio bound in a perf test behind PRIVACY_PERF_ASSERT=1.
Run and paste: pnpm --filter @ohmydate/llm test ; PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 pnpm --filter @ohmydate/llm test ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456).
Retry limit 2. Rollback: delete branch.
