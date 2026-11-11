# TASK PACKET: M23-UI — integrate Planning Wizard (M2-04) + Plan comparison UI (M3-05) with the real API; E2E-2 and E2E-3
Role: worker-frontend + e2e. Base: torgal/ohmydate HEAD (M2-03, M3-03, M3-04 merged).
Steps: create your branch from torgal/ohmydate, then `git merge --no-edit torgal/m2-04-wizard-ui` and `git merge --no-edit torgal/m3-05-plan-ui` (both are UNREVIEWED feature branches built against MSW; resolve conflicts in apps/web: router, nav, api client, mocks — keep both features).
Read: docs/blueprint/07 (wizard §3.2, comparison/calendar), 08 §2.3/§2.4/§2.4a (current contracts: IntakeInput.title required + description; POST /intake-sessions degrades to 201 manual with error.code; answers discriminated union; pause only clarification<->needs_input; approval_in_progress 409 + Retry-After; preview-edit If-Match = W/"<plan.version>" and /blocks/<i>; approve If-Match W/"availability:<n>"), 11-TEST-STRATEGY E2E-2/E2E-3, e2e/README.md + e2e/global-setup.ts (existing E2E-1 harness), docs/orchestration/FOLLOW-UPS FU-40.

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

ALLOWED PATHS: apps/web/**, e2e/** (new specs/helpers; global-setup may add env such as LLM_PROVIDER=fake and LLM budget env needed for FakeLlm intake), package.json (scripts only if needed).
REQUIRED
1) pnpm --filter @ohmydate/web gen:api against the current contracts; fix every type error; wizard step 1 now sends title (required) + description (FU-40 — remove the deliverable/prerequisites mapping hack); handle 201-manual create (banner + manual path), answers union, pause semantics, 409 approval_in_progress with Retry-After (wait + retry same key), preview-edit If-Match plan version.
2) MSW mocks updated to the same contract so unit tests stay meaningful; all existing web tests green.
3) E2E-2 (real API, PROVIDER=vikunja, LLM_PROVIDER=fake): new assignment with dueAt filled -> questions never ask dueAt -> answer/skip -> draft edit -> approve -> tasks visible in Inbox AND in Vikunja (API check like E2E-1).
4) E2E-3: availability set -> POST plans from the approved goal -> compare 3 candidates -> drag/edit one block (preview violations shown) -> approve 201 -> in a second browser context add a commitment overlapping the plan -> retry approve in the first context -> 412 availability_changed banner -> regenerate -> approve 201.
5) a11y: axe (zero critical/serious) on wizard and comparison pages; keyboard-only wizard path in E2E-2.
Run and paste: pnpm --filter @ohmydate/web test ; pnpm --filter @ohmydate/web build ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456) ; same env pnpm run e2e (all E2E-1/2/3 green).
Retry limit 2. Rollback: delete branch.
