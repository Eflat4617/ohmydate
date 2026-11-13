import { ref } from 'vue';
import { bindRequestOwnerSignal } from '../api';
import { OWNER_STORAGE_KEY, readActiveOwnerId, writeActiveOwnerId } from './owner';
import { sessionJournal } from './journal';
import { bindOwnerAuthority, clearSlotsOnOwnerChange } from './ownerStorage';

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

// The page seal (ADR-023 guardrail, FU-77). ADR-023 makes a user switch a hard
// reload, so one page instance serves one owner. With the seal installed
// (main.ts), the moment a hard reset is decided this page stops being able to
// act for anyone: storage will not open the new owner's namespace, the query
// cache takes no more data, no toast appears and the router does not move. A
// continuation that was written without a fence then has nothing left to
// write to. Unit tests switch owners on one page on purpose, so the seal is
// opt-in; it never engages for a single owner.
let pageSealInstalled = false;
const pageSealed = ref(false);

export function installPageSeal(): void {
  pageSealInstalled = true;
}

export function isPageSealed(): boolean {
  return pageSealed.value;
}

export function resetPageSealForTests(): void {
  pageSealInstalled = false;
  pageSealed.value = false;
}

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
    // After another user signed in, the page reloads on the inbox, as it
    // always has (E2E-5 checks the new owner's list there). `/` itself is
    // 개요 since HOLO-02, so the address is spelled out.
    const target = reason === 'logout' ? '/login' : '/inbox';
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
  if (pageSealInstalled) pageSealed.value = true;
  ownerId.value = nextOwnerId;
  clearSlotsOnOwnerChange();
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
  clearSlotsOnOwnerChange();
  sessionJournal.setOwner(nextOwnerId);
  writeActiveOwnerId(nextOwnerId);
  notifyOwnerChange(nextOwnerId, previous, reason);
  return true;
}

// Every API request carries the signal of the owner who started it (ADR-023
// §1): an owner change aborts what is in flight and keeps what was started but
// not yet sent from being sent with the next user's session.
bindRequestOwnerSignal(currentOwnerSignal);

// ownerStorage decides staleness and the seal through this module, without
// importing it (it sits below, so the active-owner pointer can be read here).
bindOwnerAuthority({
  isCurrent: isOwnerBindingCurrent,
  currentOwnerId: () => ownerId.value,
  isPageSealed: () => pageSealed.value,
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== OWNER_STORAGE_KEY) return;
    const next = event.newValue !== null && event.newValue.length > 0 ? event.newValue : null;
    if (next !== ownerId.value) ownerChanged(ownerId.value, next, 'storage');
  });
}
