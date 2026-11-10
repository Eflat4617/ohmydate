import {
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
} from '@ohmydate/domain';
import {
  VikunjaClient,
  mapVikunjaError,
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
