import { Writable } from 'node:stream';
import pino from 'pino';
import { createConfig } from '../src/config.js';
import { defaultLoggerOptions } from '../src/app.js';

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
