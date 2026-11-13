/**
 * CAL-05 — POST /api/v1/tasks:parse over HTTP with the real PG stores
 * (agent_run, llm_spend, idempotency) and FakeLlm / PolicyLlm over a fake
 * inner port. Never a real provider. Also: a drafted deadline is accepted by
 * POST /tasks, and the commitments read carries the guessed-AM/PM note.
 */

import type { AddressInfo } from 'node:net';
import type { CommitmentParseResponse, TaskParseResponse } from '@ohmydate/contracts';
import type { Id } from '@ohmydate/domain';
import {
  BudgetGuard,
  DEFAULT_DEEPSEEK_PRICING,
  FakeLlm,
  LlmUnavailable,
  PolicyLlm,
  type LlmBudget,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
} from '@ohmydate/llm';
import pino from 'pino';
import type { LoggerInstanceOption } from '../src/app.js';
import { createPgSpendLedger } from '../src/adapters/pg-spend-ledger.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

/** Friday 2026-11-13 14:05 in Seoul. */
const NOW = '2026-11-13T05:05:00.000Z';
const NOTE = '금요일까지 보고서 초안, 내일 9시까지 교수님께 메일, 장보기';
const TITLE_MARKER = '비밀할일제목마커';
const consent = { granted: true, at: '2026-11-12T00:00:00.000Z', provider: 'deepseek' } as const;

const threeTasks = {
  items: [
    { title: '보고서 초안', dueDate: '2026-11-13', dueTime: null, dateWasGuessed: false, meridiemWasGuessed: false },
    { title: '교수님께 메일', dueDate: '2026-11-14', dueTime: '09:00', dateWasGuessed: false, meridiemWasGuessed: true },
    { title: '장보기', dueDate: null, dueTime: null, dateWasGuessed: false, meridiemWasGuessed: false },
  ],
  leftover: '',
};

function guard(): BudgetGuard {
  return new BudgetGuard({ dailyUsd: 10, monthlyUsd: 100 }, { allowUnpricedModels: ['fake-llm'] });
}

async function setup(
  llm: LlmPort,
  options: { readonly email?: string; readonly timeZone?: string; readonly loggerInstance?: LoggerInstanceOption } = {},
): Promise<{ ctx: TestContext; ownerId: Id; user: TestSession }> {
  const ctx = await createTestContext({
    llm,
    budgetGuard: guard(),
    ...(options.loggerInstance === undefined ? {} : { loggerInstance: options.loggerInstance }),
  });
  ctx.clock.set(NOW as never);
  const email = options.email ?? 'cal05-parse@example.com';
  const ownerId = await ctx.seedUser({ email, password: 'correct-horse', timeZone: options.timeZone ?? 'Asia/Seoul' });
  const user = await login(ctx, email, 'correct-horse');
  return { ctx, ownerId, user };
}

function parse(ctx: TestContext, user: TestSession, body: unknown, key: string = newIdempotencyKey()) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tasks:parse',
    headers: authHeaders(user, { 'idempotency-key': key }),
    payload: body as Record<string, unknown>,
  });
}

async function runsOf(ctx: TestContext, ownerId: Id) {
  return ctx.db
    .selectFrom('agent_run')
    .select(['id', 'status', 'purpose', 'prompt_id_version', 'cost_usd', 'model'])
    .where('owner_id', '=', ownerId)
    .where('purpose', '=', 'task_parse')
    .execute();
}

async function taskTitles(ctx: TestContext, user: TestSession): Promise<string[]> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/tasks', headers: authHeaders(user) });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: { title: string }[] }).items.map((task) => task.title);
}

function policyPort(
  inner: LlmPort,
  access: { consent?: typeof consent | null; budget?: LlmBudget },
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
        inner,
        providerId: 'deepseek',
        defaultBudget: { dailyUsd: 5, monthlyUsd: 50 },
        resolve: async () => ({
          consent: access.consent ?? null,
          ...(access.budget === undefined ? {} : { budget: access.budget }),
        }),
        ledger: createPgSpendLedger(ctx.db),
        pricing: DEFAULT_DEEPSEEK_PRICING,
        maxOutputTokens: 2000,
        newReservationId: () => ctx.ids.next(),
        now: () => new Date(Date.parse(ctx.clock.now())),
      });
    },
  };
}

