# TASK PACKET: CAL-03 — Google Calendar sync, server side (OAuth, import to 약속, export to the phone) (GU-1 user feedback round 2)
Role: worker (Opus 5.5 xhigh — security boundary, secrets, migration, background job; MODEL_BINDINGS §9). Base: torgal/ohmydate HEAD. This change gets a separate security review after you finish (auth + secrets + migration), so leave it easy to review: small commits in the stage order below.

USER REQUEST (verbatim, Korean): "일정은 안드로이드 폰이랑 연동되게 구글일정공유? 그런거로 연동해줬으면 하고, 연동 시 구체적인 시간 구간이 정해져있는 일정이면 약속 메뉴에 그대로 일정 있다고 비워놓는 식으로." and about the product: "맨날 일을 미루기만 하는 나한테 오늘 할일이 무엇인지 리마인드 해주는 역할이 강하단말이야."
Context: one user, the app runs only on their Ubuntu laptop (web `http://127.0.0.1:5180`, which proxies `/api` to the API on `127.0.0.1:3100`; no public URL). Their phone is Android with Google Calendar. So the laptop talks to Google (outbound only), and the phone sees what Google has.

Read first: root `AGENTS.md`; `docs/blueprint/03-ARCHITECTURE.md`, `04-DOMAIN-AND-DATABASE.md` (commitment_event; conventions), `08-API-AND-EVENT-CONTRACTS.md` (header matrix, problem codes), `09-OPERATIONS-SECURITY.md` (secrets, logging, outbound), `13-ADR.md` (format; ADR-022/023 as recent examples); `services/api/src/config.ts` + `app.ts` + `main.ts` (config from env, composition, jobs, shutdown), `services/api/src/application/push-crypto.ts` (AES-256-GCM at rest with a key file), `application/notification-service.ts` + `replan-detection-job.ts` + `session-sweep-job.ts` (leader-locked interval jobs), `application/plan-service.ts` + `adapters/pg-planning-store.ts` (commitments, availability version bump on commitment writes, schedule blocks), `application/today-service.ts`, `application/replan-detection.ts` (commitment conflicts), `http/routes.ts` + `packages/contracts/src/routes.ts` (how a route is declared, bound, and what the header-matrix / conformance tests require), `services/api/migrations/0007_planning_core.sql` and the newest migration + its `.down.sql`, `services/api/src/db/types.ts`, `services/api/test/support/**`, `scripts/local/secrets.mjs` + `start.mjs` + `status.mjs` + `common.mjs` and their tests, `deploy/local/local.env` + `README.md`, `docs/user/**`.

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets (never open `*api_key*.txt`, `deploy/secrets/**`), calling paid external APIs other than your own model.
   NEVER call Google from tests or from your shell (no real OAuth, no real Calendar API): tests use an injected fake port and a local fake HTTP server. Reading Google's public documentation pages is fine and expected.
3. Commit your work on your branch with Conventional Commits; include "Task: CAL-03" in the body.
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
- a short "for the reviewer" list: where tokens are stored and read, every outbound URL, every place user data leaves the machine

SPEED RULE: do NOT run the full `pnpm run ci` or the full `pnpm run e2e`; run the commands under "Exact tests". The coordinator runs the full suites on the batched merge.
Never type `pnpm ci` (pnpm 12: that is a clean reinstall). Use `corepack pnpm …`.
NO NEW DEPENDENCIES: use Node's built-in `fetch` and `node:crypto`. (A Google SDK would need a licence review and is not needed.)

ALLOWED PATHS: `packages/contracts/**` (regenerate and commit `openapi.json`), `services/api/**` (migration number 0016 + `.down.sql`), `apps/web/src/api/schema.d.ts` (regenerated only) and, ONLY if you add a problem code, its message entry in `apps/web/src/i18n/messages/ko.ts` and whatever the web's problem-code tests require, `scripts/local/**`, `deploy/local/**`, `docs/blueprint/**` (ADR + the sections you change), `docs/user/**` (setup guide). No other web file: the settings screen is a later task (CAL-04) built on your contract.
Parallel tasks: CAL-01 (web month view), CAL-02 (adds `POST /commitments:parse` + a prompt; edits contracts, `services/api`, the commitments screen). Keep edits to shared files (`packages/contracts/src/index.ts`, `routes.ts`, `http/routes.ts`, `app.ts`, `ko.ts`) as small self-contained blocks.

