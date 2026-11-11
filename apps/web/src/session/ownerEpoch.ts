import { ref } from 'vue';
import { OWNER_STORAGE_KEY, readActiveOwnerId, writeActiveOwnerId } from './owner';
import { sessionJournal } from './journal';

export interface OwnerBinding {
  readonly ownerId: string | null;
  readonly epoch: number;
  readonly signal: AbortSignal;
}

export type OwnerChangeReason =
  | 'login'
  | 'logout'
  | 'storage'
  | 'me-mismatch'
  | 'bootstrap'
  | 'session-store';

const ownerId = ref<string | null>(readActiveOwnerId());
const epoch = ref(0);
const resetPending = ref(false);
let controller = new AbortController();

export const ownerState = { ownerId, epoch, resetPending };

type OwnerChangeListener = (
  nextOwnerId: string | null,
  previousOwnerId: string | null,
  reason: OwnerChangeReason,
) => void;
const ownerChangeListeners = new Set<OwnerChangeListener>();

export function onActiveOwnerChange(listener: OwnerChangeListener): () => void {
  ownerChangeListeners.add(listener);
  return () => ownerChangeListeners.delete(listener);
}

export function currentOwnerId(): string | null {
  return ownerId.value;
}

export function currentOwnerEpoch(): number {
  return epoch.value;
}

export function currentOwnerSignal(): AbortSignal {
  return controller.signal;
}

export function isOwnerResetPending(): boolean {
  return resetPending.value;
}

export function clearOwnerResetPending(): void {
  resetPending.value = false;
}

export function captureOwnerBinding(): OwnerBinding {
  return {
    ownerId: ownerId.value,
    epoch: epoch.value,
    signal: controller.signal,
  };
}

export function isOwnerBindingCurrent(binding: OwnerBinding): boolean {
  return (
    !binding.signal.aborted &&
    binding.epoch === epoch.value &&
    binding.ownerId === ownerId.value
  );
}

export function invalidateOwnerEpoch(): number {
  controller.abort();
  controller = new AbortController();
  epoch.value += 1;
  return epoch.value;
}

type OwnerReload = (reason: OwnerChangeReason) => void;

function defaultReload(reason: OwnerChangeReason): void {
  if (typeof window === 'undefined') return;
  try {
    const target = reason === 'logout' ? '/login' : '/';
    window.history.replaceState(window.history.state, '', target);
  } catch (cause) {
    void cause;
  }
  window.location.reload();
}

let reloadOwnerPage: OwnerReload = defaultReload;

export function injectOwnerReload(reload: OwnerReload | null): void {
  reloadOwnerPage = reload ?? defaultReload;
}

function notifyOwnerChange(
  nextOwnerId: string | null,
  previousOwnerId: string | null,
  reason: OwnerChangeReason,
): void {
  for (const listener of [...ownerChangeListeners]) {
    listener(nextOwnerId, previousOwnerId, reason);
  }
}

export function ownerChanged(
  previousOwnerId: string | null,
  nextOwnerId: string | null,
  reason: OwnerChangeReason,
): boolean {
  const previous = previousOwnerId === ownerId.value ? previousOwnerId : ownerId.value;
  if (nextOwnerId === previous) {
    sessionJournal.setOwner(nextOwnerId);
    return false;
  }
  invalidateOwnerEpoch();
  ownerId.value = nextOwnerId;
  sessionJournal.setOwner(nextOwnerId);
  if (reason !== 'storage') writeActiveOwnerId(nextOwnerId);
  resetPending.value = true;
  notifyOwnerChange(nextOwnerId, previous, reason);
  reloadOwnerPage(reason);
  return true;
}

export function adoptActiveOwner(
  nextOwnerId: string | null,
  reason: OwnerChangeReason = 'bootstrap',
): boolean {
  const previous = ownerId.value;
  if (nextOwnerId === previous) {
    sessionJournal.setOwner(nextOwnerId);
    return false;
  }
  invalidateOwnerEpoch();
  ownerId.value = nextOwnerId;
  sessionJournal.setOwner(nextOwnerId);
  writeActiveOwnerId(nextOwnerId);
  notifyOwnerChange(nextOwnerId, previous, reason);
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== OWNER_STORAGE_KEY) return;
    const next = event.newValue !== null && event.newValue.length > 0 ? event.newValue : null;
    if (next !== ownerId.value) ownerChanged(ownerId.value, next, 'storage');
  });
}
