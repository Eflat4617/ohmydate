# M5-02 report — estimator, delay detection, replan proposals API + FU-59

- taskId: task_213eea984719 · dispatchId: ctx_52cd84edd09c
- worktree: /home/torgal/orca/workspaces/oh_my_date/m5-02-replan-api · branch: torgal/m5-02-replan-api
- commits: 5975f13 (FU-59 scheduler), f8a40ca (feat api/domain), 604af61 (tests + cold start + stats marker),
  df492eb (approve 422 test); merges 5d30be8 / 6e1c916 of torgal/ohmydate (M5-01 final 54f6877 … 81bfd37). HEAD = df492eb.
- Took over the stopped DeepSeek worker's uncommitted FU-59 edits: kept them, made the hash change conditional.

## Changed paths (git diff --name-only torgal/ohmydate...HEAD) — all inside allowed paths
packages/domain/src/{estimation.ts,index.ts}, packages/domain/test/estimation.test.ts,
packages/scheduler/src/{generate.ts,types.ts}, packages/scheduler/test/{fu41.test.ts,fu59.test.ts},
services/api/src/adapters/{pg-estimation-store.ts,pg-replan-store.ts,pg-agent-run-repository.ts,pg-intake-approval-repository.ts,pg-intake-session-repository.ts},
services/api/src/application/{estimation-service.ts,replan-service.ts,replan-detection.ts,replan-detection-job.ts,replan-errors.ts,plan-service.ts,session-service.ts,intake/intake-service.ts,intake/ports.ts},
services/api/src/{app.ts,http/routes.ts},
services/api/test/{replanning.test.ts,estimation-learning.test.ts,replan-detection.test.ts,support/m5-fixtures.ts}
No contract/openapi/migration changes (check:api-client diff 0).

## Diff summary
- domain/estimation.ts (pure): versioned log-normal priors per step kind (`estimation-priors@1`), template prior from the step interval,
  leave-one-out |z|>2.5 outliers (needs >=3 other samples, spread floor 0.1), owner exclusions, latest-feedback-per-task sampling,
  shrinkage m = n·mean/(n+5), P90 widened by shrunk personal spread, confidence/method/evidence, 5-min grid rounding, cold start.
- scheduler: `ScheduleInput.affectedTaskIds` unioned into the replan affected set (+successors, staged expansion); hashed only when supplied.
- api replan: ReplanService + PgReplanStore (list/get/approve/reject/request), pure trigger detection, leader-only ReplanDetectionJob
  (advisory key 5_196_104, 5 min), approval TX mirrors plan approval (availability FOR UPDATE, proposal + plan locks, in-TX re-validation,
  supersede future blocks only, plan_version created_by=replan reason=replan:<reason>, schedule_approval idempotency, outbox plan.approved).
- api estimation: EstimationService + PgEstimationStore (owner advisory-locked refresh; estimate history kept + estimate_evidence rows;
  template.stats learned values tagged source=estimator@1), session review uses the cold-start base P50 and refreshes quietly.
- plan-service: exported assembleScheduleInput/resolveExtraTasks/etc. (behaviour unchanged) for reuse by replan.
- intake (FU-48): PATCH draft records `editedEstimateKeys`; approval stores edited steps as method `personal` at the edited value;
  non-edited LLM steps get the cold start x1.3 (grid) with confidence 0.3; template/manual stay `template` (0.6).

