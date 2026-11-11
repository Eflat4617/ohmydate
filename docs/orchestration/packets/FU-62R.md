# REVIEW PACKET: FU-62RR — Independent review of FU-62R
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/fu-62-explanation-codes. Base: torgal/ohmydate. Head: 30a8be1.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/FU-62R.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...30a8be1; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of FU-62 (explanation + violation codes, additive contract; implementer Opus 5.5 xhigh). Branch torgal/fu-62-explanation-codes HEAD 30a8be1 (468e671 feat + 30a8be1 docs). Merge candidate torgal/ohmydate...30a8be1. Read docs/orchestration/packets/FU-62.md; scope amendment (ledger 23:39): docs/blueprint/06 §6.1 + 08 §1 one line. Worker report:
What I did: added closed explanation and violation codes from end to end; worktree /home/torgal/orca/workspaces/oh_my_date/fu-62-explanation-codes, branch torgal/fu-62-explanation-codes, commits 468e671 (feat) and 30a8be1 (docs), 34 files vs 7170fc3. What I found: every exact test passes except pnpm run ci, which exits 1 only because two tests in services/api/test/db/migrate.test.ts time out at 30s (the known FU-65 shared-DB flake); the same file passes 13/13 run alone and in the standalone API suite, and every other CI step passes. What is left: wire ExplanationList into the M5-03 replan detail screen after merge, and the free-text diversityNote is not coded yet.

TESTS (on 30a8be1)
- pnpm --filter @ohmydate/scheduler test -> exit 0, 18 files / 175 tests passed.
- pnpm --filter @ohmydate/api test (DATABASE_URL planner_test, VIKUNJA_URL) -> exit 0, 64 files, 437 passed / 9 skipped.
- pnpm --filter @ohmydate/web test -> exit 0, 33 files / 256 tests passed.
- pnpm run ci -> exit 1. Typecheck and lint pass; the test step fails with 2 failed / 1624 passed / 29 skipped. The failures are migrate.test.ts "0004 backfills one live inbox per owner and clears project fingerprints" and "rolls back the latest migration and can apply it again": "Test timed out in 30000ms" (FU-65). An earlier full ci run before the docs commit failed only the rollback test, the same way.
- The ci steps after the test step, run separately: check:api-client exit 0; check:boundaries exit 0 (395 files, 0 violations); build-smoke --required exit 0 (/healthz 200); vitest run services/api/test/db/migrate.test.ts alone exit 0 (13/13).

DIFF SUMMARY
- Scheduler: new src/codes.ts holds typed parameter maps and the closed lists: 13 generator codes, 29 input_* codes and 24 h0-h8 validator codes. The generator now builds every line together with its item, so explanation[i] and explanationItems[i] always match. Violation and InputIssue now carry messageCode + params, one code per message template. The English text is unchanged.
- Contracts (additive): new src/explanation.ts with ExplanationItem {code, params}. Params are numbers or tokens matching ^[A-Za-z0-9_.:+-]{1,100}$, so titles and notes are rejected. PlanCandidate and ReplanCandidate get optional explanationItems; Violation gets optional messageCode + params. There is one API-only code, h1_active_block_overlap (storage overlap guard on approve). ExplanationItem is a component; openapi.json and the web schema.d.ts are regenerated.
- API: codes pass through for POST/GET plans, preview-edit violations (200), plan approve 422, today approve 422 and replan proposals (request, list, approve 422). plan_candidate.explanation keeps its English line array and appends one {items:[...]} object, which older readers ignore, so rollback is lossless and no migration is needed. Replan payloads store candidate.explanationItems. Legacy rows and payloads return explanationItems: []; malformed, unknown or misaligned items also return [] for that row.
- Web: ko.explain has one entry per code and is typed against the generated enum. i18n/explanation.ts renders each code with Intl dates and durations and looks up task names by ID. The new ExplanationList.vue is used in PlanComparisonView (explanations, preview and approve violations) and in ProposalPreview/TodayView (today approve 422 findings). "계산 근거 (원문)" now appears only for uncoded rows; a single unrenderable item falls back to its own English line.
- Docs (scope amendment): 06 §6.1 code tables with params, plus one line in 08 §1.

REQUIREMENTS
1 additive contract (explanationItems; messageCode + params; closed enums documented in 06; params are IDs, numbers, instants or minutes only) -> met.
2 scheduler emits a code for every explanation, violation and input issue; validator kinds map 1:1 -> met. Tests use an English oracle per code, reachability of every code, a 300-run property test, and @ts-expect-error negatives. heuristic_estimate_below_grid is a defensive generator branch that no input reaches; it stays in the enum and the test pins it as the only unreachable code.
3 API pass-through, with legacy rows and proposals serializing as [] -> met (DB-backed tests).
4 web: typed ko messages for every code, a catalog test against the openapi enum, Intl params, rendering in plan comparison, edit violations and the today proposal dialog, original text only for fallbacks -> met. The M5-03 replan detail screen does not exist on my base, so wiring it there is left for the merge.
5 tests and regenerated openapi.json + gen:api, both committed -> met.

RISKS AND FOLLOW-UPS
- pnpm run ci is red only because of FU-65.
- The M5-03 merge should use <ExplanationList :lines="c.explanation" :items="c.explanationItems" :time-zone :task-names>. I left api/client.ts and api/index.ts untouched and appended the ko.ts groups after the violation group to keep conflicts small.
- The diversityNote free text, including its appended replan-bound sentence, is not coded yet; it was outside this task.
- Dependents can use ExplanationItem, ExplanationCode and VIOLATION_MESSAGE_CODES from contracts. A new code needs codes.ts, explanation.ts, the 06 table and ko.explain; tests catch any drift.
- Rollback: delete the branch (additive contract, no migration).
Coordinator notes: migrate.test.ts 30 s timeouts under shared planner_test are FU-65 (being fixed in FU-58F) — not a finding; re-run that file alone if it fails. Wiring ExplanationList into the M5-03 replan screen happens at M5-03 merge.
Focus (medium): (1) contract strictly additive (no existing field changed/removed; openapi + web schema regenerated and in sync); (2) privacy: params can never carry titles/note text (token regex, tests); (3) explanation[i]/explanationItems[i] alignment and exhaustiveness tests meaningful (not tautological); validator 1:1; (4) persistence: plan_candidate.explanation now appends an {items} object to a string array — check every reader (API, web, export, replan, older code paths) tolerates it, legacy rows -> [], malformed -> [] without 500; (5) web renders every code in Korean with Intl params, fallback only for uncoded rows; (6) 06 §6.1 tables match the enums.
Round 1 of 2. HIGH for breaking contract changes, a reader that crashes on the appended object, or user text in params.

