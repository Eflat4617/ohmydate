import { ref } from 'vue';
import { ownerSlot } from './ownerStorage';
import type { SessionEventRecord } from './journal';

export const quarantineRevision = ref(0);

/** Durable, per owner: `ohmydate.focus.quarantine:<owner>` (see ownerStorage). */
const slot = ownerSlot('focusQuarantine');

export interface QuarantinedSessionEvent {
  readonly record: SessionEventRecord;
  readonly quarantinedAt: string;
  readonly reason: string;
}

export function listQuarantine(ownerId: string | null): QuarantinedSessionEvent[] {
  const raw = slot.read(ownerId);
  if (raw === null) return [];
  try {
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
  if (!slot.available()) return false;
  const entries = listQuarantine(ownerId).filter(
    (entry) => entry.record.idempotencyKey !== record.idempotencyKey,
  );
  entries.push({ record, quarantinedAt: new Date().toISOString(), reason });
  if (slot.writeFor(ownerId, JSON.stringify(entries)) !== 'ok') return false;
  quarantineRevision.value += 1;
  return true;
}

export function removeQuarantinedEntries(
  ownerId: string | null,
  idempotencyKeys: Iterable<string>,
): void {
  if (!slot.available()) return;
  const remove = new Set(idempotencyKeys);
  if (remove.size === 0) return;
  const entries = listQuarantine(ownerId);
  const kept = entries.filter((entry) => !remove.has(entry.record.idempotencyKey));
  if (kept.length === entries.length) return;
  const result = kept.length === 0 ? slot.discard(ownerId) : slot.writeFor(ownerId, JSON.stringify(kept));
  if (result === 'ok') quarantineRevision.value += 1;
}

export function clearQuarantine(ownerId: string | null): void {
  if (slot.discard(ownerId) === 'ok') quarantineRevision.value += 1;
}