## Requirement checklist
1 Estimator
- log-normal priors per template/kind, versioned table — met (domain ESTIMATION_PRIORS; template prior = step interval)
- shrinkage k=5 of mean log(actual/p50) — met (unit-tested exact values)
- outliers |z|>2.5 → quality=outlier, excluded — met (persisted on every refresh; unit + profile test)
- user exclusions honoured — met (PATCH feedback; unit + API)
- P50/P90 + confidence + method + evidence — met (estimate rows + estimate_evidence rows)
- cold start: template prior, else LLM x1.3, confidence <= 0.3 — met (domain coldStartEstimate, applied at intake approval)
- session review updates current estimate quietly — met (estimate row replaced, old is_current=false; failures swallowed by design, self-heal)
- GET /estimation/profile, PATCH /estimation/feedback/{id}, POST /estimation:reset (template w/o templateId → 422) — met
- FU-48 method reflects user-edited draft estimates — met (method `personal`; stored enum is prior/template/personal/llm, no migration)
2 Delay detection (leader-only job) — met: P90 slack, deadline_risk / commitment_conflict / early_completion (1/day),
  proposals via scheduler replan path with affectedTaskIds, <=2/day/owner (owner-local day), one pending per owner+reason
  (job dedupes; user request supersedes), 24 h suppression after reject, stale expiry when base version changes / expires_at passes.
3 FU-59 — met: affectedTaskIds unioned; Pacific/Chatham fix + all-zones-valid assertion; stage-specific expansion fixtures (fu59.test.ts).
4 Replan API — met: list/get; :approve with plan-approval TX semantics (412 availability_changed for If-Match or proposal snapshot,
  409 proposal_state_conflict, 422 validation_failed /editedBlocks/<i> and constraint_violation, idempotent replay);
  :reject (If-Match proposal version, reason never logged/returned, 24 h suppression); :request (409 replan_suppressed + Retry-After).
5 Tests — met: estimator unit (18), FU-59 scheduler (9) + zone validity, detection unit (9), API replanning (10: G04, approve race
  [201,409], 412, 428/400, replay, reject/suppression/cap/Retry-After, supersede, two-leader dedupe (2 real PG leader locks + 2 bare runners),
  expiry on base version change, 2/day cap, G08 + early 1/day, owner isolation 404, route walk), estimation API (6: G09 via real review,
  profile/304, exclude/include, reset rules, FU-48 integration + negative).

## Tests (DATABASE_URL=postgres://ohmydate:…@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456)
- corepack pnpm --filter @ohmydate/api test → exit 0 → "Test Files 61 passed (61) / Tests 415 passed | 9 skipped (424)"
  (9 skips = pre-existing live-Vikunja gated suites)
- corepack pnpm --filter @ohmydate/scheduler test → exit 0 → "Test Files 17 passed (17) / Tests 167 passed (167)"
- corepack pnpm run ci → exit 0 → typecheck ok, lint ok, vitest "Test Files 134 passed / Tests 1588 passed | 29 skipped",
  web "29 passed / 193 passed", check:api-client diff 0, "Boundary check passed: 375 file(s), 0 violations",
  build-smoke "/healthz 200", "SIGTERM exit 0"

## Risks / decisions to review
- FU-48 uses method `personal` for user-edited estimates (DB CHECK has no `user`); evidence rows are not written at intake time.
- Cold start x1.3 now changes stored values for non-edited, non-template LLM steps (and all estimates round up to the 5-min grid).
- Learning samples: latest non-excluded feedback per task (review actual is cumulative); ratio is vs the task's cold-start base P50
  (review `estimatedP50` now reports that base). Automatic quality reclassification does not bump the feedback version.
- Reset deletes estimation_feedback rows in scope (irreversible by design) and clears only estimator-written template stats.
- replan_suppressed is a ProblemError-style 409 that is NOT stored by the idempotency layer (time-bounded, like approval_in_progress).
- Daily cap counts every proposal created that day (incl. superseded/rejected user requests); early completion uses a 30-min margin.
- P90 slack is plan-coverage based (uncovered P90 minutes before due), not a free-capacity search; overdue tasks are not triggers.
- Replan picks the best of the 3 policies (feasible, fewest changes, smallest deficit); bound/flags derived in the service.
- Unverified: real Vikunja provider path for the job (tests use memory repos); job only starts for provider=vikunja with DATABASE_URL.

## New contracts for dependents
None changed. UI can rely on M5-01 contracts; proposals also emit outbox `replan.proposed` and an in-app notification
(kind replan_proposal, dedupe `replan_proposal:<id>`) for job-created proposals.

## Rollback
Delete branch torgal/m5-02-replan-api (no migrations or contract changes).
