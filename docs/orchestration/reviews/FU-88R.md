# FU-88R (ctx_84f4f355b34e, Fable 5.2 xhigh — Sol weekly limit; implementer DeepSeek) — APPROVE

REVIEW VERDICT: APPROVE
(Round 1 of 2. Reviewed torgal/ohmydate...95e64a4, merge-base 02129fe, one commit; reviewer Fable 5.2. No CRITICAL/HIGH: the perf gate is not vacuous, the out-of-window PATCH fix holds, no test was weakened. One MEDIUM suggestion: the timing half of the gate cannot see a window-only revert at this shape; a validated stricter shape is below and is a ~3-line change worth folding into the batch. Three LOWs.)

Findings (most severe first):
  [MEDIUM] The relative timing assertion cannot detect a window-only revert at the 5,000 / 2,000 shape; only the sampleCount assertions do
    Evidence: services/api/test/estimation-profile-bound.test.ts:124-166 (assertion :165, comment :154-157). Scratch copy of services/api outside the worktree, same measure loop, size assertions replaced by a log:
      - SQL LIMIT removed, current O(n) classifier, test's own order (small owner first), 3 runs: cpu ratio 1.29 / 1.29 / 1.09. Warm, alternating order: 1.49-1.76. Never near 2 (worker reported 1.58).
      - HEAD bounded, the real test 14 times: 0.56-0.78. It sits below 1 because the 2,000-row owner is timed first after a single warm-up request (23-27 ms cold vs 14-16 ms once warm); warm ratio is 1.00-1.03. The cold baseline widens the effective threshold to about 3x.
      - Not vacuous: with the pre-FU-64 classifier (619c3f9^ estimation.ts, O(n^2)) and the LIMIT removed the ratio is 9.54 (test order) / 6.13, so :165 fails. With current code the test as a whole still fails on a LIMIT revert, at :146 (sampleCount 5,000), which duplicates the first test.
      - Stable under load: 6/6 passes idle, 8/8 under 24 busy loops (load ~20); CPU ms itself rose 2.5-3x under load, the ratio did not move.
    Suggestion (not blocking): seed the big owner with 20,000 rows and warm both owners before timing either (or alternate the order). Measured with that shape: bounded 0.57-1.09 (idle and loaded), LIMIT removed 3.84-6.83 (idle and loaded), so 2x has margin on both sides; seeding adds ~2.5 s. Correct the comment at :154-157, which implies the revert pushes the ratio over the gate.

  [LOW] An out-of-window PATCH no longer persists the target row's reclassified quality
    Evidence: services/api/src/adapters/pg-estimation-store.ts:111-115. plan.qualities now covers window rows only, while the response still classifies window + target (estimation-service.ts:293-298). Probe (2,001 rows, oldest row stored with quality 'excluded', PATCH excluded=false): HEAD answers quality 'ok' and leaves the column 'excluded'; the base refresh rewrites it to 'ok'. The export reads the column (pg-export-store.ts:399). No effect on estimates or template stats; reachable only through a stale client or direct API.
    Suggestion: say so next to the :111 comment, or write the target's quality from the response classification.

  [LOW] The shared fixture result is computed at module scope
    Evidence: packages/scheduler/test/fu64-68.test.ts:156. The cost is fine: generate(MULTI_REPLAN_INPUT) 0.27 s CPU (the base 5-task / 14-day fixture: 1.51 s on today's unthrottled host; R2's 13.5 s was the throttled host); the two tests run in 433 ms and 76 ms. But a throw there fails collection of the whole file instead of one test, and the cost sits outside any test timeout.
    Suggestion: beforeAll or a lazy memo.

  [LOW] The contracts test imports another package's src by relative path
    Evidence: packages/contracts/test/explanation.test.ts:12 ('../../scheduler/src/generate.js'); the only cross-package relative import in the test trees. typecheck, lint and check:boundaries pass. packages/scheduler/src/index.ts was outside ALLOWED PATHS, so this was the in-scope option.
    Suggestion: export MAX_DIVERSITY_NOTE_LENGTH from the scheduler index in a later change and import it from '@ohmydate/scheduler'.

