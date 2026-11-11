# FU-76 (+ FU-54) worker report

- taskId: task_cfde75a4c8a4 · dispatchId: ctx_68cead5b15c5
- worktree: /home/torgal/orca/workspaces/oh_my_date/fu-76-long-ai-calls · branch: torgal/fu-76-long-ai-calls
- base a2023ad → commits: 3fabc49 (llm, FU-54) · 5fb3138 (api) · e637856 (web) · 3a3e107 (e2e + docs) · HEAD 3a3e107, worktree clean
- Scope amendments used (coordinator msg_57a943e740ec): services/api/migrations/0014_* ; docs/blueprint/08 §2.3.1. No packages/contracts / openapi / schema.d.ts change (contract-free as agreed).

## Changed paths (git diff --name-only a2023ad...HEAD) — 43 files, +4369/−273
apps/web/src/api/{ai-request.ts,client.ts,index.ts}, apps/web/src/components/AiWaitPanel.vue,
apps/web/src/composables/useAiWait.ts, apps/web/src/i18n/messages/ko.ts (own `aiWait` group),
apps/web/src/mocks/intake-handlers.ts, apps/web/src/views/PlanningWizardView.vue,
apps/web/test/{llm-consent.spec.ts,wizard-ai-wait.spec.ts},
docs/blueprint/08-API-AND-EVENT-CONTRACTS.md,
e2e/{global-setup.ts,helpers/db.ts,helpers/state.ts,tests/e2e-ai-wait.spec.ts},
packages/llm/src/{index,openai-compatible-llm,policy-llm,port,run-structured,spend-ledger,structured-messages}.ts, packages/llm/test/fu54-abort-usage.test.ts,
services/api/migrations/0014_agent_run_cancelled{,.down}.sql,
services/api/src/adapters/{pg-agent-run-repository,pg-intake-session-repository,pg-spend-ledger,scripted-fake-llm}.ts,
services/api/src/{app,config,main}.ts, services/api/src/application/intake/{ai-runs,intake-service,ports}.ts,
services/api/test/db/{agent-run-cancelled-schema(new),migrate,notes-schema,planning-schema,replanning-schema,today-sessions-schema}.test.ts,
services/api/test/{intake-long-ai-calls,scripted-fake-llm}.test.ts

