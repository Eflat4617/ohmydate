import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleHttpClient } from '../src/adapters/google-http.js';
import { GoogleApiError } from '../src/application/google-calendar-ports.js';

/**
 * CAL-03: the fetch adapter against a LOCAL fake HTTP server. Nothing here
 * talks to Google.
 */
interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

type Handler = (request: Recorded, response: ServerResponse) => void;

let server: Server;
let base: string;
let requests: Recorded[];
let handler: Handler;

beforeEach(async () => {
  requests = [];
  handler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  };
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function client(overrides: Partial<ConstructorParameters<typeof GoogleHttpClient>[0]> = {}) {
  const sleeps: number[] = [];
  const http = new GoogleHttpClient({
    clientId: 'client-id',
    clientSecret: 'client-secret-xyz',
    oauthBaseUrl: base,
    calendarBaseUrl: `${base}/calendar/v3`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...overrides,
  });
  return { http, sleeps };
}

describe('GoogleHttpClient OAuth', () => {
  test('the code exchange posts a form with the PKCE verifier and parses granted scopes', async () => {
    handler = (_request, response) =>
      json(response, 200, {
        access_token: 'ya29.fake-access',
        expires_in: 3599,
        refresh_token: '1//fake-refresh',
        scope: 'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.events.readonly',
        token_type: 'Bearer',
      });
    const { http } = client();
    const tokens = await http.exchangeCode({ code: 'auth-code', codeVerifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:5180/cb' });
    expect(tokens).toEqual({
      accessToken: 'ya29.fake-access',
      expiresInSec: 3599,
      refreshToken: '1//fake-refresh',
      scopes: [
        'https://www.googleapis.com/auth/calendar.app.created',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ],
    });
    const request = requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/token');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(request?.body ?? '');
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: 'v'.repeat(43),
      redirect_uri: 'http://127.0.0.1:5180/cb',
      client_id: 'client-id',
      client_secret: 'client-secret-xyz',
    });
  });

  test('invalid_grant on refresh is auth_revoked; the error never carries the token or description', async () => {
    handler = (_request, response) =>
      json(response, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    const { http, sleeps } = client();
    const error = await http.refresh('1//secret-refresh').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ kind: 'auth_revoked', status: 400, reason: 'invalid_grant' });
    expect(String((error as Error).message)).not.toContain('1//secret-refresh');
    expect(String((error as Error).message)).not.toContain('expired or revoked');
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test('revoke sends the token in the form body, never in the URL', async () => {
    const { http } = client();
    await http.revoke('1//secret-refresh');
    expect(requests[0]?.url).toBe('/revoke');
    expect(requests[0]?.body).toBe('token=1%2F%2Fsecret-refresh');
  });
});

describe('GoogleHttpClient Calendar API', () => {
  test('events.list asks for single instances in the window with a narrow field mask and a bearer token', async () => {
    handler = (_request, response) => json(response, 200, { items: [{ id: 'e1' }], nextPageToken: 'p2' });
    const { http } = client();
    const page = await http.listEvents('ya29.token', 'team#holiday@group.v.calendar.google.com', {
      timeMin: '2026-01-01T00:00:00.000Z',
      timeMax: '2026-07-01T00:00:00.000Z',
      pageToken: 'p1',
    });
    expect(page).toEqual({ items: [{ id: 'e1' }], nextPageToken: 'p2' });
    const url = new URL(requests[0]?.url ?? '', base);
    expect(url.pathname).toBe('/calendar/v3/calendars/team%23holiday%40group.v.calendar.google.com/events');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('timeMin')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('pageToken')).toBe('p1');
    expect(url.searchParams.get('fields')).not.toContain('description');
    expect(url.searchParams.get('fields')).not.toContain('location');
    expect(requests[0]?.headers['authorization']).toBe('Bearer ya29.token');
  });

  test('429 and 5xx retry with bounded exponential backoff, then fail as rate_limited', async () => {
    handler = (_request, response) => json(response, 429, { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } });
    const { http, sleeps } = client({ maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 1_000 });
    const error = await http.listCalendars('t', undefined).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  test('403 rateLimitExceeded is retried; Retry-After is honoured up to the cap; recovery returns data', async () => {
    let calls = 0;
    handler = (_request, response) => {
      calls += 1;
      if (calls === 1) {
        json(response, 403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, { 'retry-after': '120' });
      } else if (calls === 2) {
        json(response, 503, { error: { code: 503 } });
      } else {
        json(response, 200, { items: [] });
      }
    };
    const { http, sleeps } = client({ maxAttempts: 3, baseBackoffMs: 50, maxBackoffMs: 2_000 });
    await expect(http.listCalendars('t', undefined)).resolves.toEqual({ items: [] });
    expect(sleeps).toEqual([2_000, 100]);
  });

  test('other 4xx are not retried and classify 404, 410, 409 duplicate and 401', async () => {
    const { http } = client();
    for (const [status, reason, kind] of [
      [404, 'notFound', 'not_found'],
      [410, 'deleted', 'gone'],
      [409, 'duplicate', 'duplicate'],
      [401, 'authError', 'unauthorized'],
      [400, 'invalid', 'rejected'],
      [403, 'forbidden', 'rejected'],
    ] as const) {
      requests = [];
      handler = (_request, response) => json(response, status, { error: { code: status, errors: [{ reason }] } });
      const error = await http.deleteEvent('t', 'cal', 'e1').catch((caught: unknown) => caught);
      expect({ status, kind: (error as GoogleApiError).kind }).toEqual({ status, kind });
      expect(requests).toHaveLength(1);
    }
  });

  test('a hung request times out per attempt and the run signal aborts the retries', async () => {
    handler = () => {
      // never answers
    };
    const { http } = client({ timeoutMs: 50, maxAttempts: 2 });
    const timedOut = await http.listCalendars('t', undefined).catch((caught: unknown) => caught);
    expect(timedOut).toMatchObject({ kind: 'unavailable', reason: 'network' });
    expect(requests).toHaveLength(2);

    requests = [];
    const controller = new AbortController();
    const pending = http.listCalendars('t', undefined, { signal: controller.signal }).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'aborted' });
  });

  test('calendars.insert does not retry a network failure (a second "OhMyDate" calendar would be created)', async () => {
    handler = (_request, response) => {
      response.socket?.destroy();
    };
    const { http } = client({ maxAttempts: 3 });
    const error = await http
      .insertCalendar('t', { summary: 'OhMyDate', timeZone: 'Asia/Seoul' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'unavailable' });
    expect(requests).toHaveLength(1);
  });

  test('events.insert sends the deterministic id and the reminder overrides as JSON', async () => {
    handler = (_request, response) => json(response, 200, { id: 'babc' });
    const { http } = client();
    await http.insertEvent('t', 'cal@group.calendar.google.com', {
      id: 'b0193a8f26c1e7b419a2e1f1d6a0b3c55',
      summary: '논문 요약',
      start: { dateTime: '2026-01-02T01:00:00.000Z', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-01-02T02:00:00.000Z', timeZone: 'Asia/Seoul' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      transparency: 'opaque',
      status: 'confirmed',
    });
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({
      id: 'b0193a8f26c1e7b419a2e1f1d6a0b3c55',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    });
  });
});
