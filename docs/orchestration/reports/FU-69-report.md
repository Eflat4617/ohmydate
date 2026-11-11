I root-caused the FU-69 counterexample, fixed the scheduler generator for it and for a second defect that the same property exposed at 2000 runs, and added deterministic regressions. The failure is not DST arithmetic: (1) a grown task was re-placed as equal maxSession-sized chunks that fit no gap between frozen blocks, and (2) under `balanced` a released predecessor was parked at the tail of the horizon so its dependent could not follow; both now get a repair pass and the property is green on every seed I ran. Nothing is left open for this task; the property is not a theorem for non-splittable tasks (06 §7.1 keeps the explained infeasible candidate there, pinned by a negative test), and POLICY_VERSION stays 1.0.0 because tests pin it — reviewer may want to confirm that choice.

# FU-69 report

- taskId: task_794800f8286c · dispatchId: ctx_8945147a5825
- worktree: /home/torgal/orca/workspaces/oh_my_date/fu-69-replan-dst · branch: torgal/fu-69-replan-dst
- commit: 8950bd5 (base c756093)
- Replaced the earlier Fable-medium worker; its scratch dir packages/scheduler/test/tmp/ was reused for probes and deleted, never committed.

## Changed paths (git diff --name-only c756093...HEAD) — all inside allowed paths
packages/scheduler/src/generate.ts, packages/scheduler/test/fu69.test.ts (new), docs/blueprint/06-SCHEDULER-SPEC.md