class PricedLlm implements LlmPort {
  calls = 0;
  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.calls += 1;
    request.onDispatch?.();
    return {
      output: threeTasks,
      usage: { inputTokens: 800, outputTokens: 90, costUsd: 0.0003 },
      model: 'deepseek-v4.1-flash',
      latencyMs: 3,
    };
  }
}

class HangingLlm implements LlmPort {
  started = 0;
  aborted = 0;
  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.started += 1;
    return new Promise((_resolve, reject) => {
      const abort = (): void => {
        this.aborted += 1;
        reject(new LlmUnavailable('llm call aborted by caller', 'aborted', false));
      };
      if (request.signal?.aborted === true) abort();
      request.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!hasDatabase)('POST /tasks:parse (CAL-05)', () => {
  test('reads task drafts in the owner zone: date-only default, guessed AM, no deadline; writes no task; one run', async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('task_parse', { output: threeTasks });
    const { ctx, ownerId, user } = await setup(llm);
    try {
      const response = await parse(ctx, user, { text: NOTE });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        drafts: [
          { title: '보고서 초안', dueAt: '2026-11-13T14:59:00.000Z', notes: ['due_time_defaulted'] },
          { title: '교수님께 메일', dueAt: '2026-11-14T00:00:00.000Z', notes: ['meridiem_assumed'] },
          { title: '장보기', notes: [] },
        ],
        leftover: '',
      } satisfies TaskParseResponse);
      expect(await taskTitles(ctx, user)).toEqual([]);
      expect(await runsOf(ctx, ownerId)).toEqual([
        expect.objectContaining({ status: 'succeeded', prompt_id_version: 'task_parse@v1', model: 'fake-llm' }),
      ]);
      const input = llm.calls[0]?.input as { now: unknown; timeZone: string; text: string };
      expect(input.now).toEqual({ date: '2026-11-13', weekday: 'FR', time: '14:05' });
      expect(input.timeZone).toBe('Asia/Seoul');
      expect(input.text.startsWith('<untrusted_document id="task-text">')).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test("without a zone in the request the owner's own zone is used; a DST zone follows its rules", async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('task_parse', {
      output: {
        items: [
          { title: 'Slides', dueDate: '2026-11-17', dueTime: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: 'Email', dueDate: '2026-11-16', dueTime: '17:00', dateWasGuessed: false, meridiemWasGuessed: false },
        ],
        leftover: '',
      },
    });
    const { ctx, user } = await setup(llm, { email: 'cal05-zone@example.com', timeZone: 'America/New_York' });
    try {
      const response = await parse(ctx, user, { text: 'slides by tuesday, email monday 5pm' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as TaskParseResponse;
      expect(body.drafts.map((draft) => draft.dueAt)).toEqual(['2026-11-18T04:59:00.000Z', '2026-11-16T22:00:00.000Z']);
      expect((llm.calls[0]?.input as { timeZone: string }).timeZone).toBe('America/New_York');
    } finally {
      await ctx.close();
    }
  });

  test('a deadline the server cannot accept is dropped and the task kept (due_dropped), never a 500', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('task_parse', {
      output: {
        items: [
          { title: '과제', dueDate: '2026-02-30', dueTime: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: '지난 일', dueDate: '2026-11-01', dueTime: '10:00', dateWasGuessed: false, meridiemWasGuessed: false },
          { title: '먼 일', dueDate: '2031-01-01', dueTime: null, dateWasGuessed: false, meridiemWasGuessed: false },
        ],
        leftover: '요즘 너무 피곤하다',
      },
    });
    const { ctx, user } = await setup(llm, { email: 'cal05-drop@example.com' });
    try {
      const response = await parse(ctx, user, { text: '여러 할 일' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        drafts: [
          { title: '과제', notes: ['due_dropped'] },
          { title: '지난 일', notes: ['due_dropped'] },
          { title: '먼 일', notes: ['due_dropped'] },
        ],
        leftover: '요즘 너무 피곤하다',
      });
    } finally {
      await ctx.close();
    }
  });

  test('ten drafts are the cap; an eleven-item answer is 503 after one repair (negative)', async () => {
    const llm = new FakeLlm();
    const one = threeTasks.items[2] as (typeof threeTasks.items)[number];
    llm.addPromptFallback('task_parse', { output: { items: Array.from({ length: 11 }, () => one), leftover: '' } });
    const { ctx, ownerId, user } = await setup(llm, { email: 'cal05-cap@example.com' });
    try {
      const response = await parse(ctx, user, { text: '열한 개' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'llm_unavailable' });
      expect(llm.calls).toHaveLength(2);
      expect((await runsOf(ctx, ownerId)).map((run) => run.status)).toEqual(['failed']);
      llm.addPromptFallback('task_parse', { output: { items: Array.from({ length: 10 }, () => one), leftover: '' } });
      const ten = await parse(ctx, user, { text: '열 개' });
      expect((ten.json() as TaskParseResponse).drafts).toHaveLength(10);
    } finally {
      await ctx.close();
    }
  });

  test('a drafted deadline is accepted by POST /tasks and the task lands in the inbox with it', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('task_parse', { output: threeTasks });
    const { ctx, user } = await setup(llm, { email: 'cal05-add@example.com' });
    try {
      const [first] = (await parse(ctx, user, { text: NOTE })).json().drafts as TaskParseResponse['drafts'];
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: authHeaders(user, { 'idempotency-key': newIdempotencyKey() }),
        payload: { title: first?.title, dueAt: first?.dueAt },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ title: '보고서 초안', dueAt: '2026-11-13T14:59:00.000Z' });
      expect(await taskTitles(ctx, user)).toEqual(['보고서 초안']);
    } finally {
      await ctx.close();
    }
  });

