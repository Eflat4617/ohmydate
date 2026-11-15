import { computed, ref, type ComputedRef } from 'vue';
import type { OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';
import { useSessionStore } from '../stores/session';

/**
 * 계획 세우기 (HOLO-03A): which plans the owner has started and not finished.
 *
 * The server keeps every planning session and every plan, but it has no list
 * of them, so "하던 계획 이어서 하기" (개요, 계획 세우기) needs to know where to
 * look. This is that pointer and nothing more: ids and a time, per owner, on
 * this device (session/ownerStorage.ts `planFlow`). What a plan is called and
 * how far it got is always read from the server.
 *
 * Owner isolation (ADR-023): a write takes the binding of the action that
 * caused it and is dropped once that binding is stale (the slot refuses it);
 * a read names the owner it is for.
 */

/** A planning session (목표 → 질문 → 단계), or a set of schedules waiting to be confirmed. */
export interface PlanFlowEntry {
  readonly kind: 'session' | 'plan';
  readonly id: string;
  /** The session a plan came from, so "단계" can be opened again from its schedules. */
  readonly sessionId?: string;
  /** Epoch ms of the last time the owner worked on it here. */
  readonly at: number;
}

/** Only the newest few are kept: this is a way back, not a history. */
export const PLAN_FLOW_LIMIT = 3;
/** Older than this and it is no longer offered. */
export const PLAN_FLOW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const slot = ownerSlot('planFlow');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Browser storage is not reactive: bumped on every write so readers look again. */
const revision = ref(0);

export function planFlowKey(ownerId: string | null): string {
  return slot.keyFor(ownerId);
}

function isEntry(value: unknown): value is PlanFlowEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (entry['kind'] !== 'session' && entry['kind'] !== 'plan') return false;
  if (typeof entry['id'] !== 'string' || !UUID.test(entry['id'])) return false;
  if (typeof entry['at'] !== 'number' || !Number.isFinite(entry['at'])) return false;
  const sessionId = entry['sessionId'];
  return sessionId === undefined || (typeof sessionId === 'string' && UUID.test(sessionId));
}

/** The owner's unfinished plans, newest first. Anything unreadable or too old is left out. */
export function readPlanFlows(ownerId: string | null, nowMs: number = Date.now()): PlanFlowEntry[] {
  if (ownerId === null) return [];
  const raw = slot.read(ownerId);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isEntry)
    .filter((entry) => nowMs - entry.at <= PLAN_FLOW_MAX_AGE_MS)
    .sort((left, right) => right.at - left.at)
    .slice(0, PLAN_FLOW_LIMIT);
}

function write(binding: OwnerBinding, entries: readonly PlanFlowEntry[]): void {
  if (binding.ownerId === null) return;
  if (entries.length === 0) slot.remove(binding);
  else slot.write(binding, JSON.stringify(entries));
  revision.value += 1;
}

/**
 * The owner is working on this one now. A plan made from a session takes the
 * session's place: one journey is one entry.
 */
export function rememberPlanFlow(
  binding: OwnerBinding,
  entry: { readonly kind: PlanFlowEntry['kind']; readonly id: string; readonly sessionId?: string | undefined },
  nowMs: number = Date.now(),
): void {
  if (binding.ownerId === null || !UUID.test(entry.id)) return;
  const sessionId = entry.sessionId !== undefined && UUID.test(entry.sessionId) ? entry.sessionId : undefined;
  const others = readPlanFlows(binding.ownerId, nowMs).filter(
    (known) =>
      !(known.kind === entry.kind && known.id === entry.id) &&
      !(entry.kind === 'plan' && known.kind === 'session' && known.id === sessionId),
  );
  const next: PlanFlowEntry = { kind: entry.kind, id: entry.id, at: nowMs, ...(sessionId === undefined ? {} : { sessionId }) };
  write(binding, [next, ...others].slice(0, PLAN_FLOW_LIMIT));
}

/** It is finished, given up or gone: stop offering it. */
export function forgetPlanFlow(binding: OwnerBinding, kind: PlanFlowEntry['kind'], id: string): void {
  if (binding.ownerId === null) return;
  const known = readPlanFlows(binding.ownerId);
  const next = known.filter((entry) => !(entry.kind === kind && entry.id === id));
  if (next.length !== known.length) write(binding, next);
}

/**
 * The signed-in owner's unfinished plans, re-read whenever one is remembered
 * or forgotten here. Reading only: a write is `rememberPlanFlow` /
 * `forgetPlanFlow` with the binding of the action that caused it (the task's
 * `owner.binding`, a fenced lookup's binding), never "whoever is signed in
 * when an answer arrives".
 */
export function usePlanFlows(): { readonly entries: ComputedRef<PlanFlowEntry[]> } {
  const sessionStore = useSessionStore();
  const entries = computed(() => {
    void revision.value;
    return readPlanFlows(sessionStore.ownerId);
  });
  return { entries };
}