## Diff summary
- llm: runStructured gets `signal`-driven abort with FU-54 charge carry (PolicyLlm reports its reservation/settlement via new `LlmCompleteRequest.onCharge`; on a raced timeout/abort runStructured waits ≤ `abortSettleGraceMs` (1 s) for a *charged* attempt and puts the policy's final charge on error.usage), optional `totalTimeoutMs` deadline; PolicyLlm never reserves for an aborted caller, settles actual 0 if aborted during the reservation write; one `buildStructuredMessages` used by PolicyLlm bound and adapter; `staleReservationThresholdWithFallbackMs` (×2 chains) is the policy default.
- api: in-process `IntakeAiRunRegistry`; intake AI calls get AbortSignal.any(registry, shutdown) + total deadline; agent_run rows start `pending` and complete as succeeded/failed/budget_exceeded/cancelled; POST :manual (and :cancel) abort the in-flight run, wait ≤5 s for settlement, manual mode with error.code `ai_cancelled`; shutdown abort → agent_run cancelled + session error `ai_interrupted` (no draft); POST :resume re-runs an interrupted decomposition; startup sweep (background) + lazy GET check mark orphans older than the 270 s bound; client disconnect never cancels.
- FU-54 PG ledger moved to adapters/pg-spend-ledger.ts; stale recovery commits even when the reservation is budget-rejected.
- web: AiWaitPanel + useAiWait (sessionStorage resume), cancel/manual via :manual with fresh version, reload/network-loss resume by GET polling (decomposition) or same-key replay (create), ai_interrupted 다시 시도 banner, ai_cancelled notice, unknown-code fallback copy, 315 s client bound.
- e2e: dedicated `aiwait` owner, fake-only `LLM_FAKE_SCRIPTED_OWNERS`/`LLM_FAKE_LATENCY_MS=5000`.

## Requirement checklist — FU-76
1. Web
 - calm progress with elapsed time + honest copy ("AI가 단계를 만들고 있어요 · 보통 30초–1분"; detection "· 보통 10–20초"), slow (>60 s) / overdue (>315 s) states — MET
 - UI responsive (only other wizard mutations paused; panel actions + nav live; quick requests never flash the panel, 700 ms reveal) — MET
 - 취소 aborts the request, server cancels the run (POST :manual), lands on manual path with inputs kept — MET (unit + API + E2E)
 - "직접 작성으로 계속" at any time (panel button + footer) — MET
 - no client timeout shorter than server bound; documented (client 315 s ≥ socket 300 s ≥ request 270 s ≥ call 250 s; ai-request.ts, ai-runs.ts, 08 §2.3.1) — MET
 - network loss/reload → resume by polling session (decomposition) / same Idempotency-Key replay (create), no re-submit, no double charge — MET
 - a11y: role=timer (not announced), polite live region at start / 30 s / every 60 s / done / cancelled; focus to panel heading, back to step heading; axe clean in E2E — MET
2. Server
 - abort path wired to AbortSignal through runStructured → PolicyLlm → adapter (explicit :manual + shutdown signal) — MET
 - cancelled run settles spend (reserved → reserved_fallback; actual if it arrived; actual 0 if never sent) and agent_run 'cancelled' (migration 0014) — MET
 - graceful shutdown during a call: drain stops accepting, aborts, settles, session recoverable (ai_interrupted → 다시 시도 via :resume) — MET
 - no stuck running sessions after restart: startup sweep of pending runs / in-flight sessions older than 270 s + lazy GET check — MET
3. Tests
 - web component tests with fake timers: progress/cadence/focus, cancel ×2, footer manual, reload resume, lost-connection resume, create replay, interrupted retry, unknown code, client bound — MET (wizard-ai-wait.spec.ts, 11)
 - API: cancel, negative idle :manual / :resume 409, disconnect mid-call (run completes, single charge, reload sees draft), shutdown-during-call (fake slow LLM) + restart :resume, startup sweep (+fresh untouched), lazy GET sweep (+live run untouched), spend settlement on abort (PG ledger) — MET (intake-long-ai-calls.test.ts, 7) + scripted fake/bounds (5) + 0014 schema (2)
 - E2E: wizard with 5 s fake AI shows progress, cancel works (agent_run cancelled), reload resumes (one succeeded run, 0 re-posted answers) — MET (e2e-ai-wait.spec.ts, 2)

## Requirement checklist — FU-54 (listed separately)
 - (a) runStructured timeout/abort merges the in-flight attempt's charge into error.usage (agent_run cost == ledger) — MET (llm fu54 tests: abort, timeout, repair-timeout sum, deaf transport, pre-abort, abort-during-reserve; API PG cancel/shutdown tests assert cost == ledger)
 - (b) PG stale recovery committed separately from a budget-rejected reservation — MET (decided in-tx, thrown after commit; PG test)
 - (c) PolicyLlm bound and adapter share ONE message builder — MET (+ test that JSON-mode and fallback outbound bytes ≤ reserved bound)
 - (d) stale threshold accounts for the JSON-mode fallback — MET (policy default + app use ×2 chains; 200 s row kept / 241 s row recovered test; old single-chain formula unchanged)
 - (e) consent UI grant/revoke tests — MET (llm-consent.spec.ts: grant→on→revoke with If-Match/UUIDv7 keys, failed grant negative, non-deepseek negative)

## Tests (DATABASE_URL=…/planner_test VIKUNJA_URL=http://127.0.0.1:3456)
- corepack pnpm --filter @ohmydate/llm test → exit 0 → 18 files, 664 passed / 2 skipped
- corepack pnpm --filter @ohmydate/api test → exit 0 → 76 files, 505 passed / 9 skipped
- corepack pnpm --filter @ohmydate/web test → exit 0 → 44 files, 368 passed
- corepack pnpm run ci → exit 0 → typecheck+lint ok; root vitest 166 files 2025 passed / 29 skipped; web 44/368; check:api-client ok (no diff); boundaries 485 files 0 violations; build-smoke /healthz 200, SIGTERM exit 0
- corepack pnpm run e2e → exit 0 → 27 passed (6.8 m), incl. 2 new E2E-AI
(The known scheduler property counterexample from M6-01R2 did not reproduce in this CI run.)

## Risks / unverified
- Real gateway never called; live latency/cancel behaviour unverified (fake/scripted providers only).
- Registry is in-process: correct for the single-process local deploy; a multi-instance deploy would need a shared cancel signal.
- Cancel during create: the session id is unknown until the create returns, so the client replays the same key (type detection ≤ 70 s bound) and then calls :manual; the detection call itself is not aborted.
- Shutdown aborts AI calls only after the 12 s drain (kept by design); detection interrupted by shutdown continues in manual mode (no AI retry for detection).
- After a crash + quick restart, an orphaned decomposition is only marked ai_interrupted once older than 270 s (client keeps polling with slow/overdue copy meanwhile).
- A transport that ignores abort for > 1 s grace leaves its row reserved (recovered later at reserved_usd); agent_run already reports that reserved amount.
- PolicyLlm default stale threshold 150 s → 240 s (app: 780 s with 120 s decomposition) — intended FU-54 change.
- Pre-existing migration chain tests (migrate/notes/planning/replanning/today-sessions) were extended to unwind 0014 first and to expect 0014 on reapply (coordinator-requested; no assertion removed/relaxed).
- e2e/global-setup.ts gains one owner — possible (additive) merge overlap with M6-03 E2E-6.

## New contracts for dependents
- None in packages/contracts/OpenAPI. Behavioural contract documented in 08 §2.3.1: in-progress rule, :manual cancels, :resume retries `ai_interrupted`, error codes `ai_interrupted` / `ai_cancelled`, bounds. Internal: `LlmCompleteRequest.onCharge`, RunStructuredOptions `totalTimeoutMs` / `abortSettleGraceMs`, agent_run status `cancelled` (0014), env `LLM_FAKE_SCRIPTED_OWNERS` / `LLM_FAKE_LATENCY_MS` (fake provider only; rejected otherwise).

## Rollback
Delete the branch. If 0014 was applied somewhere: `db:rollback` (down maps cancelled → failed, restores the old CHECK).
