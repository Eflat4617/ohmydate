import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { Id } from '@ohmydate/domain';
import { VikunjaClient } from '@ohmydate/provider-vikunja';
import type { Kysely } from 'kysely';
import type { AppConfig } from '../../config.js';
import type { Database } from '../../db/types.js';

export interface VikunjaOwnerAccount {
  readonly ownerId: Id;
  readonly vikunjaUserId: number;
  readonly tokenSecretRef: string;
}

export async function listVikunjaOwnerAccounts(
  db: Kysely<Database>,
): Promise<readonly VikunjaOwnerAccount[]> {
  const rows = await db
    .selectFrom('vikunja_owner_account')
    .select(['owner_id', 'vikunja_user_id', 'token_secret_ref'])
    .orderBy('owner_id', 'asc')
    .execute();
  return rows.map((row) => ({
    ownerId: row.owner_id as Id,
    vikunjaUserId: row.vikunja_user_id,
    tokenSecretRef: row.token_secret_ref,
  }));
}

/**
 * Owners the reconciler must sweep: every configured account plus any owner
 * left with a `needs_reconcile` mapping (a crash can leave the latter without
 * an account row in synthetic/import scenarios).
 */
export async function listReconcilerOwnerIds(db: Kysely<Database>): Promise<readonly Id[]> {
  const accounts = await db
    .selectFrom('vikunja_owner_account')
    .select('owner_id')
    .execute();
  const staged = await db
    .selectFrom('vikunja_mapping')
    .select('owner_id')
    .where('needs_reconcile', '=', true)
    .execute();
  return [...new Set([...accounts, ...staged].map((row) => row.owner_id))] as Id[];
}

/**
 * Token files are JSON objects of ownerId -> API token (`{ "tokens": {...} }`
 * is also accepted). Supported references are:
 * - `env:VIKUNJA_TOKEN_*` — only names under that prefix are accepted, so a
 *   writable account row cannot exfiltrate an unrelated env secret. The config
 *   variable `VIKUNJA_TOKEN_FILE` is explicitly excluded: it holds a path, not
 *   a token, so `env:VIKUNJA_TOKEN_FILE` would send the path as a Bearer value.
 * - `file:<path>` — the path must realpath-resolve to VIKUNJA_TOKEN_FILE or
 *   inside VIKUNJA_SECRETS_DIR; traversal and symlink escapes are rejected.
 *   Verification is open-then-check: the canonical path is opened with
 *   O_RDONLY|O_NOFOLLOW, the opened handle's dev/ino must match the verified
 *   file, and its /proc/self/fd path must still resolve inside the allowed set.
 *   Only then is the token read from that handle, so swapping a leaf file or an
 *   intermediate directory after the path check cannot redirect the read.
 * - `default` — use the configured VIKUNJA_TOKEN_FILE.
 * Bare paths are intentionally unsupported. Cleartext tokens never touch
 * PostgreSQL, logs or error messages, and file errors never echo foreign keys.
 */
