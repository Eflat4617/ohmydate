import { uuidV7Key } from '../api';
import { ownerStorageSuffix, readActiveOwnerId } from './owner';

const CLIENT_ID_PREFIX = 'ohmydate.focus.clientId';

function clientIdKey(ownerId: string | null): string {
  return `${CLIENT_ID_PREFIX}:${ownerStorageSuffix(ownerId)}`;
}

let cached: { ownerId: string | null; id: string } | null = null;

export function focusClientId(): string {
  const ownerId = readActiveOwnerId();
  if (cached !== null && cached.ownerId === ownerId) return cached.id;
  const key = clientIdKey(ownerId);
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null && stored.length > 0 && stored.length <= 200) {
        cached = { ownerId, id: stored };
        return stored;
      }
    } catch {
      // fall through to a fresh id
    }
  }
  const id = uuidV7Key();
  cached = { ownerId, id };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, id);
    } catch {
      // in-memory id is enough for this tab
    }
  }
  return id;
}

export function resetFocusClientIdForTests(): void {
  cached = null;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(clientIdKey(readActiveOwnerId()));
    } catch {
      // ignore
    }
  }
}
