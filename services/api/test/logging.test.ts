import { Writable } from 'node:stream';
import pino from 'pino';
import { createConfig } from '../src/config.js';
import { defaultLoggerOptions } from '../src/app.js';
import { loggedPath, loggedUrl } from '../src/http/log-url.js';

function captureStream(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, output: () => chunks.join('') };
}

test('logger redacts auth headers, cookies and password fields', () => {
  const { stream, output } = captureStream();
  const logger = pino(
    defaultLoggerOptions(createConfig()) as unknown as pino.LoggerOptions,
    stream,
  );

  logger.info(
    {
      req: {
        method: 'POST',
        url: '/api/v1/auth/login',
        id: 'req-1',
        headers: {
          authorization: 'Bearer super-secret-token',
          cookie: 'sid=session-secret; csrf=csrf-secret',
          'x-csrf-token': 'csrf-secret',
        },
        body: { email: 'alice@example.com', password: 'hunter2' },
      },
      password: 'hunter2',
    },
    'incoming request',
  );

  const text = output();
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain('session-secret');
  expect(text).not.toContain('csrf-secret');
  expect(text).not.toContain('super-secret-token');
  expect(text).not.toContain('alice@example.com');
  expect(text).toContain('/auth/login');
});

test('logger options list every sensitive pino redact path', () => {
  const options = defaultLoggerOptions(createConfig()) as {
    redact?: { paths?: readonly string[] };
  };
  const paths = options.redact?.paths ?? [];
  for (const expected of [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-csrf-token"]',
    'res.headers["set-cookie"]',
    'req.body.password',
  ]) {
    expect(paths).toContain(expected);
  }
});

test('M6-01: note search strings are redacted from logged request URLs', () => {
  const { stream, output } = captureStream();
  const logger = pino(
    defaultLoggerOptions(createConfig()) as unknown as pino.LoggerOptions,
    stream,
  );
  logger.info(
    {
      req: {
        method: 'GET',
        url: '/api/v1/documents?targetKind=goal&q=%EB%85%BC%EB%AC%B8%20private-note-text&limit=5',
        id: 'req-2',
        body: { title: 'note title', bodyMd: 'private note body' },
      },
    },
    'incoming request',
  );
  const text = output();
  expect(text).not.toContain('private-note-text');
  expect(text).not.toContain('%EB%85%BC');
  expect(text).not.toContain('private note body');
  // M6-01R-1 H1: path only; allow-listed names (never values) and a count of the rest.
  const record = JSON.parse(text.trim()) as { req: Record<string, unknown> };
  expect(record.req).toEqual({
    method: 'GET',
    url: '/api/v1/documents',
    queryKeys: ['limit', 'targetKind'],
    queryOmitted: 1,
    id: 'req-2',
  });
});

test('loggedUrl keeps the path and drops every query value, whatever the spelling', () => {
  expect(loggedUrl('/api/v1/me')).toEqual({ path: '/api/v1/me' });
  for (const [url, keys, omitted] of [
    ['/api/v1/documents?q=secret', [], 1],
    ['/api/v1/documents?%71=secret', [], 1],
    ['/api/v1/documents?%71%3Dsecret', [], 1],
    ['/api/v1/documents?q=a&q=b&cursor=abc', ['cursor'], 2],
    ['/api/v1/documents?q[]=a&Q=b&q%5B%5D=c', [], 3],
    ['/api/v1/documents?limit=1;q=secret', ['limit'], 1],
    ['/api/v1/documents;q=secret', [], 1],
    ['/api/v1/documents?q=a+b%2Bc#frag', [], 1],
    ['/api/v1/documents?%6Cimit=5', ['limit'], 0],
    ['/api/v1/documents?%E0%A4%A=bad', [], 1],
    ['/api/v1/today?date=2026-11-12', ['date'], 0],
    ['/api/v1/templates?query=x', [], 1],
  ] as const) {
    const logged = loggedUrl(url);
    expect({ url, logged }).toEqual({
      url,
      logged: { path: url.split(/[?;#]/, 1)[0], queryKeys: [...keys], queryOmitted: omitted },
    });
    expect(JSON.stringify(logged)).not.toMatch(/secret|=a|=b|2026-11-12|bad/);
  }
  expect(loggedPath('/api/v1/documents?q=secret')).toBe('/api/v1/documents');
});