export async function loadVikunjaClients(options: {
  readonly db: Kysely<Database>;
  readonly config: AppConfig;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Test-only seam: runs after the path/token-file verification and before the
   * handle is opened, so a test can deterministically swap a leaf file or an
   * intermediate directory and assert the open-then-verify path rejects it.
   */
  readonly beforeTokenFileOpen?: (resolvedPath: string) => Promise<void>;
}): Promise<ReadonlyMap<Id, VikunjaClient>> {
  const baseUrl = options.config.vikunjaUrl;
  if (baseUrl === null || baseUrl.length === 0) {
    throw new Error('VIKUNJA_URL is required when PROVIDER=vikunja');
  }
  const env = options.env ?? process.env;
  const fileCache = new Map<string, ReadonlyMap<string, string>>();
  const accounts = await listVikunjaOwnerAccounts(options.db);
  const clients = new Map<Id, VikunjaClient>();

  const resolvedDefaultFile = async (): Promise<string | null> => {
    const defaultFile = options.config.vikunjaTokenFile;
    if (defaultFile === null) return null;
    return realpath(defaultFile).catch(() => null);
  };

  const isAllowedCanonicalPath = async (resolved: string): Promise<boolean> => {
    const resolvedDefault = await resolvedDefaultFile();
    if (resolvedDefault !== null && resolvedDefault === resolved) return true;
    const secretsDir = options.config.vikunjaSecretsDir;
    if (secretsDir === null) return false;
    const dir = await realpath(secretsDir).catch(() => null);
    if (dir === null) return false;
    const inside = relative(dir, resolved);
    return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
  };

  const resolveAllowedFile = async (
    path: string,
  ): Promise<{ resolved: string; dev: number; ino: number }> => {
    const resolved = await realpath(path);
    if (!(await isAllowedCanonicalPath(resolved))) {
      if (options.config.vikunjaSecretsDir === null) {
        throw new Error('VIKUNJA_SECRETS_DIR is required for file token references');
      }
      throw new Error('Vikunja token file reference escapes VIKUNJA_SECRETS_DIR');
    }
    const info = await stat(resolved);
    return { resolved, dev: info.dev, ino: info.ino };
  };

  const readVerifiedFile = async (path: string): Promise<string> => {
    const { resolved, dev, ino } = await resolveAllowedFile(path);
    // Deterministic race window for tests only; undefined in production.
    await options.beforeTokenFileOpen?.(resolved);
    let handle: FileHandle;
    try {
      handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      // ELOOP from O_NOFOLLOW: the verified leaf became a symlink.
      throw new Error('Vikunja token file changed after verification');
    }
    try {
      const opened = await handle.stat();
      if (opened.dev !== dev || opened.ino !== ino) {
        throw new Error('Vikunja token file changed after verification');
      }
      // On Linux this is the canonical path of the opened inode. It catches an
      // intermediate directory swapped for a symlink (O_NOFOLLOW only checks
      // the final component) even when the attacker copies inode metadata.
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => null);
      if (openedPath !== null && !(await isAllowedCanonicalPath(openedPath))) {
        throw new Error('Vikunja token file reference escapes VIKUNJA_SECRETS_DIR');
      }
      return await handle.readFile('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const tokenFromFile = async (path: string, ownerId: Id): Promise<string> => {
    let tokens = fileCache.get(path);
    if (tokens === undefined) {
      const text = await readVerifiedFile(path);
      tokens = parseTokenFile(path, text);
      fileCache.set(path, tokens);
    }
    const token = tokens.get(String(ownerId));
    if (token === undefined) {
      throw new Error(`Vikunja token file ${path} has no token for owner ${ownerId}`);
    }
    return token;
  };

  for (const account of accounts) {
    const ref = account.tokenSecretRef;
    let token: string;
    if (ref.startsWith('env:')) {
      const name = ref.slice('env:'.length);
      if (!/^VIKUNJA_TOKEN_[A-Z0-9_]+$/.test(name) || name === 'VIKUNJA_TOKEN_FILE') {
        throw new Error(
          `Vikunja token env reference for owner ${account.ownerId} must be env:VIKUNJA_TOKEN_* ` +
            '(VIKUNJA_TOKEN_FILE is a path, not a token)',
        );
      }
      const value = env[name];
      if (value === undefined || value.length === 0) {
        throw new Error(`Vikunja token env var ${name} is not set for owner ${account.ownerId}`);
      }
      token = value;
    } else if (ref === 'default') {
      if (options.config.vikunjaTokenFile === null) {
        throw new Error(
          `VIKUNJA_TOKEN_FILE is required for owner ${account.ownerId} (token_secret_ref=default)`,
        );
      }
      token = await tokenFromFile(options.config.vikunjaTokenFile, account.ownerId);
    } else if (ref.startsWith('file:')) {
      const path = ref.slice('file:'.length);
      token = await tokenFromFile(path, account.ownerId);
    } else {
      throw new Error(
        `unsupported vikunja token_secret_ref for owner ${account.ownerId} ` +
          '(expected env:VIKUNJA_TOKEN_*, file:<path>, or default)',
      );
    }
    clients.set(account.ownerId, new VikunjaClient({ baseUrl, token }));
  }

  return clients;
}

function parseTokenFile(path: string, text: string): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Vikunja token file ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Vikunja token file ${path} must be a JSON object`);
  }
  const candidate =
    typeof (parsed as Record<string, unknown>)['tokens'] === 'object' &&
    (parsed as Record<string, unknown>)['tokens'] !== null
      ? ((parsed as Record<string, unknown>)['tokens'] as Record<string, unknown>)
      : (parsed as Record<string, unknown>);
  const tokens = new Map<string, string>();
  for (const [ownerId, value] of Object.entries(candidate)) {
    if (typeof value !== 'string' || value.length === 0) {
      // Deliberately do not echo the foreign key: a mistyped path must not
      // leak the shape/keys of an unrelated JSON file into logs.
      throw new Error(`Vikunja token file ${path} contains a non-string token entry`);
    }
    tokens.set(ownerId, value);
  }
  return tokens;
}
