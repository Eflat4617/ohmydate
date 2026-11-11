/**
 * M6-01R-1 H1: request logs must never carry query values (note search text or
 * anything else), whatever spelling Fastify accepts for the parameter name.
 * Exercised through the real Fastify instance + production pino options.
 */

import { Writable } from 'node:stream';
import pino from 'pino';
import { defaultLoggerOptions } from '../src/app.js';
import { createConfig } from '../src/config.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const MARKERS = Array.from({ length: 12 }, (_, index) => `PRIVATESEARCHMARKER${index}`);

interface LogRecord {
  readonly msg?: string;
  readonly req?: { readonly url?: string; readonly method?: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

async function withCapturedLogs<T>(
  run: (ctx: TestContext, session: TestSession) => Promise<T>,
): Promise<{ readonly result: T; readonly text: string; readonly records: LogRecord[] }> {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  // Production options, only the level lowered so every record is captured.
  const loggerInstance = pino(
    { ...(defaultLoggerOptions(createConfig()) as unknown as pino.LoggerOptions), level: 'trace' },
    stream,
  );
  const ctx = await createTestContext({ loggerInstance });
  try {
    await ctx.seedUser({ email: 'log-url@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'log-url@example.com', 'correct-horse');
    const result = await run(ctx, session);
    const text = chunks.join('');
    const records = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogRecord);
    return { result, text, records };
  } finally {
    await ctx.close();
  }
}

function urlsLogged(records: readonly LogRecord[]): string[] {
  return records.flatMap((record) => (typeof record.req?.url === 'string' ? [record.req.url] : []));
}

describe.skipIf(!hasDatabase)('request logs never contain query values (M6-01R-1 H1)', () => {
  test('percent-encoded, repeated, bracketed, mixed-case and ;-style q spellings never reach the logs', async () => {
    const { result, text, records } = await withCapturedLogs(async (ctx, session) => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { title: `note ${MARKERS[0]}`, bodyMd: `${MARKERS[1]} body` },
      });
      expect(created.statusCode).toBe(201);
      const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: authHeaders(session) });
      return {
        // Fastify decodes %71 to `q`, so this is a real search for the marker.
        encoded: await get(`/api/v1/documents?%71=${MARKERS[0]}`),
        encodedEquals: await get(`/api/v1/documents?%71%3D${MARKERS[2]}`),
        repeated: await get(`/api/v1/documents?q=${MARKERS[3]}&q=${MARKERS[4]}`),
        ordinary: await get(`/api/v1/documents?q=${MARKERS[5]}`),
        withAllowed: await get(`/api/v1/documents?limit=5&q=${MARKERS[6]}`),
        bracketed: await get(`/api/v1/documents?q[]=${MARKERS[7]}`),
        mixedCase: await get(`/api/v1/documents?Q=${MARKERS[8]}`),
        semicolon: await get(`/api/v1/documents;q=${MARKERS[9]}`),
        semicolonQuery: await get(`/api/v1/documents?limit=1;q=${MARKERS[10]}`),
        plusEncoded: await get(`/api/v1/documents?q=${MARKERS[11]}+%2Bextra`),
      };
    });
    expect(result.encoded.statusCode).toBe(200);
    expect((result.encoded.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(result.ordinary.statusCode).toBe(200);

    for (const marker of MARKERS) {
      expect({ marker, logged: text.includes(marker) }).toEqual({ marker, logged: false });
    }
    // Only the path is logged for every request URL.
    for (const url of urlsLogged(records)) {
      expect({ url, hasQuery: /[?;#]/.test(url) }).toEqual({ url, hasQuery: false });
    }
  });

  test('control: ordinary routes still log their method and path', async () => {
    const { records } = await withCapturedLogs(async (ctx, session) => {
      const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeaders(session) });
      expect(me.statusCode).toBe(200);
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/documents?limit=2',
        headers: authHeaders(session),
      });
      expect(list.statusCode).toBe(200);
      const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/no-such-route?x=1' });
      expect(missing.statusCode).toBe(404);
    });
    const urls = urlsLogged(records);
    expect(urls).toContain('/api/v1/auth/login');
    expect(urls).toContain('/api/v1/me');
    expect(urls).toContain('/api/v1/documents');
    expect(urls).toContain('/api/v1/no-such-route');
    const listRecord = records.find((record) => record.req?.url === '/api/v1/documents');
    // Allow-listed parameter NAMES may be reported, never values.
    expect(listRecord?.req?.['queryKeys']).toEqual(['limit']);
  });

  test('malformed URLs and server errors do not echo query text', async () => {
    const { text } = await withCapturedLogs(async (ctx, session) => {
      await ctx.app.inject({ method: 'GET', url: `/api/v1/documents/%E0%A4%A?q=${MARKERS[0]}` });
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/documents/not-a-uuid?q=${MARKERS[1]}`,
        headers: authHeaders(session),
      });
      // A broken persisted row forces the 500 path of the error handler.
      const id = ctx.ids.next();
      await ctx.db
        .insertInto('intake_session')
        .values({
          id,
          owner_id: (await ctx.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id,
          state: 'clarification',
          input: JSON.stringify({ title: 'x' }) as never,
          detected_type: JSON.stringify({ classification: 'broken', confidence: 1, reasons: [], missingRequired: [] }) as never,
        })
        .execute();
      const broken = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${id}?q=${MARKERS[2]}`,
        headers: authHeaders(session),
      });
      expect(broken.statusCode).toBe(500);
    });
    for (const marker of MARKERS.slice(0, 3)) {
      expect({ marker, logged: text.includes(marker) }).toEqual({ marker, logged: false });
    }
  });
});
