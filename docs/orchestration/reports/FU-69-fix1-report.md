I fixed the FU-69R-1 MEDIUM: the gap search now explores every start that H6 makes distinct, with the reviewer's case added first as a failing all-policy regression, and I merged torgal/ohmydate first as asked. Verifying the fix with a validator-checked witness property showed the search needed more than the one start named in the review (a start anchored to the following focus run, a time-order retry, tighter pruning, and one extra repair pass for starved dependents), so those are in too; both extra seeds you sent (-1360500784, 472150992) reproduce on the pre-fix code, pass on the final code, and are now deterministic regressions. Nothing is left open for this round; the search stays a bounded heuristic, and the implication property is still not a theorem under the freeze (two breakAfter-90 cases are provably unsolvable with frozen neighbours) and infeasible-heavy inputs cost about 20% more than the base.

# FU-69 fix round 1 report (review FU-69R-1)

- taskId: task_995f85acffdd · dispatchId: ctx_94f21553e88b
- worktree: /home/torgal/orca/workspaces/oh_my_date/fu-69-replan-dst · branch: torgal/fu-69-replan-dst
- HEAD: 033e903 (previous round 8950bd5; merged torgal/ohmydate 649cb8a first as 12fe3ee, no conflicts)
- changed paths since 8950bd5 (mine): packages/scheduler/src/generate.ts, packages/scheduler/test/fu69.test.ts, packages/scheduler/test/replan.property.test.ts, docs/blueprint/06-SCHEDULER-SPEC.md — all inside allowed paths. Scratch harnesses lived in packages/scheduler/test/tmp/ and are deleted; nothing of them is committed.

