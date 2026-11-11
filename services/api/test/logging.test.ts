import { Writable } from 'node:stream';
import pino from 'pino';
import { createConfig } from '../src/config.js';
import { defaultLoggerOptions, redactLoggedUrl } from '../src/app.js';

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
  expect(text).toContain('/api/v1/documents?targetKind=goal&q=[REDACTED]&limit=5');
});

test('redactLoggedUrl only touches the q parameter', () => {
  expect(redactLoggedUrl('/api/v1/documents?q=secret')).toBe('/api/v1/documents?q=[REDACTED]');
  expect(redactLoggedUrl('/api/v1/documents?cursor=abc&q=a&q=b')).toBe(
    '/api/v1/documents?cursor=abc&q=[REDACTED]&q=[REDACTED]',
  );
  expect(redactLoggedUrl('/api/v1/today?date=2026-11-12')).toBe('/api/v1/today?date=2026-11-12');
  expect(redactLoggedUrl('/api/v1/templates?query=x')).toBe('/api/v1/templates?query=x');
});
