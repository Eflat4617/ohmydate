# REVIEW PACKET: M23-UIRR — Independent review of M23-UIR
Role: reviewer (GPT-6.1 Sol high via Codex). READ-ONLY: do not modify, create or delete files; do not commit. Running tests/builds is allowed (generated caches like node_modules are fine).
Target worktree: this worktree. Branch: torgal/m23-ui-integration. Base: torgal/ohmydate. Head: 377d821.
Original packet: read it fully with `git show torgal/ohmydate:docs/orchestration/packets/M23-UIR.md` (stacked worktrees may not contain it; use the same `git show torgal/ohmydate:<path>` for any docs/orchestration file). Worker claims (treat as unverified claims): see below.
MUST: inspect git diff torgal/ohmydate...377d821; check changed paths are within the packet's ALLOWED PATHS; run every command in the packet's TESTS yourself and paste exit codes; apply the checklist in docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md §4.
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
REVIEW of M23-UI (Planning Wizard M2-04 + Plan comparison UI M3-05 integrated with the real API; E2E-2/E2E-3). Branch torgal/m23-ui-integration: merges cc4a44c (torgal/m2-04-wizard-ui), 13de110 (torgal/m3-05-plan-ui) + 377d821. Both feature branches were never reviewed before — this is their FIRST review. Merge candidate: torgal/ohmydate...377d821 (apps/web/** and e2e/** only). Read: docs/orchestration/packets/M23-UI.md, M2-04.md, M3-05.md; 07 (wizard §3.2, comparison/calendar, a11y, offline); 08 §2.3/§2.4/§2.4a; 11 E2E-2/E2E-3. Worker report:
taskId task_3815e761ef62, dispatchId ctx_239111fefbee; worktree /home/torgal/orca/workspaces/oh_my_date/m23-ui-integration; branch torgal/m23-ui-integration; commits cc4a44c (merge M2-04 wizard), 13de110 (merge M3-05 plan UI/conflict resolution), 377d821 (integration features/tests); diff vs df3915f touches 36 files under apps/web/** and e2e/** (router/nav, api client+errors, mocks, wizard/comparison views, plan/time/rrule helpers, wizard tests, e2e helpers/specs, global-setup). Implemented: gen:api with no schema drift; wizard sends required title + optional description and drops the deliverable/prerequisites hack; discriminated answers union; pause restricted to clarification<->needs_input; 201 manual create banner/manual path via session.error; approval_in_progress 409 retries after Retry-After with the same Idempotency-Key; plan view refetches plan.version after approval/412 so regenerate succeeds; MSW aligned (title validation, answer union, pause semantics); E2E-2 (real API+vikunja+fake LLM, dueAt never re-asked, draft edit+approve, Inbox+Vikunja verify, keyboard-only path, axe) and E2E-3 (availability set, 3 candidates, keyboard block edit+preview violations, approve 201, second context commitment, retry 412 availability_changed, regenerate, approve 201, axe). Found that breakAfterMin=60 caps continuous sessions and that approval bumps plan.version (UI needed a refetch); E2E-3 therefore seeds independent draft steps to keep 3 distinct candidates. All acceptance items met; tests: pnpm --filter @ohmydate/web test exit 0 (102 passed), pnpm --filter @ohmydate/web build exit 0, pnpm run ci exit 0 (typecheck+lint+1245 API tests+102 web tests+api-client+boundaries+smoke), pnpm run e2e exit 0 (8 passed incl E2E-1/2/3). No known blockers; no new contracts needed by dependents; rollback is deleting branch torgal/m23-ui-integration (no shared branches rebased/pushed).
Focus (medium effort; prioritize):
1) E2E-3 integrity: the worker "seeds independent draft steps to keep 3 distinct candidates" and found breakAfterMin=60 caps sessions. Is the E2E still testing the spec'd user flow (3 candidates -> edit -> approve -> second-context commitment -> 412 -> regenerate -> approve) without bypassing product behavior (no direct DB writes, no API shortcuts the UI cannot do)? Run pnpm run e2e yourself.
2) Security/UI rules: no v-html; problem+json errors rendered as text; no tokens/secrets in localStorage beyond existing session handling; offline read-only gating on every mutation.
3) Contract use: wizard title/description, answers union, 201-manual banner, approval_in_progress Retry-After same-key retry (bounded retries?), preview-edit If-Match = plan version, approve If-Match availability, 412/422 mapping to the right block (/blocks/<i> vs /editedBlocks/<i>).
4) Calendar DST rendering (America/New_York 2026-11-01 week) and keyboard-only paths; axe zero critical/serious.
5) Idempotency in the UI: double-click approve sends one key; retries after network error reuse the key; a new key only on deliberate re-submit.
Round 1 of 2. HIGH for security, data-loss, contract misuse that corrupts server state, or E2E that does not test the real flow.

