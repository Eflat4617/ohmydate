# TASK PACKET: FU-38d — restore FU-32 CC_PHONE + separate 1-digit-area pattern (FU-38c BLOCKED)
Role: worker-backend (privacy). Base: EXISTING branch torgal/fu-38c-redaction-scanner at 78ad667 (worktree fu-38c-redaction-scanner).
Read FULLY: ADR-019 incl. amendments (5)-(11) (git show torgal/ohmydate:docs/blueprint/13-ADR.md); docs/orchestration/reviews/FU-38cR2.md (all evidence).

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

ALLOWED PATHS: packages/llm/src/privacy.ts, packages/llm/test/** only.
REQUIRED
1) HIGH: CC_PHONE_SOURCE (and its minDigits / shorterEnd / exact behaviour) byte-for-byte identical to FU-32 (packages/llm/test/fixtures/privacy-fu32-snapshot.ts). Add the 1-digit-area international form as a SEPARATE pattern with its own L_max, shorterEnd, exact and minDigits >= 8 (LOW: '+1 2 2026', '+1 2 2026-11-11', '+1 2-12-2026', '+5 1 23 45', '+1 2 34 56', '+1 2 3456', '+12 3 4567', '+44 1 234', '+9 9 99 99' must stay unmasked). Keep '+82-2-1234-5678', '+82 2 1234 5678', '+82-2-123-4567', '+81 3-1234-5678', '+33 1 23 45 67 89' masked. Add gate + FU-32 A/B specs with a separator after cc and glued/stripped-joined groups: every string in the review HIGH evidence list (e.g. '+82 1012345678', '+82-10-1234<ZWSP>5678', '+1 4155552671', '+44 20 71838750', SHY/ZWNJ/WJ variants) — all fully masked.
2) MEDIUM corpus: restore '' (glued) in the same-kind pair loop and the rrn/phone/rrn triple loop of the gate; per ADR-019 (10) the out-of-scope shapes are pinned as knownLimitations tests with their exact current output ('900101-1234567900101-1234567', glued 010/02/070 pairs, the 3+ glued chains from the review) and EXCLUDED from the zero-regression assertion only by an explicit named list (not by dropping corpus generation).
3) MEDIUM separators: per ADR-019 (11) pin '010'+33x'-'+'1234-5678', '900101'+' -'x17+'1234567', '010'+40x'.'+'1234.5678' as knownLimitations; fix the privacy.ts doc comment wording.
4) LOWs: extendWordRun only when rawEnd-start reached the pattern cap (document); restore an ASCII fast path when only whitespace folding is needed (fold inside the fast path or lazily build the map) — 1 MiB ASCII prose with paragraphs within 3x FU-32 time; heavy perf test timeout scales with sizes or reduce heavy shapes so it finishes well under its timeout.
5) Zero per-glyph regressions vs FU-32 in every in-scope class remains the merge condition; repo gate must reproduce the reviewer's 216k-style A/B classes (single, mixdigit, same2/same3, pairs/perms) at a reduced seeded size.
Run and paste: pnpm --filter @ohmydate/llm test ; PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 pnpm --filter @ohmydate/llm test ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456). worker_done with finding table.
Retry limit 2. Rollback: reset branch to 78ad667.
