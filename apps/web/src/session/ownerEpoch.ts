import { ref } from 'vue';
import { readActiveOwnerId, writeActiveOwnerId } from './owner';
import { sessionJournal } from './journal';

export interface OwnerBinding {
  readonly ownerId: string | null;
  readonly epoch: number;
  readonly signal: AbortSignal;
}

const ownerId = ref<string | null>(readActiveOwnerId());
const epoch = ref(0);
let controller = new AbortController();

export const ownerState = { ownerId, epoch };

export function currentOwnerId(): string | null {
  return ownerId.value;
}

export function currentOwnerEpoch(): number {
  return epoch.value;
}

export function currentOwnerSignal(): AbortSignal {
  return controller.signal;
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

export function setActiveOwner(nextOwnerId: string | null): number {
  if (nextOwnerId !== ownerId.value) {
    invalidateOwnerEpoch();
    ownerId.value = nextOwnerId;
    writeActiveOwnerId(nextOwnerId);
  }
  sessionJournal.setOwner(nextOwnerId);
  return epoch.value;
}
