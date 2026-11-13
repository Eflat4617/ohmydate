import type { OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';

/**
 * Whether the sidebar is folded down to icons (HOLO-01). Per owner, on this
 * device only, through the owner-scoped storage module.
 */
const slot = ownerSlot('shellNav');
const COLLAPSED = 'collapsed';
const EXPANDED = 'expanded';

export function shellNavKey(ownerId: string | null): string {
  return slot.keyFor(ownerId);
}

/** Anything but the word `collapsed` is the default: an open sidebar. */
export function readNavCollapsed(ownerId: string | null): boolean {
  return slot.read(ownerId) === COLLAPSED;
}

/** Into the binding's owner namespace, only while that binding is current (ADR-023). */
export function writeNavCollapsed(binding: OwnerBinding, collapsed: boolean): boolean {
  const result = slot.write(binding, collapsed ? COLLAPSED : EXPANDED);
  return result !== 'stale' && result !== 'sealed';
}
