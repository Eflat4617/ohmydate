import { readonly, ref, type Ref } from 'vue';
import { cleanChosenName } from '../domain/displayName';
import { readActiveOwnerId } from './owner';
import { captureOwnerBinding, onActiveOwnerChange, type OwnerBinding } from './ownerEpoch';
import { ownerSlot } from './ownerStorage';

/**
 * What the owner asked the app to call them (HOLO-07). The account has no
 * name field and the server is not asked for one: the name is typed once on
 * a device (설정 › 화면) and kept there, per owner, through the owner-scoped
 * storage module (slot `chosenName`).
 *
 * - Read for the owner who is signed in, and again whenever that changes, so
 *   another owner on the same device never sees it.
 * - Written under the owner binding of the screen that asks: if the owner
 *   changed since, nothing is stored and nothing on the page changes.
 * - One value for the whole page: the greeting, the account chip and the
 *   avatar's initial read the same ref, and change together.
 * - It goes nowhere else: no request, no log line, no prompt.
 */
const slot = ownerSlot('chosenName');

export function chosenNameKey(ownerId: string | null): string {
  return slot.keyFor(ownerId);
}

/** The owner's chosen name as stored, made fit again on the way out; `''` when there is none. */
export function readChosenName(ownerId: string | null): string {
  return cleanChosenName(slot.read(ownerId));
}

/**
 * Store `raw`, cleaned, in the binding's owner namespace — or remove what is
 * there when nothing is left of it. Null when it was not stored (the binding
 * is stale, the page is sealed); otherwise the name as it now stands.
 */
export function writeChosenName(binding: OwnerBinding, raw: unknown): string | null {
  const name = cleanChosenName(raw);
  const result = name.length > 0 ? slot.write(binding, name) : slot.remove(binding);
  return result === 'stale' || result === 'sealed' ? null : name;
}

const chosen = ref('');
let stopWatchingOwner: (() => void) | null = null;

/** Read the signed-in owner's name and follow owner changes. Safe to call again. */
export function bootChosenName(): void {
  chosen.value = readChosenName(readActiveOwnerId());
  stopWatchingOwner ??= onActiveOwnerChange((nextOwnerId) => {
    chosen.value = readChosenName(nextOwnerId);
  });
}

/** Test seam: drop the listener and forget the name. */
export function resetChosenNameForTests(): void {
  stopWatchingOwner?.();
  stopWatchingOwner = null;
  chosen.value = '';
}

export interface ChosenNameControls {
  /** The name in effect for the signed-in owner; `''` when they chose none. */
  readonly name: Readonly<Ref<string>>;
  /** Null when nothing was stored (the signed-in user changed); otherwise the name as kept (`''`: taken away). */
  setName(raw: string): string | null;
}

/**
 * For a screen. `setName` writes for the owner the screen was made for: the
 * binding is taken here, when the screen asks, not at the press — so a field
 * still on show after another user signed in stores nothing for them (the
 * binding is stale by then), sealed page or not.
 */
export function useChosenName(): ChosenNameControls {
  // A screen mounted before anything booted this (a test, a lazy route) still reads the right owner.
  if (stopWatchingOwner === null) bootChosenName();
  const binding = captureOwnerBinding();
  function setName(raw: string): string | null {
    const kept = writeChosenName(binding, raw);
    if (kept === null) return null;
    chosen.value = kept;
    return kept;
  }
  return { name: readonly(chosen), setName };
}