## Finding table

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | [MEDIUM] gap search skips the H6 break-offset start when a shorter session fits immediately | fixed | Reviewer case added first and failing (H7, deficit 120) on 8950bd5; now feasible in all three policies with exactly the witness F 09:00-10:00, A 10:15-11:30 + 12:00-12:45, independent validate() == [], F unchanged, deficit 0, changedBlocks 3 (fu69.test.ts "FU-69R-1 gap search explores the H6 break-offset start") |
| 2 | "(and any other start the H6/H1 rules make distinct)" | done | Three start classes per run, derived in the `startOffsets` comment: first free cell (joins the preceding focus run), first cell a full break after it, first cell from which a session may run into the following focus run (>= that run's end - breakAfter). The third was a real miss too (regressions "starts late enough to run into the following frozen block", "anchors the second session ..."). H1 and the daily cap do not depend on the start. |
| 3 | Deterministic, bounded work budget (state the bound) | kept | GAP_FIT_BUDGET = 512 evaluations (`passes` checks + trial placements) per searchRuns call; <= 2 searchRuns per searchGapSessions (policy order, then time order) x <= 2 per task (remainder after kept blocks, full re-split) = <= 2048 evaluations per task per repair pass; <= 2 repair passes per placement attempt. No time-based limits; recursion depth <= budget. |
| 4 | Property coverage for minSession > 30 | done | replan.property.test.ts: (a) seeded variant of the committed implication with minSession 45 + breakAfter 120 (seed 6945, 200 runs, ~1 s); (b) seeded witness property (seed 6903, 400 runs, ~1 s): minSession 30/45/60 x breakAfter 90/120/240 x breakMin 10/15/30, oracle = validator-accepted frozen-preserving witness. (b) FAILS on 8950bd5 with this seed and passes now. The plain minSession-45 implication alone passes on 8950bd5 too, so it would not have caught the defect; that is why (b) exists. Existing property untouched (one helper gained an optional parameter). |
| 5 | Differential fuzz: fresh generation byte-identical apart from generatorVersion | holds | 6,000 random specs vs the pre-FU-69 base c756093: all 2,380 fresh candidates feasible on the base are byte-identical; no candidate (fresh or replan) has a larger deficit than the base; 419 fresh + 92 replan candidates went infeasible -> feasible. Vs 8950bd5: no feasibility regression, 10 more fixed, differing feasible plans have equal or fewer blocks. |
| 6 | Extra seeds from the coordinator | both covered | -1360500784 (grow, front_loaded) and 472150992 path 197:4:3:5:4:5:5:5:5:6:6:7 (dependency, balanced): both fail on c756093 with exactly these paths, both pass on the final code at 200 and 400 runs, both added as deterministic regressions (root causes 1 and 2 of the first round; no new cause). |

## What changed in generate.ts (GENERATOR_VERSION stays m3-02.7, unreleased; POLICY_VERSION 1.0.0)
- searchRuns/startOffsets: all three starts, longest session first across the starts (a start that only admits short sessions no longer drains the budget first).
- searchGapSessions: when the policy order of the gaps is not chronological and finds nothing, search once more in time order (only then is a session's preceding focus known when its start is chosen; focus_blocked needed it).
- Pruning: a gap's capacity now counts the break rule including the focus stretches next to it, and leftovers below minSession count as zero (two budget-exhaustion misses found by the witness property).
- runPlacementAttempt: if the repair pass still leaves a task with dependencies short, one more repair pass keeps one breakMin free before each dependent's room and re-splits tasks without keeping their own old blocks. Found with breakAfter 120/90 (not reachable from the committed property, whose breakAfter is 480); three regressions.
- Plain greedy pass untouched; repaired plans still only replace the plain one when strictly better.
- 06 §7.1 bullet now states that the split search is bounded and which starts it tries.

## Tests
Exact tests (tree = commit 033e903):
- `corepack pnpm --filter @ohmydate/scheduler test` -> exit 0 -> "Test Files 19 passed (19) / Tests 215 passed (215) / Duration 451.19s" (SCHED_PERF_ASSERT=1 included). First attempt was exit 1: only the wall-clock perf assertion failed ("generator perf batch 2/3: p95=988.7ms ... loadavg/core=1.34", other workspaces had the 20-core host at load 27), 214 other tests passed; rerun unchanged -> exit 0. Same fixture, base vs final interleaved: median 306.5 ms vs 330.0 ms, outputs byte-identical.
- `DATABASE_URL=<planner_test dev URL> VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci` -> exit 0 -> "Test Files 143 passed (143) / Tests 1689 passed | 29 skipped (1718)", web "Test Files 39 passed (39) / Tests 307 passed (307)", check:api-client no diff, "Boundary check passed: 415 file(s), 0 violations.", build-smoke "/healthz 200" twice. I added no skip.

Committed tests (fu69.test.ts 38, replan.property.test.ts 4; no existing test deleted, skipped or weakened; the existing property is unchanged apart from an optional helper parameter):
- vs 8950bd5: 7 of these 42 fail (reviewer case, the two other start classes, time-order retry, break-rule pruning, the breakAfter-120 dependency case, the seeded witness property).
- vs base c756093: 30 of 42 fail, including both coordinator seeds.
- Negatives: reviewer day with 135 min needed stays infeasible with F untouched; plus the round-1 negatives (non-splittable, gaps below minSession, over capacity, unplaceable dependent, repair not better).

Scratch verification on the final code (harnesses not committed):
- Coordinator seeds -1360500784 and 472150992: fail on c756093 with exactly the reported paths at 200 and 400 runs; pass on the final code at 200, 400 and 2000 runs.
- Committed replan properties (both), 2000 runs, seeds -1548650610, 2035140076, 5037, -1360500784, 472150992, 1, 42, 20261112, each on the 3 committed scenarios and again with 6 extra DST scenarios: 16/16 pass.
- Implication property at 3000 runs with minSession/breakAfter (45,120) (45,480) (60,120) (45,240) (30,120), seeds 7, 1337, 271828, 5, 6: 25/25 pass. With breakAfter 90: 8/10 pass; the two failures (seed 6, a grow on a single 480-minute day) are not misses: they still fail with GAP_FIT_BUDGET raised to 5,000,000, i.e. no split exists that keeps the other tasks frozen, which is the 06 §7.1 explained-infeasible outcome.
- Witness property, 12 seeds x 5,000 validated cases x 3 policies: 0 infeasible. (8950bd5: 1-11 infeasible per 3,000 cases.)
- FU-41 preservation + change-bound properties at 3000 runs each (committed: 1600/600), seeds 42, 5037, 20261112: 9/9 tests pass each.
- Differential fuzz, 6,000 specs: see finding 5.
- Runtime (FU-66): 'forced multi-session replans' with a fixed seed, alternating runs on the loaded host: final 53.4 s and 55.5 s, 8950bd5 114.0 s and 164.1 s. Interleaved generate() benchmark on identical inputs: FU-41-shaped replans 13.7 ms (base) vs 13.8 ms (final); infeasible-heavy 20-task inputs 950 -> 1124 ms fresh (+18%) and 609 -> 747 ms replan (+23%) vs base (8950bd5: +12% / +9%).

## Residual risks
- The search is still a bounded heuristic. It is complete (up to the budget) only for one task at a time among fixed blocks, and a session never crosses a local date inside the search. Interplay between several affected tasks (H6 or contention) is only covered by the extra repair pass.
- The implication "fresh feasible => replan feasible" is not a theorem under the freeze; the two breakAfter-90 cases above are concrete, legitimately infeasible instances. The committed minSession-45 variant is therefore a seeded corpus, as its comment says.
- Infeasible-heavy inputs cost about 20% more than the base; feasible inputs are unchanged. FU-66 stands: on this loaded host the scheduler suite took 451 s (107 s on a quiet host last round), so its 180 s test timeout remains load-sensitive; this change does not make that test slower (see runtime above).
- Compared with the unreleased 8950bd5, plans that needed repair can differ (equal or fewer blocks in every differing feasible case seen); 2 of ~7,300 fresh candidates that are infeasible either way show a larger deficit than 8950bd5 gave, never larger than the base.
- GENERATOR_VERSION stays m3-02.7 because 8950bd5 was never merged; say so if you want m3-02.8.
- Not run: e2e Playwright (not in the exact tests).

## Rollback
Reset the branch to 8950bd5 (this round is one merge commit + one fix commit), or delete the branch.