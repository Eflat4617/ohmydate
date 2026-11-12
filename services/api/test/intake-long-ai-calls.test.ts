/**
 * FU-76: long AI decomposition calls.
 *
 * - explicit cancel (POST :manual) aborts the in-flight run, settles its spend
 *   and records agent_run `cancelled`; the user lands on the manual path with
 *   the inputs kept (session.error.code ai_cancelled);
 * - a client disconnect never cancels: the run completes, is charged once and
 *   the reloaded client sees the draft;
 * - graceful shutdown aborts and settles the call and marks the session
 *   recoverable (ai_interrupted); POST :resume retries it;
 * - orphaned runs/sessions older than the bound are swept at startup and
 *   lazily on GET;
 * - FU-54: PG stale recovery survives a budget-rejected reservation.
 */

import type { AddressInfo } from 'node:net';
import type { IntakeInput, IntakeSessionDto } from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import {
  BudgetExceeded,
  BudgetGuard,
  DEFAULT_DEEPSEEK_PRICING,
  LlmUnavailable,
  PolicyLlm,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
  type LlmSpendLedger,
} from '@ohmydate/llm';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { buildApp, startupSweepFor } from '../src/app.js';
import { createPgSpendLedger } from '../src/adapters/pg-spend-ledger.js';
import { PgIdempotencyStore } from '../src/adapters/pg-idempotency-store.js';
import type { IdempotencyStore } from '../src/application/ports.js';
import { createConfig } from '../src/config.js';
import { createApplicationClose } from '../src/main.js';
import { intakeAiRequestBoundMs } from '../src/application/intake/ai-runs.js';
import {
  authHeaders,
  createTestContext,
  databaseUrl,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const readyInput: IntakeInput = {
  title: 'Quarterly report',
  deliverable: 'Write the quarterly report for Q3',
  dueAt: '2026-12-01T00:00:00.000Z',
  estimatedScope: 'medium',
  currentProgress: 0.1,
  availabilityConfirmed: true,
};

const aiDraft = {
  steps: [
    {
      key: 's1',
      title: 'Gather inputs',
      deliverable: 'Inputs collected',
      doneCriteria: 'All sources present',
      kind: 'prep',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: [],
      splittable: false,
    },
    {
      key: 's2',
      title: 'AI drafted the report',
      deliverable: 'Draft report',
      doneCriteria: 'Draft reviewed',
      kind: 'work',
      estimate: { p50Minutes: 120, p90Minutes: 240 },
      dependsOn: ['s1'],
      splittable: true,
    },
    {
      key: 's3',
      title: 'Review the report',
      deliverable: 'Reviewed report',
      doneCriteria: 'Review notes resolved',
      kind: 'review',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: ['s2'],
      splittable: false,
    },
  ],
  assumptions: ['fixture draft'],
  questionsRemaining: [],
};

const consent = { granted: true, at: '2026-11-12T00:00:00.000Z', provider: 'deepseek' } as const;

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A slow provider: type detection answers at once, every decomposition call
 * waits for `release()` (or rejects like the real adapter when its signal
 * aborts). Usage is priced so the spend ledger records real amounts.
 */
class SlowDecompositionLlm implements LlmPort {
  decompositionCalls = 0;
  aborted = 0;
  started = deferred();
  #gate = deferred();

  release(): void {
    this.#gate.resolve();
  }

  rearm(): void {
    this.started = deferred();
    this.#gate = deferred();
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    request.onDispatch?.();
    if (request.promptId === 'type_detection') {
      return {
        output: { classification: 'new', confidence: 0.9, reasons: ['fixture'], missingRequired: [] },
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.000005 },
        model: 'deepseek-v4.1-flash',
        latencyMs: 1,
      };
    }
    this.decompositionCalls += 1;
    this.started.resolve();
    const gate = this.#gate.promise;
    await new Promise<void>((resolve, reject) => {
      const signal = request.signal;
      const onAbort = (): void => {
        this.aborted += 1;
        reject(new LlmUnavailable('llm call aborted by caller', 'aborted', false));
      };
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      void gate.then(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
    return {
      output: aiDraft,
      usage: { inputTokens: 1200, outputTokens: 800, costUsd: 0.00066 },
      model: 'deepseek-v4.1-flash',
      latencyMs: 31_000,
    };
  }
}

function generousGuard(): BudgetGuard {
  return new BudgetGuard({ dailyUsd: 10, monthlyUsd: 100 }, { allowUnpricedModels: ['fake-llm'] });
}

/** PolicyLlm over the slow provider with the production PG ledger, bound after the context exists. */
function policyPort(
  slow: LlmPort,
  wrapLedger: (ledger: LlmSpendLedger) => LlmSpendLedger = (ledger) => ledger,
): { port: LlmPort; bind(ctx: TestContext): void } {
  let policy: PolicyLlm | undefined;
  return {
    port: {
      complete: (request) => {
        if (policy === undefined) throw new Error('policy not bound');
        return policy.complete(request);
      },
    },
    bind(ctx) {
      policy = new PolicyLlm({
        inner: slow,
        providerId: 'deepseek',
        defaultBudget: { dailyUsd: 5, monthlyUsd: 50 },
        resolve: async () => ({ consent }),
        ledger: wrapLedger(createPgSpendLedger(ctx.db)),
        pricing: DEFAULT_DEEPSEEK_PRICING,
        maxOutputTokens: 2000,
        newReservationId: () => ctx.ids.next(),
        now: () => new Date(Date.parse(ctx.clock.now())),
      });
    },
  };
}

async function createReadySession(ctx: TestContext, user: TestSession): Promise<IntakeSessionDto> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/intake-sessions',
    headers: authHeaders(user, { 'idempotency-key': newIdempotencyKey() }),
    payload: { input: readyInput },
  });
  expect(response.statusCode).toBe(201);
  const session = response.json() as IntakeSessionDto;
  expect(session.state).toBe('clarification');
  return session;
}