  test('idempotent replay returns the stored answer without a second LLM call; a new body under the key is 422', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('task_parse', { output: threeTasks });
    const { ctx, ownerId, user } = await setup(llm, { email: 'cal05-replay@example.com' });
    try {
      const key = newIdempotencyKey();
      const first = await parse(ctx, user, { text: NOTE }, key);
      const second = await parse(ctx, user, { text: NOTE }, key);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(llm.calls).toHaveLength(1);
      expect(await runsOf(ctx, ownerId)).toHaveLength(1);
      const mismatch = await parse(ctx, user, { text: '다른 메모' }, key);
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json()).toMatchObject({ code: 'idempotency_mismatch' });
      expect(llm.calls).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  test("another owner cannot replay someone else's key: they get their own read (negative)", async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('task_parse', { output: threeTasks });
    const { ctx, user } = await setup(llm, { email: 'cal05-owner-a@example.com' });
    const ownerB = await ctx.seedUser({ email: 'cal05-owner-b@example.com', password: 'correct-horse', timeZone: 'Asia/Seoul' });
    const userB = await login(ctx, 'cal05-owner-b@example.com', 'correct-horse');
    try {
      const key = newIdempotencyKey();
      expect((await parse(ctx, user, { text: NOTE }, key)).statusCode).toBe(200);
      llm.addPromptFallback('task_parse', { output: { items: [], leftover: '다른 사람의 읽기' } });
      const other = await parse(ctx, userB, { text: NOTE }, key);
      expect(other.statusCode).toBe(200);
      expect(other.json()).toEqual({ drafts: [], leftover: '다른 사람의 읽기' });
      expect(JSON.stringify(other.json())).not.toContain('보고서');
      expect(llm.calls).toHaveLength(2);
      expect(await runsOf(ctx, ownerB)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  test('consent missing: 503 llm_unavailable, no provider call, run failed, nothing stored for the key', async () => {
    const inner = new PricedLlm();
    const policy = policyPort(inner, { consent: null });
    const { ctx, ownerId, user } = await setup(policy.port, { email: 'cal05-consent@example.com' });
    policy.bind(ctx);
    try {
      const key = newIdempotencyKey();
      const response = await parse(ctx, user, { text: NOTE }, key);
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code: 'llm_unavailable' });
      expect(inner.calls).toBe(0);
      expect((await runsOf(ctx, ownerId)).map((run) => run.status)).toEqual(['failed']);
      expect((await parse(ctx, user, { text: NOTE }, key)).statusCode).toBe(503);
      expect(await runsOf(ctx, ownerId)).toHaveLength(2);
    } finally {
      await ctx.close();
    }
  });

  test('budget exhausted: 503 budget_exceeded, no provider call, run budget_exceeded', async () => {
    const inner = new PricedLlm();
    const policy = policyPort(inner, { consent, budget: { dailyUsd: 0, monthlyUsd: 10 } });
    const { ctx, ownerId, user } = await setup(policy.port, { email: 'cal05-budget@example.com' });
    policy.bind(ctx);
    try {
      const response = await parse(ctx, user, { text: NOTE });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'budget_exceeded' });
      expect(inner.calls).toBe(0);
      expect((await runsOf(ctx, ownerId)).map((run) => run.status)).toEqual(['budget_exceeded']);
    } finally {
      await ctx.close();
    }
  });