STAGE ORDER (commit after each; stage 1 is what the web task builds on, so do it first and do not change its shapes later without saying so in the report)
 Stage 1 — contract: schemas + routes in `packages/contracts`, handlers that compile (real or `not yet` internals), `openapi.json`, web `schema.d.ts`. Commit subject must start with `feat(contracts): google calendar integration contract`.
 Stage 2 — config, secrets, token storage, OAuth connect/callback/disconnect, status.
 Stage 3 — import (Google → 약속 + all-day day events).
 Stage 4 — export (OhMyDate → the "OhMyDate" calendar) + the sync job + on-demand sync.
 Stage 5 — local scripts, docs, ADR.

DESIGN (decided by the coordinator; if a fact about Google's API contradicts it, follow Google's current documentation and report the difference)
A. OAuth
 - Client type "웹 애플리케이션" created by the user in their own Google Cloud project; the downloaded client JSON (`{"web":{client_id, client_secret, …}}`; also accept the `installed` shape) is a secret FILE: env `GOOGLE_OAUTH_CLIENT_FILE`. Redirect URI is explicit config, env `GOOGLE_OAUTH_REDIRECT_URI` (local default built by `scripts/local/start.mjs`: `http://127.0.0.1:<WEB_PORT>/api/v1/integrations/google/callback` — the web origin, so the session cookie (SameSite=Lax) comes back with the top-level redirect). After the callback the API answers 302 to a FIXED path on the configured web origin (env `GOOGLE_WEB_ORIGIN`, same default host:port): `/settings/calendar?google=connected | denied | error` — never to a URL taken from the request.
 - Authorization-code flow with PKCE S256, `access_type=offline`, `prompt=consent`, `include_granted_scopes` off, `state` = 32 random bytes, single use, 10-minute life, bound to the owner who started it; the callback requires a valid session of that same owner. `error=access_denied` and every mismatch end in the fixed redirect with a code, with nothing stored.
 - Scopes (least privilege): `https://www.googleapis.com/auth/calendar.app.created` (create ONE secondary calendar named "OhMyDate" and manage events on it), `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.readonly`. The app can therefore never change or delete anything in the user's own calendars. Granular consent: read the granted `scope` of the token response; without the two read scopes import is off, without `calendar.app.created` export is off — each reported in status, neither is an error.
 - The refresh token is stored encrypted at rest (AES-256-GCM, the push-crypto envelope; generalise that helper rather than copying it, without changing what push does) under a dedicated key file, env `GOOGLE_TOKEN_KEY_FILE`. Access tokens live in memory only. `invalid_grant` on refresh → status `needs_reauth`, sync stops, nothing is deleted.
 - Not configured (no client file, or no key) is a normal state: the API boots, status says `not_configured`, every other integration route answers with a clear problem. A configured-but-unreadable/malformed client file fails boot with a message that names the env var and not the contents.
 - Disconnect: revoke at Google (best effort), delete the stored token, soft-delete what was imported (commitments with source `google`, day events), and delete the "OhMyDate" calendar at Google when `removeExported` is true (default true; best effort, reported).
B. Data (migration 0016, with down)
 - `commitment_event`: allow source `google`; add nullable external reference columns (calendar id, event id, etag or updated stamp) with a partial unique index per owner on (calendar id, event id) for live rows. `COMMITMENT_SOURCES` gains `google`. Clients cannot create or patch a commitment INTO source `google`, and cannot edit or delete one that IS `google` (it is edited in Google): a clear 4xx problem (reuse a fitting existing code, or add `commitment_read_only`).
 - One Google connection per owner: status, encrypted refresh token + key id, granted scopes, export calendar id, settings, last sync time/result, version. A table of the owner's calendars as last listed (google calendar id, name, access role, primary flag, selected-for-import flag). A table of imported all-day events (`calendar_day_event`: owner, title, start date, end date exclusive, external ids) — these never block time. A mapping table for exported events (local kind + id → Google event id, fingerprint of what was pushed).
 - Owner-scoped everything (owner_id on every table, composite FKs as the conventions require). No token, code or event title in any log line.
