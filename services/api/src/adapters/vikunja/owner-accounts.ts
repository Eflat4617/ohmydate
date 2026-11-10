import { readFile, realpath } from 'node:fs/promises';
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
 *   writable account row cannot exfiltrate an unrelated env secret.
 * - `file:<path>` — the path must realpath-resolve to VIKUNJA_TOKEN_FILE or
 *   inside VIKUNJA_SECRETS_DIR; traversal and symlink escapes are rejected.
 * - `default` — use the configured VIKUNJA_TOKEN_FILE.
 * Bare paths are intentionally unsupported. Cleartext tokens never touch
 * PostgreSQL, logs or error messages, and file errors never echo foreign keys.
 */
export async function loadVikunjaClients(options: {
  readonly db: Kysely<Database>;
  readonly config: AppConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly readTextFile?: (path: string) => Promise<string>;
}): Promise<ReadonlyMap<Id, VikunjaClient>> {
  const baseUrl = options.config.vikunjaUrl;
  if (baseUrl === null || baseUrl.length === 0) {
    throw new Error('VIKUNJA_URL is required when PROVIDER=vikunja');
  }
  const env = options.env ?? process.env;
  const readText = options.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const fileCache = new Map<string, ReadonlyMap<string, string>>();
  const accounts = await listVikunjaOwnerAccounts(options.db);
  const clients = new Map<Id, VikunjaClient>();

  const assertAllowedFile = async (path: string): Promise<void> => {
    const resolved = await realpath(path);
    const defaultFile = options.config.vikunjaTokenFile;
    if (defaultFile !== null) {
      const resolvedDefault = await realpath(defaultFile).catch(() => null);
      if (resolvedDefault !== null && resolvedDefault === resolved) return;
    }
    const secretsDir = options.config.vikunjaSecretsDir;
    if (secretsDir === null) {
      throw new Error('VIKUNJA_SECRETS_DIR is required for file token references');
    }
    const dir = await realpath(secretsDir);
    const inside = relative(dir, resolved);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return;
    throw new Error('Vikunja token file reference escapes VIKUNJA_SECRETS_DIR');
  };

  const tokenFromFile = async (path: string, ownerId: Id): Promise<string> => {
    let tokens = fileCache.get(path);
    if (tokens === undefined) {
      const text = await readText(path);
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
      if (!/^VIKUNJA_TOKEN_[A-Z0-9_]+$/.test(name)) {
        throw new Error(
          `Vikunja token env reference for owner ${account.ownerId} must be env:VIKUNJA_TOKEN_*`,
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
      await assertAllowedFile(path);
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
