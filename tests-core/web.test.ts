/**
 * The web app served by the core, and the boot hand-off (blueprint 15 §1.3),
 * against the real binary over a socket — the path a browser takes.
 *
 * The directory is the small fixture of the server crate
 * (`core/crates/server/tests/fixtures/web`), shaped like the output of
 * `vite build`; the real web app is not built here. The Rust tests
 * (`core/crates/server/tests/web.rs`) hold the long tables of paths.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_PREFIX } from './support/contract.js';
import { WEB_FIXTURE, runCoreToExit, startCore, type Core, type RawResponse } from './support/core.js';
import { newIdempotencyKey } from './support/routes.js';

/** The policy of `core/crates/server/src/web.rs`, written out a second time on purpose. */
const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'";
const FOREVER = 'public, max-age=31536000, immutable';

let core: Core;

beforeAll(async () => {
  core = await startCore({ webDir: WEB_FIXTURE, logLevel: 'info' });
});

afterAll(async () => {
  await core.dispose();
});

function fixture(relative: string): Promise<Buffer> {
  return readFile(join(WEB_FIXTURE, relative));
}

function expectNotFound(response: RawResponse, path: string): void {
  expect(response.status, path).toBe(404);
  expect(response.headers['content-type'], path).toBe('application/problem+json; charset=utf-8');
  const body = JSON.parse(response.body.toString('utf8')) as { code: string; detail: string };
  expect([body.code, body.detail], path).toEqual(['not_found', 'no route matches this request']);
}

