# REVIEW PACKET: FU-88RR — Independent review of FU-88R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-88-estimator-followups. Base: torgal/ohmydate. Head: 95e64a4.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-88R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...95e64a4; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-88 (FU-64-68R2 follow-ups: host-independent perf gate, FU-68 fixture cost, all-or-nothing diversity items, window-only refresh, contract-tied caps; implementer DeepSeek 4.1 Flash high). Reviewer: Fable 5.2 xhigh in place of Sol (weekly limit; MODEL_BINDINGS §12). You are the REVIEWER: read-only — do not edit/create/commit repository files (scratch only outside the worktree); finish with the REVIEW VERDICT format. Branch torgal/fu-88-estimator-followups commit 95e64a4. Merge candidate torgal/ohmydate...95e64a4. Read docs/orchestration/reviews/FU-64-68R2.md (your own findings) and docs/orchestration/packets/FU-88.md (git show torgal/ohmydate:...).
SPEED RULE: no full ci/e2e (the coordinator runs them on the batched merge). Run `pnpm run typecheck`, `pnpm run lint`, `pnpm run check:boundaries` and the Focus commands. Keep it focused; small follow-up.
Worker report (treat as unverified claims):
taskId: task_06bf0e277f64
dispatchId: ctx_f3eb06abfb43
worktree: /home/torgal/orca/workspaces/oh_my_date/fu-88-estimator-followups
branch: torgal/fu-88-estimator-followups
commit: 95e64a42af65ac0c9ee3587caaeaefce462c7294 (base 02129fe)

changed paths:
services/api/test/estimation-profile-bound.test.ts
services/api/src/adapters/pg-estimation-store.ts
packages/scheduler/src/generate.ts
packages/scheduler/test/fu64-68.test.ts
services/api/src/adapters/explanation-json.ts
packages/contracts/test/explanation.test.ts
docs/blueprint/06-SCHEDULER-SPEC.md

diff summary:
- Perf gate is now relative (5,000-row owner vs a 2,000-row owner in the same test, best-of-5 each, cpu ratio <= 2) instead of an absolute 200 ms budget; a seeded second owner supplies the 2,000-row baseline.
- MULTI_REPLAN_INPUT shrunk to 4 tasks / 3-day horizon and its one generate() result is shared by both tests; both 30 s timeout overrides removed, every assertion kept.
- appendBoundDiversityLines now returns no items when any kept bound line lacks a coded item; generate() clears diversityNoteItems in that case. New test covers the mixed paired/unpaired map.
- refresh() computes the plan from the bounded window only; the mutated out-of-window row is appended to the post-write snapshot just for the response. New test proves template stats after an out-of-window un-exclude equal a plain refresh.
- API item cap now reads DiversityNoteItemsSchema.maxItems; contracts test ties the scheduler 500 constant to PlanCandidate.diversityNote.maxLength and the contract maxItems to 10. 06 section 6.1 gains the one-sentence 500-char omission rule.

requirement checklist:
1) relative host-independent perf gate - MET. 5000/2000 ratio 0.63 and 0.63 in two runs. Scratch revert of the window LIMIT makes the test fail: without the LIMIT the response sampleCount becomes 5,000 (assertion fires); with the two sampleCount assertions temporarily voided to capture numbers, cpu was 5000=194.1 ms vs 2000=122.8 ms (ratio 1.58) before the size assertion failed. LIMIT restored.
2) FU-68 fixture cost - MET. One 4-task/3-day fixture, one shared generate(), no 30 s overrides; all 6 tests pass.
3) all-or-nothing items - MET. Helper returns items [] for any unpaired kept line; generate() deletes diversityNoteItems so clients render the full English note. Test added.
4) out-of-window PATCH refresh - MET. Plan computed from window rows only; target row only in the response snapshot. Test added.
5) 500/10 tied to contract - MET. explanation-json derives maxItems from DiversityNoteItemsSchema; contracts test compares both caps; 06 6.1 sentence added.

tests (exit code -> output):
- pnpm exec vitest run --root . --no-file-parallelism packages/scheduler/test/fu64-68.test.ts -> 0 (1 file, 6 passed)
- pnpm --filter @ohmydate/contracts test -> 0 (16 files, 99 passed)
- DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 pnpm --filter @ohmydate/api exec vitest run --globals test/estimation-profile-bound.test.ts test/explanation-codes.test.ts -> 0 (2 files, 15 passed)
- pnpm run typecheck -> 0
- pnpm run lint -> 0
- pnpm run check:boundaries -> 0 (535 files, 0 violations)
Not run per coordinator speed-up: full pnpm run ci, full api suite, e2e, check:api-client (no contract source schema change).

risks / unverified:
- The CPU ratio alone against the unbounded classifier was 1.58x on this host (fixed overhead dominates), below the 2x threshold; the same test still fails on the window-size assertion, which is the hard discriminator. If a stricter door is wanted, lower the threshold or use a larger history.
- Full merge-result suites remain the coordinator gate.
- New contract needed by dependents: none (no schema or wire change).

rollback: delete branch torgal/fu-88-estimator-followups.
Focus (narrow): (1) the relative perf gate: does it still fail against the unbounded classifier? The worker reports the CPU ratio alone is 1.58x (< 2x) and that only the window-size assertion catches the revert — judge whether the gate is meaningful as a perf gate (suggest a stricter shape if not; MEDIUM at most unless it is vacuous) and whether it is stable under load; (2) fixture shrink keeps diversity_distinct + bound sentences and every assertion; no 30 s overrides remain; (3) all-or-nothing items: unpaired line -> no items, clients fall back to the full English note; (4) window-only refresh: template stats after an out-of-window un-exclude equal a plain refresh; the PATCH response still carries the mutated row (200) — no regression of the FU-64-68F fix; (5) caps tied to the contract; 06 §6.1 sentence accurate; no weakened test. Run with env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456: pnpm exec vitest run --root . --no-file-parallelism packages/scheduler/test/fu64-68.test.ts ; pnpm --filter @ohmydate/contracts test ; pnpm --filter @ohmydate/api exec vitest run --globals test/estimation-profile-bound.test.ts test/explanation-codes.test.ts test/estimation-learning.test.ts.
Round 1 of 2. HIGH for a vacuous gate that cannot fail, a regression of the out-of-window PATCH fix, weakened tests.