C. Import (Google → OhMyDate)
 - Calendars: `calendarList.list`. Default selection on first connect: calendars the user owns (`accessRole` owner) and public holiday calendars; never the "OhMyDate" export calendar. The user changes the selection through settings.
 - Per selected calendar: `events.list` with `singleEvents=true`, `timeMin = now − 1 day`, `timeMax = now + 180 days` (env-tunable), paged, bounded (cap the pages; on overflow stop and report). Each instance is one row keyed by (calendar id, instance event id).
   · timed event (`start.dateTime`) → a 약속 (`commitment_event`, source `google`, no rrule, the event's own zone or the owner's zone) — it blocks time exactly like a manual one. This is the user's sentence: "구체적인 시간 구간이 정해져있는 일정이면 약속 메뉴에 그대로".
   · all-day event (`start.date`) → `calendar_day_event` only. It blocks nothing.
   · skipped: `status=cancelled`, events the user declined (`attendees[].self` with `responseStatus=declined`), `transparency=transparent` ("한가함"), zero-length events.
   · titles cut to 200; an empty title becomes a neutral fixed title in the owner's language. Descriptions, attendees and locations are NOT stored.
 - Diff, not rewrite: unchanged rows are not touched (no version bump, no availability-version bump); changed rows are updated; rows inside the listed window that Google no longer returns are soft-deleted; rows older than the window are left alone. Real changes go through the same write path as manual commitments so the availability version and replan detection behave as they do for a manual edit.
