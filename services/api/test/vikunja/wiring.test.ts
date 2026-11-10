import { randomUUID } from 'node:crypto';
import type { Id } from '@ohmydate/domain';
import { configFromEnv, createConfig } from '../../src/config.js';
import { loadVikunjaClients } from '../../src/adapters/vikunja/owner-accounts.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './pg-support.js';

describe('provider config from environment', () => {
  test('defaults to memory and reads the vikunja wiring', () => {
    expect(configFromEnv({}).provider).toBe('memory');
    expect(configFromEnv({}).reconcileIntervalMs).toBe(300_000);

    const vikunja = configFromEnv({
      PROVIDER: 'vikunja',
      VIKUNJA_URL: 'http://127.0.0.1:3456',
      VIKUNJA_TOKEN_FILE: '/run/secrets/vikunja.json',
      VIKUNJA_RECONCILE_INTERVAL_MS: '60000',
    });
    expect(vikunja.provider).toBe('vikunja');
    expect(vikunja.vikunjaUrl).toBe('http://127.0.0.1:3456');
    expect(vikunja.vikunjaTokenFile).toBe('/run/secrets/vikunja.json');
    expect(vikunja.reconcileIntervalMs).toBe(60_000);

    expect(() => configFromEnv({ PROVIDER: 'other' })).toThrow(/PROVIDER/);
    expect(() => configFromEnv({ VIKUNJA_RECONCILE_INTERVAL_MS: '-1' })).toThrow(
      /VIKUNJA_RECONCILE_INTERVAL_MS/,
    );
  });
});

describe.skipIf(!hasDatabase)('Vikunja owner account token resolution', () => {
  let store: PgTestStore;

  beforeEach(async () => {
    store = await createPgTestStore();
  });

  afterEach(async () => {
    await store.close();
  });

  test('resolves env and file references without storing cleartext tokens', async () => {
    const envOwner = randomUUID() as Id;
    const fileOwner = randomUUID() as Id;
    await store.db
      .insertInto('vikunja_owner_account')
      .values([
        { owner_id: envOwner, vikunja_user_id: 1, token_secret_ref: 'env:VK_ENV_TOKEN' },
        { owner_id: fileOwner, vikunja_user_id: 2, token_secret_ref: 'file:/tokens.json' },
      ])
      .execute();

    const clients = await loadVikunjaClients({
      db: store.db,
      config: createConfig({ provider: 'vikunja', vikunjaUrl: 'http://127.0.0.1:3456' }),
      env: { VK_ENV_TOKEN: 'tk-env-secret' },
      readTextFile: async () => JSON.stringify({ [fileOwner]: 'tk-file-secret' }),
    });

    expect([...clients.keys()].sort()).toEqual([envOwner, fileOwner].sort());
    for (const client of clients.values()) {
      expect(client.baseUrl).toBe('http://127.0.0.1:3456');
    }
    const stored = await store.db
      .selectFrom('vikunja_owner_account')
      .select('token_secret_ref')
      .execute();
    expect(stored.map((row) => row.token_secret_ref).sort()).toEqual([
      'env:VK_ENV_TOKEN',
      'file:/tokens.json',
    ]);
  });

  test('fails loudly on missing url or token without echoing the secret', async () => {
    const ownerId = randomUUID() as Id;
    await store.db
      .insertInto('vikunja_owner_account')
      .values({ owner_id: ownerId, vikunja_user_id: 1, token_secret_ref: 'env:MISSING_TOKEN' })
      .execute();

    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({ provider: 'vikunja', vikunjaUrl: null }),
      }),
    ).rejects.toThrow(/VIKUNJA_URL/);

    const error = await loadVikunjaClients({
      db: store.db,
      config: createConfig({ provider: 'vikunja', vikunjaUrl: 'http://127.0.0.1:3456' }),
      env: {},
      readTextFile: async () => '{}',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/MISSING_TOKEN/);
  });
});
