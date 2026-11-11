import { uuidV7Key } from '../api';

const CLIENT_ID_KEY = 'ohmydate.focus.clientId';

let cached: string | null = null;

export function focusClientId(): string {
  if (cached !== null) return cached;
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(CLIENT_ID_KEY);
      if (stored !== null && stored.length > 0 && stored.length <= 200) {
        cached = stored;
        return cached;
      }
    } catch {
      // fall through to a fresh id
    }
  }
  cached = uuidV7Key();
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(CLIENT_ID_KEY, cached);
    } catch {
      // in-memory id is enough for this tab
    }
  }
  return cached;
}

export function resetFocusClientIdForTests(): void {
  cached = null;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(CLIENT_ID_KEY);
    } catch {
      // ignore
    }
  }
}
