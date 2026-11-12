#!/usr/bin/env node
// Vikunja API-token permissions and the token-file writer. The file format is
// the one read by services/api/src/adapters/vikunja/owner-accounts.ts:
// a JSON object of ownerId -> API token.
import { chmod, writeFile } from 'node:fs/promises';

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

export async function writeTokenFile(path, tokens) {
  const body = `${JSON.stringify(tokens, null, 2)}\n`;
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeTokenMetadata(path, metadata) {
  const body = `${JSON.stringify(metadata, null, 2)}\n`;
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
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
