import type { Fraction } from '../domain/canvas/layout';
import type { OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';

/**
 * What the 할 일 canvas remembers on this device, per owner (HOLO-05): where
 * each to-do and each folder was left, which folders are folded, and whether
 * the owner asked for the list instead. Ids, fractions and flags only — no
 * title ever goes into storage — through the owner-scoped storage module
 * (ADR-023): read by owner id, written under the binding of the gesture that
 * moved something, and a stale binding writes nothing.
 */
const slot = ownerSlot('todoCanvas');

export type TasksViewChoice = 'canvas' | 'list';

export interface CanvasMemory {
  /** To-do id → its anchor as a fraction of what holds it (the surface, or its folder's inside). */
  readonly places: Readonly<Record<string, Fraction>>;
  /** Folder id → the centre of its dish as a fraction of the surface. */
  readonly folders: Readonly<Record<string, Fraction>>;
  /** Folders folded to one object. */
  readonly folded: readonly string[];
  readonly view: TasksViewChoice;
}

export const EMPTY_CANVAS_MEMORY: CanvasMemory = { places: {}, folders: {}, folded: [], view: 'canvas' };

/** More entries than this are not kept: the oldest keys are dropped first. */
export const CANVAS_MEMORY_LIMIT = 800;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fractionsOf(value: unknown): Record<string, Fraction> {
  const out: Record<string, Fraction> = {};
  if (!isRecord(value)) return out;
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const { u, v } = entry;
    if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v)) continue;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    out[id] = { u, v };
  }
  return out;
}

/** Whatever is stored, read as a memory: anything that is not one is left out. */
export function parseCanvasMemory(raw: string | null): CanvasMemory {
  if (raw === null) return EMPTY_CANVAS_MEMORY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_CANVAS_MEMORY;
  }
  if (!isRecord(value)) return EMPTY_CANVAS_MEMORY;
  return {
    places: fractionsOf(value['places']),
    folders: fractionsOf(value['folders']),
    folded: Array.isArray(value['folded']) ? value['folded'].filter((id): id is string => typeof id === 'string') : [],
    view: value['view'] === 'list' ? 'list' : 'canvas',
  };
}

function round(fraction: Fraction): Fraction {
  return { u: Math.round(fraction.u * 10_000) / 10_000, v: Math.round(fraction.v * 10_000) / 10_000 };
}

function capped(entries: Readonly<Record<string, Fraction>>): Record<string, Fraction> {
  const keys = Object.keys(entries);
  const kept = keys.length > CANVAS_MEMORY_LIMIT ? keys.slice(keys.length - CANVAS_MEMORY_LIMIT) : keys;
  const out: Record<string, Fraction> = {};
  for (const key of kept) out[key] = round(entries[key] as Fraction);
  return out;
}

export function serializeCanvasMemory(memory: CanvasMemory): string {
  return JSON.stringify({
    places: capped(memory.places),
    folders: capped(memory.folders),
    folded: memory.folded.slice(0, CANVAS_MEMORY_LIMIT),
    view: memory.view,
  });
}

/**
 * Forget what is no longer there: a to-do that was finished or deleted, a
 * folder that was removed. `known` is every id the server still lists.
 */
export function pruneCanvasMemory(memory: CanvasMemory, known: { tasks: ReadonlySet<string>; folders: ReadonlySet<string> }): CanvasMemory {
  const keep = (entries: Readonly<Record<string, Fraction>>, ids: ReadonlySet<string>): Record<string, Fraction> => {
    const out: Record<string, Fraction> = {};
    for (const [id, place] of Object.entries(entries)) if (ids.has(id)) out[id] = place;
    return out;
  };
  return {
    places: keep(memory.places, known.tasks),
    folders: keep(memory.folders, known.folders),
    folded: memory.folded.filter((id) => known.folders.has(id)),
    view: memory.view,
  };
}

export function canvasMemoryKey(ownerId: string | null): string {
  return slot.keyFor(ownerId);
}

export function readCanvasMemory(ownerId: string | null): CanvasMemory {
  return parseCanvasMemory(slot.read(ownerId));
}

/** Into the binding's own namespace, only while that binding is current. */
export function writeCanvasMemory(binding: OwnerBinding, memory: CanvasMemory): boolean {
  return slot.write(binding, serializeCanvasMemory(memory)) === 'ok';
}
