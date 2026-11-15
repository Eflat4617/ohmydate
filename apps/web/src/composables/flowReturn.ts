import { computed, ref, type ComputedRef } from 'vue';
import type { OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';
import { useSessionStore } from '../stores/session';

/**
 * 되돌아오기 (HOLO-04, FLOW.md §5): a flow that has to send the owner out —
 * connecting Google Calendar leaves the app for Google and comes back to
 * 설정 › 캘린더 연동, an address the server chooses — remembers where they were,
 * so that 설정 offers the way back instead of leaving them there.
 *
 * It is a path of this app and nothing else: it must start with one `/`, and
 * 설정 itself is never a place to return to. Kept for the browser session, per
 * owner (session/ownerStorage.ts `flowReturn`), and removed on any owner change.
 */
const slot = ownerSlot('flowReturn');
/** Browser storage is not reactive: bumped on every write so readers look again. */
const revision = ref(0);

/** A path inside the app that is worth going back to; null for anything else. */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (value === '/settings' || value.startsWith('/settings/') || value.startsWith('/settings?') || value.startsWith('/login')) return null;
  return value;
}

export function readFlowReturn(ownerId: string | null): string | null {
  return ownerId === null ? null : safeReturnPath(slot.read(ownerId));
}

/** Remember where the owner is, under the binding of the press that sends them out. */
export function rememberFlowReturn(binding: OwnerBinding, path: string): boolean {
  const safe = safeReturnPath(path);
  if (binding.ownerId === null || safe === null) return false;
  const result = slot.write(binding, safe);
  revision.value += 1;
  return result === 'ok';
}

export function clearFlowReturn(binding: OwnerBinding): void {
  if (binding.ownerId === null) return;
  slot.remove(binding);
  revision.value += 1;
}

/** The signed-in owner's way back, if a flow left one. */
export function useFlowReturn(): { readonly path: ComputedRef<string | null> } {
  const sessionStore = useSessionStore();
  const path = computed(() => {
    void revision.value;
    return readFlowReturn(sessionStore.ownerId);
  });
  return { path };
}
