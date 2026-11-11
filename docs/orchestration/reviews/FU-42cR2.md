# FU-42cR2 (ctx_fdca7c977381, opus-fallback) — APPROVE

REVIEW VERDICT: APPROVE
All round-1 findings are fixed. The new issues below are not data inconsistency, crash or security issues, so they are follow-ups under the round-2 rule.

Findings (most severe first):
  [MEDIUM] Requests that arrive on a preserved socket after SIGTERM now run their handler instead of getting a 503 (introduced by the LOW-d fix)
    Evidence: main.ts:454 now calls app.server.close() at step 1, and app.close() runs only at step 5 (main.ts:505). Fastify sets router closing=true (route.js:488, return503OnClosing) only inside app.close(). The base (torgal/ohmydate) and 9889704 both called app.close() first, so a request that arrived after shutdown began got 503 with Connection: close.
      Probe S8 (in-process buildApp + createApplicationClose(app,3000,500)): GET /slow (600ms) is pending; close() starts at 50ms; at 150ms a POST /mut is pipelined on the same socket. Reviewed code: "/mut handler ran 1x after shutdown started; statuses=200,200 connection-close-header=false". Stock app.close(): "/mut handler ran 0x; statuses=200,503 connection-close-header=true".
      The new operation is tracked (drain, abort and cleanup apply), so there is no data inconsistency. But new work, including mutations, is accepted for up to the drain budget after SIGTERM, which breaks binding step (1) "server stops accepting".
    Suggestion: at step 1 set a shutdown flag in shutdown-context. The onRequest hook then replies 503 problem+json with Connection: close before it creates an operation (or reuses Fastify's closing state). Add a regression test for a pipelined request that arrives after shutdown starts.
  [LOW] An unsettled operation can lose its log and the DB destroy when an onClose hook is slow (the reconciler), because onClose now starts only after drain+cleanup
    Evidence: main.ts:505 awaits app.close() before the unsettled log (main.ts:514) and before the caller's db.destroy. That leaves only deadline - drain - cleanup (1s, or 0.5s at the 2500ms maximum) for onClose. VikunjaReconciler.stop() awaits the in-flight sweep. The sweep does not observe the shutdown signal, and the provider allows a 10s timeout per attempt with 2 retries.
      Probe R1/R2/R3 (real VikunjaReconciler, same onClose wiring as app.ts:441, drain 300 / cleanup 300):
        R1 settled: stop called at SIGTERM+1ms and done, then db.destroy, exit 0.
        R2 unsettled: stop called after drain+cleanup and done, then the "unsettled operations" log, "graceful shutdown failed", db.destroy, exit 1.
        R3 unsettled, sweep stalls 5s, deadline 2s: stop called at 773ms and never finished; "graceful shutdown timed out", exit 1; no unsettled log and no db.destroy.
      Answer to focus 2: reconciler.stop() is called on every path. It is awaited on the settled path and on the exit-1 unsettled path. On the hard-deadline path it is called (step 5 is always reached by about 14.5s) but may not finish before process.exit(1).
      The exit code stays 1 (fail-closed), and the PG session ends at exit, so there is no inconsistency.
    Suggestion: emit the unsettled log before awaiting app.close(), and bound app.close() by the remaining deadline. As a follow-up packet (reconciler.ts is outside the FU-42c allowed paths), make reconciler sweeps observe the shutdown signal, or stop and abort them at step 1 or 3.
  [LOW] The Promise.resolve wrapper sends an empty 200 too early for callback-style handlers that call reply.send() later (introduced by the LOW-a fix)
    Evidence: shutdown-context.ts:169 always returns a promise. When a sync handler returns undefined, Fastify's wrapThenable then calls reply.send(undefined) immediately, and the operation settles while the callback work is still running.
      Probe S9 (bare Fastify, handler `(req, reply) => { setTimeout(() => reply.send({late:true}), 50) }`): stock gives "status=200 body={\"late\":true}"; wrapped gives "status=200 body=\"\" pendingWhileCallbackRunning=0".
      Not reachable today: every production handler is async (routes.ts:367 is typed Promise<FastifyReply>, and both health routes are async), and no plugin registers routes. But onRoute wraps any future plugin route or callback-style route.
    Suggestion: for a non-thenable return, return the value unchanged. If the reply is not yet sent, settle on onResponse/onError, which already exist. Add a callback-style test.
  [INFO] All round-1 items are verified FIXED:
    MEDIUM: S1 at production budgets 12000/2000. Pending goes 1 before disconnect, 0 during the preHandler, then 1 when the handler starts; close() starts at 410ms; the handler finishes at 1294ms; close() resolves at 1297ms. S2 abort-ignoring variant: close rejects "shutdown cannot settle 1 in-flight operation(s)" and the unsettled log includes /pre-never.
    a: S3 sync handler returns reply, then write-after-end: 200, 0 uncaught, registry 0.
    b: S4 15 pipelined GETs: 15 responses, 0 MaxListenersExceededWarning.
    c: S5 drain 100, 300ms handler plus 150ms async onSend: 200 with body delivered. The compiled connected control now gets 503 provider_unavailable.
    d: S6 onClose runs after the handler finishes.
    e: 2500 accepted; 2501 and 3000 rejected; 0 and abc rejected; default 2000. The compiled boot with 3000 exits 1 (committed test).
    f: 5b9fdf2 body is real multi-line text with the Task footer. 9889704 history was left as is (accepted).
Contract / license / security / migration impact: none.
  Paths: 9889704..5b9fdf2 touches 5 paths (main.ts, http/shutdown-context.ts, 3 tests), all within the FU-42c allowed paths. The full torgal/ohmydate...5b9fdf2 diff (13 paths) matches round 1, including the recorded provider-vikunja barrel amendment.
  No dependency, OpenAPI/schema, migration, boundary, auth/owner, If-Match or timezone changes.
  Logs carry route template, reqId and method only. In the compiled probe, the synthetic token and password never appeared in the output.
  Test diffs only add tests or move createApplicationClose before listen (requirement 4). The weakening grep (skip/only/todo, removed expect) found nothing.
  Rollback: reset to 9889704 or 1cfd2fc; no migration.
Missing tests:
  (1) A pipelined or keep-alive request that arrives after shutdown starts (expect 503 + Connection: close, handler not run).
  (2) A callback-style handler that returns undefined and calls reply.send() later.
  (3) A slow onClose hook or in-flight reconciler sweep near the deadline (unsettled log and db.destroy ordering).
Verification actually executed: yes (env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456)
  corepack pnpm --filter @ohmydate/api test -> exit 0; 40 files, 226 passed / 9 skipped, 40.02s.
  corepack pnpm run ci -> exit 0; typecheck and lint OK; root 101 files / 1122 passed / 27 skipped; web 13 files / 69 passed; API client diff clean; boundaries 253 files / 0 violations; build smoke /healthz 200 {status:ok}, SIGTERM exit 0.
  vitest run --globals --reporter=verbose production-timeouts, shutdown-drain, shutdown-settlement, shutdown-settlement-regressions, shutdown-mutation-recovery, pool-timeout-disposal, http-timeouts, pool-connection-drop -> exit 0; 8 files, 34/34 passed, 0 skipped. Includes: 11s handler 200 + exit 0 (11547ms), trickle exit 0, incomplete pipelined body, pool disposal x4, compiled R2 (12831ms), never-settling exit 1, 1000-request mixed registry-to-0.
  git diff --check torgal/ohmydate...5b9fdf2 -> exit 0.
  Probes (tsx stdin, cwd services/api, scripts only in the session scratchpad):
    probe-inproc -> exit 0 (S1-S8, R1-R3 above).
    probe-cb -> exit 0 (S9).
    probe-compiled -> exit 0. Each case runs dist/main.js with a real authenticated PATCH, an isolated planner_test schema and a synthetic provider; after an actual SIGTERM, PG is queried after process exit:
      V1 PATCH applied, GET stalled, client disconnected: exit 0 after 12033ms, patchApplied=true, stalledAborted=true, needs_reconcile=true, idempotency rows=[].
      V2 connected control: exit 0 after 12043ms, client got 503 {"code":"provider_unavailable"}, needs_reconcile=true, rows=[].
      V3 PATCH itself stalled: exit 0 after 9961ms, needs_reconcile=true, rows=[].
      None of the three printed "already been destroyed", "idempotency release failed" or "unsettled", and none leaked a secret. All probe schemas were dropped.
git status --porcelain after review: empty (exit 0); HEAD 5b9fdf2f7f80fc091967cb6e0d17621df7423c44. No tracked file was modified, created, deleted or committed; only the ignored dist was rebuilt by the required commands.
Residual risks:
  The three follow-ups above.
  HTTP/1 only.
  The reconciler keeps starting sweeps during the drain (R2: 3 sweeps in 600ms at a 50ms interval) and is not request-scoped.
  On the hard-deadline path reconciler.stop() is not awaited.
  pg pool.end() waits for checked-out clients, bounded only by query_timeout or the deadline.
  A handler or response that overruns the cleanup budget is still force-closed (by design).
