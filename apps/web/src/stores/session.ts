import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { WorkSession } from '../api';

const STORAGE_KEY = 'ohmydate.focus.sessions';

function readStorage(): Record<string, WorkSession> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Record<string, WorkSession>;
  } catch {
    return {};
  }
}

function writeStorage(sessions: Record<string, WorkSession>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Storage can be unavailable in private modes; the in-memory store still works.
  }
}

export type SyncState = 'idle' | 'offline' | 'syncing' | 'synced' | 'conflict';

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Record<string, WorkSession>>(readStorage());
  const pendingCount = ref(0);
  const syncState = ref<SyncState>('idle');
  const syncMessage = ref<string | null>(null);

  const active = computed<WorkSession | null>(() => {
    return (
      Object.values(sessions.value).find(
        (session) => session.state === 'active' || session.state === 'paused',
      ) ?? null
    );
  });

  function get(sessionId: string): WorkSession | null {
    return sessions.value[sessionId] ?? null;
  }

  function remember(session: WorkSession): void {
    sessions.value = { ...sessions.value, [session.id]: session };
    writeStorage(sessions.value);
  }

  function update(session: WorkSession): void {
    remember(session);
  }

  function forget(sessionId: string): void {
    const next = { ...sessions.value };
    delete next[sessionId];
    sessions.value = next;
    writeStorage(next);
  }

  function setPendingCount(count: number): void {
    pendingCount.value = count;
  }

  function setSyncState(state: SyncState, message: string | null = null): void {
    syncState.value = state;
    syncMessage.value = message;
  }

  function reset(): void {
    sessions.value = {};
    pendingCount.value = 0;
    syncState.value = 'idle';
    syncMessage.value = null;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }

  return {
    sessions,
    active,
    pendingCount,
    syncState,
    syncMessage,
    get,
    remember,
    update,
    forget,
    setPendingCount,
    setSyncState,
    reset,
  };
});
