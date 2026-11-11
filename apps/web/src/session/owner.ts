import { ANONYMOUS_OWNER, deviceSlot } from './ownerStorage';

const activeOwner = deviceSlot('activeOwner');

/** The device-level pointer to the signed-in owner (see ownerStorage's device allowlist). */
export const OWNER_STORAGE_KEY = activeOwner.key;

export { ANONYMOUS_OWNER };

export function readActiveOwnerId(): string | null {
  const value = activeOwner.read();
  return value !== null && value.length > 0 ? value : null;
}

export function writeActiveOwnerId(ownerId: string | null): void {
  // Private browsing can disable storage; the in-memory owner still applies.
  if (ownerId === null) activeOwner.remove();
  else activeOwner.write(ownerId);
}

export function ownerStorageSuffix(ownerId: string | null): string {
  return ownerId ?? ANONYMOUS_OWNER;
}
