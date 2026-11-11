import { shallowReactive } from 'vue';

/**
 * Presentational memory of Today's blocks so the Focus screen can show the
 * task title and planned length instead of raw ids. In-memory only, keyed by
 * owner so a different signed-in owner never sees another owner's titles.
 * Nothing here is sent anywhere or persisted.
 */
export interface FocusBlockContext {
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly timeZone: string;
}

interface BlockLike {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
}

const MAX_ENTRIES = 200;
const contexts = shallowReactive(new Map<string, FocusBlockContext>());

function key(ownerId: string | null, kind: 'block' | 'task', id: string): string {
  return `${ownerId ?? 'anonymous'}|${kind}|${id}`;
}

export function rememberFocusBlocks(
  ownerId: string | null,
  blocks: readonly BlockLike[],
  timeZone: string,
): void {
  for (const block of blocks) {
    const context: FocusBlockContext = {
      title: block.title,
      startAt: block.startAt,
      endAt: block.endAt,
      timeZone,
    };
    contexts.set(key(ownerId, 'block', block.id), context);
    contexts.set(key(ownerId, 'task', block.taskId), context);
  }
  while (contexts.size > MAX_ENTRIES) {
    const oldest = contexts.keys().next().value;
    if (oldest === undefined) break;
    contexts.delete(oldest);
  }
}

export function focusContextFor(
  ownerId: string | null,
  blockId: string | null | undefined,
  taskId: string,
): FocusBlockContext | null {
  if (blockId !== null && blockId !== undefined) {
    const byBlock = contexts.get(key(ownerId, 'block', blockId));
    if (byBlock !== undefined) return byBlock;
  }
  return contexts.get(key(ownerId, 'task', taskId)) ?? null;
}

export function clearFocusContexts(): void {
  contexts.clear();
}
