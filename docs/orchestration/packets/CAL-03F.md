# TASK PACKET: CAL-03F — Google Calendar sync, server fix round 1 (review findings)
Role: worker (Opus 5.5 xhigh — MODEL_BINDINGS §9). Base: torgal/ohmydate HEAD (CAL-03 is merged there as bc0997d). The independent review (Fable 5.2 xhigh, separate session) approved CAL-03 with one MEDIUM and several LOW findings. Fix the ones listed under REQUIRED; do not widen the scope.

Read first: `docs/orchestration/packets/CAL-03.md` (the design you are fixing against), then the code named below. Short names: SVC = `services/api/src/application/google-calendar-service.ts`, HTTP = `services/api/src/adapters/google-http.ts`, STORE = `services/api/src/adapters/pg-google-calendar-store.ts`, ROUTES = `services/api/src/http/routes.ts`. Line numbers are from the reviewed commit and may have moved a little.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets (never open `*api_key*.txt`, `deploy/secrets/**`), calling paid external APIs other than your own model.
   NEVER call Google from tests or from your shell: tests use the injected fake port and the local fake HTTP server that CAL-03 added.
3. Commit your work on your branch with Conventional Commits; include "Task: CAL-03F" in the body.
4. Run every command in "Exact tests" and paste the real exit codes and tail output. Never claim a test passed
   that you did not run. If you could not run something, say SKIPPED + reason.
5. Send heartbeat if Orca's preamble asks for it.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
   (if your Orca preamble gives a different exact worker_done form, the preamble wins)
REPORT (body): taskId, dispatchId, worktree, branch, commit SHA(s); changed paths; each REQUIRED item -> fixed / not fixed with the test that proves it; tests: command -> exit code -> key lines.

SPEED RULE: do NOT run the full `pnpm run ci` or `pnpm run e2e`. MEMORY RULE: 15 GB laptop, other workers running — ONE test command at a time, the files you touched first.
Never type `pnpm ci`. Use `corepack pnpm …`. No new dependencies.

ALLOWED PATHS: `services/api/src/**`, `services/api/test/**`, `packages/contracts/**` ONLY if a description text must change (no shape change: a web task is building on the contract right now), `docs/blueprint/08-API-AND-EVENT-CONTRACTS.md` + `13-ADR.md` (ADR-024) + `docs/user/Google-캘린더-연동-설정.md` where behaviour you change is described. No web files, no migration.

REQUIRED (each with a regression test that fails before your fix; all Google traffic faked)
1) [MEDIUM] SVC ~576-582 — a token-refresh failure other than `invalid_grant` (laptop offline, Google 5xx, timeout, with no cached access token: the first sync after every API start and about hourly after) escapes the run. `POST /integrations/google:sync` answers 500 instead of the contracted failure, and a scheduled run records no `lastError`, so status keeps saying a healthy `connected`. Fix: handle it like any other failed step — record the matching `lastError` (`google_unavailable` / `rate_limited` / …), finish the run cleanly, answer the route as the contract says, keep the stored grant.
2) [LOW] SVC ~603-605 — `lastSyncAt` advances even when the run failed or was aborted. It must mean "last time a sync completed"; a failed run leaves it as it was and only sets `lastError`. (The settings screen shows it to the user as the last sync time.) Say in 08 what the field means.
3) [LOW] ROUTES ~1663-1666 + STORE ~199-217 — the ETag of `GET /integrations/google` is the version only, but a sync changes `lastSyncAt` / `lastError` without a version bump, so a conditional GET returns 304 with a stale status. Fix so the client always gets the current sync status (for example never answer 304 on this route, or make the validator cover the sync fields) WITHOUT making a background sync invalidate the user's `If-Match` for a settings save.
4) [LOW] HTTP ~457 + SVC ~686-703, 772 — a 200 `calendarList` answer without `items` (or with an empty list) is treated as "the user has no calendars": every listed calendar row is deleted, the selection resets, and all imported rows are soft-deleted. A Google account always has at least its primary calendar. Fix: an empty or item-less list is a failed step (`google_rejected`), nothing is replaced or removed.
5) [LOW] SVC ~796-805 + HTTP ~227-245 — `calendars.insert` is not idempotent but is retried on 429/5xx; a lost response or a crash before the id is stored leaves an untracked "OhMyDate" calendar and the next run makes another. Fix: one attempt for that call (a failure is a failed export step, retried on the next run), and store the returned id in the same step.
6) [LOW] STORE ~687 — the export takes every commitment whose source is not `google` (so `caldav` and `vikunja` too); the design says manual 약속 only. Fix: `source = 'manual'`.
7) [LOW] SVC ~584 — after a re-consent WITHOUT the read scopes, import is skipped but the rows imported earlier stay live, read-only and never refreshed, blocking time until disconnect. Fix: when a run finds import unavailable, remove what was imported (the same soft-delete path disconnect uses), once.
8) [LOW] SVC ~349 — if saving the grant throws, the callback answers a 500 problem document instead of the fixed redirect, and the fresh grant stays live at Google. Fix: redirect with `error` and revoke best effort.

NOT in this round (recorded as FU-103 by the coordinator): sequential task-title lookups outside the run deadline, the unbounded `response.text()`, the order of Google-side deletion vs the version-checked write on disconnect, the raw `state` inside the stored idempotent connect response, revoking the previous refresh token on re-consent.

Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456), one at a time:
corepack pnpm exec vitest run services/api/test/google-oauth.test.ts services/api/test/google-import.test.ts services/api/test/google-export.test.ts services/api/test/google-sync-job.test.ts services/api/test/google-http.test.ts services/api/test/google-conformance.test.ts services/api/test/google-logging.test.ts <any test file you add> ; corepack pnpm exec vitest run packages/contracts ; corepack pnpm run typecheck ; corepack pnpm run lint ; corepack pnpm run check:api-client ; corepack pnpm run check:boundaries.
Commit (Task trailer), clean git status, worker_done.
Retry limit 2. Rollback: delete branch.