  test('with consent: the spend ledger row links to the task_parse run and the run cost converges on it', async () => {
    const inner = new PricedLlm();
    const policy = policyPort(inner, { consent });
    const { ctx, ownerId, user } = await setup(policy.port, { email: 'cal05-spend@example.com' });
    policy.bind(ctx);
    try {
      expect((await parse(ctx, user, { text: NOTE })).statusCode).toBe(200);
      const [run] = await runsOf(ctx, ownerId);
      expect(run).toMatchObject({ status: 'succeeded', model: 'deepseek-v4.1-flash' });
      const spend = await ctx.db
        .selectFrom('llm_spend')
        .select(['agent_run_id', 'purpose', 'state', 'actual_usd'])
        .where('owner_id', '=', ownerId)
        .execute();
      expect(spend).toEqual([expect.objectContaining({ agent_run_id: run?.id, purpose: 'task_parse@v1', state: 'settled' })]);
      expect(Number(spend[0]?.actual_usd)).toBeCloseTo(0.0003, 6);
      expect(Number(run?.cost_usd)).toBeCloseTo(0.0003, 6);
    } finally {
      await ctx.close();
    }
  });

  test('provider unavailable: 503 llm_unavailable, run failed', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('task_parse', { error: new LlmUnavailable('synthetic outage', 'provider', false) });
    const { ctx, ownerId, user } = await setup(llm, { email: 'cal05-outage@example.com' });
    try {
      const response = await parse(ctx, user, { text: NOTE });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'llm_unavailable' });
      expect((await runsOf(ctx, ownerId)).map((run) => run.status)).toEqual(['failed']);
    } finally {
      await ctx.close();
    }
  });

  test('client disconnect mid-read cancels the call and settles the run as cancelled', async () => {
    const llm = new HangingLlm();
    const { ctx, ownerId, user } = await setup(llm, { email: 'cal05-disconnect@example.com' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;
    try {
      const controller = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}/api/v1/tasks:parse`, {
        method: 'POST',
        headers: { ...authHeaders(user, { 'idempotency-key': newIdempotencyKey() }), 'content-type': 'application/json' },
        body: JSON.stringify({ text: NOTE }),
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await waitFor(async () => (llm.started > 0 ? true : undefined));
      controller.abort();
      expect(await request).toBeInstanceOf(Error);
      const runs = await waitFor(async () => {
        const rows = await runsOf(ctx, ownerId);
        return rows[0]?.status === 'pending' || rows.length === 0 ? undefined : rows;
      });
      expect(runs.map((run) => run.status)).toEqual(['cancelled']);
      expect(llm.aborted).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  test('request validation: blank, too long, unknown zone, missing key, CSRF, anonymous (negative)', async () => {
    const llm = new FakeLlm();
    const { ctx, user } = await setup(llm, { email: 'cal05-validation@example.com' });
    try {
      for (const body of [{ text: '   ' }, { text: 'x'.repeat(501) }, { text: '장보기', timeZone: 'Mars/Olympus' }, {}]) {
        const response = await parse(ctx, user, body);
        expect({ body, status: response.statusCode }).toEqual({ body, status: 400 });
      }
      const noKey = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/tasks:parse',
        headers: authHeaders(user),
        payload: { text: NOTE },
      });
      expect(noKey.statusCode).toBe(400);
      const noCsrf = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/tasks:parse',
        headers: { cookie: authHeaders(user)['cookie'] as string, 'idempotency-key': newIdempotencyKey() },
        payload: { text: NOTE },
      });
      expect(noCsrf.statusCode).toBe(403);
      const anonymous = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/tasks:parse',
        headers: { 'idempotency-key': newIdempotencyKey() },
        payload: { text: NOTE },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(llm.calls).toHaveLength(0);
      // The collection action does not shadow the task routes around it.
      const missing = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/tasks/0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55',
        headers: authHeaders(user),
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  test('logs never carry the note, a title or the prompt', async () => {
    const lines: string[] = [];
    const stream = {
      write(line: string) {
        lines.push(line);
        return true;
      },
    };
    const loggerInstance = pino({ level: 'trace' }, stream) as unknown as LoggerInstanceOption;
    const llm = new FakeLlm();
    llm.addPromptFallback('task_parse', {
      output: {
        items: [
          { title: TITLE_MARKER, dueDate: '2026-11-14', dueTime: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: `${TITLE_MARKER}-dropped`, dueDate: '2026-02-30', dueTime: null, dateWasGuessed: false, meridiemWasGuessed: false },
        ],
        leftover: '',
      },
    });
    const { ctx, user } = await setup(llm, { email: 'cal05-logs@example.com', loggerInstance });
    try {
      expect((await parse(ctx, user, { text: `${TITLE_MARKER} 내일까지` })).statusCode).toBe(200);
      llm.addPromptFallback('task_parse', { error: new LlmUnavailable('synthetic outage', 'provider', false) });
      expect((await parse(ctx, user, { text: `${TITLE_MARKER} 실패하는 읽기` })).statusCode).toBe(503);
      const log = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0);
      expect(log).toContain('tasks:parse');
      expect(log).not.toContain(TITLE_MARKER);
      expect(log).not.toContain('내일까지');
      expect(log).not.toContain('untrusted_document');
    } finally {
      await ctx.close();
    }
  });
});

describe.skipIf(!hasDatabase)('POST /commitments:parse after the shared refactor (CAL-05 addendum)', () => {
  test('a guessed AM start carries meridiem_assumed; an explicit 오후 does not', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('commitment_parse', {
      output: {
        items: [
          { title: '스터디', date: '2026-11-19', startTime: '07:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: true },
          { title: '치과', date: '2026-11-17', startTime: '15:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
        ],
        leftover: '',
      },
    });
    const { ctx, user } = await setup(llm, { email: 'cal05-meridiem@example.com' });
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/commitments:parse',
        headers: authHeaders(user, { 'idempotency-key': newIdempotencyKey() }),
        payload: { text: '목요일 7시 스터디, 화요일 오후 3시 치과' },
      });
      expect(response.statusCode).toBe(200);
      const [study, dentist] = (response.json() as CommitmentParseResponse).drafts;
      expect(study).toMatchObject({ startAt: '2026-11-18T22:00:00.000Z', notes: ['duration_defaulted', 'meridiem_assumed'] });
      expect(dentist?.notes).toEqual(['duration_defaulted']);
    } finally {
      await ctx.close();
    }
  });
});
