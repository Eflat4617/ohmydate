import type { User } from '@ohmydate/contracts';
import {
  BudgetGuard,
  FakeLlm,
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
      resolve: async () => ({
        consent: null,
        spentTodayUsd: 0,
        spentThisMonthUsd: 0,
      }),
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
});