function answersRequest(ctx: TestContext, user: TestSession, session: IntakeSessionDto, key = newIdempotencyKey()) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/intake-sessions/${session.id}/answers`,
    headers: authHeaders(user, { 'if-match': `W/"${session.version}"`, 'idempotency-key': key }),
    payload: { answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] },
  });
}

async function getSession(ctx: TestContext, user: TestSession, id: string): Promise<IntakeSessionDto> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/intake-sessions/${id}`,
    headers: authHeaders(user),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as IntakeSessionDto;
}

function sessionAction(ctx: TestContext, user: TestSession, id: string, action: 'manual' | 'resume' | 'cancel', version: number) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/intake-sessions/${id}:${action}`,
    headers: authHeaders(user, { 'if-match': `W/"${version}"`, 'idempotency-key': newIdempotencyKey() }),
  });
}

async function decompositionRuns(ctx: TestContext, ownerId: Id) {
  return ctx.db
    .selectFrom('agent_run')
    .select(['status', 'cost_usd', 'tokens_in', 'model'])
    .where('owner_id', '=', ownerId)
    .where('purpose', '=', 'decomposition')
    .execute();
}

async function decompositionSpend(ctx: TestContext, ownerId: Id) {
  return ctx.db
    .selectFrom('llm_spend')
    .select(['state', 'settle_reason', 'reserved_usd', 'actual_usd'])
    .where('owner_id', '=', ownerId)
    // FU-89: the ledger purpose is the prompt key the service sends.
    .where('purpose', '=', 'decomposition@v3')
    .execute();
}

/**
 * PG idempotency store whose `complete` lands late, so the stored response is
 * still pending while the draft is already visible (the FU-76R-1 M1 race,
 * made deterministic).
 */
function slowCompleteIdempotency(delayMs: number): { store: IdempotencyStore; bind(ctx: TestContext): void } {
  let inner: IdempotencyStore | undefined;
  const target = (): IdempotencyStore => {
    if (inner === undefined) throw new Error('idempotency store not bound');
    return inner;
  };
  return {
    store: {
      reserve: (input) => target().reserve(input),
      complete: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return target().complete(input);
      },
      release: (ownerId, key) => target().release(ownerId, key),
    },
    bind(ctx) {
      inner = new PgIdempotencyStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids, ttlMs: 86_400_000 });
    },
  };
}

/** Replays the same key while the server answers the permitted 409 idempotency_in_progress. */
interface InjectedResponse {
  readonly statusCode: number;
  json(): unknown;
}

async function replayUntilStored<T extends InjectedResponse>(
  send: () => PromiseLike<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await send();
    const inProgress =
      response.statusCode === 409 &&
      (response.json() as { code?: string }).code === 'idempotency_in_progress';
    if (!inProgress || Date.now() > deadline) return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!hasDatabase)('FU-76 long AI calls', () => {
  test('POST :manual cancels the in-flight decomposition: spend settled, agent_run cancelled, manual path keeps inputs', async () => {
    const slow = new SlowDecompositionLlm();
    const policy = policyPort(slow);
    const ctx = await createTestContext({ llm: policy.port, budgetGuard: generousGuard() });
    policy.bind(ctx);
    const ownerId = await ctx.seedUser({ email: 'fu76-cancel@example.com', password: 'correct-horse' });
    const user = await login(ctx, 'fu76-cancel@example.com', 'correct-horse');
    try {
      const session = await createReadySession(ctx, user);
      const inFlight = answersRequest(ctx, user, session);
      await slow.started.promise;

      // The waiting client reads the current version and the in-progress rule.
      const waiting = await getSession(ctx, user, session.id);
      expect(waiting.state).toBe('decomposition');
      expect(waiting.draft).toBeUndefined();
      expect(waiting.error).toBeUndefined();
      expect(waiting.manual).toBe(false);

      const manual = await sessionAction(ctx, user, session.id, 'manual', waiting.version);
      expect(manual.statusCode).toBe(200);
      const landed = manual.json() as IntakeSessionDto;
      expect(landed.manual).toBe(true);
      expect(landed.error?.code).toBe('ai_cancelled');
      expect(landed.state).toBe('decomposition');
      expect(landed.draft?.steps.length).toBeGreaterThanOrEqual(3);
      expect(landed.draft?.steps.some((step) => step.title === 'AI drafted the report')).toBe(false);
      // Inputs kept: the answer submitted before the AI call is part of the session.
      expect(landed.input).toMatchObject({ ...readyInput, priority: 2 });

      const original = await inFlight;
      expect(original.statusCode).toBe(200);
      expect(slow.aborted).toBe(1);

      const runs = await decompositionRuns(ctx, ownerId);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('cancelled');
      const spend = await decompositionSpend(ctx, ownerId);
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({ state: 'settled', settle_reason: 'reserved_fallback' });
      // agent_run cost == ledger (FU-54 semantics on abort).
      expect(Number(runs[0]?.cost_usd)).toBeCloseTo(Number(spend[0]?.actual_usd), 6);
      expect(Number(runs[0]?.cost_usd)).toBeGreaterThan(0);
    } finally {
      slow.release();
      await ctx.close();
    }
  });

  test('negative: POST :manual with nothing in flight keeps the existing behaviour (no ai_cancelled)', async () => {
    const slow = new SlowDecompositionLlm();
    const ctx = await createTestContext({ llm: slow, budgetGuard: generousGuard() });
    await ctx.seedUser({ email: 'fu76-idle@example.com', password: 'correct-horse' });
    const user = await login(ctx, 'fu76-idle@example.com', 'correct-horse');
    try {
      const session = await createReadySession(ctx, user);
      const manual = await sessionAction(ctx, user, session.id, 'manual', session.version);
      expect(manual.statusCode).toBe(200);
      const landed = manual.json() as IntakeSessionDto;
      expect(landed.manual).toBe(true);
      expect(landed.error).toBeUndefined();
      expect(slow.decompositionCalls).toBe(0);
      // :resume is only a retry for an interrupted decomposition.
      const resume = await sessionAction(ctx, user, session.id, 'resume', landed.version);
      expect(resume.statusCode).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test('client disconnect mid-call: the run completes, is charged once, and the reloaded client sees the draft', async () => {
    const slow = new SlowDecompositionLlm();
    const policy = policyPort(slow);
    const idempotency = slowCompleteIdempotency(400);
    const ctx = await createTestContext({
      llm: policy.port,
      budgetGuard: generousGuard(),
      idempotency: idempotency.store,
    });
    policy.bind(ctx);
    idempotency.bind(ctx);
    const ownerId = await ctx.seedUser({ email: 'fu76-disconnect@example.com', password: 'correct-horse' });
    const user = await login(ctx, 'fu76-disconnect@example.com', 'correct-horse');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;
    try {
      const session = await createReadySession(ctx, user);
      const key = newIdempotencyKey();
      const controller = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}/api/v1/intake-sessions/${session.id}/answers`, {
        method: 'POST',
        headers: {
          ...authHeaders(user, { 'if-match': `W/"${session.version}"`, 'idempotency-key': key }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] }),
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await slow.started.promise;
      controller.abort(); // reload / network blip: the socket goes away
      expect(await request).toBeInstanceOf(Error);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(slow.aborted).toBe(0);

      // Reloaded client: in progress, then polls until the draft appears.
      const polled = await getSession(ctx, user, session.id);
      expect(polled.state).toBe('decomposition');
      expect(polled.draft).toBeUndefined();
      slow.release();
      const done = await waitFor(async () => {
        const fresh = await getSession(ctx, user, session.id);
        return fresh.draft === undefined ? undefined : fresh;
      });
      expect(done.manual).toBe(false);
      expect(done.error).toBeUndefined();
      expect(done.draft?.steps[1]?.title).toBe('AI drafted the report');

      // Same Idempotency-Key replays the stored outcome; nothing runs again.
      // The stored result may still be pending (the draft is visible before the
      // idempotent response is persisted, here slowed down on purpose): poll the
      // same key through the permitted transient 409 until the stored 200 exists.
      const replay = await replayUntilStored(() => answersRequest(ctx, user, session, key));
      expect(replay.statusCode).toBe(200);
      expect(slow.decompositionCalls).toBe(1);
      const runs = await decompositionRuns(ctx, ownerId);
      expect(runs.map((run) => run.status)).toEqual(['succeeded']);
      const spend = await decompositionSpend(ctx, ownerId);
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({ state: 'settled', settle_reason: 'actual' });
      expect(Number(spend[0]?.actual_usd)).toBeCloseTo(0.00066, 6);
      expect(Number(runs[0]?.cost_usd)).toBeCloseTo(0.00066, 6);
    } finally {
      slow.release();
      await ctx.close();
    }
  });

  test('graceful shutdown during the call aborts and settles it, marks ai_interrupted; :resume retries after restart', async () => {
    const slow = new SlowDecompositionLlm();
    const policy = policyPort(slow);
    const ctx = await createTestContext({ llm: policy.port, budgetGuard: generousGuard() });
    policy.bind(ctx);
    const ownerId = await ctx.seedUser({ email: 'fu76-shutdown@example.com', password: 'correct-horse' });
    const user = await login(ctx, 'fu76-shutdown@example.com', 'correct-horse');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;
    let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
    // Installed at boot in production (main.ts); short drain (the call outlives
    // it) and the production cleanup budget.
    const close = createApplicationClose(ctx.app, 100, 2_000);
    try {
      const session = await createReadySession(ctx, user);
      const request = fetch(`http://127.0.0.1:${port}/api/v1/intake-sessions/${session.id}/answers`, {
        method: 'POST',
        headers: {
          ...authHeaders(user, { 'if-match': `W/"${session.version}"`, 'idempotency-key': newIdempotencyKey() }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] }),
      }).catch((error: unknown) => error);
      await slow.started.promise;

      await expect(close()).resolves.toBeUndefined();
      await request;
      expect(slow.aborted).toBe(1);

      const runs = await decompositionRuns(ctx, ownerId);
      expect(runs.map((run) => run.status)).toEqual(['cancelled']);
      const spend = await decompositionSpend(ctx, ownerId);
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({ state: 'settled', settle_reason: 'reserved_fallback' });
      expect(Number(runs[0]?.cost_usd)).toBeCloseTo(Number(spend[0]?.actual_usd), 6);
      const stored = await ctx.db
        .selectFrom('intake_session')
        .select(['state', 'error', 'manual'])
        .where('id', '=', session.id as Id)
        .executeTakeFirstOrThrow();
      expect(stored).toMatchObject({ state: 'decomposition', manual: false });
      expect((stored.error as { code?: string } | null)?.code).toBe('ai_interrupted');

      // "Restart": a new app on the same database; the user sees 다시 시도.
      slow.rearm();
      restarted = await buildApp({
        config: createConfig({
          databaseUrl: databaseUrl ?? null,
          cookieSecure: false,
          logLevel: 'silent',
          loginRateLimit: { limit: 1_000, windowMs: 60_000 },
        }),
        repos: createInMemoryRepositories({ clock: ctx.clock, ids: ctx.ids }),
        clock: ctx.clock,
        ids: ctx.ids,
        db: ctx.db,
        logger: false,
        llm: policy.port,
        budgetGuard: generousGuard(),
      });
      await restarted.ready();
      const afterCtx = { ...ctx, app: restarted } as TestContext;
      const reloginUser = await login(afterCtx, 'fu76-shutdown@example.com', 'correct-horse');
      const interrupted = await getSession(afterCtx, reloginUser, session.id);
      expect(interrupted.error?.code).toBe('ai_interrupted');
      expect(interrupted.draft).toBeUndefined();

      const retry = sessionAction(afterCtx, reloginUser, session.id, 'resume', interrupted.version);
      await slow.started.promise;
      slow.release();
      const retried = await retry;
      expect(retried.statusCode).toBe(200);
      const body = retried.json() as IntakeSessionDto;
      expect(body.error).toBeUndefined();
      expect(body.draft?.steps[1]?.title).toBe('AI drafted the report');
      // The retry is one new, explicit charge.
      expect((await decompositionRuns(ctx, ownerId)).map((run) => run.status).sort()).toEqual([
        'cancelled',
        'succeeded',
      ]);
      expect(await decompositionSpend(ctx, ownerId)).toHaveLength(2);
    } finally {
      slow.release();
      await restarted?.close();
      await ctx.close();
    }
  });

  test('startup sweep cancels orphaned pending runs and marks stale in-flight sessions; fresh ones are left alone', async () => {
    const slow = new SlowDecompositionLlm();
    const ctx = await createTestContext({ llm: slow, budgetGuard: generousGuard() });
    const ownerId = await ctx.seedUser({ email: 'fu76-sweep@example.com', password: 'correct-horse' });
    const user = await login(ctx, 'fu76-sweep@example.com', 'correct-horse');
    let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      const stale = await createReadySession(ctx, user);
      const fresh = await createReadySession(ctx, user);
      // Simulate a crash mid-decomposition: state written, no draft, run pending.
      const bound = intakeAiRequestBoundMs();
      for (const [id, ageMs] of [
        [stale.id, bound + 60_000],
        [fresh.id, 1_000],
      ] as const) {
        await ctx.db
          .updateTable('intake_session')
          .set({ state: 'decomposition', updated_at: new Date(Date.parse(ctx.clock.now()) - ageMs) })
          .where('id', '=', id as Id)
          .execute();
      }
      for (const [id, minutes] of [
        [ctx.ids.next(), 10],
        [ctx.ids.next(), 0],
      ] as const) {
        await ctx.db
          .insertInto('agent_run')
          .values({
            id,
            owner_id: ownerId,
            purpose: 'decomposition',
            prompt_id_version: 'decomposition@v1',
            model: 'unknown',
            provider: 'deepseek',
            status: 'pending',
            created_at: new Date(Date.now() - minutes * 60_000),
          } as never)
          .execute();
      }

      restarted = await buildApp({
        config: createConfig({
          databaseUrl: databaseUrl ?? null,
          cookieSecure: false,
          logLevel: 'silent',
          loginRateLimit: { limit: 1_000, windowMs: 60_000 },
        }),
        repos: createInMemoryRepositories({ clock: ctx.clock, ids: ctx.ids }),
        clock: ctx.clock,
        ids: ctx.ids,
        db: ctx.db,
        logger: false,
        llm: slow,
        budgetGuard: generousGuard(),
      });
      await expect(startupSweepFor(restarted)).resolves.toEqual({ runs: 1, sessions: 1 });

      const runs = await ctx.db
        .selectFrom('agent_run')
        .select(['status', 'created_at'])
        .where('owner_id', '=', ownerId)
        .where('purpose', '=', 'decomposition')
        .orderBy('created_at')
        .execute();
      expect(runs.map((run) => run.status)).toEqual(['cancelled', 'pending']);

      const rows = await ctx.db
        .selectFrom('intake_session')
        .select(['id', 'error', 'manual'])
        .where('owner_id', '=', ownerId)
        .execute();
      const byId = new Map(rows.map((row) => [row.id as string, row]));
      expect((byId.get(stale.id)?.error as { code?: string } | null)?.code).toBe('ai_interrupted');
      expect(byId.get(stale.id)?.manual).toBe(false);
      expect(byId.get(fresh.id)?.error).toBeNull();
    } finally {
      await restarted?.close();
      await ctx.close();
    }
  });

  test('GET marks an orphaned in-flight session ai_interrupted only once no run is alive and the bound has passed', async () => {
    const slow = new SlowDecompositionLlm();
    const ctx = await createTestContext({ llm: slow, budgetGuard: generousGuard() });
    await ctx.seedUser({ email: 'fu76-lazy@example.com', password: 'correct-horse' });
    const user = await login(ctx, 'fu76-lazy@example.com', 'correct-horse');
    try {
      const session = await createReadySession(ctx, user);
      const inFlight = answersRequest(ctx, user, session);
      await slow.started.promise;
      // Negative: a live run is never swept, however long it takes.
      ctx.clock.advance(intakeAiRequestBoundMs() + 60_000);
      const alive = await getSession(ctx, user, session.id);
      expect(alive.error).toBeUndefined();
      expect(alive.draft).toBeUndefined();
      slow.release();
      expect((await inFlight).statusCode).toBe(200);

      // Orphan (crashed process): decomposition without a draft, nothing running.
      const orphan = await createReadySession(ctx, user);
      await ctx.db
        .updateTable('intake_session')
        .set({ state: 'decomposition' })
        .where('id', '=', orphan.id as Id)
        .execute();
      const young = await getSession(ctx, user, orphan.id);
      expect(young.error).toBeUndefined();
      ctx.clock.advance(intakeAiRequestBoundMs() + 1_000);
      const swept = await getSession(ctx, user, orphan.id);
      expect(swept.error?.code).toBe('ai_interrupted');
      expect(swept.version).toBe(young.version + 1);
    } finally {
      slow.release();
      await ctx.close();
    }
  });

  test('FU-76R-1 H1: a cancel during a slow settlement still converges agent_run cost with the ledger', async () => {
    // A successful provider (actual 0.00027) whose ledger settlement is slow
    // (1200 ms, longer than the default abort grace); the user cancels once
    // the settlement has started.
    const settleStarted = deferred();
    const settleDone = deferred();
    const provider: LlmPort = {
      async complete(request): Promise<LlmCompleteResponse> {
        request.onDispatch?.();
        if (request.promptId === 'type_detection') {
          return {
            output: { classification: 'new', confidence: 0.9, reasons: ['fixture'], missingRequired: [] },
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.000005 },
            model: 'deepseek-v4.1-flash',
            latencyMs: 1,
          };
        }
        return {
          output: aiDraft,
          usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.00027 },
          model: 'deepseek-v4.1-flash',
          latencyMs: 30_000,
        };
      },
    };
    let slowSettles = false;
    const policy = policyPort(provider, (ledger) => ({
      reserve: (input) => ledger.reserve(input),
      settle: async (input) => {
        if (!slowSettles) return ledger.settle(input);
        settleStarted.resolve();
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        try {
          return await ledger.settle(input);
        } finally {
          settleDone.resolve();
        }
      },
    }));
    const ctx = await createTestContext({ llm: policy.port, budgetGuard: generousGuard() });
    policy.bind(ctx);
    const ownerId = await ctx.seedUser({ email: 'fu76-late-settle@example.com', password: 'correct-horse' });
    const user = await login(ctx, 'fu76-late-settle@example.com', 'correct-horse');
    try {
      const session = await createReadySession(ctx, user);
      slowSettles = true;
      const inFlight = answersRequest(ctx, user, session);
      await settleStarted.promise;
      const waiting = await getSession(ctx, user, session.id);
      const manual = await sessionAction(ctx, user, session.id, 'manual', waiting.version);
      expect(manual.statusCode).toBe(200);
      expect((await inFlight).statusCode).toBe(200);
      await settleDone.promise;

      const spend = await decompositionSpend(ctx, ownerId);
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({ state: 'settled', settle_reason: 'actual' });
      expect(Number(spend[0]?.actual_usd)).toBeCloseTo(0.00027, 6);
      // After all work settled the run reports exactly what the ledger holds.
      const runs = await decompositionRuns(ctx, ownerId);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('cancelled');
      expect(Number(runs[0]?.cost_usd)).toBeCloseTo(Number(spend[0]?.actual_usd), 6);
      expect(runs[0]?.tokens_in).toBe(1000);
    } finally {
      await ctx.close();
    }
  });

  test('FU-76R-1 H1: stale recovery of a linked reservation rewrites the run cost from the ledger', async () => {
    const ctx = await createTestContext({ budgetGuard: generousGuard() });
    const ownerId = await ctx.seedUser({ email: 'fu76-recover@example.com', password: 'correct-horse' });
    try {
      const now = Date.parse('2026-11-12T10:00:00.000Z');
      const runId = ctx.ids.next();
      // A crash left the run swept as cancelled (cost unknown, 0) and its reservation open.
      await ctx.db
        .insertInto('agent_run')
        .values({
          id: runId,
          owner_id: ownerId,
          purpose: 'decomposition',
          prompt_id_version: 'decomposition@v1',
          model: 'unknown',
          provider: 'deepseek',
          status: 'cancelled',
        } as never)
        .execute();
      await ctx.db
        .insertInto('llm_spend')
        .values({
          id: ctx.ids.next(),
          owner_id: ownerId,
          agent_run_id: runId,
          purpose: 'decomposition@v1',
          state: 'reserved',
          reserved_usd: '0.004321',
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          created_at: new Date(now - 900_000),
        } as never)
        .execute();
      const nowIso = new Date(now).toISOString();
      await createPgSpendLedger(ctx.db).reserve({
        id: ctx.ids.next(),
        ownerId,
        purpose: 'type_detection@v1',
        estimateUsd: 0.001,
        dailyLimitUsd: 5,
        monthlyLimitUsd: 50,
        dayStart: `${nowIso.slice(0, 10)}T00:00:00.000Z`,
        monthStart: `${nowIso.slice(0, 7)}-01T00:00:00.000Z`,
        createdAt: nowIso,
        staleAfterMs: 780_000,
      });
      const run = await ctx.db
        .selectFrom('agent_run')
        .select(['status', 'cost_usd'])
        .where('id', '=', runId as Id)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('cancelled');
      expect(Number(run.cost_usd)).toBeCloseTo(0.004321, 6);
    } finally {
      await ctx.close();
    }
  });

  test('FU-54: PG stale recovery is committed even when the new reservation is budget-rejected', async () => {
    const ctx = await createTestContext({ budgetGuard: generousGuard() });
    const ownerId = await ctx.seedUser({ email: 'fu54-ledger@example.com', password: 'correct-horse' });
    try {
      const now = Date.parse('2026-11-12T10:00:00.000Z');
      const staleId = ctx.ids.next();
      await ctx.db
        .insertInto('llm_spend')
        .values({
          id: staleId,
          owner_id: ownerId,
          purpose: 'decomposition@v1',
          state: 'reserved',
          reserved_usd: '0.999900',
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          created_at: new Date(now - 200_000),
        } as never)
        .execute();
      const ledger = createPgSpendLedger(ctx.db);
      const nowIso = new Date(now).toISOString() as Instant;
      await expect(
        ledger.reserve({
          id: ctx.ids.next(),
          ownerId,
          purpose: 'decomposition@v1',
          estimateUsd: 0.01,
          dailyLimitUsd: 1,
          monthlyLimitUsd: 1,
          dayStart: `${nowIso.slice(0, 10)}T00:00:00.000Z`,
          monthStart: `${nowIso.slice(0, 7)}-01T00:00:00.000Z`,
          createdAt: nowIso,
          staleAfterMs: 150_000,
        }),
      ).rejects.toBeInstanceOf(BudgetExceeded);

      const rows = await ctx.db
        .selectFrom('llm_spend')
        .select(['id', 'state', 'settle_reason', 'actual_usd'])
        .where('owner_id', '=', ownerId)
        .execute();
      expect(rows).toEqual([
        { id: staleId, state: 'settled', settle_reason: 'recovered', actual_usd: '0.999900' },
      ]);
    } finally {
      await ctx.close();
    }
  });
});