D. Export (OhMyDate → Google, into the app's own "OhMyDate" calendar only)
 - What: approved, non-superseded schedule blocks from `now − 1 day` to `now + 60 days` (env-tunable) with the task title as the event title; manual 약속 (a repeating one as a Google recurring event: `recurrence: ["RRULE:…"]` + `start.timeZone`); and, when the setting is on, ONE short "오늘 할 일" event per day that has blocks, at the first block's start minus the reminder lead or at the owner's day start (pick one rule, state it), titled with the count ("오늘 할 일 3개") and listing times + titles in the description. Imported (`google`) 약속 are never exported.
 - Reminders: `reminders.useDefault=false` with one popup override at the setting `reminderMinutes` (default 10; `null` = no popup). This is how the phone reminds the user.
 - Idempotent: deterministic client-supplied event ids (Google allows base32hex characters a–v and 0–9, length 5–1024: e.g. a one-letter kind prefix + the uuid's 32 hex digits), the mapping table's fingerprint to skip unchanged events, insert → on duplicate id treat as existing and patch (a previously deleted id comes back as cancelled: patch it to confirmed), patch/delete on 404/410 → drop the mapping. Blocks that moved are patched; blocks that are gone are deleted.
 - What leaves the machine: task titles, block times, 약속 titles and times. Nothing else (no notes, no descriptions, no goal text).
E. Sync
 - A leader-locked interval job like the existing ones (env `GOOGLE_SYNC_INTERVAL_MS`, default 300000; 0 = off), one owner at a time, import then export, each Google call with a timeout, bounded retries with backoff on 429 / 5xx / `rateLimitExceeded`, and a per-run wall-clock bound. A failure of one owner or one calendar is recorded (`lastError` code) and does not stop the others.
 - A debounced nudge: after a successful mutation that changes what should be exported (plan approval, replan approval, Today accept/shrink/reschedule, block lock is not one, commitment create/update/delete) the owner's export runs within a few seconds. Best effort, never fails or delays the request, cancelled on shutdown.
 - `POST /integrations/google:sync` runs one sync now and returns counts.
F. API (all under `/api/v1`, owner-authenticated, the standard header rules; names can be adjusted to the contract conventions but keep the shapes)
 - `GET  /integrations/google` → `{ status: 'not_configured' | 'disconnected' | 'connected' | 'needs_reauth', importAvailable, exportAvailable, calendars: [{ id, name, primary, accessRole, selected }], exportCalendarName | null, settings: { exportBlocks, exportCommitments, dailySummary, reminderMinutes | null }, lastSyncAt | null, lastError | null (code), version }` with an ETag.
 - `POST /integrations/google:connect` → `{ authorizationUrl }` (Idempotency-Key).
 - `GET  /integrations/google/callback?code&state` (or `error`) → 302 as in A. Not in the JSON header matrix (it is a browser redirect); document why.
 - `PUT  /integrations/google/settings` (If-Match + Idempotency-Key) → selected calendar ids + the settings above.
 - `POST /integrations/google:sync` (Idempotency-Key) → `{ imported: { created, updated, removed, dayEvents }, exported: { created, updated, removed }, lastSyncAt }`.
 - `DELETE /integrations/google` (If-Match + Idempotency-Key, `removeExported` flag) → 204.
 - `GET  /calendar-day-events?from=YYYY-MM-DD&to=YYYY-MM-DD` (range ≤ 92 days) → `{ items: [{ id, title, startDate, endDate (exclusive), source: 'google', calendarName }] }`.
 - `Commitment` gains nothing but the new source value; the list keeps working unchanged.
G. Local run package
 - `scripts/local/secrets.mjs` also generates the token key (0600) and reports it like the other keys; `start.mjs` passes `GOOGLE_TOKEN_KEY_FILE`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_WEB_ORIGIN`, and `GOOGLE_OAUTH_CLIENT_FILE` when the file exists at the default place `deploy/secrets/local/google-oauth-client.json` (or the env override); `status.mjs` says in one line whether Google sync is configured. `deploy/local/local.env` documents the non-secret knobs. Existing script tests stay green; add tests for the new behaviour (file missing → not configured, wrong permissions → refuse with a clear message, values never printed).
H. Docs
 - ADR-024 in `13-ADR.md` (why Google OAuth with these three scopes, why a dedicated calendar, why windowed full listing instead of sync tokens, what leaves the machine, alternatives rejected: private iCal address = import only, CalDAV = same OAuth).
 - 04 / 08 / 09 updated where this adds tables, routes, secrets, outbound hosts (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`).
 - `docs/user/`: a Korean setup guide a non-developer can follow — create a Google Cloud project, enable the Calendar API, configure the consent screen (external, add yourself as a test user; explain that in "Testing" status Google expires the sign-in after 7 days and that pressing "앱 게시" removes that, at the cost of an "unverified app" warning once), create the OAuth client (type 웹 애플리케이션, the exact redirect URI to paste), download the JSON to the exact local path with `chmod 600`, restart with `local:stop` / `local:start`, then connect in the app. Verify every step against Google's current console/documentation wording and say in the report which steps you could not verify.

REQUIRED TESTS (each new behaviour with at least one negative case; all Google traffic faked)
 - contract/conformance/header-matrix for the new routes; openapi regenerated; `check:api-client` clean.
 - migration up/down on a fresh schema and on a schema with existing commitments; constraints (source, unique external ref, owner isolation).
 - config: not configured boots; malformed client file fails boot without leaking contents; key rules.
 - OAuth: state single-use / expiry / wrong owner / missing session / `access_denied`; PKCE verifier sent; redirect is always the fixed one; token encrypted at rest (ciphertext in the row, plaintext nowhere, key id recorded); `invalid_grant` → `needs_reauth`; partial scopes → import or export unavailable.
 - import: timed vs all-day vs cancelled vs declined vs transparent; paging; update, removal inside the window, past rows kept; unchanged sync bumps no version; another owner's rows untouched; imported 약속 enters scheduling as busy time (one planning test); client cannot write source `google` or edit/delete an imported row.
 - export: block created / moved / removed; repeating 약속 as RRULE; daily summary on and off; reminder minutes incl. null; duplicate-id recovery; 404/410 on patch; imported rows never exported; fingerprint prevents re-patching.
 - sync job: leader lock, one failing calendar does not stop the rest, 429 backoff bounded, shutdown stops cleanly; nudge fires after the listed mutations and never fails the request.
 - logging: tokens, codes, authorization headers and event titles never appear (extend the redaction tests).
 - local scripts: as in G.

Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456):
corepack pnpm exec vitest run packages/contracts <every services/api test file you added or touched, plus planning.test.ts, conformance.test.ts, daily-conformance.test.ts, logging.test.ts, config.test.ts, main.test.ts, the migration tests under services/api/test/db> ; corepack pnpm exec vitest run -c scripts/local/vitest.config.mjs (or however the local-script tests are run in this repo — check package.json) ; corepack pnpm run typecheck ; corepack pnpm run lint ; corepack pnpm run check:api-client ; corepack pnpm run check:boundaries.
Commit (Task trailer), clean git status, worker_done.
Retry limit 2. Rollback: delete branch (migration 0016 has a down file; nothing is deployed until the coordinator merges).