Focus results: (1) See MEDIUM. (2) 4 tasks / 3 days yields ['diversity_distinct','replan_bound_exceeded'] (note 237 chars), the same codes as the base fixture, so the expected-code assertions are untouched; the diff removes only the two ", 30_000" arguments and the two generate(MULTI_REPLAN_INPUT) calls; no 30 s override remains. (3) generate.ts:65-76: a kept unpaired line returns items [] and the note keeps every sentence (test at fu64-68.test.ts:250); generate.ts:318 deletes diversityNoteItems. The base note and its item are always produced together (generate.ts:3834-3847), so no partially coded note remains; an unpaired line is still unreachable through generate(). (4) The new test discriminates: against the old refresh in scratch it fails (after the un-exclude: {sampleCount:1, meanRatio:1, p90Ratio:1, source:'estimator@1'}; after a plain refresh: {}), on HEAD it passes with the seeded stats intact, which also shows the old path overwrote seeded template stats. The PATCH regression test passes; my probe got 200 with version 2, 3, 4 and the DB agreeing each time. (5) explanation-json.ts:27 reads DiversityNoteItemsSchema.maxItems (?? 0 fails closed); explanation.test.ts:109 pins 500 = scheduler constant = PlanCandidate.diversityNote.maxLength and maxItems 10; the 06 §6.1 sentence (line 149) matches generate.ts:68. No test deleted or skipped; the only removed assertion is the absolute "< 200" ms, replaced as the packet required. All 7 changed paths are inside ALLOWED PATHS, the 06 change is one sentence in §6.1, the commit is Conventional with "Task: FU-88". torgal/ohmydate has moved to 1598333 but touched none of the 7 files.

Contract / license / security / migration impact: none. No schema, OpenAPI, dependency or migration change. Behaviour: an out-of-window PATCH no longer feeds template stats or estimates from that row (intended) and no longer rewrites its stored quality (LOW 1); generate() output is unchanged for reachable inputs (scheduler suite incl. goldens 224/224).

Missing tests: a timing shape that fails on a window-only revert (MEDIUM); generate()-level coverage of the delete-items branch (unreachable without a stub, covered at helper level only); stale If-Match on an out-of-window row (still probe-verified only, from R2).

Verification actually executed: yes —
  pnpm run typecheck -> 0
  pnpm run lint -> 0
  pnpm run check:boundaries -> 0 (535 files, 0 violations)
  With DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456:
  pnpm exec vitest run --root . --no-file-parallelism packages/scheduler/test/fu64-68.test.ts -> 0, twice (6 passed; 54 s wall cold at load 25-35 with 68% in import, 7.9 s warm)
  pnpm --filter @ohmydate/contracts test -> 0 (16 files, 99 passed)
  pnpm --filter @ohmydate/api exec vitest run --globals test/estimation-profile-bound.test.ts test/explanation-codes.test.ts test/estimation-learning.test.ts -> 0 (3 files, 21 passed)
  pnpm --filter @ohmydate/scheduler test -> 0 (20 files, 224 passed, 252 s)
  The worktree's bound test 14 more times through a scratch vitest config without the dist-build global setup -> 0 each (4/4)
  Scratch only (copy of services/api outside the worktree, node_modules symlinked, ephemeral t_* schemas dropped on close): bound test against the old refresh -> 1 (the FU-88 test fails as intended, 3 others pass); perf probes with the LIMIT kept/removed at 5,000 / 10,000 / 20,000 rows, idle and loaded -> 0; pre-FU-64 classifier probes -> 0; quality-column probe on HEAD and on the old refresh -> 0; fixture cost probe -> 0.
  NOT run (SPEED RULE): full pnpm run ci, full pnpm --filter @ohmydate/api test, check:api-client, web tests, e2e.

git status --porcelain after review: (empty)

Residual risks: the relative gate has no absolute bound, so a uniform slowdown inside the 2,000-row window passes it (with the old O(n^2) classifier and the window kept the ratio was 1.20-1.88 while a request cost ~120-225 ms); process CPU time excludes PostgreSQL, so an unbounded SQL-side scan that returns few rows is invisible to the gate; the gate currently passes with extra slack only because of the cold baseline, so reordering the two measurements without also changing the shape would tighten it to ~1.0 vs 1.5-1.8; no full API suite or merge-result CI from me, that remains the coordinator's gate.
