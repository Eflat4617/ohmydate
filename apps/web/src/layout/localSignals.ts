import { ref } from 'vue';
import { ownerStorageSuffix } from '../session/owner';
import { isOwnerBindingCurrent, type OwnerBinding } from '../session/ownerEpoch';

/**
 * Small per-owner, per-device facts the layout needs and the API does not
 * expose: "I saw today's deadline risk", "I already reviewed this session",
 * "skip today's review prompt". Only ids and dates are stored, never content.
 *
 * Writers take the OwnerBinding captured where the action started (ADR-023):
 * they write only into that owner's namespace, and nothing at all once the
 * owner or its epoch changed (a late continuation after a user switch).
 */
const RISK_ACK = 'ohmydate.layout.riskAck';
const REVIEWED = 'ohmydate.layout.reviewed';
const REVIEW_SKIP = 'ohmydate.layout.reviewSkip';
const MAX_REVIEWED = 200;

/** Bumped on every write so computed signals re-read storage. */
export const layoutSignalRevision = ref(0);

function key(prefix: string, ownerId: string | null): string {
  return `${prefix}:${ownerStorageSuffix(ownerId)}`;
}

function read(name: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function write(name: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(name, value);
  } catch {
    // ignore: the layout simply asks again.
  }
  layoutSignalRevision.value += 1;
}

export function acknowledgeRisk(binding: OwnerBinding, day: string): boolean {
  if (!isOwnerBindingCurrent(binding)) return false;
  write(key(RISK_ACK, binding.ownerId), day);
  return true;
}

export function isRiskAcknowledged(ownerId: string | null, day: string): boolean {
  void layoutSignalRevision.value;
  return read(key(RISK_ACK, ownerId)) === day;
}

export function skipReviewToday(binding: OwnerBinding, day: string): boolean {
  if (!isOwnerBindingCurrent(binding)) return false;
  write(key(REVIEW_SKIP, binding.ownerId), day);
  return true;
}

export function isReviewSkipped(ownerId: string | null, day: string): boolean {
  void layoutSignalRevision.value;
  return read(key(REVIEW_SKIP, ownerId)) === day;
}

function reviewedIds(ownerId: string | null): string[] {
  const raw = read(key(REVIEWED, ownerId));
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function markSessionReviewed(binding: OwnerBinding, sessionId: string): boolean {
  if (!isOwnerBindingCurrent(binding)) return false;
  const ids = reviewedIds(binding.ownerId).filter((id) => id !== sessionId);
  ids.push(sessionId);
  write(key(REVIEWED, binding.ownerId), JSON.stringify(ids.slice(-MAX_REVIEWED)));
  return true;
}

export function isSessionReviewed(ownerId: string | null, sessionId: string): boolean {
  void layoutSignalRevision.value;
  return reviewedIds(ownerId).includes(sessionId);
}
