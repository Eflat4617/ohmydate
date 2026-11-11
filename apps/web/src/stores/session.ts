import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { WorkSession } from '../api';
import { readActiveOwnerId, writeActiveOwnerId } from '../session/owner';
import { ownerSlot } from '../session/ownerStorage';
import {
  adoptActiveOwner,
  isOwnerBindingCurrent,
  onActiveOwnerChange,
  ownerChanged,
  ownerState,
  type OwnerBinding,
} from '../session/ownerEpoch';

/** Durable, per owner: `ohmydate.focus.sessions:<owner>` (see ownerStorage). */
const slot = ownerSlot('focusSessions');

function readStorage(ownerId: string | null): Record<string, WorkSession> {
  const raw = slot.read(ownerId);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Record<string, WorkSession>;
  } catch {
    return {};
  }
}

function writeStorage(ownerId: string | null, sessions: Record<string, WorkSession>): void {
  // Storage can be unavailable in private modes; the in-memory store still works.
  slot.writeFor(ownerId, JSON.stringify(sessions));
}

export type SyncState = 'idle' | 'offline' | 'syncing' | 'synced' | 'conflict';

export const useSessionStore = defineStore('session', () => {
  const ownerId = ref<string | null>(readActiveOwnerId());
  const sessions = ref<Record<string, WorkSession>>(readStorage(ownerId.value));
  const pendingCount = ref(0);
  const syncState = ref<SyncState>('idle');
  const syncMessage = ref<string | null>(null);

  onActiveOwnerChange((nextOwnerId) => {
    ownerId.value = nextOwnerId;
    sessions.value = readStorage(nextOwnerId);
    pendingCount.value = 0;
    syncState.value = 'idle';
    syncMessage.value = null;
  });  const active = computed<WorkSession | null>(() => {
    const all = Object.values(sessions.value);
    return (
      all.find((session) => session.state === 'active') ??
      all.find((session) => session.state === 'paused') ??
      null
    );
  });

  function get(sessionId: string): WorkSession | null {
    return sessions.value[sessionId] ?? null;
  }

  function remember(session: WorkSession, binding?: OwnerBinding): void {
    if (binding !== undefined && !isOwnerBindingCurrent(binding)) {
      const target = binding.ownerId;
      if (target === ownerId.value) {
        sessions.value = { ...sessions.value, [session.id]: session };
        writeStorage(ownerId.value, sessions.value);
        return;
      }
      writeStorage(target, { ...readStorage(target), [session.id]: session });
      return;
    }
    sessions.value = { ...sessions.value, [session.id]: session };
    writeStorage(ownerId.value, sessions.value);
  }

  function update(session: WorkSession, binding?: OwnerBinding): void {
    remember(session, binding);
  }

  function forget(sessionId: string, binding?: OwnerBinding): void {
    if (binding !== undefined && !isOwnerBindingCurrent(binding)) {
      const target = binding.ownerId;
      if (target === ownerId.value) {
        const next = { ...sessions.value };
        delete next[sessionId];
        sessions.value = next;
        writeStorage(ownerId.value, next);
        return;
      }
      const stored = { ...readStorage(target) };
      delete stored[sessionId];
      writeStorage(target, stored);
      return;
    }
    const next = { ...sessions.value };
    delete next[sessionId];
    sessions.value = next;
    writeStorage(ownerId.value, next);
  }

  function setPendingCount(count: number, binding?: OwnerBinding): void {
    if (binding !== undefined && !isOwnerBindingCurrent(binding)) return;
    pendingCount.value = count;
  }

  function setSyncState(
    state: SyncState,
    message: string | null = null,
    binding?: OwnerBinding,
  ): void {
    if (binding !== undefined && !isOwnerBindingCurrent(binding)) return;
    syncState.value = state;
    syncMessage.value = message;
  }

  function setOwner(nextOwnerId: string | null): void {
    const previous = ownerState.ownerId.value;
    if (nextOwnerId !== previous) {
      ownerChanged(previous, nextOwnerId, 'session-store');
    } else {
      adoptActiveOwner(nextOwnerId, 'session-store');
      writeActiveOwnerId(nextOwnerId);
    }
    ownerId.value = nextOwnerId;
    sessions.value = readStorage(nextOwnerId);
    pendingCount.value = 0;
    syncState.value = 'idle';
    syncMessage.value = null;
  }

  function reset(): void {
    sessions.value = {};
    pendingCount.value = 0;
    syncState.value = 'idle';
    syncMessage.value = null;
    slot.discard(ownerId.value);
  }

  return {
    ownerId,
    sessions,
    active,
    pendingCount,
    syncState,
    syncMessage,
    get,
    remember,
    update,
    forget,
    setOwner,
    setPendingCount,
    setSyncState,
    reset,
  };
});