## Root cause 1 — the reported counterexample (rigid chunks between frozen blocks)
Shrunk to 2 tasks, UTC, no DST: one day 09:00-12:00, T0=60, T1=60 (min 30, max 120) -> plan T0 09-10, T1 10-11. Grow T0 to 90.
- prepareReplan marks T0 affected because its blocks no longer equal the requirement (FU-41 e35c459 changed `>` to `abs(...) > 0`), and buildReplanSeeds drops every seed of an affected task. T1 is unaffected -> frozen.
- Placement asks buildChunks for ceil(90/120) = 1 chunk of 90. Free time is 09-10 and 11-12 (60 + 60): no contiguous 90 -> H7 deficit 90, although T0 is splittable and 60 + 30 fits.
- Staged expansion only adds predecessors (T0 has none); the from-scratch fallback is rejected because it does not reproduce frozen T1. A fresh plan simply packs T0 90 + T1 60, so fresh is feasible and the replan is not.
- Reported case: 2026-10-25 is the Berlin DST end and windows are weekdays-only, so only Monday 09:00-17:00 (480 min) has capacity: T0 115 | T1 95 | T2 100, free tail 170. T0 grows to 175 (max 180 -> one chunk); gaps are 115 and 170. DST only shapes the horizon; the same shape fails for Berlin 2026-03-29, New York 2026-11-01 and plain UTC, in all three policies.
- Not the cause: DST unit grid, capacity not released (T0's old slot is free), the change bound (never reached), locked/history handling.
- History: before FU-41 the seed was kept and the last fallback was a no-seed fresh plan, which made the property trivially true. FU-41 correctly froze unaffected blocks but left the chunking rigid.

## Root cause 2 — found by raising the property to 2000 runs (starved dependents)
Seeds 5037 and 2035140076, all `mutation: dependency`, `policy: balanced`, Berlin all-day windows (also fails on the pre-fix code).
- The added edge releases both endpoints. `balanced` places the predecessor on the least-loaded local date; with the unaffected task frozen on an earlier day that is the 1-2 hour tail of the horizon (Tue 00:00-01:00 Berlin) or the minutes just before it. The dependent then has less than its duration left -> H7. Placement had no notion of the room dependents need.

## Fix (packages/scheduler/src/generate.ts, GENERATOR_VERSION m3-02.7)
- runPlacementAttempt = the unchanged policy greedy first ("plain"); a feasible plain plan is returned as is. Only if it is infeasible AND hit a dead end the aids target AND the work is not certainly over capacity, a repair pass repeats the greedy with two aids, and its result is used only when it ranks strictly better (feasible, then smaller H7 deficit, then fewer violations).
- fitSessionsIntoGaps (cause 1): for a splittable task whose equal chunks do not fit, cover the requirement with sessions inside [minSession, maxSession] fitted to the free runs (bounded depth-first search, longest session first, runs in policy order, every session checked by `passes` so H1/H6 hold). In a replan the task's own still-valid future blocks are kept first and only the remainder is fitted (minimal change). Complete splits only; otherwise the partial equal-chunk result stands.
- successorBound (cause 2): a task with dependents may end no later than the latest instant from which each dependent's unplaced minutes still fit before its own deadline (and before any block it already has). Necessary condition only; a dependent that cannot fit at all imposes no bound.
- Unaffected blocks stay frozen (06 §7). A split that exceeds 2x(affected existing)+2 is flagged with the existing `Replan change bound exceeded:` line, never silent (test). No new explanation/violation codes, no contract change. "retaining N existing block(s)" now also counts own blocks a split kept.
- 06 §7.1: one clarifying bullet. Why the contract needed it: "배치할 수 없으면" was read as "the equal chunks do not fit", which is exactly this defect; the bullet also states the scope of the property (below).

## Property premise
The property test is unchanged. It holds in its domain (all tasks splittable, minSession 30). It is NOT a theorem of 06 §7 in general: a non-splittable grown task that fits no gap between frozen blocks must return the explained infeasible candidate even though a fresh plan is feasible (FU-41/FU-59 tests require the freeze). That boundary is pinned by a negative test instead of weakening anything; no full-replan fallback was added.

## Requirement checklist
1. Root cause first, shrunk, explained -> met (above).
2. Scheduler fixed so the property holds; property not weakened, no seed pinned -> met. No bound/full-replan change was needed.
3. Deterministic unit test with the exact and the shrunk case; property at raised runs with fixed seeds incl. -1548650610; DST-start Berlin 2026-03-29 and New York 2026-11-01 -> met (below).
4. Golden, FU-41/FU-59, validator independence, determinism kept; no test deleted or weakened -> met (no existing test file touched; validate.ts untouched).

## Tests
Exact tests (clean tree = commit 8950bd5):
- `corepack pnpm --filter @ohmydate/scheduler test` -> exit 0 -> "Test Files 19 passed (19) / Tests 200 passed (200) / Duration 107.62s" (SCHED_PERF_ASSERT=1, perf assertion included; 175 existing + 25 new).
- `DATABASE_URL=<planner_test dev URL> VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci` -> exit 0 -> "Test Files 141 passed (141) / Tests 1663 passed | 29 skipped (1692)", web "Test Files 33 passed (33) / Tests 256 passed (256)", check:api-client no diff, "Boundary check passed: 399 file(s), 0 violations.", build-smoke "/healthz 200" twice. I added no skip.

Regression file packages/scheduler/test/fu69.test.ts (25 tests): exact counterexample with exact expected blocks (T0 keeps 08:00-09:55Z, T1/T2 frozen, one 60-min block added, changedBlocks 1), same shape for Berlin 2026-03-29 and New York 2026-11-01, all three policies, determinism; shrunk UTC case; the three dependency counterexamples (seeds 5037, 2035140076 x2 incl. the DST-start one) plus a hand-made UTC tail-slot case; gap-fit around a commitment in a fresh plan; H6 break and daily cap respected; change-bound flag. Negatives: non-splittable task stays infeasible and explained, gaps below minSession unused, over-capacity keeps the old partial result, a dependent that can never fit does not move its predecessor, repair not better -> plain plan kept.
- Same file against the pre-fix sources: 18 of 25 fail (every positive test), the 7 baseline/negative/determinism tests pass.

Reported seed (scratch copy of replan.property.test.ts with seed/numRuns overrides, not committed):
- before, seed -1548650610 path 99:11:15:19:19:19:19:20 -> exit 1, same counterexample as the packet.
- after, seed -1548650610 -> pass.

Property at raised runs, final code, all pass:
- both properties x 2000 runs: seeds -1548650610, 2035140076, 5037, 1, 7, 42 on the 3 committed scenarios and again with 6 extra scenarios (Berlin 2026-03-29 x2, New York 2026-11-01 and 2026-03-08, America/St_Johns, Australia/Lord_Howe), plus 1337 on the committed scenarios: 13/13.
- feasibility property x 3000 runs: seeds 1337, 20261112, -99, 123456789, 314159, 271828, 8675309, 99991, each with and without the extra scenarios: 16/16.
- Before the second fix, seeds 5037 and 2035140076 failed at 2000 runs (root cause 2); the committed 200-run test would only hit them occasionally.

FU-41 preservation + change-bound properties (scratch copy, 3000 runs each instead of 1600/600): seeds 42, 5037, 20261112 -> 9/9 tests pass each.

Differential fuzz against the pre-fix sources (scratch, 10,000 random specs: 6 zones incl. DST dates, commitments, daily caps 120-480, fresh / mutated fresh / replans by grow, shrink, commitment, dependency):
- fresh generation: output byte-identical whenever the pre-fix candidate was feasible (asserted, 0 exceptions).
- no candidate anywhere with a larger deficit (asserted).
- 878 candidates went infeasible -> feasible (152 of them replans).
- 1 replan was feasible both ways but different: new code keeps the predecessor frozen, changedBlocks 4 -> 2.

## Risks / unverified
- Replans: an attempt that was feasible is unchanged, but the staged replan can now succeed one stage earlier (keeping the predecessor frozen instead of releasing it). Seen once in 10,000 fuzz specs, with fewer changed blocks (4 -> 2). Fresh generation: every previously feasible output is byte-identical by construction.
- Infeasible outputs can change only for the better by the generator's own ranking; ~10% extra time on infeasible inputs, none on feasible ones (bench vs pre-fix: 120 -> 120 ms feasible, 289 -> 324 ms infeasible fresh, 188 -> 203 ms infeasible replan).
- The gap search is budgeted (512 evaluations) and heuristic; the successor bound ignores H6 and contention. Both can still miss a plan that exists.
- POLICY_VERSION stays 1.0.0: generate.test.ts pins it and the plain greedy (ordering + slot rule) is untouched; the repair pass is covered by GENERATOR_VERSION m3-02.7. Say so if you want a policy bump instead.
- Not run: e2e Playwright (not in "Exact tests").

## New contracts for dependents
None. API/web see the same shapes; plans stored with generatorVersion m3-02.6 are unaffected.

## Rollback
Delete branch torgal/fu-69-replan-dst (single commit).