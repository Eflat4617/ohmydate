import { reactive, ref } from 'vue';
import { ActionStore, ApiError, isStoredFinalResult, plannerClient } from '../api';
import { t } from '../i18n';
import { errorMessage } from '../i18n/problem';
import { runOwnerBound } from '../session/ownerBound';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';

/** What a lock toggle needs to know about an approved block (ScheduleBlock fields). */
export interface LockableBlock {
  readonly id: string;
  readonly locked: boolean;
  readonly version: number;
  readonly status: string;
  readonly startAt: string;
}

/**
 * The server's rule (08 §2.5, FU-71): only a planned block that has not
 * started yet can be locked or unlocked. Started blocks are history (06 §7.1).
 */
export function isBlockLockable(block: Pick<LockableBlock, 'status' | 'startAt'>, nowMs: number): boolean {
  return block.status === 'planned' && Date.parse(block.startAt) >= nowMs;
}

export interface BlockLockOptions {
  /**
   * Re-read what the screen shows (blocks and the plan revision — a lock moves
   * Today.version / Plan.version). Called after a change and after a 412/409.
   */
  readonly refresh: () => Promise<unknown>;
}

/**
 * `POST /schedule-blocks/{id}:lock` / `:unlock` for a screen.
 *
 * Optimistic UI only through the owner guardrail (ADR-023, FU-77): the
 * requested state shows at once (`displayLocked`), the request, the toast, the
 * refresh and the clean-up all run inside one `runOwnerBound` task, so after a
 * user switch nothing of this action reaches the next user. A 412 (the block
 * changed elsewhere) or 409 (it started or finished meanwhile) refreshes the
 * screen and drops the optimistic state; one Idempotency-Key per logical
 * toggle, reused only by a retry of the same request (08 §1).
 */
export function useBlockLock(options: BlockLockOptions) {
  const offline = useOfflineStore();
  const toast = useToastStore();
  const actions = new ActionStore();
  /** blockId → the state the user asked for, until the server answered and the screen re-read. */
  const pending = reactive(new Map<string, boolean>());
  const error = ref<string | null>(null);

  function displayLocked(block: Pick<LockableBlock, 'id' | 'locked'>): boolean {
    return pending.get(block.id) ?? block.locked;
  }

  function isPending(blockId: string): boolean {
    return pending.has(blockId);
  }

  async function toggle(block: LockableBlock): Promise<void> {
    if (!offline.mutationsEnabled || pending.has(block.id)) return;
    const locked = !block.locked;
    const scope = `schedule-block:lock:${block.id}`;
    const action = actions.begin(
      scope,
      { blockId: block.id, locked },
      (left, right) => left.blockId === right.blockId && left.locked === right.locked,
      block.version,
    );
    await runOwnerBound(function* (owner) {
      pending.set(block.id, locked);
      error.value = null;
      try {
        const saved = yield* owner.wait(
          plannerClient.setScheduleBlockLock(block.id, locked, action.key, block.version, owner.signal),
        );
        actions.settle(scope, action);
        toast.show(saved.locked ? t('blockLock.lockedToast') : t('blockLock.unlockedToast'));
        yield* owner.wait(options.refresh());
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 412) {
          // The next attempt sends another If-Match, so it is a new action.
          actions.settle(scope, action);
          error.value = t('blockLock.stale');
          yield* owner.wait(options.refresh());
        } else if (cause instanceof ApiError && cause.status === 409 && cause.code === 'illegal_transition') {
          error.value = t('blockLock.notLockable');
          yield* owner.wait(options.refresh());
        } else {
          error.value = errorMessage(cause, t('blockLock.error'));
        }
      } finally {
        pending.delete(block.id);
      }
    });
  }

  return { displayLocked, isPending, toggle, error };
}
