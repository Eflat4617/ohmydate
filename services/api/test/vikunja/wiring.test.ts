import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Id } from '@ohmydate/domain';
import {
  configFromEnv,
  createConfig,
  DEFAULT_RECONCILE_INTERVAL_MS,
  defaultReconcileIntervalMs,
} from '../../src/config.js';
import { loadVikunjaClients } from '../../src/adapters/vikunja/owner-accounts.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './pg-support.js';

describe('provider config from environment', () => {
  test('defaults to memory with reconciliation disabled and reads vikunja wiring', () => {
    expect(configFromEnv({}).provider).toBe('memory');
    expect(configFromEnv({}).reconcileIntervalMs).toBe(0);

    const vikunja = configFromEnv({
      PROVIDER: 'vikunja',
      VIKUNJA_URL: 'http://127.0.0.1:3456',
      VIKUNJA_TOKEN_FILE: '/run/secrets/vikunja.json',
      VIKUNJA_SECRETS_DIR: '/run/secrets',
      VIKUNJA_RECONCILE_INTERVAL_MS: '60000',
    });
    expect(vikunja.provider).toBe('vikunja');
    expect(vikunja.vikunjaUrl).toBe('http://127.0.0.1:3456');
    expect(vikunja.vikunjaTokenFile).toBe('/run/secrets/vikunja.json');
    expect(vikunja.vikunjaSecretsDir).toBe('/run/secrets');
    expect(vikunja.reconcileIntervalMs).toBe(60_000);

    expect(() => configFromEnv({ PROVIDER: 'other' })).toThrow(/PROVIDER/);
    expect(() => configFromEnv({ VIKUNJA_RECONCILE_INTERVAL_MS: '-1' })).toThrow(
      /VIKUNJA_RECONCILE_INTERVAL_MS/,
    );
  });

  test('defaults reconciliation ON for vikunja with a lock database, OFF for memory', () => {
    expect(DEFAULT_RECONCILE_INTERVAL_MS).toBe(300_000);
    expect(defaultReconcileIntervalMs('vikunja', 'postgres://x')).toBe(300_000);
    expect(defaultReconcileIntervalMs('vikunja', null)).toBe(0);
    expect(defaultReconcileIntervalMs('memory', 'postgres://x')).toBe(0);

    const vikunjaEnv = {
      PROVIDER: 'vikunja',
      VIKUNJA_URL: 'http://127.0.0.1:3456',
      DATABASE_URL: 'postgres://owner:pw@127.0.0.1:55432/planner_test',
    };
    expect(configFromEnv(vikunjaEnv).reconcileIntervalMs).toBe(300_000);
    expect(configFromEnv({ ...vikunjaEnv, PROVIDER: 'memory' }).reconcileIntervalMs).toBe(0);
    expect(
      configFromEnv({ ...vikunjaEnv, VIKUNJA_RECONCILE_INTERVAL_MS: '0' }).reconcileIntervalMs,
    ).toBe(0);
    expect(
      configFromEnv({ PROVIDER: 'vikunja', VIKUNJA_URL: vikunjaEnv.VIKUNJA_URL })
        .reconcileIntervalMs,
    ).toBe(0);

    expect(
      createConfig({
        provider: 'vikunja',
        databaseUrl: vikunjaEnv.DATABASE_URL,
      }).reconcileIntervalMs,
    ).toBe(300_000);
    expect(
      createConfig({
        provider: 'vikunja',
        databaseUrl: vikunjaEnv.DATABASE_URL,
        reconcileIntervalMs: 0,
      }).reconcileIntervalMs,
    ).toBe(0);
    expect(
      createConfig({ provider: 'memory', databaseUrl: vikunjaEnv.DATABASE_URL })
        .reconcileIntervalMs,
    ).toBe(0);
  });
});

