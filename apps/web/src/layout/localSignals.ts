import { ref } from 'vue';
import type { OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot, type OwnerSlot } from '../session/ownerStorage';

/**
 * Small per-owner, per-device facts the layout needs and the API does not
 * expose: "I saw today's deadline risk", "I already reviewed this session",
 * "skip today's review prompt". Only ids and dates are stored, never content.
 *
 * Writers take the OwnerBinding captured where the action started (ADR-023):
 * they write only into that owner's namespace, and nothing at all once the
 * owner or its epoch changed (a late continuation after a user switch). The
 * slots themselves enforce that (session/ownerStorage.ts).
 */
const riskAck = ownerSlot('layoutRiskAck');
const reviewed = ownerSlot('layoutReviewed');
const reviewSkip = ownerSlot('layoutReviewSkip');
const MAX_REVIEWED = 200;

/** Bumped on every write so computed signals re-read storage. */
export const layoutSignalRevision = ref(0);

/** False when nothing may be stored for this binding (stale owner, or the page is being reset). */
function write(slot: OwnerSlot, binding: OwnerBinding, value: string): boolean {
  const result = slot.write(binding, value);
  if (result === 'stale' || result === 'sealed') return false;
  // A failed write is ignored: the layout simply asks again.
  if (result !== 'unavailable') layoutSignalRevision.value += 1;
  return true;
}

export function acknowledgeRisk(binding: OwnerBinding, day: string): boolean {
  return write(riskAck, binding, day);
}

export function isRiskAcknowledged(ownerId: string | null, day: string): boolean {
  void layoutSignalRevision.value;
  return riskAck.read(ownerId) === day;
}

export function skipReviewToday(binding: OwnerBinding, day: string): boolean {
  return write(reviewSkip, binding, day);
}

export function isReviewSkipped(ownerId: string | null, day: string): boolean {
  void layoutSignalRevision.value;
  return reviewSkip.read(ownerId) === day;
}

function reviewedIds(ownerId: string | null): string[] {
  const raw = reviewed.read(ownerId);
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function markSessionReviewed(binding: OwnerBinding, sessionId: string): boolean {
  const ids = reviewedIds(binding.ownerId).filter((id) => id !== sessionId);
  ids.push(sessionId);
  return write(reviewed, binding, JSON.stringify(ids.slice(-MAX_REVIEWED)));
}

export function isSessionReviewed(ownerId: string | null, sessionId: string): boolean {
  void layoutSignalRevision.value;
  return reviewedIds(ownerId).includes(sessionId);
}
