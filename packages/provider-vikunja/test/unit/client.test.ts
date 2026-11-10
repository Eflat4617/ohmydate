import { createServer } from 'node:http';
import {
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
} from '@ohmydate/domain';
import {
  VikunjaClient,
  mapVikunjaError,
  runWithAbortSignal,
  toValidationIssues,
} from '../../src/client.js';
import { FakeHttp } from './fake-http.js';

describe('mapVikunjaError', () => {
  test('maps 404 and the numeric task codes to NotFoundError', () => {
    expect(mapVikunjaError(404, { code: 4002, detail: 'task missing' })).toBeInstanceOf(
      NotFoundError,
    );
    expect(mapVikunjaError(400, { code: 4002 })).toBeInstanceOf(NotFoundError);
    expect(mapVikunjaError(200, { code: 4040 })).toBeInstanceOf(NotFoundError);
    expect(mapVikunjaError(200, { code: 3001 })).toBeInstanceOf(NotFoundError);
    expect(mapVikunjaError(403, { detail: 'forbidden' })).toBeInstanceOf(NotFoundError);
  });

  test('maps validation statuses/codes and keeps the field issues', () => {
    const error = mapVikunjaError(422, {
      code: 2002,
      detail: 'invalid',
      errors: [{ location: 'title', message: 'title is required' }],
    });
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).issues).toEqual([
      { path: 'title', message: 'title is required' },
    ]);
    expect(toValidationIssues({ detail: 'plain' })).toEqual([
      { path: 'body', message: 'plain' },
    ]);
  });

  test('maps 401 to a distinct provider_auth reason without secrets', () => {
    const error = mapVikunjaError(401, { detail: 'invalid token tk_secret' });
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).reason).toBe('provider_auth');
    expect(error.message).toContain('provider_auth');
    expect(error.message).not.toContain('tk_secret');
  });

  test('maps server, auth, rate-limit and unknown statuses to ProviderUnavailableError', () => {
    for (const status of [401, 429, 500, 502, 503]) {
      expect(mapVikunjaError(status)).toBeInstanceOf(ProviderUnavailableError);
    }
  });
});

describe('VikunjaClient transport behaviour', () => {
  test('retries idempotent GETs on 5xx and network errors with backoff', async () => {
    let attempts = 0;
    const http = new FakeHttp(() => {
      attempts += 1;
      if (attempts < 3) return { status: 503, body: { title: 'unavailable' } };
      return { status: 200, body: { id: 1, title: 'ok' } };
    });
    const sleeps: number[] = [];
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      fetch: http.fetch,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    const result = await client.getTask('1');

    expect(result.data.title).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  test('does not retry non-idempotent writes', async () => {
    const http = new FakeHttp(() => ({ status: 503, body: { title: 'unavailable' } }));
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      fetch: http.fetch,
      sleep: async () => {},
    });

    await expect(client.patchTask('1', { title: 'x' })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(http.calls).toHaveLength(1);
  });

  test('maps a timeout to ProviderUnavailableError', async () => {
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      timeoutMs: 5,
      fetch: (input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
          void input;
        }),
      sleep: async () => {},
    });

    await expect(client.getTask('1')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  test('treats a 304 no-op write as success without a body', async () => {
    const methods: string[] = [];
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      fetch: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return new Response(null, { status: 304 });
      },
      sleep: async () => {},
    });

    const result = await client.request<unknown>('PATCH', '/tasks/1', {
      body: { done: false },
    });

    expect(result.status).toBe(304);
    expect(result.etag).toBeNull();
    expect(methods).toEqual(['PATCH']);
  });

  test('sends bearer auth and an explicit merge-patch content type', async () => {
    const http = new FakeHttp(() => ({
      status: 200,
      body: { id: 1, title: 'patched' },
    }));
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      token: 'tk_test',
      fetch: http.fetch,
    });

    await client.patchTask('1', { done: true });

    expect(http.calls[0]?.headers.authorization).toBe('Bearer tk_test');
    expect(http.calls[0]?.headers['content-type']).toBe(
      'application/merge-patch+json',
    );
    expect(http.calls[0]?.body).toEqual({ done: true });
  });
});

describe('VikunjaClient failure normalization', () => {
  test('GET retries exhausted network errors into ProviderUnavailableError', async () => {
    let calls = 0;
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      token: 'tk_secret',
      fetch: async () => {
        calls += 1;
        throw new TypeError('fetch failed https://user:pass@vikunja.test tk_secret');
      },
      sleep: async () => {},
    });

    const error = await client.getTask('1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(String((error as Error).message)).not.toContain('tk_secret');
    expect(String((error as Error).message)).not.toContain('user:pass');
    expect(calls).toBe(3);
  });

  test('writes do not retry and normalize network errors immediately', async () => {
    let calls = 0;
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      token: 'tk_secret',
      fetch: async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
      sleep: async () => {},
    });

    await expect(client.patchTask('1', { done: true })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(calls).toBe(1);
  });

  test('the timeout stays active while the response body is consumed', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":');
      setTimeout(() => response.end('1}'), 250);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('test server did not expose a port');
    }
    try {
      const client = new VikunjaClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 40,
        retries: 0,
        sleep: async () => {},
      });
      await expect(client.getTask('1')).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('VikunjaClient response validation', () => {
  test('maps a 2xx non-JSON body to ProviderUnavailableError', async () => {
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      fetch: async () =>
        new Response('<html>proxy</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      sleep: async () => {},
    });

    await expect(client.getTask('1')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('VikunjaClient abort signal', () => {
  test('a caller abort stops the retry loop with no further attempts', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const sleeps: number[] = [];
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      retries: 5,
      fetch: (_input, init) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
          // Abort while the first attempt is in flight, as a shutdown
          // deadline does.
          controller.abort();
        });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(
      client.request('GET', '/tasks/1', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('an ambient request-context signal is observed without per-call wiring', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      retries: 3,
      fetch: (_input, init) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
          controller.abort();
        });
      },
      sleep: async () => {},
    });

    await expect(
      runWithAbortSignal(controller.signal, () => client.getTask('1')),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(attempts).toBe(1);
  });

  test('an already-aborted signal makes no fetch attempt at all', async () => {
    let attempts = 0;
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      fetch: async () => {
        attempts += 1;
        return new Response('{}', { status: 200 });
      },
      sleep: async () => {},
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.request('GET', '/tasks/1', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(attempts).toBe(0);
  });
});
