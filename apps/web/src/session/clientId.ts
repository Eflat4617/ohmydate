import { uuidV7Key } from '../api';
import { readActiveOwnerId } from './owner';
import { ownerSlot } from './ownerStorage';

/** `ohmydate.focus.clientId:<owner>`: a random id, no user content (see ownerStorage). */
const slot = ownerSlot('focusClientId');

let cached: { ownerId: string | null; id: string } | null = null;

export function focusClientId(): string {
  const ownerId = readActiveOwnerId();
  if (cached !== null && cached.ownerId === ownerId) return cached.id;
  const stored = slot.read(ownerId);
  if (stored !== null && stored.length > 0 && stored.length <= 200) {
    cached = { ownerId, id: stored };
    return stored;
  }
  const id = uuidV7Key();
  cached = { ownerId, id };
  // If storage is unavailable the in-memory id is enough for this tab.
  slot.writeFor(ownerId, id);
  return id;
}

export function resetFocusClientIdForTests(): void {
  cached = null;
  slot.discard(readActiveOwnerId());
}
