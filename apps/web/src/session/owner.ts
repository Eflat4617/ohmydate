export const OWNER_STORAGE_KEY = 'ohmydate.focus.owner';

export const ANONYMOUS_OWNER = 'anonymous';

export function readActiveOwnerId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const value = localStorage.getItem(OWNER_STORAGE_KEY);
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeActiveOwnerId(ownerId: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (ownerId === null) localStorage.removeItem(OWNER_STORAGE_KEY);
    else localStorage.setItem(OWNER_STORAGE_KEY, ownerId);
  } catch {
    // Private browsing can disable storage; the in-memory owner still applies.
  }
}

export function ownerStorageSuffix(ownerId: string | null): string {
  return ownerId ?? ANONYMOUS_OWNER;
}
