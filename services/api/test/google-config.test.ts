import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromEnv, createConfig } from '../src/config.js';
import { loadGoogleOAuthSecrets, parseGoogleClientJson } from '../src/google-config.js';
import { main } from '../src/main.js';
import { atRestKey, decryptAtRest, encryptAtRest, keyIdOf } from '../src/application/at-rest-crypto.js';
import { encryptPushValue } from '../src/application/push-crypto.js';

const REDIRECT = 'http://127.0.0.1:5180/api/v1/integrations/google/callback';
const ORIGIN = 'http://127.0.0.1:5180';
const SECRET = 'GOCSPX-super-secret-client-value';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ohmydate-google-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function secretFile(name: string, content: string, mode = 0o600): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

function clientJson(shape: 'web' | 'installed' = 'web'): string {
  return JSON.stringify({
    [shape]: {
      client_id: '123-abc.apps.googleusercontent.com',
      project_id: 'ohmydate-local',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_secret: SECRET,
      redirect_uris: [REDIRECT],
    },
  });
}

function googleConfig(clientFile: string | null, keyFile: string | null) {
  return createConfig({
    googleOAuthClientFile: clientFile,
    googleTokenKeyFile: keyFile,
    googleOAuthRedirectUri: REDIRECT,
    googleWebOrigin: ORIGIN,
  });
}

describe('Google env configuration', () => {
  test('nothing set is a normal not-configured state with the documented defaults', () => {
    const config = configFromEnv({});
    expect(config).toMatchObject({
      googleOAuthClientFile: null,
      googleTokenKeyFile: null,
      googleOAuthRedirectUri: null,
      googleWebOrigin: null,
      googleSyncIntervalMs: 300_000,
      googleImportDays: 180,
      googleExportDays: 60,
    });
    expect(loadGoogleOAuthSecrets(config)).toBeNull();
  });

  test('paths must be absolute and a client file needs the redirect URI and web origin', () => {
    expect(() => configFromEnv({ GOOGLE_OAUTH_CLIENT_FILE: 'deploy/secrets/local/google.json' })).toThrow(
      'GOOGLE_OAUTH_CLIENT_FILE must be an absolute path',
    );
    expect(() => configFromEnv({ GOOGLE_TOKEN_KEY_FILE: 'google-token.key' })).toThrow(
      'GOOGLE_TOKEN_KEY_FILE must be an absolute path',
    );
    expect(() => configFromEnv({ GOOGLE_OAUTH_CLIENT_FILE: '/x/google.json' })).toThrow(
      /GOOGLE_OAUTH_REDIRECT_URI and GOOGLE_WEB_ORIGIN are required/,
    );
    const config = configFromEnv({
      GOOGLE_OAUTH_CLIENT_FILE: '/x/google.json',
      GOOGLE_TOKEN_KEY_FILE: '/x/google-token.key',
      GOOGLE_OAUTH_REDIRECT_URI: REDIRECT,
      GOOGLE_WEB_ORIGIN: `${ORIGIN}/`,
      GOOGLE_SYNC_INTERVAL_MS: '0',
      GOOGLE_EXPORT_DAYS: '14',
    });
    expect(config).toMatchObject({
      googleWebOrigin: ORIGIN,
      googleSyncIntervalMs: 0,
      googleExportDays: 14,
    });
  });

  test('redirect URI and web origin rules (loopback-only http, exact callback path, no query)', () => {
    const base = { GOOGLE_WEB_ORIGIN: ORIGIN };
    for (const [uri, message] of [
      ['http://192.168.0.5:5180/api/v1/integrations/google/callback', /http only on a loopback host/],
      ['http://127.0.0.1:5180/callback', /path must be \/api\/v1\/integrations\/google\/callback/],
      [`${REDIRECT}?next=x`, /must not contain credentials, a query or a fragment/],
      ['javascript:alert(1)', /absolute http\(s\) URL/],
      ['not a url', /absolute http\(s\) URL/],
    ] as const) {
      expect(() => configFromEnv({ ...base, GOOGLE_OAUTH_REDIRECT_URI: uri })).toThrow(message);
    }
    expect(() =>
      configFromEnv({ GOOGLE_OAUTH_REDIRECT_URI: 'https://planner.example/api/v1/integrations/google/callback' }),
    ).not.toThrow();
    expect(() => configFromEnv({ GOOGLE_WEB_ORIGIN: 'http://127.0.0.1:5180/settings' })).toThrow(
      /without a path/,
    );
    expect(() => configFromEnv({ GOOGLE_SYNC_INTERVAL_MS: '-5' })).toThrow(
      'GOOGLE_SYNC_INTERVAL_MS must be a non-negative integer',
    );
    expect(() => configFromEnv({ GOOGLE_IMPORT_DAYS: '400' })).toThrow('GOOGLE_IMPORT_DAYS must be at most 366');
  });
});

