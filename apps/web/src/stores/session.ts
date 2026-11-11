import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { WorkSession } from '../api';
import {
  ownerStorageSuffix,
  readActiveOwnerId,
  writeActiveOwnerId,
} from '../session/owner';
import {
  isOwnerBindingCurrent,
  setActiveOwner,
  type OwnerBinding,
} from '../session/ownerEpoch';

const STORAGE_KEY_PREFIX = 'ohmydate.focus.sessions';

function storageKey(ownerId: string | null): string {
  return `${STORAGE_KEY_PREFIX}:${ownerStorageSuffix(ownerId)}`;
}

function readStorage(ownerId: string | null): Record<string, WorkSession> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(storageKey(ownerId));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Record<string, WorkSession>;
  } catch {
    return {};
  }
}

function writeStorage(ownerId: string | null, sessions: Record<string, WorkSession>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(ownerId), JSON.stringify(sessions));
  } catch {
    // Storage can be unavailable in private modes; the in-memory store still works.
  }
}

export type SyncState = 'idle' | 'offline' | 'syncing' | 'synced' | 'conflict';

export const useSessionStore = defineStore('session', () => {
  const ownerId = ref<string | null>(readActiveOwnerId());
  const sessions = ref<Record<string, WorkSession>>(readStorage(ownerId.value));
  const pendingCount = ref(0);
  const syncState = ref<SyncState>('idle');
  const syncMessage = ref<string | null>(null);

  const active = computed<WorkSession | null>(() => {
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
    setActiveOwner(nextOwnerId);
    ownerId.value = nextOwnerId;
    writeActiveOwnerId(nextOwnerId);
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
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(storageKey(ownerId.value));
      } catch {
        // ignore
      }
    }
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
