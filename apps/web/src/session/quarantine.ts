import { ref } from 'vue';
import { ownerStorageSuffix } from './owner';
import type { SessionEventRecord } from './journal';

export const quarantineRevision = ref(0);

const QUARANTINE_PREFIX = 'ohmydate.focus.quarantine';

export interface QuarantinedSessionEvent {
  readonly record: SessionEventRecord;
  readonly quarantinedAt: string;
  readonly reason: string;
}

function storageKey(ownerId: string | null): string {
  return `${QUARANTINE_PREFIX}:${ownerStorageSuffix(ownerId)}`;
}

export function listQuarantine(ownerId: string | null): QuarantinedSessionEvent[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(storageKey(ownerId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QuarantinedSessionEvent[]) : [];
  } catch {
    return [];
  }
}

export function quarantineRecord(
  ownerId: string | null,
  record: SessionEventRecord,
  reason: string,
): boolean {
  if (typeof localStorage === 'undefined') return false;
  const entries = listQuarantine(ownerId).filter(
    (entry) => entry.record.idempotencyKey !== record.idempotencyKey,
  );
  entries.push({ record, quarantinedAt: new Date().toISOString(), reason });
  try {
    localStorage.setItem(storageKey(ownerId), JSON.stringify(entries));
    quarantineRevision.value += 1;
    return true;
  } catch {
    return false;
  }
}

export function removeQuarantinedEntries(
  ownerId: string | null,
  idempotencyKeys: Iterable<string>,
): void {
  if (typeof localStorage === 'undefined') return;
  const remove = new Set(idempotencyKeys);
  if (remove.size === 0) return;
  const entries = listQuarantine(ownerId);
  const kept = entries.filter((entry) => !remove.has(entry.record.idempotencyKey));
  if (kept.length === entries.length) return;
  try {
    if (kept.length === 0) localStorage.removeItem(storageKey(ownerId));
    else localStorage.setItem(storageKey(ownerId), JSON.stringify(kept));
    quarantineRevision.value += 1;
  } catch (cause) {
    void cause;
  }
}

export function clearQuarantine(ownerId: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(storageKey(ownerId));
    quarantineRevision.value += 1;
  } catch {
    // ignore
  }
}
