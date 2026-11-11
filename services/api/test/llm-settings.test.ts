import type { User } from '@ohmydate/contracts';
import {
  BudgetGuard,
  DEFAULT_DEEPSEEK_PRICING,
  FakeLlm,
  InMemorySpendLedger,
  PolicyLlm,
  type LlmPort,
} from '@ohmydate/llm';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import type { LoggerInstanceOption } from '../src/app.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
} from './support/test-context.js';

const hasDatabaseEnv = hasDatabase;

const input = {
  title: 'Quarterly report',
  deliverable: 'Write the quarterly report',
};

describe.skipIf(!hasDatabaseEnv)('LLM settings and consent wiring', () => {
  test('PATCH /me/settings persists consent provider/timestamp and budget additively', async () => {
    const ctx = await createTestContext({
      config: { llmProvider: 'deepseek' },
      llm: new FakeLlm(),
    });
    await ctx.seedUser({ email: 'llm-settings@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'llm-settings@example.com', 'correct-horse');
    try {
      const before = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeaders(session),
      });
      const initial = before.json() as User;
      expect(initial.llm).toBeUndefined();

      const granted = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${initial.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { llm: { consent: { granted: true } } },
      });
      expect(granted.statusCode).toBe(200);
      const afterGrant = granted.json() as User;
      expect(afterGrant.llm?.consent).toMatchObject({
        granted: true,
        provider: 'deepseek',
      });
      expect(afterGrant.llm?.consent?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const budgeted = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${afterGrant.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { llm: { budget: { dailyUsd: 1.5, monthlyUsd: 20 } } },
      });
      expect(budgeted.statusCode).toBe(200);
      const afterBudget = budgeted.json() as User;
      expect(afterBudget.llm?.budget).toEqual({ dailyUsd: 1.5, monthlyUsd: 20 });
      // The nested settings merge keeps the consent record.
      expect(afterBudget.llm?.consent?.granted).toBe(true);

      const revoked = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${afterBudget.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { llm: { consent: { granted: false } } },
      });
      expect(revoked.statusCode).toBe(200);
      const afterRevoke = revoked.json() as User;
      expect(afterRevoke.llm?.consent?.granted).toBe(false);
      expect(afterRevoke.llm?.budget).toEqual({ dailyUsd: 1.5, monthlyUsd: 20 });

      const row = await ctx.db
        .selectFrom('user')
        .select('settings')
        .where('email', '=', 'llm-settings@example.com')
        .executeTakeFirstOrThrow();
      expect(row.settings).toMatchObject({
        llm: {
          consent: { granted: false, provider: 'deepseek' },
          budget: { dailyUsd: 1.5, monthlyUsd: 20 },
        },
      });
    } finally {
      await ctx.close();
    }
  });

  test('missing consent degrades intake to manual llm_unavailable and records the provider', async () => {
    const inner = new FakeLlm();
    const llm: LlmPort = new PolicyLlm({
      inner,
      providerId: 'deepseek',
      defaultBudget: { dailyUsd: 0.2, monthlyUsd: 5 },
      resolve: async () => ({ consent: null }),
      ledger: new InMemorySpendLedger(),
      pricing: DEFAULT_DEEPSEEK_PRICING,
      maxOutputTokens: 2000,
      newReservationId: () => crypto.randomUUID(),
    });
    const guard = new BudgetGuard(
      { dailyUsd: 10, monthlyUsd: 100 },
      { allowUnpricedModels: ['fake-llm'] },
    );
    const ctx = await createTestContext({
      config: { llmProvider: 'deepseek' },
      llm,
      budgetGuard: guard,
    });
    const ownerId = await ctx.seedUser({
      email: 'llm-no-consent@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'llm-no-consent@example.com', 'correct-horse');
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { manual: boolean; error?: { code: string } };
      expect(body.manual).toBe(true);
      expect(body.error?.code).toBe('llm_unavailable');
      expect(inner.callCount).toBe(0);

      const run = await ctx.db
        .selectFrom('agent_run')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      expect(run.provider).toBe('deepseek');
      expect(run.status).toBe('failed');
      expect(run.model).toBe('unknown');
      expect(run.tokens_in).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('deepseek composition calls the local fake gateway only after consent and never logs the key', async () => {
    const keyMarker = 'sk-synthetic-api-key-marker';
    const requests: { readonly body: string; readonly authorization?: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          body: Buffer.concat(chunks).toString('utf8'),
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
        });
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'deepseek-v4.1-flash',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    classification: 'new',
                    confidence: 0.9,
                    reasons: ['local fake gateway'],
                    missingRequired: [],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 200 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const logLines: string[] = [];
    const stream = {
      write(line: string) {
        logLines.push(line);
        return true;
      },
    };
    const loggerInstance = pino({ level: 'info' }, stream) as unknown as LoggerInstanceOption;
    const ctx = await createTestContext({
      config: {
        llmProvider: 'deepseek',
        llmBaseUrl: `http://127.0.0.1:${String(port)}`,
        llmModel: 'deepseek-v4.1-flash',
      },
      llmApiKey: keyMarker,
      loggerInstance,
    });
    const ownerId = await ctx.seedUser({
      email: 'llm-gateway@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'llm-gateway@example.com', 'correct-horse');
    try {
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      // No consent yet: manual mode, no outbound call.
      expect((first.json() as { manual: boolean }).manual).toBe(true);
      expect(requests).toHaveLength(0);

      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeaders(session),
      });
      const user = me.json() as User;
      const granted = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${user.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { llm: { consent: { granted: true } } },
      });
      expect(granted.statusCode).toBe(200);

      const second = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      expect(second.statusCode).toBe(201);
      const body = second.json() as { manual: boolean; detectedType?: { classification: string } };
      expect(body.manual).toBe(false);
      expect(body.detectedType?.classification).toBe('new');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toContain(keyMarker);
      expect(requests[0]?.body).not.toContain(keyMarker);

      const run = await ctx.db
        .selectFrom('agent_run')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('status', '=', 'succeeded')
        .executeTakeFirstOrThrow();
      expect(run.provider).toBe('deepseek');
      expect(run.model).toBe('deepseek-v4.1-flash');
      expect(Number(run.cost_usd)).toBeGreaterThan(0);
      expect(run.tokens_in).toBe(1000);
      expect(run.tokens_out).toBe(200);

      expect(logLines.join('')).not.toContain(keyMarker);
    } finally {
      await ctx.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  test('H1 classifies gateway errors without leaking provider strings into response, logs or rows', async () => {
    const bodyMarker = 'sk-synthetic-secret-marker-never-echo';
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            type: bodyMarker,
            message: `${bodyMarker} provider says no`,
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const logLines: string[] = [];
    const loggerInstance = pino(
      { level: 'info' },
      {
        write(line: string) {
          logLines.push(line);
          return true;
        },
      },
    ) as unknown as LoggerInstanceOption;
    const ctx = await createTestContext({
      config: {
        llmProvider: 'deepseek',
        llmBaseUrl: `http://127.0.0.1:${String(port)}`,
      },
      llmApiKey: 'sk-synthetic-classification-marker',
      loggerInstance,
    });
    const ownerId = await ctx.seedUser({
      email: 'llm-gateway-401@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'llm-gateway-401@example.com', 'correct-horse');
    try {
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeaders(session),
      });
      const user = me.json() as User;
      const granted = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${user.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { llm: { consent: { granted: true } } },
      });
      expect(granted.statusCode).toBe(200);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as {
        manual: boolean;
        error?: { code: string; message: string };
      };
      expect(body.manual).toBe(true);
      expect(body.error?.code).toBe('llm_unavailable');
      expect(body.error?.message).toContain('auth');
      expect(created.body).not.toContain(bodyMarker);
      expect(logLines.join('')).not.toContain(bodyMarker);

      const run = await ctx.db
        .selectFrom('agent_run')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      expect(run.provider).toBe('deepseek');
      expect(JSON.stringify(run)).not.toContain(bodyMarker);
    } finally {
      await ctx.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  test('H2 saved zero budget disables the provider before any network call', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(200).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const ctx = await createTestContext({
      config: {
        llmProvider: 'deepseek',
        llmBaseUrl: `http://127.0.0.1:${String(port)}`,
      },
      llmApiKey: 'sk-synthetic-zero-budget',
    });
    await ctx.seedUser({ email: 'llm-zero-budget@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'llm-zero-budget@example.com', 'correct-horse');
    try {
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeaders(session),
      });
      const user = me.json() as User;
      const saved = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${user.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          llm: {
            consent: { granted: true },
            budget: { dailyUsd: 0, monthlyUsd: 5 },
          },
        },
      });
      expect(saved.statusCode).toBe(200);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { manual: boolean; error?: { code: string } };
      expect(body.manual).toBe(true);
      expect(body.error?.code).toBe('budget_exceeded');
      expect(calls).toBe(0);
      const rows = await ctx.db.selectFrom('llm_spend').selectAll().execute();
      expect(rows).toHaveLength(0);
    } finally {
      await ctx.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  test('H2 invalid saved budget fails closed instead of substituting defaults', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(200).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const ctx = await createTestContext({
      config: {
        llmProvider: 'deepseek',
        llmBaseUrl: `http://127.0.0.1:${String(port)}`,
      },
      llmApiKey: 'sk-synthetic-invalid-budget',
    });
    const ownerId = await ctx.seedUser({
      email: 'llm-invalid-budget@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'llm-invalid-budget@example.com', 'correct-horse');
    try {
      // Simulate a partially saved/corrupt budget (missing monthlyUsd).
      await ctx.db
        .updateTable('user')
        .set({
          settings: {
            llm: {
              consent: {
                granted: true,
                at: '2026-11-11T00:00:00.000Z',
                provider: 'deepseek',
              },
              budget: { dailyUsd: 0.5 },
            },
          } as never,
        })
        .where('id', '=', ownerId)
        .execute();

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { manual: boolean; error?: { code: string } };
      expect(body.manual).toBe(true);
      expect(body.error?.code).toBe('budget_exceeded');
      expect(calls).toBe(0);
    } finally {
      await ctx.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  test('H5 missing gateway usage is settled at the reserved amount, not free', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          model: 'deepseek-v4.1-flash',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  classification: 'new',
                  confidence: 0.9,
                  reasons: ['no usage'],
                }),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const ctx = await createTestContext({
      config: {
        llmProvider: 'deepseek',
        llmBaseUrl: `http://127.0.0.1:${String(port)}`,
      },
      llmApiKey: 'sk-synthetic-missing-usage',
    });
    const ownerId = await ctx.seedUser({
      email: 'llm-missing-usage@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'llm-missing-usage@example.com', 'correct-horse');
    try {
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeaders(session),
      });
      const user = me.json() as User;
      const saved = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${user.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          llm: {
            consent: { granted: true },
            budget: { dailyUsd: 1, monthlyUsd: 5 },
          },
        },
      });
      expect(saved.statusCode).toBe(200);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      expect(created.statusCode).toBe(201);
      expect((created.json() as { manual: boolean }).manual).toBe(true);

      const spend = await ctx.db
        .selectFrom('llm_spend')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      expect(spend.state).toBe('settled');
      expect(spend.actual_usd).toBe(spend.reserved_usd);
      expect(Number(spend.actual_usd)).toBeGreaterThan(0);
      const run = await ctx.db
        .selectFrom('agent_run')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      expect(Number(run.cost_usd)).toBeGreaterThan(0);
    } finally {
      await ctx.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  test('H3 concurrent provider attempts reserve atomically against one owner cap', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'deepseek-v4.1-flash',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    classification: 'new',
                    confidence: 0.9,
                    reasons: ['concurrent reservation'],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
      }, 200);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const ctx = await createTestContext({
      config: {
        llmProvider: 'deepseek',
        llmBaseUrl: `http://127.0.0.1:${String(port)}`,
        llmPriceInputPerM: 0,
        llmPriceOutputPerM: 1000,
        llmPriceCachedPerM: 0,
        llmMaxOutputTokens: 100,
      },
      llmApiKey: 'sk-synthetic-concurrent',
    });
    await ctx.seedUser({ email: 'llm-concurrent@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'llm-concurrent@example.com', 'correct-horse');
    try {
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeaders(session),
      });
      const user = me.json() as User;
      const saved = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${user.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          llm: {
            consent: { granted: true },
            budget: { dailyUsd: 0.15, monthlyUsd: 5 },
          },
        },
      });
      expect(saved.statusCode).toBe(200);

      const [first, second] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/intake-sessions',
          headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
          payload: { input },
        }),
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/intake-sessions',
          headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
          payload: { input },
        }),
      ]);
      const bodies = [first, second].map(
        (response) => response.json() as { manual: boolean; error?: { code: string } },
      );
      expect(bodies.filter((body) => body.manual === false)).toHaveLength(1);
      expect(bodies.filter((body) => body.error?.code === 'budget_exceeded')).toHaveLength(1);
      expect(calls).toBe(1);
      const rows = await ctx.db.selectFrom('llm_spend').selectAll().execute();
      expect(rows.filter((row) => row.state === 'settled')).toHaveLength(1);
    } finally {
      await ctx.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  test('S2 stale reservations are recovered at the reserved amount before the next dispatch', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          model: 'deepseek-v4.1-flash',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  classification: 'new',
                  confidence: 0.9,
                  reasons: ['stale recovery'],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const ctx = await createTestContext({
      config: {
        llmProvider: 'deepseek',
        llmBaseUrl: `http://127.0.0.1:${String(port)}`,
      },
      llmApiKey: 'sk-synthetic-stale-recovery',
    });
    const ownerId = await ctx.seedUser({
      email: 'llm-stale-recovery@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'llm-stale-recovery@example.com', 'correct-horse');
    try {
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeaders(session),
      });
      const user = me.json() as User;
      const saved = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: authHeaders(session, {
          'if-match': `W/"${user.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          llm: {
            consent: { granted: true },
            budget: { dailyUsd: 1, monthlyUsd: 5 },
          },
        },
      });
      expect(saved.statusCode).toBe(200);

      // Simulate a process that reserved before dispatch and crashed.
      const staleId = ctx.ids.next();
      await ctx.db
        .insertInto('llm_spend')
        .values({
          id: staleId,
          owner_id: ownerId,
          purpose: 'type_detection@v1',
          state: 'reserved',
          reserved_usd: '0.05',
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          created_at: new Date(Date.parse(ctx.clock.now()) - 60 * 60 * 1000),
        })
        .execute();

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      expect(created.statusCode).toBe(201);
      expect(calls).toBe(1);

      const stale = await ctx.db
        .selectFrom('llm_spend')
        .selectAll()
        .where('id', '=', staleId)
        .executeTakeFirstOrThrow();
      expect(stale.state).toBe('settled');
      expect(stale.settle_reason).toBe('recovered');
      expect(stale.actual_usd).toBe(stale.reserved_usd);
      expect(stale.settled_at).not.toBeNull();
      expect(stale.input_tokens).toBe(0);
      expect(stale.output_tokens).toBe(0);
    } finally {
      await ctx.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
