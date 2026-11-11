import { ownerStorageSuffix } from './owner';
import type { SessionEventRecord } from './journal';

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
): number {
  const entries = listQuarantine(ownerId).filter(
    (entry) => entry.record.idempotencyKey !== record.idempotencyKey,
  );
  entries.push({ record, quarantinedAt: new Date().toISOString(), reason });
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(storageKey(ownerId), JSON.stringify(entries));
    } catch {
      // The in-memory queue still drops the terminal record when storage is unavailable.
    }
  }
  return entries.length;
}

export function clearQuarantine(ownerId: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(storageKey(ownerId));
  } catch {
    // ignore
  }
}