describe.skipIf(!hasDatabase)('Vikunja owner account token resolution', () => {
  let store: PgTestStore;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    store = await createPgTestStore();
  });

  afterEach(async () => {
    await store.close();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function secretLayout(): Promise<{ root: string; secrets: string }> {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-tokens-'));
    tempDirs.push(root);
    const secrets = join(root, 'secrets');
    await mkdir(secrets, { recursive: true });
    return { root, secrets };
  }

  async function insertAccount(
    ownerId: Id,
    tokenSecretRef: string,
    vikunjaUserId = 1,
  ): Promise<void> {
    await store.db
      .insertInto('vikunja_owner_account')
      .values({
        owner_id: ownerId,
        vikunja_user_id: vikunjaUserId,
        token_secret_ref: tokenSecretRef,
      })
      .execute();
  }

  test('resolves constrained env and secrets-dir file references', async () => {
    const { secrets } = await secretLayout();
    const envOwner = randomUUID() as Id;
    const fileOwner = randomUUID() as Id;
    const tokenFile = join(secrets, 'tokens.json');
    await writeFile(tokenFile, JSON.stringify({ [fileOwner]: 'tk-file-secret' }), 'utf8');
    await insertAccount(envOwner, 'env:VIKUNJA_TOKEN_ENV', 1);
    await insertAccount(fileOwner, `file:${tokenFile}`, 2);

    const clients = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaSecretsDir: secrets,
      }),
      env: { VIKUNJA_TOKEN_ENV: 'tk-env-secret' },
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
      'env:VIKUNJA_TOKEN_ENV',
      `file:${tokenFile}`,
    ]);
  });

  test('allows the configured VIKUNJA_TOKEN_FILE and the tokens wrapper shape', async () => {
    const { root } = await secretLayout();
    const ownerId = randomUUID() as Id;
    const tokenFile = join(root, 'default-tokens.json');
    await writeFile(tokenFile, JSON.stringify({ tokens: { [ownerId]: 'tk-default' } }), 'utf8');
    await insertAccount(ownerId, 'default');

    const clients = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaTokenFile: tokenFile,
      }),
    });
    expect([...clients.keys()]).toEqual([ownerId]);
  });

  test('rejects non-VIKUNJA_TOKEN env names and bare paths', async () => {
    const ownerId = randomUUID() as Id;
    await insertAccount(ownerId, 'env:DATABASE_URL');

    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({ provider: 'vikunja', vikunjaUrl: 'http://127.0.0.1:3456' }),
        env: { DATABASE_URL: 'postgres://not-a-vikunja-token' },
      }),
    ).rejects.toThrow(/VIKUNJA_TOKEN_/);

    await store.db.deleteFrom('vikunja_owner_account').execute();
    await insertAccount(ownerId, '/etc/passwd');
    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({ provider: 'vikunja', vikunjaUrl: 'http://127.0.0.1:3456' }),
      }),
    ).rejects.toThrow(/unsupported vikunja token_secret_ref/);
  });

  test('rejects traversal and symlink escapes from VIKUNJA_SECRETS_DIR', async () => {
    const { root, secrets } = await secretLayout();
    const outside = join(root, 'outside.json');
    await writeFile(outside, JSON.stringify({ anyone: 'tk-outside' }), 'utf8');
    const ownerId = randomUUID() as Id;

    await insertAccount(ownerId, `file:${join(secrets, '..', 'outside.json')}`);
    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({
          provider: 'vikunja',
          vikunjaUrl: 'http://127.0.0.1:3456',
          vikunjaSecretsDir: secrets,
        }),
      }),
    ).rejects.toThrow(/escapes VIKUNJA_SECRETS_DIR/);

    await store.db.deleteFrom('vikunja_owner_account').execute();
    const link = join(secrets, 'link.json');
    await symlink(outside, link);
    await insertAccount(ownerId, `file:${link}`);
    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({
          provider: 'vikunja',
          vikunjaUrl: 'http://127.0.0.1:3456',
          vikunjaSecretsDir: secrets,
        }),
      }),
    ).rejects.toThrow(/escapes VIKUNJA_SECRETS_DIR/);
  });

  test('never echoes foreign token-file keys in errors', async () => {
    const { secrets } = await secretLayout();
    const ownerId = randomUUID() as Id;
    const tokenFile = join(secrets, 'bad.json');
    await writeFile(tokenFile, JSON.stringify({ 'foreign-secret-key': 123 }), 'utf8');
    await insertAccount(ownerId, `file:${tokenFile}`);

    const error = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaSecretsDir: secrets,
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('foreign-secret-key');
  });

  test('fails on missing url or token without echoing the secret', async () => {
    const ownerId = randomUUID() as Id;
    await insertAccount(ownerId, 'env:VIKUNJA_TOKEN_MISSING');

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
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/VIKUNJA_TOKEN_MISSING/);
  });

  test('rejects env:VIKUNJA_TOKEN_FILE because it holds a path, not a token', async () => {
    const ownerId = randomUUID() as Id;
    await insertAccount(ownerId, 'env:VIKUNJA_TOKEN_FILE');

    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({ provider: 'vikunja', vikunjaUrl: 'http://127.0.0.1:3456' }),
        env: { VIKUNJA_TOKEN_FILE: '/run/secrets/tokens.json' },
      }),
    ).rejects.toThrow(/VIKUNJA_TOKEN_FILE is a path/);
  });

  test('rejects a prefix-sibling secrets directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-tokens-'));
    tempDirs.push(root);
    const secrets = join(root, 'secrets');
    const sibling = join(root, 'secrets-evil');
    await mkdir(secrets, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const outside = join(sibling, 'tokens.json');
    await writeFile(outside, '{}', 'utf8');
    const ownerId = randomUUID() as Id;
    await insertAccount(ownerId, `file:${outside}`);

    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({
          provider: 'vikunja',
          vikunjaUrl: 'http://127.0.0.1:3456',
          vikunjaSecretsDir: secrets,
        }),
      }),
    ).rejects.toThrow(/escapes VIKUNJA_SECRETS_DIR/);
  });

  test('allows a symlinked VIKUNJA_SECRETS_DIR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-tokens-'));
    tempDirs.push(root);
    const realSecrets = join(root, 'real-secrets');
    const linkedSecrets = join(root, 'linked-secrets');
    await mkdir(realSecrets, { recursive: true });
    await symlink(realSecrets, linkedSecrets);
    const ownerId = randomUUID() as Id;
    const tokenFile = join(linkedSecrets, 'tokens.json');
    await writeFile(
      join(realSecrets, 'tokens.json'),
      JSON.stringify({ [ownerId]: 'tk-linked' }),
      'utf8',
    );
    await insertAccount(ownerId, `file:${tokenFile}`);

    const clients = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaSecretsDir: linkedSecrets,
      }),
    });
    expect([...clients.keys()]).toEqual([ownerId]);
  });

  test('rejects a file reference when VIKUNJA_SECRETS_DIR is unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-tokens-'));
    tempDirs.push(root);
    const tokenFile = join(root, 'tokens.json');
    await writeFile(tokenFile, '{}', 'utf8');
    const ownerId = randomUUID() as Id;
    await insertAccount(ownerId, `file:${tokenFile}`);

    await expect(
      loadVikunjaClients({
        db: store.db,
        config: createConfig({ provider: 'vikunja', vikunjaUrl: 'http://127.0.0.1:3456' }),
      }),
    ).rejects.toThrow(/VIKUNJA_SECRETS_DIR is required/);
  });

  test('still follows the input symlink and reads the verified file', async () => {
    const { secrets } = await secretLayout();
    const inside = join(secrets, 'inside.json');
    const link = join(secrets, 'link.json');
    const ownerId = randomUUID() as Id;
    await writeFile(inside, JSON.stringify({ [ownerId]: 'tk-inside' }), 'utf8');
    await symlink(inside, link);
    await insertAccount(ownerId, `file:${link}`);

    const clients = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaSecretsDir: secrets,
      }),
    });
    expect([...clients.keys()]).toEqual([ownerId]);
  });

  test('rejects a leaf file swapped for a symlink after verification', async () => {
    const { root, secrets } = await secretLayout();
    const inside = join(secrets, 'inside.json');
    const outside = join(root, 'outside.json');
    const ownerId = randomUUID() as Id;
    await writeFile(inside, JSON.stringify({ [ownerId]: 'tk-inside' }), 'utf8');
    await writeFile(outside, JSON.stringify({ [ownerId]: 'tk-outside' }), 'utf8');
    await insertAccount(ownerId, `file:${inside}`);
    const resolvedInside = await realpath(inside);

    const error = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaSecretsDir: secrets,
      }),
      beforeTokenFileOpen: async (resolved) => {
        expect(resolved).toBe(resolvedInside);
        // O_NOFOLLOW catches the leaf turning into a symlink after the check.
        await rm(inside);
        await symlink(outside, inside);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/changed after verification/);
    expect(String(error)).not.toContain('tk-outside');
  });

  test('rejects a leaf file replaced with a different inode after verification', async () => {
    const { root, secrets } = await secretLayout();
    const inside = join(secrets, 'inside.json');
    const outside = join(root, 'outside.json');
    const ownerId = randomUUID() as Id;
    await writeFile(inside, JSON.stringify({ [ownerId]: 'tk-inside' }), 'utf8');
    await writeFile(outside, JSON.stringify({ [ownerId]: 'tk-outside' }), 'utf8');
    await insertAccount(ownerId, `file:${inside}`);

    const error = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaSecretsDir: secrets,
      }),
      beforeTokenFileOpen: async () => {
        // Same path, different inode: O_NOFOLLOW succeeds, fstat must catch it.
        await rm(inside);
        await copyFile(outside, inside);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/changed after verification/);
    expect(String(error)).not.toContain('tk-outside');
  });

  test('rejects an intermediate directory swapped for a symlink after verification', async () => {
    const { root, secrets } = await secretLayout();
    const sub = join(secrets, 'sub');
    const outsideDir = join(root, 'outside-dir');
    const inside = join(sub, 'tokens.json');
    const outside = join(outsideDir, 'tokens.json');
    const ownerId = randomUUID() as Id;
    await mkdir(sub, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(inside, JSON.stringify({ [ownerId]: 'tk-inside' }), 'utf8');
    await writeFile(outside, JSON.stringify({ [ownerId]: 'tk-outside' }), 'utf8');
    await insertAccount(ownerId, `file:${inside}`);

    const error = await loadVikunjaClients({
      db: store.db,
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        vikunjaSecretsDir: secrets,
      }),
      beforeTokenFileOpen: async () => {
        // O_NOFOLLOW only covers the leaf; a dir symlink resolves to outside.
        await rename(sub, join(secrets, 'sub-original'));
        await symlink(outsideDir, sub);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/changed after verification/);
    expect(String(error)).not.toContain('tk-outside');
  });
});
