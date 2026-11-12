#!/usr/bin/env node
// Vikunja API-token permissions and the token-file writer. The file format is
// the one read by services/api/src/adapters/vikunja/owner-accounts.ts:
// a JSON object of ownerId -> API token.
import { randomBytes } from 'node:crypto';
import { chmod, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Kept in parity with e2e/global-setup.ts VIKUNJA_TOKEN_PERMISSIONS. */
export const VIKUNJA_TOKEN_PERMISSIONS = {
  projects: ['create', 'read_all', 'read_one', 'update', 'delete', 'permanent'],
  tasks: ['create', 'read_all', 'read_one', 'update', 'delete', 'deleted', 'permanent'],
  tasks_relations: ['create', 'delete'],
  other: ['user'],
};

export const TOKEN_TTL_DAYS = 365;

export function tokenExpiry(now = Date.now()) {
  return new Date(now + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Write a JSON file atomically: a 0600 temp file in the same directory,
 * fsync, then rename over the target. A crash or a reader never sees a
 * truncated token/meta file.
 */
export async function writeJsonAtomic(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temp = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle = null;
  let renamed = false;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temp, 0o600);
    await rename(temp, path);
    renamed = true;
    await chmod(path, 0o600);
    const dirHandle = await open(dirname(path), 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    // The rename already replaced the target: a caller must treat the file as
    // written even though a later chmod/fsync failed.
    if (renamed && error !== null && typeof error === 'object') error.fileReplaced = true;
    throw error;
  }
}

export async function writeTokenFile(path, tokens) {
  await writeJsonAtomic(path, tokens);
}

export async function writeTokenMetadata(path, metadata) {
  await writeJsonAtomic(path, metadata);
}

export function readJsonObject(text) {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/** Accepts both flat `{ownerId: token}` and `{tokens: {...}}` shapes. */
export function tokenMapOf(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const nested = parsed.tokens;
  const candidate =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? nested : parsed;
  const result = {};
  for (const [ownerId, token] of Object.entries(candidate)) {
    if (typeof token === 'string' && token.length > 0) result[ownerId] = token;
  }
  return result;
}
