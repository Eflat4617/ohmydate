import { readonly, ref, type Ref } from 'vue';
import { readActiveOwnerId } from '../session/owner';
import { captureOwnerBinding, onActiveOwnerChange, type OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';

/**
 * 투명 효과 줄이기 (HOLO-04, FLOW.md §6): the owner's own switch for the glass.
 *
 * The glass turns opaque by itself where `backdrop-filter` is missing and
 * under `prefers-reduced-transparency`; this is the same thing asked for by
 * hand (설정 › 화면) — for a machine that paints the blur slowly, or a desktop
 * shell whose compositor does not paint it at all. One attribute on the root
 * carries it, `data-transparency="reduce"`, and `.glass` reads it
 * (styles/primitives.css).
 *
 * Remembered per owner on this device through the owner-scoped storage module
 * (slot `transparencyPref`), like the theme.
 */
const REDUCE = 'reduce';
const slot = ownerSlot('transparencyPref');

export function transparencyPrefKey(ownerId: string | null): string {
  return slot.keyFor(ownerId);
}

/** Anything but the word `reduce` is the default: glass. */
export function readTransparencyReduced(ownerId: string | null): boolean {
  return slot.read(ownerId) === REDUCE;
}

/** Into the binding's owner namespace, only while that binding is current (ADR-023). */
export function writeTransparencyReduced(binding: OwnerBinding, reduced: boolean): boolean {
  const result = reduced ? slot.write(binding, REDUCE) : slot.remove(binding);
  return result !== 'stale' && result !== 'sealed';
}

const reduced = ref(false);
let stopWatchingOwner: (() => void) | null = null;

function apply(): void {
  if (typeof document === 'undefined') return;
  if (reduced.value) document.documentElement.dataset['transparency'] = REDUCE;
  else delete document.documentElement.dataset['transparency'];
}

/** Read the signed-in owner's choice and put it on the root element (before the app mounts). */
export function bootTransparency(): void {
  reduced.value = readTransparencyReduced(readActiveOwnerId());
  apply();
  stopWatchingOwner ??= onActiveOwnerChange((nextOwnerId) => {
    reduced.value = readTransparencyReduced(nextOwnerId);
    apply();
  });
}

/** Test seam: drop the listener and go back to glass. */
export function resetTransparencyForTests(): void {
  stopWatchingOwner?.();
  stopWatchingOwner = null;
  reduced.value = false;
  apply();
}

export interface TransparencyControls {
  readonly reduced: Readonly<Ref<boolean>>;
  /** False when nothing was stored (the signed-in user changed): the page shows what is in effect. */
  setReduced(next: boolean): boolean;
}

export function useTransparency(): TransparencyControls {
  function setReduced(next: boolean): boolean {
    // The owner is noted at the click, before anything else can change it.
    const binding = captureOwnerBinding();
    if (!writeTransparencyReduced(binding, next)) return false;
    reduced.value = next;
    apply();
    return true;
  }
  return { reduced: readonly(reduced), setReduced };
}