describe('the document and its files', () => {
  test('the root and any route of the app answer the document, never kept, with the policy', async () => {
    const document = await fixture('index.html');
    for (const path of ['/', '/overview', '/tasks/0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55', '/settings/display?tab=1']) {
      const response = await core.raw('GET', path);
      expect(response.status, path).toBe(200);
      expect(response.body.equals(document), path).toBe(true);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toBe(POLICY);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  test('files have their type; only content-hashed assets are kept', async () => {
    for (const [path, type, cache] of [
      ['/assets/index-B3xY9aZ1.js', 'text/javascript; charset=utf-8', FOREVER],
      ['/assets/three-C0ffee12.js', 'text/javascript; charset=utf-8', FOREVER],
      ['/assets/index-Dq8FhP2c.css', 'text/css; charset=utf-8', FOREVER],
      ['/assets/PretendardVariable-Zx81kQpL.woff2', 'font/woff2', FOREVER],
      ['/assets/glass-orb-9aBcD_eF.webp', 'image/webp', FOREVER],
      ['/assets/unhashed.js', 'text/javascript; charset=utf-8', 'no-cache'],
      ['/mockServiceWorker.js', 'text/javascript; charset=utf-8', 'no-cache'],
      ['/favicon.svg', 'image/svg+xml', 'no-cache'],
      ['/LICENSE', 'application/octet-stream', 'no-cache'],
    ] as const) {
      const response = await core.raw('GET', path);
      expect(response.status, path).toBe(200);
      expect([response.headers['content-type'], response.headers['cache-control']], path).toEqual([type, cache]);
      expect(response.body.equals(await fixture(path.slice(1))), path).toBe(true);
      expect(response.headers['content-length'], path).toBe(String(response.body.length));
      expect(response.headers['content-security-policy']).toBe(POLICY);
    }
  });

  test('HEAD answers the headers of GET and no body', async () => {
    const get = await core.raw('GET', '/assets/index-B3xY9aZ1.js');
    const head = await core.raw('HEAD', '/assets/index-B3xY9aZ1.js');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    for (const name of ['content-length', 'content-type', 'cache-control', 'content-security-policy']) {
      expect(head.headers[name], name).toBe(get.headers[name]);
    }
  });

  test('a missing file, a directory and a reserved path are 404, never the document', async () => {
    for (const path of [
      '/assets/index-AAAA1111.js',
      '/favicon.ico',
      '/assets',
      '/assets/',
      '/api',
      '/api/v2/tasks',
      '/__nothing',
      '/healthz/extra',
    ]) {
      expectNotFound(await core.raw('GET', path), path);
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expectNotFound(await core.raw(method, '/'), `${method} /`);
    }
  });

  test('hostile paths, sent as written, get nothing', async () => {
    const document = (await fixture('index.html')).toString('utf8');
    for (const path of [
      '/../../../../etc/passwd',
      '/assets/../../../../etc/passwd',
      '/assets/../.hidden',
      '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/assets/..%2f..%2f..%2fetc%2fpasswd',
      '/..%5c..%5cetc%5cpasswd',
      '//etc/passwd',
      '/.hidden',
      '/%2ehidden',
      '/.git/config',
      '/index.html%00',
      '/.hidden%00.png',
      '/%zz',
    ]) {
      const response = await core.raw('GET', path);
      expectNotFound(response, path);
      const text = response.body.toString('utf8');
      expect(text, path).not.toContain('HIDDEN-FILE-CONTENT');
      expect(text, path).not.toContain('root:');
      expect(text, path).not.toContain(document);
    }
  });

  test('a request for another host name is refused before any file is read', async () => {
    const response = await core.raw('GET', '/', { host: 'attacker.example' });
    expect(response.status).toBe(403);
    expect((JSON.parse(response.body.toString('utf8')) as { code: string }).code).toBe('forbidden');
  });
});

describe('the boot hand-off', () => {
  test('the right token sets the launch cookie and leads to the document', async () => {
    const boot = await core.raw('GET', `/__boot?token=${core.token}`);
    expect(boot.status).toBe(303);
    expect(boot.headers.location).toBe('/');
    expect(boot.body.length).toBe(0);
    expect(boot.headers['cache-control']).toBe('no-store');
    expect(boot.headers['referrer-policy']).toBe('no-referrer');
    // Exactly the cookie of 15 §1.3 — and never `Secure`: the desktop webview
    // is WebKit, which does not keep a Secure cookie set by http://127.0.0.1.
    const setCookie = boot.headers['set-cookie'] ?? [];
    expect(setCookie).toEqual([`omd_launch=${core.token}; Path=/; HttpOnly; SameSite=Strict`]);
    expect(setCookie.join(';').toLowerCase()).not.toContain('secure');

    // What a browser does next: follow the redirect with the cookie it got.
    const cookie = (setCookie[0] ?? '').split(';')[0] ?? '';
    const landing = await core.raw('GET', boot.headers.location ?? '', { cookie });
    expect(landing.status).toBe(200);
    expect(landing.body.equals(await fixture('index.html'))).toBe(true);

    // From here on the page's requests are same-origin and carry the cookie.
    const me = await core.request('GET', `${API_PREFIX}/me`, { authenticated: false, headers: { cookie } });
    expect(me.status).toBe(200);
    const origin = core.baseUrl;
    const version = (me.body as { version: number }).version;
    const patch = (from: string): ReturnType<Core['request']> =>
      core.request('PATCH', `${API_PREFIX}/me/settings`, {
        authenticated: false,
        headers: { cookie, origin: from, 'if-match': `W/"${version}"`, 'idempotency-key': newIdempotencyKey() },
        body: { locale: 'ko-KR' },
      });
    expect((await patch('https://evil.example')).status).toBe(403);
    expect((await patch(origin)).status).toBe(200);
  });

  test('a wrong or missing token gets no cookie and tells nothing', async () => {
    const answers: string[] = [];
    for (const target of [
      '/__boot',
      '/__boot?token=',
      '/__boot?token=nope',
      `/__boot?token=${core.token.slice(0, 63)}`,
      `/__boot?token=${core.token}0`,
      `/__boot?Token=${core.token}`,
      `/__boot?token=other&token=${core.token}`,
    ]) {
      const response = await core.raw('GET', target);
      expect(response.status, target).toBe(401);
      expect(response.headers['set-cookie'], target).toBeUndefined();
      expect(response.headers.location, target).toBeUndefined();
      const body = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
      expect(body['code']).toBe('unauthenticated');
      delete body['traceId'];
      answers.push(JSON.stringify(body));
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).not.toContain(core.token);
    // Without the cookie the API stays closed, web directory or not.
    expect((await core.request('GET', `${API_PREFIX}/me`, { authenticated: false })).status).toBe(401);
  });

  test('the launch token never reaches the log', async () => {
    // Everything above ran against this process with request lines on.
    await core.raw('GET', `/__boot?token=${core.token}`);
    await core.raw('GET', '/__boot?token=SECRET-BOOT-GUESS-77aa');
    await core.raw('GET', '/SECRET-PATH-51c0/page?q=SECRET-QUERY-9d2e');
    await core.request('GET', `${API_PREFIX}/me`);
    // The log is written line by line; give the last lines time to arrive.
    await expect.poll(() => core.logs(), { timeout: 5_000 }).toContain('"operation":"getMe"');
    const logs = core.logs();
    expect(logs).toContain('"operation":"boot"');
    expect(logs).toContain('"operation":"web"');
    for (const secret of [core.token, core.token.slice(0, 16), 'SECRET-BOOT', 'SECRET-PATH', 'SECRET-QUERY', '__boot']) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('--web-dir', () => {
  test('a directory without an index.html, or no directory, is a usage error (exit 2)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ohmydate-web-empty-'));
    const data = await mkdtemp(join(tmpdir(), 'ohmydate-web-data-'));
    try {
      await writeFile(join(empty, 'app.js'), 'export {};');
      expect(await runCoreToExit(['--data-dir', data, '--web-dir', empty])).toBe(2);
      expect(await runCoreToExit(['--data-dir', data, '--web-dir', join(empty, 'missing')])).toBe(2);
      expect(await runCoreToExit(['--data-dir', data, '--web-dir'])).toBe(2);
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });

  test('without it the core serves nothing outside the API, as before', async () => {
    const plain = await startCore();
    try {
      for (const path of ['/', '/index.html', '/overview', '/assets/index-B3xY9aZ1.js']) {
        expectNotFound(await plain.raw('GET', path), path);
      }
      expect((await plain.raw('GET', '/healthz')).status).toBe(200);
      // The hand-off itself does not need a web directory.
      expect((await plain.raw('GET', `/__boot?token=${plain.token}`)).status).toBe(303);
    } finally {
      await plain.dispose();
    }
  });
});
