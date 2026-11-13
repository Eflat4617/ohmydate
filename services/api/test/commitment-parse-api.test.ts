/**
 * CAL-02 — POST /api/v1/commitments:parse over HTTP with the real PG stores
 * (agent_run, llm_spend, idempotency) and FakeLlm / PolicyLlm over a fake
 * inner port. Never a real provider.
 */

import type { AddressInfo } from 'node:net';
import type { CommitmentParseResponse } from '@ohmydate/contracts';
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
const NOTE = '다음 주 화요일 오후 3시에 치과, 14일 저녁 7시부터 9시까지 동창 모임';
const TITLE_MARKER = '비밀약속제목마커';
const consent = { granted: true, at: '2026-11-12T00:00:00.000Z', provider: 'deepseek' } as const;

const twoDrafts = {
  items: [
    { title: '치과', date: '2026-11-17', startTime: '15:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
    { title: '동창 모임', date: '2026-11-14', startTime: '19:00', endTime: '21:00', endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
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
  const email = options.email ?? 'cal02-parse@example.com';
  const ownerId = await ctx.seedUser({ email, password: 'correct-horse', timeZone: options.timeZone ?? 'Asia/Seoul' });
  const user = await login(ctx, email, 'correct-horse');
  return { ctx, ownerId, user };
}

function parse(ctx: TestContext, user: TestSession, body: unknown, key: string = newIdempotencyKey()) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/commitments:parse',
    headers: authHeaders(user, { 'idempotency-key': key }),
    payload: body as Record<string, unknown>,
  });
}

async function runsOf(ctx: TestContext, ownerId: Id) {
  return ctx.db
    .selectFrom('agent_run')
    .select(['id', 'status', 'purpose', 'prompt_id_version', 'cost_usd', 'model'])
    .where('owner_id', '=', ownerId)
    .where('purpose', '=', 'commitment_parse')
    .execute();
}

async function commitmentRows(ctx: TestContext): Promise<number> {
  const rows = await ctx.db.selectFrom('commitment_event').select('id').execute();
  return rows.length;
}

/** PolicyLlm (consent + budget + PG spend ledger) over `inner`, bound once the context exists. */
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

/** A priced fake provider answering the two-draft output. */
class PricedLlm implements LlmPort {
  calls = 0;
  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.calls += 1;
    request.onDispatch?.();
    return {
      output: twoDrafts,
      usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.0004 },
      model: 'deepseek-v4.1-flash',
      latencyMs: 3,
    };
  }
}

/** Never answers until aborted. */
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