describe('Google secret files', () => {
  test('loads the web and the installed client shapes with a 0600 key file', async () => {
    const key = await secretFile('google-token.key', `${randomBytes(32).toString('hex')}\n`);
    for (const shape of ['web', 'installed'] as const) {
      const client = await secretFile(`client-${shape}.json`, clientJson(shape));
      const secrets = loadGoogleOAuthSecrets(googleConfig(client, key));
      expect(secrets).toMatchObject({
        clientId: '123-abc.apps.googleusercontent.com',
        clientSecret: SECRET,
        redirectUri: REDIRECT,
        webOrigin: ORIGIN,
      });
      expect(secrets?.tokenKey.key).toHaveLength(32);
      expect(secrets?.tokenKey.keyId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test('a client file without a key file (or the reverse) is not configured', async () => {
    const client = await secretFile('client.json', clientJson());
    expect(loadGoogleOAuthSecrets(googleConfig(client, null))).toBeNull();
    expect(loadGoogleOAuthSecrets(googleConfig(null, join(dir, 'missing.key')))).toBeNull();
  });

  test('a configured but missing, open or malformed file fails with the env name and no contents', async () => {
    const key = await secretFile('google-token.key', randomBytes(32).toString('hex'));
    const cases: [string, RegExp][] = [
      [join(dir, 'missing.json'), /^GOOGLE_OAUTH_CLIENT_FILE does not exist or is not readable$/],
      [await secretFile('open.json', clientJson(), 0o644), /^GOOGLE_OAUTH_CLIENT_FILE must not be group- or world-accessible \(chmod 600\)$/],
      [await secretFile('broken.json', `{"web":{"client_secret":"${SECRET}"`), /^GOOGLE_OAUTH_CLIENT_FILE is not valid JSON$/],
      [
        await secretFile('shape.json', JSON.stringify({ other: { client_secret: SECRET } })),
        /^GOOGLE_OAUTH_CLIENT_FILE must be the downloaded OAuth client JSON/,
      ],
      [
        await secretFile('nosecret.json', JSON.stringify({ web: { client_id: 'x', client_secret: '' } })),
        /^GOOGLE_OAUTH_CLIENT_FILE must be the downloaded OAuth client JSON/,
      ],
    ];
    for (const [path, message] of cases) {
      let error: unknown;
      try {
        loadGoogleOAuthSecrets(googleConfig(path, key));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(dir);
    }
  });

  test('token key rules: 0600, 32 bytes, message names the env variable only', async () => {
    const client = await secretFile('client.json', clientJson());
    const shortKey = 'ab'.repeat(8);
    const short = await secretFile('short.key', shortKey);
    expect(() => loadGoogleOAuthSecrets(googleConfig(client, short))).toThrow(
      'GOOGLE_TOKEN_KEY_FILE must decode to a 32-byte AES-256 key',
    );
    const open = await secretFile('open.key', randomBytes(32).toString('hex'), 0o640);
    expect(() => loadGoogleOAuthSecrets(googleConfig(client, open))).toThrow(
      'GOOGLE_TOKEN_KEY_FILE must not be group- or world-accessible (chmod 600)',
    );
    const empty = await secretFile('empty.key', '\n');
    expect(() => loadGoogleOAuthSecrets(googleConfig(client, empty))).toThrow('GOOGLE_TOKEN_KEY_FILE is empty');
  });

  test('parseGoogleClientJson never echoes the parser message (which quotes the input)', () => {
    expect(() => parseGoogleClientJson(`{"web": ${SECRET}}`)).toThrow('GOOGLE_OAUTH_CLIENT_FILE is not valid JSON');
  });

  test('boot fails before opening the database when a configured client file is malformed', async () => {
    const client = await secretFile('broken.json', `{"web":{"client_secret":"${SECRET}"`);
    const key = await secretFile('google-token.key', randomBytes(32).toString('hex'));
    await expect(
      main({
        DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/never',
        GOOGLE_OAUTH_CLIENT_FILE: client,
        GOOGLE_TOKEN_KEY_FILE: key,
        GOOGLE_OAUTH_REDIRECT_URI: REDIRECT,
        GOOGLE_WEB_ORIGIN: ORIGIN,
      }),
    ).rejects.toThrow(/^GOOGLE_OAUTH_CLIENT_FILE is not valid JSON$/);
  });
});

describe('at-rest envelope (generalised from push-crypto)', () => {
  test('push values keep their envelope: key id as AAD, decryptable by the generic helper', () => {
    const key = atRestKey(randomBytes(32));
    const envelope = encryptPushValue('p256dh-material', key.key, key.keyId);
    expect(envelope.length).toBe(12 + 16 + Buffer.byteLength('p256dh-material'));
    expect(decryptAtRest(envelope, key.key, key.keyId)).toBe('p256dh-material');
    expect(keyIdOf(key.key)).toBe(key.keyId);
  });

  test('a wrong key, wrong AAD or tampered envelope fails authentication without echoing data', () => {
    const key = randomBytes(32);
    const envelope = encryptAtRest('1//refresh-secret', key, 'google-refresh-token:a:k');
    expect(() => decryptAtRest(envelope, randomBytes(32), 'google-refresh-token:a:k')).toThrow(
      'at-rest envelope failed authentication',
    );
    expect(() => decryptAtRest(envelope, key, 'google-refresh-token:b:k')).toThrow(
      'at-rest envelope failed authentication',
    );
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptAtRest(tampered, key, 'google-refresh-token:a:k')).toThrow(/authentication/);
    expect(() => decryptAtRest(Buffer.alloc(10), key, 'x')).toThrow('at-rest envelope is too short');
  });
});
