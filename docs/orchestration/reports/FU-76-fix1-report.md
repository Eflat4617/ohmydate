# FU-76R-1 fix round — task_6332187385c9 / ctx_df8bc8066707

- branch torgal/fu-76-long-ai-calls · HEAD 416e6a4bee667701bd140a85d854b2da4f158c79 · git status clean
- commits: 06e1be6 merge torgal/ohmydate (963b4a4, FU-69) · 24bd784 fix(api,llm) H1/H3/M1 · 416e6a4 fix(web) H2
- base moved after my merge to 9e6dd8a (FU-53+72): `git merge-tree` HEAD vs torgal/ohmydate → clean (exit 0); not merged, so the tests below ran on 416e6a4.
- M6-03 (LLM_FAKE_SCENARIO) is NOT merged into torgal/ohmydate yet (no services/api/src/adapters/fake-llm-scenarios.ts) → the composition is left for the short follow-up, per coordinator msg_598e0189e964.

## Findings — reproduced first, then fixed

| # | Finding | Failing reproduction (before fix) | Fix | Now |
|---|---|---|---|---|
| H1 | agent_run cost ≠ ledger after a slow settlement | API PG test, provider actual 0.00027, ledger.settle delayed 1200 ms, :manual after settlement started: `expected 0.005268 to be close to 0.00027` | The ledger is the single source of truth. `agentRunId` flows request → runStructured → PolicyLlm → reservation (`llm_spend.agent_run_id`, existing column, no migration). The PG settle and stale recovery rewrite the run's cost/tokens from its rows in the same TX. `completeRun` derives cost/tokens from the linked rows under the owner's spend advisory lock (caller usage only for unlinked/fake runs). The abort response stores the ledger view at that moment (open rows at their reservation = "settling"), and the late settle overwrites it. | agent_run 0.00027 == ledger 0.00027 (status cancelled, tokens 1000). Added a linked stale-recovery test and an llm linkage unit test. |
| H2 | pending create crosses owners; continuations not owner-bound | 8 web tests failed: A's record survives logout and B's /plan/new restores A's title and POSTs; navigation, polling, answers and resume continue after an owner change | Key `ohmydate.intake.aiWait.v2:<verifiedOwnerId>`; the record names its owner. Written only while that owner's OwnerBinding is current and the owner is /me-verified. Read only for the same verified owner. The legacy unscoped key is never read and is removed. `onActiveOwnerChange` clears every record. Every continuation (create success, replay, poll, answers/type/resume, :manual) captures the binding before awaiting and drops itself when stale. An owner change bumps the poll token, aborts the client request, and resets the wait. The client stop never cancels the server call. | 8/8 owner tests pass (3/3 standalone runs); the existing wait tests now seed the owner-scoped key. |
| H3 | scripted fake usable in production | `configFromEnv({NODE_ENV:'production', LLM_PROVIDER:'fake', LLM_FAKE_SCRIPTED_OWNERS, LLM_FAKE_LATENCY_MS})` accepted; buildApp booted | One `assertFakeKnobsAllowed(config, extra)`, run at `configFromEnv` and at `buildApp` (programmatic configs). Any set knob needs `LLM_PROVIDER=fake` and is refused when `NODE_ENV=production`. New `AppConfig.nodeEnv`. `fakeLlmFor(config)` wraps the base fake with ScriptedFakeLlm (no early return), so other fake modes compose; M6-03 adds its knob to `fakeKnobsOf` / `extra`. | Config and boot rejection tests pass; the deepseek rejection is kept. |
| M1 | replay test races idempotent completion | Same test with an idempotency store whose `complete` is delayed 400 ms: `expected 409 to be 200` (deterministic) | The test replays the same key through the permitted 409 `idempotency_in_progress` until the stored 200 (bounded at 10 s). The delayed-complete store stays in, so the race is always exercised. | Passes; still asserts a single dispatch (1 decomposition call), a single charge (1 ledger row, actual 0.00027) and the final status `succeeded`. |

## Tests (DATABASE_URL=…/planner_test VIKUNJA_URL=http://127.0.0.1:3456)
- corepack pnpm --filter @ohmydate/llm test → exit 0 → 18 files, 665 passed / 2 skipped
- corepack pnpm --filter @ohmydate/api test → exit 0 → 76 files, 510 passed / 9 skipped
- corepack pnpm --filter @ohmydate/web test → exit 0 → 45 files, 376 passed
- corepack pnpm run ci → exit 0 → typecheck + lint ok; root 167 files 2071 passed / 29 skipped; web 45/376; check:api-client ok; boundaries 487 files 0 violations; build-smoke /healthz 200, SIGTERM exit 0 (the fu41 timeout did not occur, so no separate rerun was needed)
- corepack pnpm run e2e → exit 0 → 27 passed (7.0 m), incl. both E2E-AI tests

## Changed in this round
packages/llm/src/{port,run-structured,policy-llm,spend-ledger}.ts, packages/llm/test/fu54-abort-usage.test.ts,
services/api/src/{config,app}.ts, services/api/src/adapters/{pg-spend-ledger,pg-agent-run-repository}.ts,
services/api/src/application/intake/intake-service.ts, services/api/test/{intake-long-ai-calls,scripted-fake-llm}.test.ts,
apps/web/src/composables/useAiWait.ts, apps/web/src/views/PlanningWizardView.vue,
apps/web/test/wizard-ai-wait.spec.ts (seeds the owner-scoped key; owner confirmed first like AppShell), apps/web/test/wizard-ai-wait-owner.spec.ts (new)

## Residual risks
- M6-03 fake-scenario composition pending (needs its merge). The guard and the wrapper are ready for it.
- agent_run cost for ledger-linked runs now equals the ledger (open rows at reserved_usd until settled), which is intentionally more conservative than before.
- Cancel during create still waits for type detection/session discovery; the in-process cancel registry assumes a single API process; the 270 s orphan threshold is unchanged; the real gateway is unverified.
- The FU-77 structural guardrail (eslint storage ban, shared owner-bound helper) is not part of this round; the AI-wait code follows the existing layout-store pattern.