describe.skipIf(!hasDatabase)('POST /commitments:parse (CAL-02)', () => {
  test('reads drafts with Seoul instants from the owner zone; writes no commitment; one succeeded run', async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('commitment_parse', { output: twoDrafts });
    const { ctx, ownerId, user } = await setup(llm);
    try {
      const response = await parse(ctx, user, { text: NOTE });
      expect(response.statusCode).toBe(200);
      const body = response.json() as CommitmentParseResponse;
      expect(body).toEqual({
        drafts: [
          {
            title: '치과',
            timeZone: 'Asia/Seoul',
            date: '2026-11-17',
            startAt: '2026-11-17T06:00:00.000Z',
            endAt: '2026-11-17T07:00:00.000Z',
            notes: ['duration_defaulted'],
          },
          {
            title: '동창 모임',
            timeZone: 'Asia/Seoul',
            date: '2026-11-14',
            startAt: '2026-11-14T10:00:00.000Z',
            endAt: '2026-11-14T12:00:00.000Z',
            notes: [],
          },
        ],
        leftover: '',
      });
      expect(await commitmentRows(ctx)).toBe(0);
      const runs = await runsOf(ctx, ownerId);
      expect(runs).toEqual([
        expect.objectContaining({ status: 'succeeded', prompt_id_version: 'commitment_parse@v1', model: 'fake-llm' }),
      ]);
      expect((llm.calls[0]?.input as { now: unknown }).now).toEqual({ date: '2026-11-13', weekday: 'FR', time: '14:05' });
    } finally {
      await ctx.close();
    }
  });

  test('a DST zone in the request: wall clock -> instant per the zone rules', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('commitment_parse', {
      output: {
        items: [
          { title: 'Dentist', date: '2026-11-17', startTime: '09:00', endTime: '10:00', endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: 'Weekly study', date: '2026-11-19', startTime: '19:00', endTime: null, endDate: null, weeklyDays: ['TH'], untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
        ],
        leftover: '',
      },
    });
    const { ctx, user } = await setup(llm, { email: 'cal02-dst@example.com' });
    try {
      const response = await parse(ctx, user, { text: 'dentist tue 9-10, study every thursday 7pm', timeZone: 'America/New_York' });
      expect(response.statusCode).toBe(200);
      const [dentist, study] = (response.json() as CommitmentParseResponse).drafts;
      expect(dentist).toMatchObject({ timeZone: 'America/New_York', startAt: '2026-11-17T14:00:00.000Z', endAt: '2026-11-17T15:00:00.000Z' });
      expect(study).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=TH', startAt: '2026-11-20T00:00:00.000Z', notes: ['duration_defaulted', 'repeats_weekly'] });
      // The drafted RRULE is one the create call accepts and expands.
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/commitments',
        headers: authHeaders(user, { 'idempotency-key': newIdempotencyKey() }),
        payload: { title: study?.title, startAt: study?.startAt, endAt: study?.endAt, timeZone: study?.timeZone, rrule: study?.rrule },
      });
      expect(created.statusCode).toBe(201);
      const listed = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/commitments?from=2026-11-16T00:00:00.000Z&to=2026-12-01T00:00:00.000Z',
        headers: authHeaders(user),
      });
      const occurrences = (listed.json() as { items: { occurrences: { startAt: string }[] }[] }).items[0]?.occurrences;
      expect(occurrences?.map((occurrence) => Date.parse(occurrence.startAt))).toEqual([
        Date.parse('2026-11-20T00:00:00.000Z'),
        Date.parse('2026-11-27T00:00:00.000Z'),
      ]);
    } finally {
      await ctx.close();
    }
  });

  test('items the server cannot accept are dropped into leftover, never a 500', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('commitment_parse', {
      output: {
        items: [
          { title: '치과', date: '2026-02-30', startTime: '15:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: '회의', date: '2026-11-16', startTime: '10:00', endTime: '09:00', endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: '지난 약속', date: '2026-11-01', startTime: '10:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: '먼 약속', date: '2031-01-01', startTime: '10:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: '영화', date: '2026-11-14', startTime: null, endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: true, meridiemWasGuessed: false },
        ],
        leftover: '보고서 쓰기',
      },
    });
    const { ctx, user } = await setup(llm, { email: 'cal02-drop@example.com' });
    try {
      const response = await parse(ctx, user, { text: '여러 약속' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as CommitmentParseResponse;
      expect(body.drafts).toEqual([{ title: '영화', timeZone: 'Asia/Seoul', date: '2026-11-14', notes: ['date_assumed'] }]);
      expect(body.leftover).toBe(
        '보고서 쓰기 / 치과 (2026-02-30 15:00) / 회의 (2026-11-16 10:00) / 지난 약속 (2026-11-01 10:00) / 먼 약속 (2031-01-01 10:00)',
      );
    } finally {
      await ctx.close();
    }
  });

  test('idempotent replay returns the stored answer without a second LLM call; a new body under the key is 422', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('commitment_parse', { output: twoDrafts });
    const { ctx, ownerId, user } = await setup(llm, { email: 'cal02-replay@example.com' });
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
    llm.addPromptFallback('commitment_parse', { output: twoDrafts });
    const { ctx, user } = await setup(llm, { email: 'cal02-owner-a@example.com' });
    const ownerB = await ctx.seedUser({ email: 'cal02-owner-b@example.com', password: 'correct-horse', timeZone: 'Asia/Seoul' });
    const userB = await login(ctx, 'cal02-owner-b@example.com', 'correct-horse');
    try {
      const key = newIdempotencyKey();
      const first = await parse(ctx, user, { text: NOTE }, key);
      expect(first.statusCode).toBe(200);
      llm.addPromptFallback('commitment_parse', { output: { items: [], leftover: '다른 사람의 읽기' } });
      const other = await parse(ctx, userB, { text: NOTE }, key);
      expect(other.statusCode).toBe(200);
      expect(other.json()).toEqual({ drafts: [], leftover: '다른 사람의 읽기' });
      expect(JSON.stringify(other.json())).not.toContain('치과');
      expect(llm.calls).toHaveLength(2);
      expect(await runsOf(ctx, ownerB)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  test('consent missing: 503 llm_unavailable, the provider is never called, run failed, nothing stored for the key', async () => {
    const inner = new PricedLlm();
    const policy = policyPort(inner, { consent: null });
    const { ctx, ownerId, user } = await setup(policy.port, { email: 'cal02-consent@example.com' });
    policy.bind(ctx);
    try {
      const key = newIdempotencyKey();
      const response = await parse(ctx, user, { text: NOTE }, key);
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code: 'llm_unavailable' });
      expect(inner.calls).toBe(0);
      expect((await runsOf(ctx, ownerId)).map((run) => run.status)).toEqual(['failed']);
      // 503 is not stored: the same key can try again (e.g. after consenting).
      const again = await parse(ctx, user, { text: NOTE }, key);
      expect(again.statusCode).toBe(503);
      expect((await runsOf(ctx, ownerId)).length).toBe(2);
    } finally {
      await ctx.close();
    }
  });

  test('budget exhausted: 503 budget_exceeded, no provider call, run budget_exceeded', async () => {
    const inner = new PricedLlm();
    const policy = policyPort(inner, { consent, budget: { dailyUsd: 0, monthlyUsd: 10 } });
    const { ctx, ownerId, user } = await setup(policy.port, { email: 'cal02-budget@example.com' });
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

  test('with consent: the spend ledger row links to the run and the run cost converges on it', async () => {
    const inner = new PricedLlm();
    const policy = policyPort(inner, { consent });
    const { ctx, ownerId, user } = await setup(policy.port, { email: 'cal02-spend@example.com' });
    policy.bind(ctx);
    try {
      const response = await parse(ctx, user, { text: NOTE });
      expect(response.statusCode).toBe(200);
      const [run] = await runsOf(ctx, ownerId);
      expect(run).toMatchObject({ status: 'succeeded', model: 'deepseek-v4.1-flash' });
      const spend = await ctx.db
        .selectFrom('llm_spend')
        .select(['agent_run_id', 'purpose', 'state', 'actual_usd'])
        .where('owner_id', '=', ownerId)
        .execute();
      expect(spend).toEqual([
        expect.objectContaining({ agent_run_id: run?.id, purpose: 'commitment_parse@v1', state: 'settled' }),
      ]);
      expect(Number(spend[0]?.actual_usd)).toBeCloseTo(0.0004, 6);
      expect(Number(run?.cost_usd)).toBeCloseTo(0.0004, 6);
    } finally {
      await ctx.close();
    }
  });

  test('provider unavailable: 503 llm_unavailable, run failed', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('commitment_parse', { error: new LlmUnavailable('synthetic outage', 'provider', false) });
    const { ctx, ownerId, user } = await setup(llm, { email: 'cal02-outage@example.com' });
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
    const { ctx, ownerId, user } = await setup(llm, { email: 'cal02-disconnect@example.com' });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;
    try {
      const controller = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}/api/v1/commitments:parse`, {
        method: 'POST',
        headers: { ...authHeaders(user, { 'idempotency-key': newIdempotencyKey() }), 'content-type': 'application/json' },
        body: JSON.stringify({ text: NOTE }),
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await waitFor(async () => (llm.started > 0 ? true : undefined));
      controller.abort(); // the web's 취소
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

  test('request validation: blank, too long, unknown zone, missing key, CSRF (negative)', async () => {
    const llm = new FakeLlm();
    const { ctx, user } = await setup(llm, { email: 'cal02-validation@example.com' });
    try {
      for (const body of [{ text: '   ' }, { text: 'x'.repeat(501) }, { text: '내일 3시', timeZone: 'Mars/Olympus' }, {}]) {
        const response = await parse(ctx, user, body);
        expect({ body, status: response.statusCode }).toEqual({ body, status: 400 });
      }
      const noKey = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/commitments:parse',
        headers: authHeaders(user),
        payload: { text: NOTE },
      });
      expect(noKey.statusCode).toBe(400);
      const noCsrf = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/commitments:parse',
        headers: { cookie: authHeaders(user)['cookie'] as string, 'idempotency-key': newIdempotencyKey() },
        payload: { text: NOTE },
      });
      expect(noCsrf.statusCode).toBe(403);
      const anonymous = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/commitments:parse',
        headers: { 'idempotency-key': newIdempotencyKey() },
        payload: { text: NOTE },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(llm.calls).toHaveLength(0);
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
    llm.addPromptFallback('commitment_parse', {
      output: {
        items: [
          { title: TITLE_MARKER, date: '2026-11-17', startTime: '15:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
          { title: `${TITLE_MARKER}-dropped`, date: '2026-02-30', startTime: '15:00', endTime: null, endDate: null, weeklyDays: null, untilDate: null, dateWasGuessed: false, meridiemWasGuessed: false },
        ],
        leftover: '',
      },
    });
    const { ctx, user } = await setup(llm, { email: 'cal02-logs@example.com', loggerInstance });
    try {
      const ok = await parse(ctx, user, { text: `${TITLE_MARKER} 다음 주 화요일 3시` });
      expect(ok.statusCode).toBe(200);
      llm.addPromptFallback('commitment_parse', { error: new LlmUnavailable('synthetic outage', 'provider', false) });
      const failed = await parse(ctx, user, { text: `${TITLE_MARKER} 실패하는 읽기` });
      expect(failed.statusCode).toBe(503);
      const log = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0);
      expect(log).toContain('commitments:parse');
      expect(log).not.toContain(TITLE_MARKER);
      expect(log).not.toContain('다음 주 화요일');
      expect(log).not.toContain('untrusted_document');
    } finally {
      await ctx.close();
    }
  });
});
